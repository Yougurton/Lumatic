import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertMap, type ConvertInput } from '../src/editor/convert';
import { parseInfo } from '../src/engine/core/beatmap/info';
import { parseDifficulty } from '../src/engine/core/beatmap/parse';
import type { Difficulty } from '../src/engine/core/beatmap/types';

/**
 * A map from v3 to v4 and back: what the viewer's own parsers read from the v4 files is what they read
 * from the v3 ones (notes, walls, arcs, chains, lights, the group lighting system, the tempo), and the
 * map back in v3 is read the same again. A made-up map with every kind of object, and any map folders
 * given.
 *
 * npx tsx tests/convert.ts [map folder…]
 */

let failures = 0;
let checks = 0;
const check = (ok: boolean, ...what: unknown[]) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('fail', ...what);
  }
};

const KEYS = ['notes', 'obstacles', 'arcs', 'chains', 'events', 'rotationEvents', 'bpmEvents', 'lightColorEventBoxGroups', 'lightRotationEventBoxGroups', 'lightTranslationEventBoxGroups', 'fxEventBoxGroups'] as const;
/** For comparing: numbers to 1/1000, keys in order, custom data left out when asked (the viewer's v4
 *  parser doesn't read objects' own custom data — it is checked in the files instead); a tempo change
 *  by where it lands (a jump of a few samples at 100000 BPM can't be kept to the BPM in v4's samples). */
const normal = (value: unknown, custom: boolean): unknown => {
  if (typeof value === 'number') return Math.round(value * 1000) / 1000;
  if (Array.isArray(value)) return value.map((item) => normal(item, custom));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.keys(value).filter((key) => custom || key !== 'customData').sort().map((key) => [key, normal((value as Record<string, unknown>)[key], custom)]));
  return value;
};
const same = (name: string, a: Difficulty, b: Difficulty, custom: boolean) => {
  for (const key of KEYS) {
    const pick = (item: Difficulty) => (key === 'bpmEvents' ? item.bpmEvents.map((event) => [event.jsonTime, event.songBpmTime]) : item[key]);
    const left = normal(pick(a), custom) as unknown[];
    const right = normal(pick(b), custom) as unknown[];
    const first = left.findIndex((item, index) => JSON.stringify(item) !== JSON.stringify(right[index]));
    check(left.length === right.length && first < 0, name, key, left.length, right.length, first, JSON.stringify(left[first])?.slice(0, 300), JSON.stringify(right[first])?.slice(0, 300));
  }
};

function roundTrip(name: string, texts: Record<string, string>, infoName = 'Info.dat') {
  const song = { sampleCount: 44100 * 300, frequency: 44100 };
  const input: ConvertInput = { infoName, texts, song };
  const v4 = convertMap(input, '4');
  const info3 = parseInfo(texts[infoName]!);
  const v4Texts = { ...texts, ...v4.files };
  const info4 = parseInfo(v4Texts[infoName]!);
  check(info4.version.startsWith('4') && info4.songName === info3.songName && info4.beatsPerMinute === info3.beatsPerMinute, name, 'info v4', info4.songName);
  const difficulties3 = info3.difficultySets.flatMap((set) => set.difficulties);
  const difficulties4 = info4.difficultySets.flatMap((set) => set.difficulties);
  check(difficulties3.length === difficulties4.length, name, 'difficulties', difficulties3.length, difficulties4.length);
  for (const item of difficulties3) {
    const four = difficulties4.find((other) => other.characteristic === item.characteristic && other.difficulty === item.difficulty)!;
    check(four !== undefined && four.noteJumpSpeed === item.noteJumpSpeed && four.customLabel === item.customLabel, name, item.difficulty, 'entry');
    const original = parseDifficulty(texts[item.beatmapFilename]!, info3.beatsPerMinute);
    const converted = parseDifficulty(v4Texts[four.beatmapFilename]!, info4.beatsPerMinute, { lightshowText: v4Texts[four.lightshowFilename], audioDataText: v4Texts['BPMInfo.dat'] });
    // (v4 keeps a tempo change at beat 0 as the first stretch; v3 may not have one)
    if (original.bpmEvents.length === 0 || original.bpmEvents[0]!.jsonTime !== 0) original.bpmEvents.unshift({ jsonTime: 0, songBpmTime: 0, bpm: info3.beatsPerMinute });
    same(`${name} ${item.difficulty} v4`, original, converted, false);
    // (the objects' own custom data is in the v4 files)
    const owned = (root: Record<string, unknown>, keys: string[]) => keys.flatMap((key) => (Array.isArray(root[key]) ? (root[key] as { customData?: unknown }[]) : [])).filter((item) => item.customData !== undefined).length;
    const before = owned(JSON.parse(texts[item.beatmapFilename]!) as Record<string, unknown>, ['colorNotes', 'bombNotes', 'obstacles', 'sliders', 'burstSliders', 'basicBeatmapEvents']);
    const after = owned(JSON.parse(v4Texts[four.beatmapFilename]!) as Record<string, unknown>, ['colorNotes', 'bombNotes', 'obstacles', 'arcs', 'chains']) + owned(JSON.parse(v4Texts[four.lightshowFilename]!) as Record<string, unknown>, ['basicEvents']);
    check(before === after, name, item.difficulty, 'custom data in v4', before, after);
  }
  // and back
  const v3 = convertMap({ infoName, texts: v4Texts, song }, '3');
  const back = { ...v4Texts, ...v3.files };
  for (const name4 of v3.dropped) delete back[name4];
  const infoBack = parseInfo(back[infoName]!);
  check(infoBack.version === '2.1.0' && infoBack.songName === info3.songName && infoBack.environmentName === info3.environmentName, name, 'info back', infoBack.environmentName, info3.environmentName);
  for (const item of difficulties3) {
    const found = infoBack.difficultySets.flatMap((set) => set.difficulties).find((other) => other.characteristic === item.characteristic && other.difficulty === item.difficulty)!;
    const original = parseDifficulty(texts[item.beatmapFilename]!, info3.beatsPerMinute);
    const returned = parseDifficulty(back[found.beatmapFilename]!, infoBack.beatsPerMinute);
    if (original.bpmEvents.length === 0 || original.bpmEvents[0]!.jsonTime !== 0) original.bpmEvents.unshift({ jsonTime: 0, songBpmTime: 0, bpm: info3.beatsPerMinute });
    if (returned.bpmEvents.length === 0 || returned.bpmEvents[0]!.jsonTime !== 0) returned.bpmEvents.unshift({ jsonTime: 0, songBpmTime: 0, bpm: infoBack.beatsPerMinute });
    same(`${name} ${item.difficulty} back`, original, returned, true);
    // custom data carried
    const custom = (JSON.parse(texts[item.beatmapFilename]!) as { customData?: unknown }).customData;
    check(JSON.stringify((JSON.parse(back[found.beatmapFilename]!) as { customData?: unknown }).customData) === JSON.stringify(custom), name, item.difficulty, 'custom data');
  }
  return { v4, v3 };
}

// ----- a made-up map with everything
const box = (extra: Record<string, unknown>) => ({ f: { f: 1, p: 1, t: 0, r: 0, c: 0, n: 0, s: 0, l: 0, d: 0 }, w: 1, d: 1, t: 1, b: 0, i: 0, ...extra });
const synthetic = {
  version: '3.3.0',
  bpmEvents: [{ b: 16, m: 140 }],
  rotationEvents: [{ b: 4, e: 0, r: 15 }],
  colorNotes: [{ b: 1, x: 1, y: 0, a: 0, c: 0, d: 1 }, { b: 2, x: 2, y: 0, a: 5, c: 1, d: 1, customData: { color: [1, 0, 0] } }, { b: 3, x: 1, y: 0, a: 0, c: 0, d: 1 }],
  bombNotes: [{ b: 5, x: 0, y: 2 }],
  obstacles: [{ b: 6, x: 0, y: 0, d: 2, w: 1, h: 5 }],
  sliders: [{ c: 0, b: 7, x: 1, y: 0, d: 1, mu: 1, tb: 8, tx: 2, ty: 2, tc: 0, tmu: 0.5, m: 1 }],
  burstSliders: [{ c: 1, b: 9, x: 2, y: 0, d: 1, tb: 9.5, tx: 3, ty: 1, sc: 5, s: 0.8 }],
  waypoints: [],
  basicBeatmapEvents: [{ b: 0, et: 1, i: 1, f: 1 }, { b: 1, et: 2, i: 5, f: 0.5 }, { b: 2, et: 1, i: 1, f: 1, customData: { color: [0, 1, 0] } }],
  colorBoostBeatmapEvents: [{ b: 3, o: true }, { b: 4, o: false }],
  lightColorEventBoxGroups: [{ b: 2, g: 0, e: [box({ r: 1, e: [{ b: 0, i: 0, c: 1, s: 1, f: 0, sb: 0, sf: 0 }, { b: 1, i: 1, c: 2, s: 0.5, f: 4, sb: 0.2, sf: 1 }, { b: 2, i: 2, c: 0, s: 0, f: 0, sb: 0, sf: 0 }] })] }],
  lightRotationEventBoxGroups: [{ b: 3, g: 1, e: [box({ s: 15, a: 1, r: 1, l: [{ b: 0, p: 0, e: 1, l: 2, r: 90, o: 1 }] })] }],
  lightTranslationEventBoxGroups: [{ b: 4, g: 2, e: [box({ s: 1, a: 2, r: 0, l: [{ b: 0, p: 0, e: 3, t: 5 }] })] }],
  vfxEventBoxGroups: [{ b: 5, g: 3, t: 0, e: [box({ s: 0, l: [0, 1] })] }],
  _fxEventsCollection: { _fl: [{ b: 0, p: 0, i: 0, v: 1 }, { b: 1, p: 1, i: 2, v: 0.25 }], _il: [] },
  basicEventTypesWithKeywords: { d: [] },
  useNormalEventsAsCompatibleEvents: true,
  customData: { environment: [{ id: 'Thing', lookupMethod: 'Contains', active: false }], customEvents: [{ b: 1, t: 'AnimateTrack', d: { track: 'x', duration: 1 } }] },
};
const syntheticInfo = {
  _version: '2.1.0', _songName: 'Made up', _songSubName: '', _songAuthorName: 'Nobody', _levelAuthorName: 'Me', _beatsPerMinute: 120, _songTimeOffset: 0, _shuffle: 0, _shufflePeriod: 0.5, _previewStartTime: 12, _previewDuration: 10,
  _songFilename: 'song.ogg', _coverImageFilename: 'cover.jpg', _environmentName: 'BigMirrorEnvironment', _allDirectionsEnvironmentName: 'GlassDesertEnvironment', _environmentNames: [], _colorSchemes: [],
  _customData: { _editors: { _lastEditedBy: 'ChroEditor' } },
  _difficultyBeatmapSets: [{ _beatmapCharacteristicName: 'Standard', _difficultyBeatmaps: [{ _difficulty: 'Expert', _difficultyRank: 7, _beatmapFilename: 'ExpertStandard.dat', _noteJumpMovementSpeed: 18, _noteJumpStartBeatOffset: 0.5, _beatmapColorSchemeIdx: 0, _environmentNameIdx: 0, _customData: { _difficultyLabel: 'Hi', _requirements: ['Chroma'] } }] }],
};
const made = roundTrip('made up', { 'Info.dat': JSON.stringify(syntheticInfo), 'ExpertStandard.dat': JSON.stringify(synthetic) });
const lightshow = JSON.parse(made.v4.files['ExpertStandard.lightshow.dat']!) as { basicEventsData: unknown[]; basicEvents: unknown[] };
check(lightshow.basicEventsData.length === 2 && lightshow.basicEvents.length === 3, 'kept once', lightshow.basicEventsData);
const info4 = JSON.parse(made.v4.files['Info.dat']!) as { difficultyBeatmaps: { customData?: Record<string, unknown> }[]; environmentNames: string[] };
check(JSON.stringify(info4.difficultyBeatmaps[0]!.customData) === '{"difficultyLabel":"Hi","requirements":["Chroma"]}' && info4.environmentNames[0] === 'BigMirrorEnvironment', 'info custom data', info4);
check(made.v3.dropped.includes('BPMInfo.dat') && made.v3.dropped.includes('ExpertStandard.lightshow.dat'), 'dropped', made.v3.dropped);

// ----- real maps
for (const folder of process.argv.slice(2)) {
  const texts: Record<string, string> = {};
  for (const name of readdirSync(folder)) if (/\.(dat|json)$/iu.test(name)) texts[name] = readFileSync(join(folder, name), 'utf8');
  const infoName = Object.keys(texts).find((name) => name.toLowerCase() === 'info.dat')!;
  const result = roundTrip(folder.split('/').pop()!, texts, infoName);
  if (result.v4.warnings.length + result.v3.warnings.length > 0) console.log(folder, [...result.v4.warnings, ...result.v3.warnings]);
}

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
