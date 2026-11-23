import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDifficulty } from '../src/engine/core/beatmap/parse';
import { boxGroupRows, boxGroupStats, lightGroupsOf, readBoxGroups, splitGroupName, type BoxGroupBlock } from '../src/editor/box-groups';
import { convertMap, mapVersion } from '../src/editor/convert';
import { difficultyVersion, writeDifficulty } from '../src/editor/map-io';

/**
 * Maps with the game's group lighting system (the folders given: unpacked maps), read and saved:
 *
 *   1. saving a v3 difficulty leaves its event box groups as they were in the file;
 *   2. the blocks read are as many as the file has — blocks, boxes and events;
 *   3. a v3 map made into v4 reads as the same blocks (and a v4 map made into v3).
 *
 *   esbuild tests/box-groups.ts --bundle --platform=node --format=cjs --outfile=/tmp/box-groups.cjs
 *   node /tmp/box-groups.cjs <map folder> …
 */

type Json = Record<string, unknown>;
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const V3_KEYS = ['lightColorEventBoxGroups', 'lightRotationEventBoxGroups', 'lightTranslationEventBoxGroups', 'vfxEventBoxGroups'] as const;
const read = (path: string) => readFileSync(path, 'utf8').replace(/^﻿/u, '');

let failed = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

/** What the file itself has: blocks of each kind, boxes, events (v3: its four lists; v4: its one). */
function fileCounts(root: Json) {
  const counts = { blocks: { color: 0, rotation: 0, translation: 0, fx: 0 }, boxes: 0, events: 0 };
  if (Array.isArray(root.eventBoxGroups)) {
    const kinds = ['', 'color', 'rotation', 'translation', 'fx'] as const;
    for (const group of list(root.eventBoxGroups)) {
      const kind = kinds[Number(group.t ?? 0)];
      if (kind === undefined || kind === '') continue;
      counts.blocks[kind]++;
      for (const box of list(group.e)) {
        counts.boxes++;
        counts.events += list(box.l).length;
      }
    }
    return counts;
  }
  V3_KEYS.forEach((key, index) => {
    const kind = (['color', 'rotation', 'translation', 'fx'] as const)[index]!;
    for (const group of list(root[key])) {
      counts.blocks[kind]++;
      for (const box of list(group.e)) {
        counts.boxes++;
        counts.events += (Array.isArray(box.e) ? box.e : Array.isArray(box.l) ? box.l : []).length;
      }
    }
  });
  return counts;
}

/** A value's text with its objects' keys in order (the two parsers put them in different ones). */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : typeof value === 'object' && value !== null
      ? `{${Object.keys(value).filter((key) => (value as Json)[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`).join(',')}}`
      : JSON.stringify(value) ?? 'null';

/** The blocks without what differs by the file they are read from (their place in it). */
const plain = (blocks: BoxGroupBlock[]) =>
  JSON.stringify(
    blocks
      // (v4 keeps all in one list in time; blocks at one beat on one group are told apart by their content)
      .map((block) => canonical({ kind: block.kind, group: block.group, beat: block.beat, boxes: block.boxes }))
      .sort(),
  );

// the groups' names taken apart: the category is the words before the Local/Global/Left/Right tail
const nameParts: [string, string | null, string | null][] = [
  ['TopConesLocalLeft', 'Top Cones', 'Local Left'],
  ['TopConesGlobalRight', 'Top Cones', 'Global Right'],
  ['CenterConesLocalLeft', 'Center Cones', 'Local Left'],
  ['DiamondRingsGlobal', 'Diamond Rings', 'Global'],
  ['SpectogramLeft', 'Spectogram', 'Left'],
  ['CenterLasersBottomLeft', 'Center Lasers Bottom', 'Left'],
  ['RunwayInnerLaser', null, null],
  ['WindowLeftPieces', null, null],
  ['RunwayLasersLeftTransformZ', null, null],
  ['0', null, null],
];
for (const [name, base, sub] of nameParts) {
  const made = splitGroupName(name);
  check((made?.base ?? null) === base && (made?.sub ?? null) === sub, `splitGroupName("${name}") → ${base === null ? 'no category' : `"${base}" / "${sub}"`}`);
}

for (const dir of process.argv.slice(2)) {
  const files = readdirSync(dir);
  const infoName = files.find((file) => file.toLowerCase() === 'info.dat')!;
  const infoText = read(join(dir, infoName));
  const info = JSON.parse(infoText) as Json;
  const version = mapVersion(infoText);
  const environment = String(info._environmentName ?? (Array.isArray(info.environmentNames) ? info.environmentNames[0] : ''));
  const groups = lightGroupsOf(environment);
  const bpm = Number(info._beatsPerMinute ?? (info.audio as Json | undefined)?.bpm ?? 120);
  console.log(`\n${String(info._songName ?? (info.song as Json | undefined)?.title)} — ${environment}, map v${version}, ${String(groups.length)} groups known`);

  const texts: Record<string, string> = {};
  for (const file of files) if (file.endsWith('.dat')) texts[file] = read(join(dir, file));

  if (version === '4') {
    // one lightshow file for the difficulties: read with any of them
    const shows = Object.keys(texts).filter((file) => Array.isArray((JSON.parse(texts[file]!) as Json).eventBoxGroups));
    const beatmap = Object.keys(texts).find((file) => Array.isArray((JSON.parse(texts[file]!) as Json).colorNotes) && difficultyVersion(texts[file]!) === '4')!;
    for (const show of shows) {
      const root = JSON.parse(texts[show]!) as Json;
      const blocks = readBoxGroups(parseDifficulty(texts[beatmap]!, bpm, { lightshowText: texts[show]! }), groups);
      const stats = boxGroupStats(blocks);
      const counts = fileCounts(root);
      check(JSON.stringify(stats.blocks) === JSON.stringify(counts.blocks) && stats.boxes === counts.boxes && stats.events === counts.events, `${show}: read ${JSON.stringify(stats.blocks)}, ${String(stats.boxes)} boxes, ${String(stats.events)} events — as the file has`);
      let saved = true;
      try {
        writeDifficulty(texts[show]!, []);
      } catch {
        saved = false;
      }
      console.log(`  ${saved ? 'ok  ' : 'note'} ${show}: ${saved ? 'saved' : 'the editor does not save v4 files yet (writeDifficulty refuses them)'}`);
      // into v3 and read again
      const converted = convertMap({ infoName, texts, song: { sampleCount: 0, frequency: 44100 } }, '3');
      const v3Name = Object.keys(converted.files).find((file) => V3_KEYS.some((key) => list((JSON.parse(converted.files[file]!) as Json)[key]).length > 0));
      if (v3Name !== undefined) {
        const again = readBoxGroups(parseDifficulty(converted.files[v3Name]!, bpm), groups);
        check(plain(again) === plain(blocks), `${show} → v3 (${v3Name}): the same blocks`);
      } else check(false, `${show} → v3: no difficulty with groups came out`);
    }
    continue;
  }

  let convertedOnce = false;
  for (const [file, text] of Object.entries(texts)) {
    const root = JSON.parse(text) as Json;
    if (!V3_KEYS.some((key) => Array.isArray(root[key]))) continue;
    const blocks = readBoxGroups(parseDifficulty(text, bpm), groups);
    const stats = boxGroupStats(blocks);
    const counts = fileCounts(root);
    check(JSON.stringify(stats.blocks) === JSON.stringify(counts.blocks) && stats.boxes === counts.boxes && stats.events === counts.events, `${file}: read ${JSON.stringify(stats.blocks)}, ${String(stats.boxes)} boxes, ${String(stats.events)} events — as the file has`);

    // saved with other events, bookmarks and the rest written: the groups are as they were
    const saved = JSON.parse(writeDifficulty(text, [{ beat: 1, type: 4, value: 1, floatValue: 1 }], undefined, [])) as Json;
    const same = V3_KEYS.every((key) => JSON.stringify(saved[key]) === JSON.stringify(root[key])) && JSON.stringify(saved._fxEventsCollection) === JSON.stringify(root._fxEventsCollection);
    check(same, `${file}: saved — its groups and FX values are as in the file`);
    const reread = readBoxGroups(parseDifficulty(JSON.stringify(saved), bpm), groups);
    check(plain(reread) === plain(blocks), `${file}: saved and read again — the same blocks`);

    const rows = boxGroupRows(blocks, groups);
    const missing = rows.filter((row) => row.missing);
    if (missing.length > 0) console.log(`  note ${file}: blocks on groups the environment has not got: ${missing.map((row) => `${String(row.group)} (${String(row.lanes.reduce((sum, lane) => sum + lane.blocks.length, 0))})`).join(', ')}`);
    const longest = blocks.reduce((max, block) => Math.max(max, block.length), 0);
    if (!convertedOnce) console.log(`  info ${file}: ${String(rows.filter((row) => row.lanes.length > 0).length)} rows with blocks, ${String(rows.reduce((sum, row) => sum + row.lanes.length, 0))} lanes, the longest block ${longest.toFixed(2)} beats`);

    // into v4 and read again (once a map: its difficulties are alike here)
    if (!convertedOnce) {
      convertedOnce = true;
      const converted = convertMap({ infoName, texts: { [infoName]: infoText, [file]: text }, song: { sampleCount: 44100 * 300, frequency: 44100 } }, '4');
      const showName = Object.keys(converted.files).find((name) => Array.isArray((JSON.parse(converted.files[name]!) as Json).eventBoxGroups));
      const beatmapName = Object.keys(converted.files).find((name) => Array.isArray((JSON.parse(converted.files[name]!) as Json).colorNotes));
      if (showName !== undefined && beatmapName !== undefined) {
        const again = readBoxGroups(parseDifficulty(converted.files[beatmapName]!, bpm, { lightshowText: converted.files[showName]! }), groups);
        check(plain(again) === plain(blocks), `${file} → v4: the same blocks`);
      } else check(false, `${file} → v4: no lightshow came out`);
    }
  }
}

console.log(failed === 0 ? '\nAll passed' : `\n${String(failed)} failed`);
process.exit(failed === 0 ? 0 : 1);
