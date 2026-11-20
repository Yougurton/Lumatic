import type { InfoColorScheme } from '../engine/core/beatmap/info';
import type { BpmEvent, Difficulty } from '../engine/core/beatmap/types';
import type { ChromaEnvironmentData } from '../engine/core/chroma-environment';
import type { Rgb } from '../engine/core/colors';
import type { NoodleBeatmapData } from '../engine/core/noodle-data';
import type { OutEvent } from './bake';
import type { Editor } from './editor';
import type { EnvironmentMods } from './environment-mods';
import type { MapObjects, MapWall } from './notes';
import type { Project } from './model';
import type { Settings } from './settings';
import type { DifficultyRow } from '../engine/mapfile/viewer-types';

export interface RemoteEditorSnapshot {
  project: Pick<Project, 'environmentMods'> | null;
  objects: MapObjects;
  fakeWalls: MapWall[];
  infoDifficulty: DifficultyRow['infoDifficulty'] | null;
  songBpm: number;
  bpmEvents: BpmEvent[];
  tab: Editor['tab'];
  noteView: Editor['noteView'];
  noteVersion: number;
  noteSelection: string[];
  noteTool: Editor['noteTool'];
  noteRow: number;
  wallKind: Editor['wallKind'];
  wallStrobe: Editor['wallStrobe'];
  precision: boolean;
  snap: number;
  viewSnap: number | null;
  envMode: boolean;
  envSelection: string[];
  envSceneData: Editor['envSceneData'];
  version: number;
  animAuto: boolean;
  animSelection: string[];
  linkPicking: Editor['linkPicking'];
}

export interface RemoteEditorPatch {
  objects?: MapObjects;
  noteSelection?: string[];
  envSelection?: string[];
  animSelection?: string[];
  environmentMods?: EnvironmentMods;
  values?: Partial<Pick<Editor, 'noteTool' | 'noteRow' | 'noteView' | 'wallKind' | 'wallStrobe' | 'precision' | 'animAuto' | 'linkPicking'>>;
  seek?: number;
  snapStep?: boolean;
  status?: string;
  options?: Partial<Settings>;
}

export interface PreviewHighlight {
  lights: readonly { type: number; id: number }[];
  color?: Rgb;
  strength?: number;
}

export interface PreviewSnapshot {
  revision: number;
  environmentVersion: number;
  songBpm: number;
  bpmEvents: BpmEvent[];
  colorScheme: InfoColorScheme | undefined;
  environment: { id: string; chromaEnvironment?: ChromaEnvironmentData } | null;
  noodle: NoodleBeatmapData | null;
  objects: Pick<Difficulty, 'notes' | 'obstacles' | 'arcs' | 'chains'> | null;
  jump: { speed: number; offset: number };
  boxGroups: Pick<Difficulty, 'lightColorEventBoxGroups' | 'lightRotationEventBoxGroups' | 'lightTranslationEventBoxGroups' | 'fxEventBoxGroups'> | null;
  events: readonly OutEvent[];
  notesMode: 'auto' | 'show' | 'hide';
  options: { platform: boolean; distortion: boolean; notes: boolean; ringTicks: number; trackScale: number; trackBehind: number; visionLine: boolean; fps: boolean; previewLights: boolean };
  horizontalFov: number | null;
  freeCamera: { position: [number, number, number]; yaw: number; pitch: number } | null;
  editor?: { revision: string; state: RemoteEditorSnapshot };
}

export interface PreviewTick {
  beat: number;
  playing: boolean;
  /** Map beats per second, for smooth local playback between IPC updates. */
  beatRate: number;
  spectrum: number[] | null;
  highlight: PreviewHighlight | null;
}
