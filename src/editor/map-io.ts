import { parseInfo } from '../engine/core/beatmap/info';
import { parseDifficulty } from '../engine/core/beatmap/parse';
import { parseMapPackage, type ParsedMapPackage } from '../engine/mapfile/parse-map-package';
import type { DifficultyRow } from '../engine/mapfile/viewer-types';
import type { OutEvent } from './bake';
import { newId, type Bookmark, type Project } from './model';
import { chromaCustomData, TRACK_PREFIX, type RingAnimation, type RingEnhancement } from './rings';
import { replaceFragment, type EnvironmentFragment } from './environment-mods';
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
/** A difficulty's bookmarks (v2 `_customData._bookmarks`, v3 `customData.bookmarks`). */
export function readBookmarks(text: string): Bookmark[] {
  try {
    const root = JSON.parse(text) as Record<string, unknown>;
    const v2 = difficultyVersion(text) === '2';
    const custom = (root[v2 ? '_customData' : 'customData'] ?? {}) as Record<string, unknown>;
    const list = custom[v2 ? '_bookmarks' : 'bookmarks'];
    if (!Array.isArray(list)) return [];
    return (list as Record<string, unknown>[]).map((item, index) => {
      const color = (item[v2 ? '_color' : 'c'] ?? null) as number[] | null;
      return {
        id: newId('m'),
        beat: Number(item[v2 ? '_time' : 'b'] ?? 0),
        name: String(item[v2 ? '_name' : 'n'] ?? `Метка ${String(index + 1)}`),
        color: Array.isArray(color) && color.length >= 3 ? [Number(color[0]), Number(color[1]), Number(color[2])] : [0.35, 0.75, 1],
      };
    });
  } catch {
    return [];
  }
}

function writeBookmarks(root: Record<string, unknown>, bookmarks: readonly Bookmark[], v2: boolean) {
  const customKey = v2 ? '_customData' : 'customData';
  const key = v2 ? '_bookmarks' : 'bookmarks';
  const custom = (typeof root[customKey] === 'object' && root[customKey] !== null ? root[customKey] : {}) as Record<string, unknown>;
  const sorted = [...bookmarks].sort((a, b) => a.beat - b.beat);
  if (sorted.length === 0) delete custom[key];
  else custom[key] = sorted.map((item) => (v2 ? { _time: item.beat, _name: item.name, _color: [...item.color, 1] } : { b: item.beat, n: item.name, c: [...item.color, 1] }));
  if (Object.keys(custom).length > 0) root[customKey] = custom;
  else delete root[customKey];
}

export function writeDifficulty(
  original: string,
  events: readonly OutEvent[],
  rings?: { enhancements: readonly RingEnhancement[]; animations: readonly RingAnimation[] },
  bookmarks?: readonly Bookmark[],
  environment?: { previous: EnvironmentFragment | undefined; next: EnvironmentFragment },
): string {
  const version = difficultyVersion(original);
  const root = JSON.parse(original) as Record<string, unknown>;
  if (environment !== undefined && version !== '4') {
    const key = version === '2' ? '_customData' : 'customData';
    const custom = replaceFragment((typeof root[key] === 'object' && root[key] !== null ? root[key] : {}) as Record<string, unknown>, environment.previous, environment.next, version === '2');
    if (Object.keys(custom).length > 0) root[key] = custom;
    else delete root[key];
  }
  if (bookmarks !== undefined && version !== '4') writeBookmarks(root, bookmarks, version === '2');
  if (rings !== undefined && version !== '4') writeRingChroma(root, rings.enhancements, rings.animations, version === '2');
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

/**
 * The ring poses on Chroma tracks into a difficulty's custom data: the rings' environment entries and
 * their AnimateTrack events in place of the ones written before (told apart by their tracks' names);
 * everything else the map has there stays as it was.
 */
function writeRingChroma(root: Record<string, unknown>, enhancements: readonly RingEnhancement[], animations: readonly RingAnimation[], v2: boolean) {
  const customKey = v2 ? '_customData' : 'customData';
  const environmentKey = v2 ? '_environment' : 'environment';
  const eventsKey = v2 ? '_customEvents' : 'customEvents';
  const custom = (typeof root[customKey] === 'object' && root[customKey] !== null ? root[customKey] : {}) as Record<string, unknown>;
  const ours = (track: unknown) => (Array.isArray(track) ? track : [track]).some((name) => typeof name === 'string' && name.startsWith(TRACK_PREFIX));
  const made = chromaCustomData(enhancements, animations, v2);
  const environment = [
    ...(Array.isArray(custom[environmentKey]) ? (custom[environmentKey] as Record<string, unknown>[]) : []).filter((entry) => !ours(entry[v2 ? '_track' : 'track'])),
    ...made[environmentKey]!,
  ];
  const time = (event: Record<string, unknown>) => Number(event[v2 ? '_time' : 'b'] ?? 0);
  const customEvents = [
    ...(Array.isArray(custom[eventsKey]) ? (custom[eventsKey] as Record<string, unknown>[]) : []).filter((event) => {
      const data = event[v2 ? '_data' : 'd'] as Record<string, unknown> | undefined;
      return !(event[v2 ? '_type' : 't'] === 'AnimateTrack' && ours(data?.[v2 ? '_track' : 'track']));
    }),
    ...(made[eventsKey] as Record<string, unknown>[]),
  ].sort((a, b) => time(a) - time(b));
  if (environment.length > 0) custom[environmentKey] = environment;
  else delete custom[environmentKey];
  if (customEvents.length > 0) custom[eventsKey] = customEvents;
  else delete custom[eventsKey];
  if (Object.keys(custom).length > 0) root[customKey] = custom;
  else delete root[customKey];
}

/**
 * Info.dat with the difficulty's required mods: `add` put in (and taken from its suggestions), `remove`
 * (the ones put in before and not needed any more) taken out.
 */
export function setRequirements(infoText: string, difficulty: string, add: readonly string[], remove: readonly string[]): string {
  const info = JSON.parse(infoText) as Record<string, unknown>;
  const update = (custom: Record<string, unknown>, requirementsKey: string, suggestionsKey: string) => {
    let requirements = Array.isArray(custom[requirementsKey]) ? (custom[requirementsKey] as string[]) : [];
    let suggestions = Array.isArray(custom[suggestionsKey]) ? (custom[suggestionsKey] as string[]) : [];
    requirements = [...requirements.filter((mod) => !remove.includes(mod) || add.includes(mod)), ...add.filter((mod) => !requirements.includes(mod))];
    suggestions = suggestions.filter((mod) => !add.includes(mod));
    if (requirements.length > 0) custom[requirementsKey] = requirements;
    else delete custom[requirementsKey];
    if (suggestions.length > 0 || custom[suggestionsKey] !== undefined) custom[suggestionsKey] = suggestions;
  };
  const sets = (info._difficultyBeatmapSets ?? []) as { _difficultyBeatmaps?: Record<string, unknown>[] }[];
  for (const set of sets) {
    for (const entry of set._difficultyBeatmaps ?? []) {
      if (entry._beatmapFilename !== difficulty) continue;
      const custom = (entry._customData ?? {}) as Record<string, unknown>;
      update(custom, '_requirements', '_suggestions');
      entry._customData = custom;
    }
  }
  for (const entry of (info.difficultyBeatmaps ?? []) as Record<string, unknown>[]) {
    if (entry.beatmapDataFilename !== difficulty) continue;
    const custom = (entry.customData ?? {}) as Record<string, unknown>;
    update(custom, 'requirements', 'suggestions');
    entry.customData = custom;
  }
  return JSON.stringify(info, null, 2);
}

/** The mods Info.dat says the difficulty requires. */
export function requirementsOf(infoText: string, difficulty: string): string[] {
  const info = JSON.parse(infoText) as Record<string, unknown>;
  for (const set of (info._difficultyBeatmapSets ?? []) as { _difficultyBeatmaps?: Record<string, unknown>[] }[]) {
    for (const entry of set._difficultyBeatmaps ?? []) {
      if (entry._beatmapFilename === difficulty) return ((entry._customData as Record<string, unknown> | undefined)?._requirements as string[] | undefined) ?? [];
    }
  }
  for (const entry of (info.difficultyBeatmaps ?? []) as Record<string, unknown>[]) {
    if (entry.beatmapDataFilename === difficulty) return ((entry.customData as Record<string, unknown> | undefined)?.requirements as string[] | undefined) ?? [];
  }
  return [];
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
  copy.bookmarks = (copy.bookmarks ?? []).map((item) => ({ ...item, beat: beat(item.beat) })).filter((item) => item.beat >= -1e-6);
  copy.ringBlocks = (copy.ringBlocks ?? [])
    .map((block) => ({ ...block, start: beat(block.start), end: beat(block.end), poses: block.poses.map((pose) => ({ ...pose, beat: length(pose.beat), duration: length(pose.duration), delay: length(pose.delay) })) }))
    .filter((block) => block.end > 0);
  return copy;
}
