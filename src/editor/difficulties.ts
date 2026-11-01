import type { Editor } from './editor';
import { difficultyFile, difficultyVersion, loadProject, projectFileName } from './map-io';
import { emptyDifficulty } from './new-map';
import { DIFFICULTY_NAMES } from './jump';

/**
 * A map's difficulties in Info.dat: a difficulty's NJS, offset and label changed; a new difficulty made
 * (empty, or with the open one's notes, or its notes and lights) and put into Info.dat.
 */

type Json = Record<string, unknown>;

export interface DifficultyPatch {
  njs?: number;
  offset?: number;
  label?: string;
}

/** Info.dat with a difficulty's NJS, offset and label set (v2 and v4 Info). */
export function setDifficultyInfo(infoText: string, file: string, patch: DifficultyPatch): string {
  const info = JSON.parse(infoText) as Json;
  for (const set of (info._difficultyBeatmapSets ?? []) as { _difficultyBeatmaps?: Json[] }[]) {
    for (const entry of set._difficultyBeatmaps ?? []) {
      if (entry._beatmapFilename !== file) continue;
      if (patch.njs !== undefined) entry._noteJumpMovementSpeed = patch.njs;
      if (patch.offset !== undefined) entry._noteJumpStartBeatOffset = patch.offset;
      if (patch.label !== undefined) {
        const custom = (entry._customData ?? {}) as Json;
        if (patch.label === '') delete custom._difficultyLabel;
        else custom._difficultyLabel = patch.label;
        entry._customData = custom;
      }
    }
  }
  for (const entry of (info.difficultyBeatmaps ?? []) as Json[]) {
    if (entry.beatmapDataFilename !== file) continue;
    if (patch.njs !== undefined) entry.noteJumpMovementSpeed = patch.njs;
    if (patch.offset !== undefined) entry.noteJumpStartBeatOffset = patch.offset;
    if (patch.label !== undefined) {
      const custom = (entry.customData ?? {}) as Json;
      if (patch.label === '') delete custom.difficultyLabel;
      else custom.difficultyLabel = patch.label;
      entry.customData = custom;
    }
  }
  return JSON.stringify(info, null, 2);
}

export interface NewDifficulty {
  /** Easy … ExpertPlus. */
  difficulty: string;
  /** Standard or OneSaber. */
  characteristic: string;
  label: string;
  njs: number;
  offset: number;
  /** What it starts with: nothing, the open difficulty's notes, or its notes and lights. */
  from: 'empty' | 'notes' | 'all';
}

/** The difficulties a characteristic has already (their names). */
export function takenDifficulties(infoText: string, characteristic: string): string[] {
  const info = JSON.parse(infoText) as Json;
  const out: string[] = [];
  for (const set of (info._difficultyBeatmapSets ?? []) as { _beatmapCharacteristicName?: string; _difficultyBeatmaps?: Json[] }[]) {
    if (set._beatmapCharacteristicName !== characteristic) continue;
    for (const entry of set._difficultyBeatmaps ?? []) out.push(String(entry._difficulty));
  }
  for (const entry of (info.difficultyBeatmaps ?? []) as Json[]) if (entry.characteristic === characteristic) out.push(String(entry.difficulty));
  return out;
}

/** Makes the difficulty: its file (and the editor's file, its lights copied), its entry in Info.dat.
 *  Returns its file's name. */
export async function addDifficulty(editor: Editor, spec: NewDifficulty): Promise<string> {
  const map = editor.map;
  if (map === null) throw new Error('Карта не открыта');
  const infoName = map.folder.files.find((name) => name.toLowerCase() === 'info.dat');
  if (infoName === undefined) throw new Error('В карте нет Info.dat');
  let infoText = await map.folder.readText(infoName);
  const info = JSON.parse(infoText) as Json;
  if (Array.isArray(info.difficultyBeatmaps)) throw new Error('В картах формата v4 сложности здесь пока не создаются — сделайте копию карты в v3');
  if (takenDifficulties(infoText, spec.characteristic).includes(spec.difficulty)) throw new Error('Такая сложность уже есть');
  // its file
  let file = `${spec.difficulty}${spec.characteristic}.dat`;
  for (let n = 2; map.folder.files.includes(file); n++) file = `${spec.difficulty}${spec.characteristic}${String(n)}.dat`;
  const row = editor.row;
  const source = row === null ? null : difficultyFile(row);
  let text: string;
  if (spec.from === 'empty' || source === null) {
    text = emptyDifficulty(source === null ? '3' : difficultyVersion(await map.folder.readText(source)) === '2' ? '2' : '3');
  } else {
    const root = JSON.parse(await map.folder.readText(source)) as Json;
    if (spec.from === 'notes') {
      // (the notes and walls; no lights)
      for (const key of ['_events', 'basicBeatmapEvents', 'colorBoostBeatmapEvents', 'lightColorEventBoxGroups', 'lightRotationEventBoxGroups', 'lightTranslationEventBoxGroups', 'vfxEventBoxGroups']) if (Array.isArray(root[key])) root[key] = [];
      for (const customKey of ['_customData', 'customData']) {
        const custom = root[customKey] as Json | undefined;
        if (custom === undefined) continue;
        for (const key of ['_environment', 'environment', '_customEvents', 'customEvents']) delete custom[key];
      }
    }
    text = JSON.stringify(root);
  }
  await map.folder.writeText(file, text);
  if (spec.from === 'all' && source !== null) {
    const project = await loadProject(map.folder, source);
    if (project !== null) await map.folder.writeText(projectFileName(file), JSON.stringify({ ...project, difficulty: file }));
  }
  // its entry in Info.dat: in its characteristic's set (made if there's none), in order of difficulty
  const sets = ((info._difficultyBeatmapSets ?? []) as { _beatmapCharacteristicName?: string; _difficultyBeatmaps?: Json[] }[]);
  let set = sets.find((item) => item._beatmapCharacteristicName === spec.characteristic);
  if (set === undefined) {
    set = { _beatmapCharacteristicName: spec.characteristic, _difficultyBeatmaps: [] };
    sets.push(set);
  }
  const sourceEntry = sets.flatMap((item) => item._difficultyBeatmaps ?? []).find((entry) => entry._beatmapFilename === source);
  const rank = DIFFICULTY_NAMES.find(([id]) => id === spec.difficulty)?.[2] ?? 9;
  const custom: Json = spec.from === 'all' && sourceEntry !== undefined ? structuredClone((sourceEntry._customData ?? {}) as Json) : {};
  if (spec.label !== '') custom._difficultyLabel = spec.label;
  else delete custom._difficultyLabel;
  const entry: Json = { _difficulty: spec.difficulty, _difficultyRank: rank, _beatmapFilename: file, _noteJumpMovementSpeed: spec.njs, _noteJumpStartBeatOffset: spec.offset };
  if (Object.keys(custom).length > 0) entry._customData = custom;
  set._difficultyBeatmaps = [...(set._difficultyBeatmaps ?? []), entry].sort((a, b) => Number(a._difficultyRank ?? 0) - Number(b._difficultyRank ?? 0));
  info._difficultyBeatmapSets = sets;
  infoText = JSON.stringify(info, null, 2);
  await map.folder.writeText(infoName, infoText);
  await map.folder.refresh();
  return file;
}
