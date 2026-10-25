import { parseInfo } from '../engine/core/beatmap/info';
import { parseDifficulty } from '../engine/core/beatmap/parse';
import { parseMapPackage, type ParsedMapPackage } from '../engine/mapfile/parse-map-package';
import type { DifficultyRow } from '../engine/mapfile/viewer-types';
import type { OutEvent } from './bake';
import type { Project } from './model';
import type { MapFolder } from './platform';

/**
 * A map folder in and out: Info.dat and its difficulties read with ChroPaper's parsers; a
 * difficulty written back in its own format (v2 or v3) with its events replaced by the editor's —
 * notes, walls and everything else in the file stay exactly as they were. The editor's own work
 * (clips, layers, groups) goes next to it in "<difficulty>.chroeditor.json".
 */

export interface LoadedMap {
  folder: MapFolder;
  parsed: ParsedMapPackage;
}

export async function loadMap(folder: MapFolder): Promise<LoadedMap> {
  const files = folder.files.map((name) => ({
    name,
    text: () => folder.readText(name),
    arrayBuffer: () => folder.readBinary(name),
  }));
  const parsed = await parseMapPackage(
    files,
    {
      parseInfo: (text) => Promise.resolve(parseInfo(text)),
      parseDifficulty: (text, songBpm, extras) => Promise.resolve(parseDifficulty(text, songBpm, extras)),
    },
    null,
  );
  return { folder, parsed };
}

export function difficultyFile(row: DifficultyRow): string {
  return row.infoDifficulty?.beatmapFilename ?? row.key.split('/').at(-1) ?? '';
}

export function projectFileName(difficulty: string) {
  return `${difficulty.replace(/\.(dat|json)$/iu, '')}.chroeditor.json`;
}

export async function loadProject(folder: MapFolder, difficulty: string): Promise<Project | null> {
  const name = projectFileName(difficulty);
  if (!folder.files.includes(name)) return null;
  try {
    const project = JSON.parse(await folder.readText(name)) as Project;
    return project.format === 'chroeditor' ? project : null;
  } catch {
    return null;
  }
}

/** The format of a difficulty file's text: '2', '3' or '4'. */
export function difficultyVersion(text: string): '2' | '3' | '4' {
  const match = /"_?version"\s*:\s*"(\d)/u.exec(text);
  return match?.[1] === '3' ? '3' : match?.[1] === '4' ? '4' : '2';
}

/** Chroma's event keys: "_rotation" in v2 files, "rotation" in v3 ones. */
const CHROMA_KEYS = new Set(['rotation', 'step', 'prop', 'speed', 'direction', 'nameFilter', 'counterSpin', 'reset', 'stepMult', 'propMult', 'speedMult', 'lockRotation', 'preciseSpeed', 'lightID', 'color', 'lerpType', 'easing']);

function chromaKeys(data: Record<string, unknown>, v2: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const bare = key.startsWith('_') ? key.slice(1) : key;
    out[CHROMA_KEYS.has(bare) ? (v2 ? `_${bare}` : bare) : key] = value;
  }
  return out;
}

function v2Event(event: OutEvent) {
  const node: Record<string, unknown> = { _time: event.beat, _type: event.type, _value: event.value, _floatValue: event.floatValue };
  const custom: Record<string, unknown> = chromaKeys(event.customData ?? {}, true);
  if (event.color !== undefined) custom._color = event.color;
  if (event.lightIds !== undefined) custom._lightID = event.lightIds.length === 1 ? event.lightIds[0] : event.lightIds;
  if (event.hsv === true) custom._lerpType = 'HSV';
  if (Object.keys(custom).length > 0) node._customData = custom;
  return node;
}

function v3Event(event: OutEvent) {
  const node: Record<string, unknown> = { b: event.beat, et: event.type, i: event.value, f: event.floatValue };
  const custom: Record<string, unknown> = chromaKeys(event.customData ?? {}, false);
  if (event.color !== undefined) custom.color = event.color;
  if (event.lightIds !== undefined) custom.lightID = event.lightIds.length === 1 ? event.lightIds[0] : event.lightIds;
  if (event.hsv === true) custom.lerpType = 'HSV';
  if (Object.keys(custom).length > 0) node.customData = custom;
  return node;
}

/** The difficulty's text with its events replaced (v2: `_events`; v3: `basicBeatmapEvents` and the
 *  boost events). v4 isn't written yet. */
export function writeDifficulty(original: string, events: readonly OutEvent[]): string {
  const version = difficultyVersion(original);
  const root = JSON.parse(original) as Record<string, unknown>;
  const sorted = [...events].sort((a, b) => a.beat - b.beat);
  if (version === '2') {
    root._events = sorted.map(v2Event);
  } else if (version === '3') {
    root.basicBeatmapEvents = sorted.filter((event) => event.type !== 5).map(v3Event);
    root.colorBoostBeatmapEvents = sorted.filter((event) => event.type === 5).map((event) => ({ b: event.beat, o: event.value === 1 }));
  } else {
    throw new Error('v4 maps can be opened, but saving them is not supported yet');
  }
  return JSON.stringify(root);
}

/** Info.dat with Chroma suggested for the difficulty (its lights use colours and light IDs). */
export function suggestChroma(infoText: string, difficulty: string): string {
  const info = JSON.parse(infoText) as Record<string, unknown>;
  const sets = (info._difficultyBeatmapSets ?? []) as { _difficultyBeatmaps?: Record<string, unknown>[] }[];
  for (const set of sets) {
    for (const entry of set._difficultyBeatmaps ?? []) {
      if (entry._beatmapFilename !== difficulty) continue;
      const custom = (entry._customData ?? {}) as Record<string, unknown>;
      const requirements = Array.isArray(custom._requirements) ? (custom._requirements as string[]) : [];
      const suggestions = Array.isArray(custom._suggestions) ? (custom._suggestions as string[]) : [];
      if (!requirements.includes('Chroma') && !suggestions.includes('Chroma')) custom._suggestions = [...suggestions, 'Chroma'];
      entry._customData = custom;
    }
  }
  // (v4 Info.dat: the difficulty's customData too)
  const beatmaps = (info.difficultyBeatmaps ?? []) as Record<string, unknown>[];
  for (const entry of beatmaps) {
    if (entry.beatmapDataFilename !== difficulty) continue;
    const custom = (entry.customData ?? {}) as Record<string, unknown>;
    const suggestions = Array.isArray(custom.suggestions) ? (custom.suggestions as string[]) : [];
    if (!suggestions.includes('Chroma')) custom.suggestions = [...suggestions, 'Chroma'];
    entry.customData = custom;
  }
  return JSON.stringify(info, null, 2);
}

/**
 * Moves or stretches every time in a difficulty file (notes, walls, arcs, chains, events, light
 * groups, bookmarks…): `beat` maps a time to its new one, `length` a duration. What comes out before
 * the song's start is dropped (its count returned). v2 and v3 files; v4 isn't supported yet.
 */
export function transformDifficultyBeats(text: string, beat: (b: number) => number, length: (d: number) => number): { text: string; dropped: number } {
  const version = difficultyVersion(text);
  if (version === '4') throw new Error('Формат v4 пока не поддерживается');
  const data = JSON.parse(text) as Record<string, unknown>;
  let dropped = 0;
  const each = (holder: Record<string, unknown> | undefined, key: string, time: string, extra: { times?: string[]; lengths?: string[] } = {}) => {
    const list = holder?.[key];
    if (!Array.isArray(list)) return;
    holder![key] = list.filter((item: Record<string, unknown>) => {
      if (typeof item[time] !== 'number' && item[time] !== undefined) return true;
      const moved = beat((item[time] as number | undefined) ?? 0);
      if (moved < -1e-6) {
        dropped++;
        return false;
      }
      item[time] = Math.round(moved * 1e6) / 1e6;
      for (const other of extra.times ?? []) if (typeof item[other] === 'number') item[other] = Math.round(beat(item[other] as number) * 1e6) / 1e6;
      for (const span of extra.lengths ?? []) if (typeof item[span] === 'number') item[span] = Math.round(length(item[span] as number) * 1e6) / 1e6;
      return true;
    });
  };
  if (version === '3') {
    for (const key of ['colorNotes', 'bombNotes', 'basicBeatmapEvents', 'colorBoostBeatmapEvents', 'rotationEvents', 'waypoints', 'lightColorEventBoxGroups', 'lightRotationEventBoxGroups', 'lightTranslationEventBoxGroups', 'vfxEventBoxGroups']) each(data, key, 'b');
    each(data, 'bpmEvents', 'b');
    each(data, 'obstacles', 'b', { lengths: ['d'] });
    each(data, 'sliders', 'b', { times: ['tb'] });
    each(data, 'burstSliders', 'b', { times: ['tb'] });
    const custom = data.customData as Record<string, unknown> | undefined;
    for (const key of ['bookmarks', 'customEvents', 'fakeColorNotes', 'fakeBombNotes', 'fakeObstacles', 'fakeBurstSliders']) each(custom, key, 'b', key === 'fakeObstacles' ? { lengths: ['d'] } : key === 'fakeBurstSliders' ? { times: ['tb'] } : {});
  } else {
    for (const key of ['_notes', '_events', '_waypoints']) each(data, key, '_time');
    each(data, '_obstacles', '_time', { lengths: ['_duration'] });
    each(data, '_sliders', '_headTime', { times: ['_tailTime'] });
    const custom = data._customData as Record<string, unknown> | undefined;
    for (const key of ['_bookmarks', '_customEvents', '_BPMChanges', '_bpmChanges']) each(custom, key, '_time');
  }
  return { text: JSON.stringify(data), dropped };
}

/** The same for the editor's own file of a difficulty (clips, events, effects). */
export function transformProjectBeats(project: Project, beat: (b: number) => number, length: (d: number) => number): Project {
  const copy = structuredClone(project);
  copy.clips = copy.clips
    .map((clip) => ({ ...clip, start: beat(clip.start), end: beat(clip.end), fadeIn: length(clip.fadeIn) }))
    .filter((clip) => clip.end > 0)
    .map((clip) => ({ ...clip, start: Math.max(0, clip.start) }));
  copy.raw = copy.raw.map((event) => ({ ...event, beat: beat(event.beat) })).filter((event) => event.beat >= -1e-6);
  copy.effects = (copy.effects ?? [])
    .map((effect) => {
      const params = { ...effect.params, pulse: length(effect.params.pulse), rate: length(effect.params.rate), fadeIn: length(effect.params.fadeIn) };
      const gls = effect.gls === undefined ? undefined : { boxes: effect.gls.boxes.map((box) => ({ ...box, beatValue: length(box.beatValue), events: box.events.map((event) => ({ ...event, beat: length(event.beat) })), rotations: box.rotations.map((event) => ({ ...event, beat: length(event.beat) })) })) };
      return { ...effect, start: beat(effect.start), end: beat(effect.end), params, ...(gls === undefined ? {} : { gls }) };
    })
    .filter((effect) => effect.end > 0);
  return copy;
}
