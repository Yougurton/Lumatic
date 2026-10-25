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

function v2Event(event: OutEvent) {
  const node: Record<string, unknown> = { _time: event.beat, _type: event.type, _value: event.value, _floatValue: event.floatValue };
  const custom: Record<string, unknown> = { ...(event.customData ?? {}) };
  if (event.color !== undefined) custom._color = event.color;
  if (event.lightIds !== undefined) custom._lightID = event.lightIds.length === 1 ? event.lightIds[0] : event.lightIds;
  if (event.hsv === true) custom._lerpType = 'HSV';
  if (Object.keys(custom).length > 0) node._customData = custom;
  return node;
}

function v3Event(event: OutEvent) {
  const node: Record<string, unknown> = { b: event.beat, et: event.type, i: event.value, f: event.floatValue };
  const custom: Record<string, unknown> = { ...(event.customData ?? {}) };
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
