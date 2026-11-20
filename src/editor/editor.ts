import { SongSpectrum } from '../engine/core/lighting/spectrogram';
import { bootstrapBpmEvents, createBpmConverter } from '../engine/core/beatmap/bpm';
import { ringTickSeconds } from '../engine/core/lighting/ring-motion';
import { generatePatterns } from './note-generator';
import type { BeatmapCustomData, BpmEvent } from '../engine/core/beatmap/types';
import { parseNoodleBeatmap, type NoodleBeatmapData } from '../engine/core/noodle-data';
import { EMPTY_CHROMA_ENVIRONMENT, parseV2ChromaEnvironment, parseV3ChromaEnvironment, type ChromaEnvironmentData } from '../engine/core/chroma-environment';
import { createAudioClock, createSilentClock, type SongClock } from '../engine/core/clock/song-clock';
import type { DifficultyRow } from '../engine/mapfile/viewer-types';
import { bakeLights, rawEvents, type OutEvent, type SchemeColors } from './bake';
import { importEvents } from './import';
import { difficultyFile, difficultyVersion, loadMap, loadProject, projectFileName, readBookmarks, readBpmChanges, requirementsOf, setRequirements, suggestChroma, writeDifficulty, type LoadedMap } from './map-io';
import { EMPTY_FRAGMENT, fragmentRequirements, geometrySystems, hasMods, isEmptyFragment, loadPreset, modsFragment, ringSystemParts, type EnvironmentFragment, type EnvironmentMods } from './environment-mods';
import { setInfoEnvironment } from './map-settings';
import { loadEnvironmentData } from '../engine/renderer/environment/environment-worker-client';
import type { EnvironmentData } from '../engine/renderer/environment/types';
import {
  clipLights,
  clipPriority,
  cloneClip,
  findGroup,
  groupLights,
  isLightType,
  lightKey,
  newId,
  parentOf,
  type Bookmark,
  type ClipColor,
  type Rgb,
  type EndMode,
  type GroupItem,
  type LightClip,
  type LightGroup,
  type LightRef,
  type Project,
  type RawEvent,
  type StartMode,
} from './model';
import { clipRank, resolveRgb } from './bake';
import { buildEffect, childrenSignature, defaultParams, effectItems, effectNeededLength, KIND_NAMES, type Effect, type EffectExtras, type EffectKind, type EffectParams } from './effects';
import { defaultGls } from './gls';
import { adjustClips, type Adjustment } from './adjust';
import { laserEvents } from './lasers';
import { writeMapColors, type MapColors } from './map-colors';
import type { BoxGroupBlock } from './box-groups';
import { colorSchemeForDifficulty, parseInfo, type InfoColorScheme } from '../engine/core/beatmap/info';
import { findBandFlux } from './audio-tools';
import { BANDS } from './onsets';
import { lightGroupName, otherEventName, setEnvironmentTracks } from './names';
import type { MapFolder } from './platform';
import { choose } from './menu';
import { tr, translate } from './i18n';
import { expandObjects, isLightShader, sceneCommand, type FogValues, type SceneLink, type TubeValues, SHADERS, SHAPES, type SceneEdit, type SceneMaterial, type SceneObject } from './environment-mods';
import { arrayCount, type SceneArray } from './env-array';
import { ALL_PARTS, animValue, defaultMotion, hasKeys, isPeriodic, linkDelta, motionParts, movedValue, partsOf, type AnimKey, type AnimPart, type MotionKind, type SceneAnim, type SceneMotion } from './env-anim';
import { localOf, sceneTree, worldMatrix } from './env-scene';
import type { Matrix4 } from 'three';
import type { LightInfo, Preview } from './preview';
import { computeSpectrogram, type Spectrogram } from './spectrogram';
import { readPreview, writePreview } from './map-settings';
import { settings } from './settings';
import { checkMap, type MapIssue } from './checks';
import { jumpOf } from './jump';
import { allObjects, chainFromNote, directionOf, objectSpan, usesNoodlePlaces, noteRolls, readFakeWalls, strobeWalls, type MapWall, emptyObjects, engineObjects, readObjects, unsupported, type MapObjects, type ObjectKind, type WallKind } from './notes';
import { effectiveNoteJumpSpeed } from '../engine/core/beatmap/info';
import { createRingRotationSampler, deterministicRingRandom } from '../engine/core/lighting/ring-motion';
import type { BasicEvent } from '../engine/core/beatmap/types';
import { chromaCustomData, chromaMoveBeats, newPose, newRingBlock, newZoomBlock, cloneRingBlock, EVENT_SHAPES, fitRingBlock, isLasers, isTurn, laserBlockMove, TRACK_PREFIX, poseRingEvents, poseZoomEvents, type ZoomSystemInfo, ringAnimations, ringEnhancements, type RingAnimation, type RingBlock, type RingEnhancement, type RingSystemInfo } from './rings';

/**
 * The editor's state and everything that changes it: the open map and difficulty, the project
 * (clips, raw events), the selection, undo/redo, the song's clock, the rows of the timeline. Views
 * (timeline, inspector, mini map, preview) read it and are told to redraw through `onChange`.
 */

export type Row =
  /** A light group of the environment (an event type). */
  | { kind: 'group'; key: string; type: number; label: string; expanded: boolean; lights: number[]; depth: number }
  /** One light; `parent`: the user's group it is shown in (null: under its event type). */
  | { kind: 'light'; key: string; type: number; id: number; label: string; depth: number; parent: string | null }
  /** One of the user's groups (or subgroups). */
  | { kind: 'custom'; key: string; group: LightGroup; label: string; expanded: boolean; depth: number; parent: string | null }
  | { kind: 'raw'; key: string; type: number; label: string; depth: number }
  /** The ring poses (blocks of them). */
  | { kind: 'poses'; key: string; label: string; depth: number; ring: 'rotation' | 'zoom' | 'lasers' }
  /** A light group of the game's own Group Lighting System (GLS) with the map's colour blocks on it
   *  (`element`: one of its elements, on a row opened up from the group's; null: the group's own;
   *  `category`: a header holding several groups of one part of the environment, no blocks of its
   *  own). Made by the timeline, which shows them — not in `rows`. */
  | { kind: 'box'; key: string; group: number; label: string; count: number; missing: boolean; blocks: BoxGroupBlock[]; expanded: boolean; element: number | null; depth: number; category?: boolean };

/** A row of lights (a light group, a light, a group of the user's) — clips and effects go there. */
export type LightRow = Extract<Row, { kind: 'group' | 'light' | 'custom' }>;
export const isLightRow = (row: Row): row is LightRow => row.kind === 'group' || row.kind === 'light' || row.kind === 'custom';

/** The event type ring events turn the rings with. */
export const RING_EVENT_TYPE = 8;
/** …and zooms them with. */
export const ZOOM_EVENT_TYPE = 9;

/** A clip as a row shows it: `partial` — it lights only some of the row's lights; `level` — how
 *  far up it sits among the clips of the row (drawn lower the higher it is). */
export interface ShownClip {
  /** For an effect: a stand-in clip (its id, place and colours). */
  clip: LightClip;
  effect?: Effect;
  partial: boolean;
  level: number;
  /** 'own': drawn on this row; 'inner': drawn on a group or light inside it (above it, shown
   *  lower); 'background': drawn on something around it (under it — shown dim, not clickable: the
   *  row stays free to draw on). */
  role: 'own' | 'inner' | 'background';
}

/** What `sortGroup` orders a group's items by. */
export type SortKey = 'id' | 'x' | 'y' | 'z' | 'angle' | 'reverse';

export interface Brush {
  color: ClipColor;
  endColor: ClipColor | null;
  startMode: StartMode;
  fadeIn: number;
  endMode: EndMode;
  /** endMode fade: the beats the fade out takes (none: all of the clip). */
  fadeOut?: number;
  layer: number;
  hsv: boolean;
}

type Listener = (what: 'all' | 'clips' | 'selection' | 'time' | 'rows' | 'lights' | 'grid') => void;

/** See `Editor.glsInspect`. */
export interface GlsInspect {
  block?: {
    source: { startMode: StartMode; fadeIn: number; endMode: EndMode; fadeOut?: number; color: ClipColor; endColor: ClipColor | null; hsv?: boolean; start: number; end: number; strobe: number; strobeDuty?: number; strobeWith?: 'dark' | 'color' | 'dim'; strobeColor?: ClipColor; strobeDim?: number };
    apply: (change: (target: { startMode: StartMode; fadeIn: number; endMode: EndMode; fadeOut?: number; color: ClipColor; endColor: ClipColor | null; hsv?: boolean; start: number; end: number; strobe: number; strobeDuty?: number; strobeWith?: 'dark' | 'color' | 'dim'; strobeColor?: ClipColor; strobeDim?: number; layer?: number }) => void) => void;
    remove: () => void;
  };
  /** Set while the picked block is the map's own (a GLS block picked on the timeline): the panel is
   *  the timeline's to take back, not the GLS editor's. */
  box?: boolean;
  render?: (root: HTMLElement) => void;
}

/** A scene kept in the gallery: its parts and the environment it was made for. */
export interface SceneSnapshot {
  environment: string;
  scene?: SceneEdit[];
  objects?: SceneObject[];
  materials?: Record<string, SceneMaterial>;
  anims?: SceneAnim[];
  links?: SceneLink[];
  fog?: FogValues;
  player?: { risky?: boolean };
  motions?: SceneMotion[];
}

/** The scene's parts besides its edits, objects, materials and animations (for undo). */
function sceneExtras(mods: EnvironmentMods | undefined) {
  return { links: mods?.links, fog: mods?.fog, player: mods?.player, motions: mods?.motions };
}

/** An object's place, turn and size. */
const MOVES = ['position', 'rotation', 'scale'] as const;

export class Editor {
  map: LoadedMap | null = null;
  row: DifficultyRow | null = null;
  project: Project | null = null;
  lightsByType = new Map<number, number[]>();
  lightInfo: LightInfo[] = [];
  rows: Row[] = [];
  selection = new Set<string>();
  /** The light row picked last (its lamp shown in the mini map). */
  pickedLight: { type: number; id: number } | null = null;
  /** Lights picked for grouping (rows of the timeline, lamps of the mini map), "type:id" keys, in
   *  the order they were picked. */
  lightSelection = new Set<string>();
  /** The user's group the lights were picked in (on its light rows), if any. */
  lightSelectionContext: string | null = null;
  /** The group the timeline has gone into (null: the whole show). */
  focus: string | null = null;
  /** A row the timeline should scroll to (set by the mini map). */
  reveal: string | null = null;
  /** Grows with every change (the rows' clip lists are kept until it does). */
  version = 0;
  /** The effect gone into: its events shown and editable (null: none). */
  openEffect: string | null = null;
  /** What drawing on a row makes: a clip (the brush), or an effect from the library. */
  /** What a drag on the timeline makes: plain light, an effect — or a ring tool's block (put in its own
   *  rows: `types`; `open`: its editor opened once it's put). */
  tool:
    | { kind: 'clip' }
    | { kind: 'effect'; name: string; effect: EffectKind; params: Partial<EffectParams> }
    | { kind: 'ring'; name: string; types: number[]; template: RingBlock; open?: boolean } = { kind: 'clip' };
  /** The row effects and ring forms from the library go onto (its key). */
  activeRow: string | null = null;
  /** Something tried out in the 3D view only (not in the show): played over and over. */
  previewExtra: { clips: LightClip[]; raw: RawEvent[]; start: number; end: number; songLoop?: boolean } | null = null;
  private rowCache = new Map<string, { version: number; clips: ShownClip[] }>();
  snap = 0.25;
  brush: Brush = {
    color: { ref: 'right', brightness: 1 },
    endColor: null,
    startMode: 'on',
    fadeIn: 0.5,
    endMode: 'off',
    layer: 1,
    hsv: false,
  };
  songBpm = 120;
  bpmEvents: BpmEvent[] = [];
  duration = 60;
  clock: SongClock | null = null;
  spectrogram: Spectrogram | null = null;
  /** The song decoded (null: none, or not yet). */
  private songBuffer: AudioBuffer | null = null;
  /** Where the song's bands grow (`low-high` → its flux): worked out when first asked for. */
  private fluxes = new Map<string, Promise<{ flux: Float32Array; fps: number; offset: number }>>();
  /** The environment's turning ring systems (as it came, before the editor's ring tracks). */
  ringInfo: RingSystemInfo[] = [];
  /** …and the ones that zoom. */
  zoomInfo: ZoomSystemInfo[] = [];
  /** The difficulty's own Chroma environment (what the map had). */
  private mapChroma: ChromaEnvironmentData | undefined;
  /** What the 3D view's environment was last loaded with for the ring tracks, and the animations
   *  it plays. */
  private ringEnhancementKey = '';
  private ringAnimationKey = '';
  private previewChroma: ChromaEnvironmentData | undefined;
  /** A stretch of the song picked on the timeline (map beats; start may come after end while it is
   *  dragged), null: none. */
  songRange: { start: number; end: number } | null = null;
  /** The song list's preview as Info.dat has it (seconds of the song). */
  songPreview: { start: number; duration: number } | null = null;
  /** Opens a ring pose block's editor (set by the app). */
  ringEditorHook: ((id: string) => void) | null = null;
  status = '';
  private dirtyValue = false;
  onDirty: (() => void) | null = null;
  get dirty() {
    return this.dirtyValue;
  }
  set dirty(value: boolean) {
    if (value && !this.dirtyValue) this.onDirty?.();
    this.dirtyValue = value;
  }

  // ----- the notes side ---------------------------------------------------------------------------

  /** Which side of the editor is open: the lights or the notes. */
  tab: 'lights' | 'notes' = 'lights';
  /** The difficulty's notes, bombs, walls, arcs and chains (written back on saving). */
  objects: MapObjects = emptyObjects();
  /** The open difficulty's format ('2', '3', '4'). */
  fileVersion: '2' | '3' | '4' = '3';
  /** The notes side's selected objects (their ids). */
  noteSelection = new Set<string>();
  /** Grows with every change to the objects. */
  noteVersion = 0;
  /** What the notes side places: a red or blue note, a bomb, a wall; the arrows' direction. */
  /** What a click on the notes' wall puts in (`angle`: a dot note's turn, degrees — F again turns it). */
  noteTool: { kind: 'red' | 'blue' | 'bomb' | 'wall'; direction: number; angle?: number } = { kind: 'red', direction: 1 };
  /** How the notes side's 3D view shows the notes: on the editor's track, or as in the game. */
  noteView: 'track' | 'game' = 'track';
  /** The 3D track's free grid: a cell in quarters, notes, bombs and walls anywhere on it and around it
   *  (Noodle Extensions' coordinates). */
  precision = false;

  togglePrecision() {
    this.precision = !this.precision;
    this.setStatus(this.precision ? tr('Свободная сетка: клетка на четверти, ноты и стены ставятся куда угодно (Noodle Extensions). Q — обычная') : tr('Обычная сетка 4×3'));
    this.emit('selection');
  }
  /** Makes the grid finer or coarser (set by the app). */
  stepSnap: ((finer: boolean) => void) | null = null;
  /** The grid's row new notes and bombs go into from the timeline (0 bottom … 2 top). */
  noteRow = 0;
  /** What walls are drawn as: full height (dodged) or crouch ones. */
  wallKind: WallKind = 'full';
  /** The wall tool draws a strobe: short walls one every `step` beats, each `fill` of the step long. */
  wallStrobe = { on: false, step: 0.25, fill: 0.5 };
  private noteUndo: string[] = [];
  private noteRedo: string[] = [];
  private noteClipboard: { kind: ObjectKind; item: MapObjects[ObjectKind][number] }[] | null = null;

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  private clipboard: {
    clips: LightClip[];
    raw: RawEvent[];
    effects: { effect: Effect; children: LightClip[]; raw: RawEvent[] }[];
    ringBlocks: RingBlock[];
    /** The rows things were copied from (clip / effect id → row key), top to bottom (`rows`). */
    from: Map<string, string>;
    rows: string[];
  } | null = null;
  private rebuildTimer: number | null = null;
  private toSong: (jsonTime: number) => number = (beat) => beat;

  constructor(readonly preview: Preview) {}

  /** Listens to changes (the result: stop listening). */
  onChange(listener: Listener) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  emit(what: Parameters<Listener>[0]) {
    for (const listener of this.listeners) listener(what);
  }

  setStatus(text: string) {
    this.status = text;
    this.emit('time');
    for (const listen of this.statusListeners) listen(text);
  }

  private readonly statusListeners: ((text: string) => void)[] = [];

  /** Each status line as it's put up (the app's log keeps them). */
  onStatus(listen: (text: string) => void) {
    this.statusListeners.push(listen);
  }

  // ----- time ----------------------------------------------------------------------------------

  /** Map beat (jsonTime) → seconds of the song. */
  beatToSeconds(beat: number) {
    return (this.toSong(beat) * 60) / this.songBpm;
  }

  secondsToBeat(seconds: number) {
    // (the BPM changes only ever speed time up or slow it down: a bisection finds it)
    let lo = -10_000;
    let hi = 100_000;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (this.beatToSeconds(mid) < seconds) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** Where the song is now (map beats). */
  playhead() {
    return this.clock === null ? 0 : this.secondsToBeat(this.shownSeconds());
  }

  /** Where the song is in the sound being played (seconds; `playhead` waits for the sound by the
   *  settings' latency while playing). */
  songSeconds() {
    return this.clock?.currentTime() ?? 0;
  }

  /** Where the song is in what's shown (seconds): the sound's place, less the latency while playing. */
  private shownSeconds() {
    const clock = this.clock;
    if (clock === null) return 0;
    return clock.isPlaying() ? Math.max(0, clock.currentTime() - (settings().latency / 1000) * this.rate) : clock.currentTime();
  }

  get endBeat() {
    return this.secondsToBeat(this.duration);
  }

  isPlaying() {
    return this.clock?.isPlaying() === true;
  }

  togglePlay() {
    if (this.clock === null) return;
    if (this.clock.isPlaying()) {
      this.clock.pause();
      // (a stretch of the song played over and over: a pause ends it)
      if (this.previewExtra?.songLoop === true) {
        this.previewExtra = null;
        this.rebuildPreview(true);
      }
    } else {
      void this.clock.unlockAudio();
      this.clock.play();
    }
    this.emit('time');
  }

  /** Moves the song cursor; moved by hand away from a stretch played over and over, that stops. */
  seek(beat: number, looping = false) {
    if (this.clock === null) return;
    const extra = this.previewExtra;
    if (!looping && extra !== null && (beat < extra.start - 1.5 || beat > extra.end + 1.5)) {
      this.previewExtra = null;
      this.rebuildPreview(true);
    }
    this.clock.seek(Math.max(0, Math.min(this.duration, this.beatToSeconds(beat))));
    this.emit('time');
  }

  // ----- the tempo changes -----------------------------------------------------------------------------

  /** The tempo changes (BPM_EVENT_TYPE events: their beat, the BPM from there) as the timing goes by. */
  private timingKey = '';

  /**
   * The song's timing from its tempo changes, again when they changed. `ask`: a change made by hand —
   * with things after it, the question whether they keep their beats (they move in time: the default)
   * or their place in the song (their beats worked out again).
   */
  private syncTiming(ask: boolean) {
    const project = this.project;
    if (project === null) return;
    const changes = project.raw
      .filter((event) => event.type === BPM_EVENT_TYPE && event.floatValue > 0)
      .map((event) => ({ jsonTime: event.beat, songBpmTime: 0, bpm: event.floatValue }))
      .sort((a, b) => a.jsonTime - b.jsonTime);
    const key = JSON.stringify(changes.map((change) => [change.jsonTime, change.bpm]));
    if (key === this.timingKey) return;
    const before = { events: this.bpmEvents, toSong: this.toSong };
    const had = this.timingKey;
    this.timingKey = key;
    this.bpmEvents = bootstrapBpmEvents(changes, this.songBpm);
    this.toSong = createBpmConverter(this.bpmEvents, this.songBpm);
    this.preview.setTiming(this.songBpm, this.bpmEvents, this.row?.colorScheme);
    if (!ask || had === '') return;
    // (where the timing first differs: what's after it is what moves)
    const from = firstTimingChange(before.events, this.bpmEvents, this.songBpm);
    if (from === null || !this.hasAfter(from)) return;
    const oldToSong = before.toSong;
    void choose(tr('Смена темпа'), tr('После доли {0} уже есть события. Что с ними сделать?', Math.round(from * 1000) / 1000), [tr('Оставить на своих долях (сдвинутся по времени)'), tr('Оставить на своих местах в песне (доли пересчитаются)')]).then((answer) => {
      if (answer !== 1) return;
      this.retime(oldToSong, from);
    });
  }

  /** The tempo at a beat (BPM). */
  bpmAt(beat: number) {
    let bpm = this.songBpm;
    for (const event of this.bpmEvents) {
      if (event.jsonTime > beat + 1e-9) break;
      bpm = event.bpm;
    }
    return bpm;
  }

  /** Anything of the show or the notes after this beat (the tempo changes themselves aside). */
  private hasAfter(beat: number) {
    const project = this.project;
    if (project === null) return false;
    const after = (value: number) => value > beat + 1e-6;
    return (
      project.clips.some((clip) => after(clip.end)) ||
      project.raw.some((event) => event.type !== BPM_EVENT_TYPE && after(event.beat)) ||
      (project.ringBlocks ?? []).some((block) => after(block.end)) ||
      allObjects(this.objects).some(({ item }) => after((item as { b: number }).b))
    );
  }

  /**
   * Everything after `from` kept where it was in the song (in seconds) though the tempo changed: its
   * beats worked out again under the new timing (`oldToSong`: the timing before). Part of the change
   * made by hand (no undo step of its own); the notes too.
   */
  private retime(oldToSong: (beat: number) => number, from: number) {
    const project = this.project;
    if (project === null) return;
    const newToSong = this.toSong;
    // (the new timing turned round: a song beat → its beat in the file, by halving)
    const back = (song: number) => {
      let low = 0;
      let high = Math.max(1, song) * 4 + 1000;
      for (let k = 0; k < 60; k++) {
        const middle = (low + high) / 2;
        if (newToSong(middle) < song) low = middle;
        else high = middle;
      }
      return Math.round(((low + high) / 2) * 1e6) / 1e6;
    };
    const map = (beat: number) => (beat > from + 1e-6 ? back(oldToSong(beat)) : beat);
    for (const clip of project.clips) {
      const start = map(clip.start);
      const end = map(clip.end);
      clip.start = start;
      clip.end = Math.max(start, end);
    }
    for (const event of project.raw) if (event.type !== BPM_EVENT_TYPE) event.beat = map(event.beat);
    for (const effect of project.effects ?? []) {
      effect.start = map(effect.start);
      effect.end = Math.max(effect.start, map(effect.end));
    }
    for (const block of project.ringBlocks ?? []) {
      const start = block.start;
      const newStart = map(start);
      for (const pose of block.poses) {
        const at = map(start + pose.beat);
        pose.duration = Math.max(0, map(start + pose.beat + pose.duration) - at);
        pose.beat = Math.max(0, at - newStart);
      }
      block.end = Math.max(newStart + 0.25, map(block.end));
      block.start = newStart;
    }
    for (const bookmark of project.bookmarks ?? []) bookmark.beat = map(bookmark.beat);
    for (const { item } of allObjects(this.objects)) {
      const object = item as { b: number; tb?: number; d?: number };
      const b = object.b;
      object.b = map(b);
      if (typeof object.tb === 'number') object.tb = map(object.tb);
      // (a wall's length: to where its end was)
      if ('w' in object && typeof object.d === 'number') object.d = Math.max(0, map(b + object.d) - object.b);
    }
    for (const effect of project.effects ?? []) if (effect.custom !== true) this.regenerate(effect);
    this.noteVersion++;
    this.version++;
    this.dirty = true;
    this.rebuildPreview(true);
    this.emit('clips');
    this.setStatus(tr('События после доли {0} оставлены на своих местах в песне', Math.round(from * 1000) / 1000));
  }

  /** The grid the timeline puts events on when it isn't the chosen one (seen from far: a coarser one,
   *  the one whose lines show); null: the chosen one. */
  viewSnap: number | null = null;

  snapBeat(beat: number) {
    return this.snap <= 0 ? beat : Math.round(beat / this.snap) * this.snap;
  }

  // ----- opening and saving -----------------------------------------------------------------------

  async open(folder: MapFolder) {
    this.setStatus('Читаю карту…');
    const map = await loadMap(folder);
    this.map = map;
    const rows = map.parsed.rows.filter((row) => row.difficulty !== undefined);
    if (rows.length === 0) throw new Error('В папке нет сложностей, которые получилось прочитать');
    this.songBpm = map.parsed.songBpm;
    this.songRange = null;
    await this.readSongPreview();
    await this.openDifficulty(rows[0]!);
    await this.loadSong();
  }

  private infoName() {
    return this.map?.folder.files.find((name) => name.toLowerCase() === 'info.dat');
  }

  private async readSongPreview() {
    const name = this.infoName();
    this.songPreview = null;
    if (this.map === null || name === undefined) return;
    try {
      this.songPreview = readPreview(await this.map.folder.readText(name));
    } catch {
      // (a map without a readable Info.dat has no preview to show)
    }
  }

  setSongRange(range: { start: number; end: number } | null) {
    this.songRange = range;
    this.emit('time');
  }

  /** The picked stretch of the song becomes its preview in the song list (Info.dat, at once). */
  async previewFromRange() {
    const range = this.songRange;
    const name = this.infoName();
    if (range === null || this.map === null || name === undefined) return;
    const start = this.beatToSeconds(Math.min(range.start, range.end));
    const end = this.beatToSeconds(Math.max(range.start, range.end));
    await this.map.folder.writeText(name, writePreview(await this.map.folder.readText(name), start, end - start));
    await this.readSongPreview();
    this.setStatus(`Превью песни: с ${start.toFixed(2)} с, ${(end - start).toFixed(2)} с`);
  }

  /** The rings are worked out for another tick of the game's (the settings): the 3D view, the ring
   *  events made from poses and the rings' speed strip again. */
  ringTimingChanged() {
    this.ringSpeedCache = null;
    this.rebuildPreview(true);
    this.emit('clips');
  }

  /** The 3D view and the timeline in these colours (null: the difficulty's own; 'environment': the
   *  environment's, no map colours) — tried before they are kept. */
  previewColors(scheme: InfoColorScheme | 'environment' | null) {
    const own = scheme === 'environment' ? undefined : (scheme ?? this.row?.colorScheme);
    this.preview.setTiming(this.songBpm, this.bpmEvents, own);
    this.preview.view.refreshMapColors(own);
    this.emit('clips');
  }

  /** The map's colours (Info.dat, every difficulty; null: the environment's own again). */
  async setMapColors(colors: MapColors | null) {
    const map = this.map;
    const name = this.infoName();
    if (map === null || name === undefined) return;
    const text = writeMapColors(await map.folder.readText(name), colors);
    await map.folder.writeText(name, text);
    // (the difficulties' colours as the Info now has them)
    const info = parseInfo(text);
    for (const row of map.parsed.rows) {
      const own = row.infoDifficulty;
      if (own === undefined) continue;
      const found = info.difficultySets.flatMap((set) => set.difficulties).find((item) => item.characteristic === own.characteristic && item.difficulty === own.difficulty);
      if (found !== undefined) row.colorScheme = colorSchemeForDifficulty(info, found);
    }
    this.previewColors(null);
  }

  /** Another environment in the 3D view, to look at (the map stays as it is; opening a difficulty
   *  brings its own back). */
  async showEnvironment(id: string): Promise<boolean> {
    return this.preview.setEnvironment(id, undefined);
  }

  /** The map's cover picture, if it has one. */
  cover(): Blob | null {
    const cover = this.map?.parsed.cover ?? null;
    return cover === null ? null : new Blob([cover.data], { type: cover.type });
  }

  difficulties(): DifficultyRow[] {
    return this.map?.parsed.rows.filter((row) => row.difficulty !== undefined) ?? [];
  }

  async openDifficulty(row: DifficultyRow) {
    const map = this.map;
    if (map === null || row.difficulty === undefined) return;
    this.row = row;
    const difficulty = row.difficulty;
    this.bpmEvents = difficulty.bpmEvents;
    this.toSong = createBpmConverter(this.bpmEvents, this.songBpm);
    const environment = row.environmentId ?? 'DefaultEnvironment';
    this.setStatus(`Загружаю окружение ${environment}…`);
    this.preview.setTiming(this.songBpm, this.bpmEvents, row.colorScheme);
    this.mapChroma = difficulty.chromaEnvironment;
    this.previewChroma = difficulty.chromaEnvironment;
    this.envPreviewBase = null;
    this.mapNoodle = difficulty.noodle;
    this.ringParentKey = '';
    this.ringNoodle = [];
    this.sceneNoodle = null;
    this.preview.setNoodle(difficulty.noodle);
    // (a GLS environment's map: its event box groups play as the file has them)
    this.preview.setBoxGroups(difficulty);
    this.ringEnhancementKey = '';
    this.ringAnimationKey = '';
    await this.preview.setEnvironment(environment, difficulty.chromaEnvironment);
    // (the rows named as the environment names its light groups)
    setEnvironmentTracks(this.preview.environmentData()?.eventTracks);
    this.lightInfo = this.preview.lights();
    this.zoomInfo = this.preview.ringSystems().flatMap((system) => {
      const position = system.position;
      if (position === undefined) return [];
      const initial = position.initialPositions;
      return [{ name: system.name, rings: system.rings, position, initialStep: initial.length > 1 ? Math.abs(initial[1]! - initial[0]!) : (position.minPositionStep + position.maxPositionStep) / 2 }];
    });
    this.ringInfo = this.preview.ringSystems().flatMap((system) => (system.rotation === undefined ? [] : [{ name: system.name, rings: system.rings, rotation: system.rotation, seed: system.seed, ringIds: system.ringIds }]));
    this.lightsByType = new Map();
    for (const light of this.lightInfo) {
      if (!isLightType(light.type)) continue;
      const list = this.lightsByType.get(light.type) ?? [];
      list.push(light.lightId);
      this.lightsByType.set(light.type, list);
    }
    for (const list of this.lightsByType.values()) list.sort((a, b) => a - b);
    const file = difficultyFile(row);
    const saved = await loadProject(map.folder, file);
    const fileText = await map.folder.readText(file).catch(() => '');
    const fileBookmarks = readBookmarks(fileText);
    try {
      this.objects = fileText === '' ? emptyObjects() : readObjects(fileText);
      this.fakeWalls = readFakeWalls(fileText);
      this.fileVersion = fileText === '' ? '3' : difficultyVersion(fileText);
    } catch (error) {
      console.error('[lumatic] reading the notes failed', error);
      this.objects = emptyObjects();
    }
    this.noteSelection.clear();
    this.noteUndo = [];
    this.noteRedo = [];
    this.noteVersion++;
    const info = row.infoDifficulty;
    if (info !== undefined) this.preview.setJump(effectiveNoteJumpSpeed(info), info.noteStartBeatOffset);
    if (saved !== null) this.project = { ...saved, groups: saved.groups ?? [], expandedGroups: saved.expandedGroups ?? [], effects: saved.effects ?? [], ringBlocks: saved.ringBlocks ?? [], bookmarks: saved.bookmarks ?? fileBookmarks };
    else {
      const lastBeat = Math.max(0, ...difficulty.events.map((event) => event.jsonTime), ...difficulty.notes.map((note) => note.jsonTime));
      const { clips, raw } = importEvents(difficulty.events, this.lightsByType, lastBeat + 8, this.songBpm / 60);
      this.project = { format: 'lumatic', version: 1, difficulty: file, environment, clips, raw, expanded: [], groups: [], expandedGroups: [], effects: [], ringBlocks: [], bookmarks: fileBookmarks };
    }
    // (the map's colours: kept in every difficulty's project — one made before them takes theirs)
    if (this.project.palette === undefined || this.project.presets === undefined) {
      for (const other of this.difficulties()) {
        const found = other === row ? null : await loadProject(map.folder, difficultyFile(other)).catch(() => null);
        if (this.project.palette === undefined && found?.palette !== undefined && found.palette.length > 0) this.project.palette = structuredClone(found.palette);
        if (this.project.presets === undefined && found?.presets !== undefined && found.presets.length > 0) this.project.presets = structuredClone(found.presets);
      }
    }
    this.selection.clear();
    this.lightSelection.clear();
    this.focus = null;
    this.openEffect = null;
    this.previewExtra = null;
    this.activeRow = null;
    this.snap = settings().grid;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    // (ring poses "each ring on its own" and rings built from geometry are gone: such blocks turned
    // into ring events — their shapes the spiral the events can make)
    let converted = 0;
    for (const block of this.project.ringBlocks ?? []) {
      if (block.mode !== 'tracks') continue;
      block.mode = 'event';
      for (const pose of block.poses) if (!EVENT_SHAPES.has(pose.shape)) pose.shape = 'spiral';
      converted++;
    }
    for (const look of Object.values(this.project.environmentMods?.rings ?? {})) {
      if (look.geometry !== true) continue;
      delete look.geometry;
      converted++;
    }
    // (ring pose blocks are gone: each pose a Lumatic event of its own on its row — the groups only
    // what "rings in steps" and the glitch made, and copies of presets)
    const split: RingBlock[] = [];
    for (const block of this.project.ringBlocks ?? []) {
      if (isLasers(block) || block.spin !== undefined || block.steps !== undefined || block.glitch !== undefined || block.poses.length === 0 || block.group === true) {
        split.push(block);
        continue;
      }
      const length = block.end - block.start;
      const poses = [...block.poses].filter((pose) => pose.beat <= length + 1e-6).sort((a, b) => a.beat - b.beat);
      if (poses.length === 1 && poses[0]!.beat === 0) {
        split.push(block);
        continue;
      }
      poses.forEach((pose, index) => {
        const start = Math.round((block.start + pose.beat) * 1e6) / 1e6;
        const one: RingBlock = { ...block, id: index === 0 ? block.id : newId('k'), start, end: start + Math.max(0.25, pose.duration), poses: [{ ...pose, beat: 0 }] };
        fitRingBlock(one);
        split.push(one);
      });
      converted++;
    }
    this.project.ringBlocks = split;
    if (converted > 0) this.dirty = true;
    // the tempo changes: events of their own on the timeline (from the file when the project has none)
    if (!this.project.raw.some((event) => event.type === BPM_EVENT_TYPE)) {
      // (v4 keeps the tempo not in the difficulty but in the song's audio data — where the engine read it
      // from: the changes are those, the stretches that don't change the tempo left out)
      let last = this.songBpm;
      const changes =
        this.fileVersion === '4'
          ? difficulty.bpmEvents
              .filter((event) => {
                const same = Math.abs(event.bpm - last) < 1e-6;
                last = event.bpm;
                return !same;
              })
              .map((event) => ({ beat: event.jsonTime, bpm: event.bpm }))
          : readBpmChanges(fileText);
      for (const change of changes) this.project.raw.push({ id: newId('r'), beat: change.beat, type: BPM_EVENT_TYPE, value: 0, floatValue: change.bpm });
    }
    this.timingKey = '';
    this.syncTiming(false);
    await this.findGeometryRings();
    this.buildRows();
    this.rebuildPreview(true);
    this.setStatus(`${map.parsed.mapMeta.title} — ${row.label} (${environment})`);
    this.emit('all');
    // (left unsaved before — a hang, a crash: what was autosaved offered back)
    void this.offerAutosave(row).catch((error: unknown) => console.error('[lumatic] autosave check failed', error));
  }

  private async loadSong() {
    const map = this.map;
    if (map === null) return;
    this.clock?.dispose();
    this.clock = null;
    this.preview.setSpectrumSource(null);
    this.spectrogram = null;
    const audio = map.parsed.audioData;
    let buffer: AudioBuffer | null = null;
    if (audio !== null) {
      const result = await createAudioClock({
        audioData: audio,
        songBpm: this.songBpm,
        onBuffer: (decoded) => {
          buffer = decoded;
          // (the environment's spectrograms move with the song's left channel)
          const spectrum = new SongSpectrum(decoded.getChannelData(0), decoded.sampleRate);
          this.preview.setSpectrumSource((seconds) => spectrum.at(seconds));
        },
      });
      if (result.isOk()) this.clock = result.value;
    }
    if (this.clock === null) this.clock = createSilentClock(this.beatToSeconds(this.endBeatOfProject()) + 10, this.songBpm);
    if (map.parsed.mapMeta.songTimeOffset !== 0) this.clock.setAudioOffset(map.parsed.mapMeta.songTimeOffset);
    this.duration = this.clock.duration;
    if (this.rate !== 1) this.clock.setRate(this.rate);
    this.clock.setVolume(settings().volume);
    const clock = this.clock;
    // (the 3D view waits for the sound too: the latency in the song's own beats)
    this.preview.setBeatSource(() => clock.currentBeat() - (clock.isPlaying() ? ((settings().latency / 1000) * this.rate * this.songBpm) / 60 : 0));
    this.emit('all');
    // (the spectrogram comes when it's ready)
    this.spectrogram = null;
    this.songBuffer = buffer;
    this.fluxes.clear();
    if (buffer !== null) {
      void computeSpectrogram(buffer).then((spectrogram) => {
        if (this.map !== map) return;
        this.spectrogram = spectrogram;
        // (the effects following the sound: made now that it's heard)
        const sounding = (this.project?.effects ?? []).filter((effect) => effect.kind === 'sound');
        if (sounding.length > 0) {
          for (const effect of sounding) this.regenerate(effect);
          this.version++;
          this.rebuildPreview(true);
          this.emit('clips');
        }
        this.emit('time');
      });
    }
  }

  /** The song's length in samples and their rate (v4's audio data). */
  songSamples(): { sampleCount: number; frequency: number } {
    const buffer = this.songBuffer;
    if (buffer !== null) return { sampleCount: buffer.length, frequency: buffer.sampleRate };
    return { sampleCount: Math.round(this.duration * 44100), frequency: 44100 };
  }

  /** How much a band of the song grows frame by frame (for finding its hits, see onsets.ts); the
   *  first time, the usual drum bands are worked out together with it. */
  songFlux(lowHz: number, highHz: number): Promise<{ flux: Float32Array; fps: number; offset: number }> | null {
    const buffer = this.songBuffer;
    if (buffer === null) return null;
    const key = `${String(lowHz)}-${String(highHz)}`;
    const known = this.fluxes.get(key);
    if (known !== undefined) return known;
    const bands: [number, number][] = [[lowHz, highHz], ...(this.fluxes.size === 0 ? BANDS.map((band): [number, number] => [band.lowHz, band.highHz]) : [])];
    const all = findBandFlux(buffer, bands);
    bands.forEach(([low, high], index) => {
      const name = `${String(low)}-${String(high)}`;
      if (!this.fluxes.has(name)) this.fluxes.set(name, all.then((result) => ({ flux: result.flux[index]!, fps: result.fps, offset: result.offset })));
    });
    return this.fluxes.get(key)!;
  }

  private endBeatOfProject() {
    const project = this.project;
    if (project === null) return 0;
    return Math.max(0, ...project.clips.map((clip) => clip.end), ...project.raw.map((event) => event.beat));
  }

  /** The events the game gets. */
  bake(): OutEvent[] {
    const project = this.project;
    if (project === null) return [];
    // (kept till the show changes: the 3D view, saving and the autosave all want the same — worked out
    // once, not a fifth of a second again each time on a big map)
    const cached = this.bakeCache;
    if (cached !== null && cached.version === this.version && cached.project === project && cached.rings === this.ringInfo && cached.zooms === this.zoomInfo) return cached.events;
    const events = this.bakeWith(project.clips, project.raw);
    this.bakeCache = { version: this.version, project, rings: this.ringInfo, zooms: this.zoomInfo, events };
    return events;
  }

  private bakeCache: { version: number; project: Project; rings: unknown; zooms: unknown; events: OutEvent[] } | null = null;

  /** What the 3D view shows: the show, and whatever is being tried out. */
  bakeForPreview(): OutEvent[] {
    const project = this.project;
    const extra = this.previewExtra;
    if (project === null || extra === null) return [...this.bake()];
    return this.bakeWith([...project.clips, ...extra.clips], [...project.raw, ...extra.raw]);
  }

  private bakeWith(clips: readonly LightClip[], raw: readonly RawEvent[]): OutEvent[] {
    const other = rawEvents(raw);
    const rings = other.filter((event) => event.type === RING_EVENT_TYPE).sort((a, b) => a.beat - b.beat);
    const poses = [...poseRingEvents(this.ringBlocks, rings, this.ringInfo, RING_EVENT_TYPE, this.toSong, 60 / this.songBpm), ...poseZoomEvents(this.ringBlocks, this.zoomInfo, ZOOM_EVENT_TYPE, 60 / this.songBpm), ...this.laserBlockEvents()].map(({ group: _group, ...event }) => event);
    // (the poses' ring events before the show's own at the same moment: of two at once, the first wins)
    return [...bakeLights(clips, this.lightsByType, this.scheme(), 60 / this.songBpm, this.groups), ...poses, ...other].sort((a, b) => a.beat - b.beat);
  }

  /** The ring poses' ring events (for drawing them on the rings' row). */
  poseEvents() {
    const project = this.project;
    if (project === null) return [];
    // (kept till something changes: the timeline asks for them every frame, a few times — and a spin
    // makes thousands)
    const cached = this.poseCache;
    if (cached !== null && cached.version === this.version && cached.project === project && cached.rings === this.ringInfo && cached.zooms === this.zoomInfo) return cached.events;
    const rings = rawEvents(project.raw).filter((event) => event.type === RING_EVENT_TYPE).sort((a, b) => a.beat - b.beat);
    const events = [...poseRingEvents(this.ringBlocks, rings, this.ringInfo, RING_EVENT_TYPE, this.toSong, 60 / this.songBpm), ...poseZoomEvents(this.ringBlocks, this.zoomInfo, ZOOM_EVENT_TYPE, 60 / this.songBpm), ...this.laserBlockEvents()];
    this.poseCache = { version: this.version, project, rings: this.ringInfo, zooms: this.zoomInfo, events };
    return events;
  }

  private poseCache: { version: number; project: Project; rings: unknown; zooms: unknown; events: (OutEvent & { group: string })[] } | null = null;

  /** The laser speed events of the lasers blocks (as long as each block is now). */
  laserBlockEvents(): (OutEvent & { group: string })[] {
    return this.ringBlocks.filter(isLasers).flatMap((block) => laserEvents(laserBlockMove(block), block.start, (beat) => this.beatToSeconds(beat)).map((event) => ({ ...event, group: block.id })));
  }

  /** The Chroma environment the ring poses on tracks need: the rings on tracks, their turns
   *  (`forGame`: the rings found where the game puts them for this player — gameFirstRing). */
  ringChroma(forGame = false): { enhancements: RingEnhancement[]; animations: RingAnimation[] } {
    const first = forGame ? this.gameFirstRing : null;
    return { enhancements: ringEnhancements(this.ringBlocks, this.ringInfo, first ?? undefined, this.geometryRings), animations: ringAnimations(this.ringBlocks, this.ringInfo) };
  }

  /** The ring systems drawn from Chroma geometry (their names). */
  geometryRings = new Set<string>();

  private async findGeometryRings() {
    const rings = new Set(geometrySystems(this.project?.environmentMods));
    if (rings.size === 0) {
      this.geometryRings = new Set();
      return;
    }
    const source = await this.environmentSource().catch(() => null);
    this.geometryRings = new Set(source === null ? [] : ringSystemParts(source).filter((system) => rings.has(system.ring)).map((system) => system.system));
  }

  /** Where the game spawns its first ring in its GameCore scene for this player (it hangs on the game's
   *  version and mods; Chroma finds the rings by it) — null: where the environment data has it. */
  get gameFirstRing(): number | null {
    try {
      const value = Number(localStorage.getItem(FIRST_RING_KEY) ?? NaN);
      return Number.isInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  set gameFirstRing(value: number | null) {
    try {
      if (value === null) localStorage.removeItem(FIRST_RING_KEY);
      else localStorage.setItem(FIRST_RING_KEY, String(Math.round(value)));
    } catch {
      // (not kept: it stays as it was)
    }
    // (what's saved changes with it)
    this.dirty = this.dirty || this.ringBlocks.some((block) => block.mode === 'tracks');
  }

  private sourceEnvironment: { id: string; data: Promise<EnvironmentData> } | null = null;

  /** The environment's own data (as the game has it: before the map's Chroma changes; `id`: another
   *  environment than the difficulty's). */
  environmentSource(id = this.row?.environmentId ?? 'DefaultEnvironment'): Promise<EnvironmentData> {
    if (this.sourceEnvironment?.id !== id) this.sourceEnvironment = { id, data: loadEnvironmentData(id) };
    return this.sourceEnvironment.data;
  }

  /** What the environment's changes write into the difficulty. */
  async environmentFragment(mods = this.project?.environmentMods, environment?: string): Promise<EnvironmentFragment> {
    if (!hasMods(mods)) return { ...EMPTY_FRAGMENT };
    const preset = mods?.preset === undefined ? undefined : await loadPreset(mods.preset);
    return modsFragment(mods, await this.environmentSource(environment).catch(() => null), preset);
  }

  // ----- the scene editor (the Environment side) ---------------------------------------------------------

  /** The Environment side is open: the scene's tree and an object's settings beside the 3D view. */
  envMode = false;
  /** The picked things of the scene: "g:<index>" — a game's object (its place among the environment's
   *  objects), "o:<uid>" — an added one. The first: the one the handles are on. */
  envSelection: string[] = [];
  /** The environment as the game has it (the scene's tree is of it; set by the scene panel). */
  envSceneData: EnvironmentData | null = null;

  setEnvMode(on: boolean) {
    if (this.envMode === on) return;
    this.envMode = on;
    // (every lamp lit a little, nothing moving: the objects show whatever the lights do)
    this.staticLights = on;
    this.rebuildPreview(true);
    this.emit('all');
  }

  selectEnv(keys: readonly string[], mode: 'replace' | 'toggle' | 'add' = 'replace') {
    if (mode === 'replace') this.envSelection = [...keys];
    else if (mode === 'add') this.envSelection = [...this.envSelection, ...keys.filter((key) => !this.envSelection.includes(key))];
    else for (const key of keys) this.envSelection = this.envSelection.includes(key) ? this.envSelection.filter((item) => item !== key) : [...this.envSelection, key];
    this.emit('selection');
  }

  /** The scene editor's changes (one an object, by its Chroma id). */
  sceneEdits(): SceneEdit[] {
    return this.project?.environmentMods?.scene ?? [];
  }

  /** The objects the scene editor added (copies, shapes). */
  sceneObjects(): SceneObject[] {
    return this.project?.environmentMods?.objects ?? [];
  }

  sceneMaterials(): Record<string, SceneMaterial> {
    return this.project?.environmentMods?.materials ?? {};
  }

  /** The scene's part of the environment's changes put (what's empty dropped). */
  private putScene(scene: SceneEdit[], objects: SceneObject[] = this.sceneObjects(), materials: Record<string, SceneMaterial> = this.sceneMaterials()) {
    const project = this.project;
    if (project === null) return;
    const kept = scene.filter((edit) => sceneCommand(edit) !== null);
    const mods: EnvironmentMods = { ...(project.environmentMods ?? {}) };
    if (kept.length > 0) mods.scene = kept;
    else delete mods.scene;
    if (objects.length > 0) mods.objects = objects;
    else delete mods.objects;
    if (Object.keys(materials).length > 0) mods.materials = materials;
    else delete mods.materials;
    // (an animation of an object that is no more goes with it)
    const uids = new Set(objects.map((object) => `o:${object.uid}`));
    const anims = (mods.anims ?? []).filter((anim) => hasKeys(anim) && (!anim.target.startsWith('o:') || uids.has(anim.target)));
    if (anims.length > 0) mods.anims = anims;
    else delete mods.anims;
    const motions = (mods.motions ?? []).filter((motion) => !motion.target.startsWith('o:') || uids.has(motion.target));
    if (motions.length > 0) mods.motions = motions;
    else delete mods.motions;
    const links = (mods.links ?? []).filter((link) => [link.child, link.parent].every((target) => !target.startsWith('o:') || uids.has(target)));
    if (links.length > 0) mods.links = links;
    else delete mods.links;
    project.environmentMods = hasMods(mods) || mods.materials !== undefined ? mods : undefined;
    this.tidyArrays();
  }

  // ----- the scene's animations: keys on beats ------------------------------------------------------------

  /** ⏺: every change of a place, turn or size in the scene makes a key at the playhead. */
  animAuto = false;
  /** The picked keys (their ids). */
  animSelection = new Set<string>();

  sceneAnims(): SceneAnim[] {
    return this.project?.environmentMods?.anims ?? [];
  }

  private putAnims(anims: SceneAnim[], tidy = true) {
    const project = this.project;
    if (project === null) return;
    const mods: EnvironmentMods = { ...(project.environmentMods ?? {}) };
    mods.anims = anims;
    project.environmentMods = mods;
    if (tidy) this.putScene(this.sceneEdits());
  }

  /** What a picked thing's animation is kept under (null: it can't have one). "m:<name>": a material,
   *  "f:fog": the fog, "p:player": the player. */
  animTarget(key: string): string | null {
    if (key.startsWith('m:')) return this.sceneMaterials()[key.slice(2)] === undefined ? null : key;
    if (key === 'f:fog') return 'fog';
    if (key === 'p:player') return 'player';
    const now = this.sceneValues(key);
    if (now === null) return null;
    if (now.object !== undefined) return now.object.ghost === true ? null : key;
    return now.id ?? null;
  }

  animOf(key: string): SceneAnim | undefined {
    const target = this.animTarget(key);
    return target === null ? undefined : this.sceneAnims().find((anim) => anim.target === target);
  }

  /** The picked thing an animation is of (null: it's gone). */
  animKeyOf(anim: SceneAnim): string | null {
    if (anim.target.startsWith('m:')) return this.sceneMaterials()[anim.target.slice(2)] === undefined ? null : anim.target;
    if (anim.target === 'fog') return 'f:fog';
    if (anim.target === 'player') return 'p:player';
    if (anim.target.startsWith('o:')) return this.sceneObjects().some((object) => `o:${object.uid}` === anim.target) ? anim.target : null;
    return this.gameKey(anim.target);
  }

  /** The name a thing is shown by. */
  thingName(key: string): string {
    if (key.startsWith('m:')) return tr('Материал «{0}»', key.slice(2));
    if (key === 'f:fog') return tr('Туман');
    if (key === 'p:player') return tr('Игрок');
    if (key.startsWith('o:')) return this.sceneObjects().find((object) => `o:${object.uid}` === key)?.name ?? '';
    return this.envTree()?.nodes.get(Number(key.slice(2)))?.name ?? '';
  }

  /** Whether a picked object is a lamp with settings of its own (brightness, glow in the fog). */
  isTube(key: string): boolean {
    if (key.startsWith('o:')) {
      const object = this.sceneObjects().find((item) => `o:${item.uid}` === key);
      const material = object?.material === undefined ? undefined : this.sceneMaterials()[object.material];
      return object?.kind === 'shape' && material !== undefined && isLightShader(material.shader);
    }
    if (!key.startsWith('g:')) return false;
    const components = this.envSceneData?.objects[Number(key.slice(2))]?.components;
    return (components?.ParametricBloomFogLightController ?? []).length > 0 || (components?.MaterialLightController ?? []).length > 0;
  }

  /** The parts a picked thing can have keys of. */
  partsOfKey(key: string): readonly AnimPart[] {
    const target = this.animTarget(key);
    return target === null ? [] : partsOf(target, this.isTube(key));
  }

  /** The fog as it is set (what's not set: as the environment has it). */
  fogValues(): Required<FogValues> {
    const own = this.envSceneData?.fogParams;
    const set = this.project?.environmentMods?.fog ?? {};
    return { attenuation: set.attenuation ?? own?.attenuation ?? 0.002, offset: set.offset ?? own?.offset ?? 0, startY: set.startY ?? own?.startY ?? -300, height: set.height ?? own?.height ?? 10 };
  }

  /** A lamp's own settings (1: as it is). */
  tubeValues(key: string): Required<TubeValues> {
    const object = key.startsWith('o:') ? this.sceneObjects().find((item) => `o:${item.uid}` === key) : undefined;
    const id = key.startsWith('g:') ? this.envTree()?.nodes.get(Number(key.slice(2)))?.id : undefined;
    const tube = object?.tube ?? (id === undefined || id === null ? undefined : this.sceneEdits().find((edit) => edit.id === id)?.tube);
    return { alpha: tube?.alpha ?? 1, bloom: tube?.bloom ?? 1 };
  }

  /** A part's value as the thing has it without animation (null: it has no such part). */
  baseValue(key: string, part: AnimPart): number[] | null {
    if (part === 'color') {
      const material = key.startsWith('m:') ? this.sceneMaterials()[key.slice(2)] : undefined;
      return material === undefined ? null : [...material.color];
    }
    if (part === 'attenuation' || part === 'offset' || part === 'startY' || part === 'height') return key === 'f:fog' ? [this.fogValues()[part]] : null;
    if (part === 'alpha' || part === 'bloom') return this.isTube(key) ? [this.tubeValues(key)[part]] : null;
    const now = this.sceneValues(key);
    return now === null ? null : [...now[part]];
  }

  /** A part's value at a beat: as its keys have it, or as the thing has it without them. */
  shownValue(key: string, part: AnimPart, beat = this.playhead()): number[] | null {
    return animValue(this.animOf(key), part, beat) ?? this.baseValue(key, part);
  }

  /** Where a picked thing stands at the playhead: its own values, the animated parts as their keys
   *  have them there (`keyed`: those parts). */
  sceneShown(key: string, beat = this.playhead(), withMotions = true) {
    const now = this.sceneValues(key);
    if (now === null) return null;
    const anim = this.animOf(key);
    const keyed: AnimPart[] = [];
    const out = { ...now, keyed };
    const motions = withMotions ? this.motionsOf(key) : [];
    for (const part of MOVES) {
      // (keyed: by keys — a motion on top of them is shown, but changes go to the keys or its own value)
      if (animValue(anim, part, beat) !== null) keyed.push(part);
      const value = motions.length === 0 ? animValue(anim, part, beat) : movedValue(anim, motions, now, part, beat);
      if (value === null) continue;
      out[part] = value as [number, number, number];
    }
    return out;
  }

  /**
   * A part of a thing set to a value: a key at the playhead when the part is animated (or ⏺ is on, or
   * it's the player — it has no place of its own), its own value otherwise. For the fog, the lamps'
   * settings and the materials' colours (places, turns and sizes go through `applyScene`).
   */
  setPart(keys: readonly string[], part: AnimPart, value: (key: string, now: number[]) => number[], merge?: string) {
    const project = this.project;
    if (project === null || keys.length === 0) return;
    const beat = this.snapBeat(this.playhead());
    const anims = structuredClone(this.sceneAnims());
    const mods: EnvironmentMods = structuredClone(project.environmentMods ?? {});
    let keyed = false;
    for (const key of keys) {
      const target = this.animTarget(key);
      const now = this.shownValue(key, part);
      if (target === null || now === null) continue;
      const next = value(key, now);
      const anim = this.animOf(key);
      if (target === 'player' || this.animAuto || (anim?.keys[part] ?? []).length > 0) {
        this.keyAt(anims, target, part, beat).value = [...next];
        keyed = true;
        continue;
      }
      if (part === 'color') {
        const material = mods.materials?.[key.slice(2)];
        if (material !== undefined) material.color = next.slice(0, 4) as [number, number, number, number];
      } else if (part === 'attenuation' || part === 'offset' || part === 'startY' || part === 'height') (mods.fog ??= {})[part] = next[0]!;
      else if (part === 'alpha' || part === 'bloom') {
        if (key.startsWith('o:')) {
          const object = mods.objects?.find((item) => `o:${item.uid}` === key);
          if (object !== undefined) object.tube = { ...(object.tube ?? {}), [part]: next[0]! };
        } else if (target !== null) {
          const scene = (mods.scene ??= []);
          let edit = scene.find((item) => item.id === target);
          if (edit === undefined) scene.push((edit = { id: target }));
          edit.tube = { ...(edit.tube ?? {}), [part]: next[0]! };
        }
      }
    }
    this.sceneStep(merge);
    if (keyed) mods.anims = anims;
    project.environmentMods = mods;
    this.putScene(mods.scene ?? [], mods.objects ?? [], mods.materials ?? {});
    this.sceneChanged();
  }

  /** The fog back as the environment has it (its keys stay). */
  resetFog() {
    const project = this.project;
    if (project?.environmentMods?.fog === undefined) return;
    this.sceneStep();
    const mods = { ...project.environmentMods };
    delete mods.fog;
    project.environmentMods = mods;
    this.putScene(this.sceneEdits());
    this.sceneChanged();
  }

  /** The player: whether its turns and uneven moves are allowed. */
  playerRisky(): boolean {
    return this.project?.environmentMods?.player?.risky === true;
  }

  setPlayerRisky(on: boolean) {
    const project = this.project;
    if (project === null) return;
    this.sceneStep();
    const mods = { ...(project.environmentMods ?? {}) };
    if (on) mods.player = { risky: true };
    else delete mods.player;
    project.environmentMods = mods;
    // (not allowed any more: its turns go, its moves become even)
    if (!on)
      for (const anim of mods.anims ?? []) {
        if (anim.target !== 'player') continue;
        delete anim.keys.rotation;
        for (const key of anim.keys.position ?? []) delete key.easing;
      }
    this.putScene(this.sceneEdits());
    this.sceneChanged();
  }

  /** Changes the animations (one undo step). */
  changeAnims(patch: (anims: SceneAnim[]) => void, merge?: string) {
    if (this.project === null) return;
    this.sceneStep(merge);
    const anims = structuredClone(this.sceneAnims());
    patch(anims);
    // (the player: even moves only, no turns — unless the risk is taken)
    if (!this.playerRisky())
      for (const anim of anims) {
        if (anim.target !== 'player') continue;
        delete anim.keys.rotation;
        for (const key of anim.keys.position ?? []) delete key.easing;
      }
    this.putAnims(anims);
    const left = new Set(this.sceneAnims().flatMap((anim) => ALL_PARTS.flatMap((part) => (anim.keys[part] ?? []).map((key) => key.id))));
    this.animSelection = new Set([...this.animSelection].filter((id) => left.has(id)));
    this.sceneChanged();
  }

  /** A key in an animation list at a beat: the one there already, or a new one. */
  private keyAt(anims: SceneAnim[], target: string, part: AnimPart, beat: number): AnimKey {
    let anim = anims.find((item) => item.target === target);
    if (anim === undefined) anims.push((anim = { target, keys: {} }));
    const keys = (anim.keys[part] ??= []);
    let key = keys.find((item) => Math.abs(item.beat - beat) < 1e-3);
    if (key === undefined) keys.push((key = { id: newId('k'), beat, value: [] }));
    return key;
  }

  /** A key of these parts at a beat for each picked thing, with what it has there now (picked after). */
  addAnimKeys(keys: readonly string[], parts: readonly AnimPart[], beat = this.snapBeat(this.playhead())) {
    const made: string[] = [];
    const targets = keys.map((key) => ({ key, target: this.animTarget(key) })).filter((item) => item.target !== null);
    if (targets.length === 0) return;
    // (the player, at first: what moving it means)
    if (targets.some((item) => item.target === 'player') && this.sceneAnims().every((anim) => anim.target !== 'player' || !hasKeys(anim)) && !window.confirm(tr('Движение игрока легко вызывает укачивание в VR. Lumatic разрешает только равномерное движение без поворотов; повороты и плавность включаются галочкой «Я понимаю риск». Двигайте игрока редко и медленно. Поставить ключ?'))) return;
    this.changeAnims((anims) => {
      for (const { key, target } of targets) {
        for (const part of parts) {
          if (!this.partsOfKey(key).includes(part)) continue;
          const now = this.shownValue(key, part, beat);
          if (now === null) continue;
          const made_ = this.keyAt(anims, target!, part, beat);
          made_.value = [...now];
          made.push(made_.id);
        }
      }
    });
    this.animSelection = new Set(made);
    this.emit('selection');
  }

  /** Changes keys by their ids (one undo step). */
  changeAnimKeys(ids: ReadonlySet<string>, patch: (key: AnimKey, part: AnimPart, anim: SceneAnim) => void, merge?: string) {
    if (ids.size === 0) return;
    this.changeAnims((anims) => {
      for (const anim of anims) for (const part of ALL_PARTS) for (const key of anim.keys[part] ?? []) if (ids.has(key.id)) patch(key, part, anim);
    }, merge);
  }

  removeAnimKeys(ids: ReadonlySet<string>) {
    if (ids.size === 0) return;
    this.changeAnims((anims) => {
      for (const anim of anims) for (const part of ALL_PARTS) if (anim.keys[part] !== undefined) anim.keys[part] = anim.keys[part]!.filter((key) => !ids.has(key.id));
    });
  }

  /** How many times a part of an animation plays (1: once). */
  setAnimRuns(target: string, part: AnimPart, runs: number) {
    this.changeAnims((anims) => {
      const anim = anims.find((item) => item.target === target);
      if (anim === undefined) return;
      const more = Math.max(0, Math.min(999, Math.round(runs) - 1));
      anim.repeat = { ...(anim.repeat ?? {}), [part]: more };
      if (more === 0) delete anim.repeat[part];
      if (Object.keys(anim.repeat).length === 0) delete anim.repeat;
    }, `anim:runs:${part}`);
  }

  /** A part going along a smooth curve through its keys, or straight from one to the next. */
  setAnimSpline(target: string, part: AnimPart, on: boolean) {
    this.changeAnims((anims) => {
      const anim = anims.find((item) => item.target === target);
      if (anim === undefined) return;
      anim.spline = { ...(anim.spline ?? {}), [part]: on };
      if (!on) delete anim.spline[part];
      if (Object.keys(anim.spline).length === 0) delete anim.spline;
    });
  }

  /** The keys copied (their beats from the first of them). */
  private animClipboard: { target: string; part: AnimPart; beat: number; value: number[]; easing?: string }[] = [];

  copyAnimKeys(): boolean {
    const picked = this.sceneAnims().flatMap((anim) => ALL_PARTS.flatMap((part) => (anim.keys[part] ?? []).filter((key) => this.animSelection.has(key.id)).map((key) => ({ target: anim.target, part, beat: key.beat, value: [...key.value], ...(key.easing === undefined ? {} : { easing: key.easing }) }))));
    if (picked.length === 0) return false;
    const first = Math.min(...picked.map((item) => item.beat));
    this.animClipboard = picked.map((item) => ({ ...item, beat: item.beat - first }));
    this.setStatus(tr('Скопировано ключей: {0}', picked.length));
    return true;
  }

  /** The copied keys put at the playhead — on the things they were copied from, or (copied from one
   *  thing, others picked now) on the picked ones that have such parts. */
  pasteAnimKeys(): boolean {
    const copied = this.animClipboard;
    if (copied.length === 0) return false;
    const from = new Set(copied.map((item) => item.target));
    const picked = this.envSelection.map((key) => ({ key, target: this.animTarget(key) })).filter((item): item is { key: string; target: string } => item.target !== null);
    const onto = from.size === 1 && picked.length > 0 && !picked.some((item) => item.target === [...from][0]) ? picked : null;
    const start = this.snapBeat(this.playhead());
    const made: string[] = [];
    this.changeAnims((anims) => {
      for (const item of copied) {
        for (const { key: thing, target } of onto ?? [{ key: '', target: item.target }]) {
          if (thing !== '' && !this.partsOfKey(thing).includes(item.part)) continue;
          const key = this.keyAt(anims, target, item.part, Math.round((start + item.beat) * 10000) / 10000);
          key.value = [...item.value];
          if (item.easing === undefined) delete key.easing;
          else key.easing = item.easing;
          made.push(key.id);
        }
      }
    });
    this.animSelection = new Set(made);
    this.emit('selection');
    return true;
  }

  /** All the animation of the picked things taken away. */
  clearAnims(keys: readonly string[]) {
    const targets = new Set(keys.map((key) => this.animTarget(key)));
    this.changeAnims((anims) => {
      for (const anim of anims) {
        if (!targets.has(anim.target)) continue;
        anim.keys = {};
        delete anim.repeat;
        delete anim.spline;
      }
    });
  }

  selectAnimKeys(ids: readonly string[], mode: 'replace' | 'toggle' | 'add' = 'replace') {
    if (mode === 'replace') this.animSelection = new Set(ids);
    else for (const id of ids) {
      if (mode === 'toggle' && this.animSelection.has(id)) this.animSelection.delete(id);
      else this.animSelection.add(id);
    }
    this.emit('selection');
  }

  // ----- ready motions: blocks on an object's timeline ---------------------------------------------------

  sceneMotions(): SceneMotion[] {
    return this.project?.environmentMods?.motions ?? [];
  }

  /** The motions of a picked thing. */
  motionsOf(key: string): SceneMotion[] {
    const target = this.animTarget(key);
    return target === null ? [] : this.sceneMotions().filter((motion) => motion.target === target);
  }

  /** The motion picked on the timeline (its settings on the right). */
  motionSelection: string | null = null;

  private putMotions(motions: SceneMotion[]) {
    const project = this.project;
    if (project === null) return;
    const mods: EnvironmentMods = { ...(project.environmentMods ?? {}) };
    if (motions.length > 0) mods.motions = motions;
    else delete mods.motions;
    project.environmentMods = mods;
    this.putScene(this.sceneEdits());
  }

  /** A ready motion on a picked thing from a beat (picked after). */
  addMotion(key: string, kind: MotionKind, start = this.snapBeat(this.playhead())) {
    const target = this.animTarget(key);
    if (target === null || target.startsWith('m:') || target === 'fog' || target === 'player') return;
    this.sceneStep();
    const motion = defaultMotion(kind, target, Math.max(0, start), newId('m'));
    this.putMotions([...structuredClone(this.sceneMotions()), motion]);
    this.motionSelection = motion.id;
    if (!this.envSelection.includes(key)) this.envSelection = [key];
    this.sceneChanged();
    if (kind === 'follow' || kind === 'depends') this.setStatus(tr('Пока идёт этот блок, он заменяет ключи своего свойства. В окне просмотра голова, руки и значения игры показаны условно — проверьте в игре.'));
  }

  changeMotion(id: string, patch: (motion: SceneMotion) => void, merge?: string) {
    this.sceneStep(merge);
    const motions = structuredClone(this.sceneMotions());
    const motion = motions.find((item) => item.id === id);
    if (motion === undefined) return;
    patch(motion);
    motion.end = Math.max(motion.start + 0.0625, motion.end);
    this.putMotions(motions);
    this.sceneChanged();
  }

  removeMotion(id: string) {
    this.sceneStep();
    this.putMotions(this.sceneMotions().filter((motion) => motion.id !== id));
    if (this.motionSelection === id) this.motionSelection = null;
    this.sceneChanged();
  }

  selectMotion(id: string | null) {
    this.motionSelection = id;
    if (id !== null) this.animSelection = new Set();
    this.emit('selection');
  }

  /** A ready motion made keys: one every quarter of a beat (with the keys there were), the block gone. */
  bakeMotion(id: string) {
    const motion = this.sceneMotions().find((item) => item.id === id);
    if (motion === undefined || !isPeriodic(motion)) return;
    const key = this.animKeyOf({ target: motion.target, keys: {} });
    const base = key === null ? null : this.sceneValues(key);
    if (base === null) return;
    const anim = this.animOf(key!);
    this.sceneStep();
    const anims = structuredClone(this.sceneAnims());
    for (const part of motionParts(motion)) {
      const step = Math.min(0.25, Math.max(1 / 16, motion.period / 16));
      const beats: number[] = [];
      for (let beat = motion.start; beat < motion.end - 1e-6; beat += step) beats.push(Math.round(beat * 10000) / 10000);
      beats.push(motion.end);
      const values = beats.map((beat) => movedValue(anim, [motion], base, part, Math.min(beat, motion.end - 1e-4)) ?? [...base[part as 'position']]);
      // (the keys inside the block: in the made ones now)
      const own = anims.find((item) => item.target === motion.target);
      if (own?.keys[part] !== undefined) own.keys[part] = own.keys[part]!.filter((item) => item.beat < motion.start - 1e-6 || item.beat > motion.end + 1e-6);
      beats.forEach((beat, at) => (this.keyAt(anims, motion.target, part, beat).value = [...values[at]!]));
    }
    this.putAnims(anims, false);
    this.putMotions(this.sceneMotions().filter((item) => item.id !== id));
    if (this.motionSelection === id) this.motionSelection = null;
    this.sceneChanged();
    this.setStatus(tr('Движение разобрано в ключи'));
  }

  // ----- links: things hung on others ------------------------------------------------------------------

  sceneLinks(): SceneLink[] {
    return this.project?.environmentMods?.links ?? [];
  }

  /** What a picked thing hangs on (its key; null: nothing). */
  linkParentOf(key: string): string | null {
    const target = this.animTarget(key);
    const link = this.sceneLinks().find((item) => item.child === target);
    return link === undefined ? null : this.animKeyOf({ target: link.parent, keys: {} });
  }

  /** The things hung on a picked one (their keys). */
  linkChildrenOf(key: string): string[] {
    const target = this.animTarget(key);
    return this.sceneLinks().filter((item) => item.parent === target).map((item) => this.animKeyOf({ target: item.child, keys: {} })).filter((item): item is string => item !== null);
  }

  /** The parts' lines opened on the timeline (their curves shown): "<key>|<part>" → how tall. */
  curveRows = new Map<string, number>();

  /** A part's line opened on the timeline (its curves), or closed. */
  toggleCurve(key: string, part: AnimPart, open = !this.curveRows.has(`${key}|${part}`)) {
    if (open) this.curveRows.set(`${key}|${part}`, this.curveRows.get(`${key}|${part}`) ?? 110);
    else this.curveRows.delete(`${key}|${part}`);
    this.emit('selection');
  }

  setCurveHeight(key: string, part: AnimPart, height: number) {
    this.curveRows.set(`${key}|${part}`, Math.round(height));
    this.emit('selection');
  }

  /** The material open on the Scene side's right panel (its colour's keys shown on the timeline). */
  envMaterialOpen: string | null = null;
  /** Opens a material on the right (set by main). */
  showMaterial: (name: string) => void = () => {};

  /** Waiting for the parent to be picked (the things to hang on it), or not. */
  linkPicking: string[] | null = null;

  startLinkPick(keys: readonly string[]) {
    this.linkPicking = keys.filter((key) => key.startsWith('o:') || key.startsWith('g:'));
    this.setStatus(tr('Выберите родителя: кликните по объекту в 3D-окне или в списке (Esc — отмена)'));
    this.emit('selection');
  }

  /** Hangs things on a parent (null: on nothing any more). A thing can't hang on itself or on one of
   *  those hung on it. */
  setLinkParent(keys: readonly string[], parent: string | null) {
    const project = this.project;
    if (project === null) return;
    this.linkPicking = null;
    const parentTarget = parent === null ? null : this.animTarget(parent);
    if (parent !== null && (parentTarget === null || parentTarget === 'player' || parentTarget === 'fog' || parentTarget.startsWith('m:'))) {
      this.setStatus(tr('К этому привязать нельзя'));
      this.emit('selection');
      return;
    }
    const links = structuredClone(this.sceneLinks());
    const above = (target: string): string[] => {
      const out: string[] = [];
      for (let at: string | undefined = target; at !== undefined; at = links.find((link) => link.child === at)?.parent) {
        if (out.includes(at)) break;
        out.push(at);
      }
      return out;
    };
    let refused = 0;
    let next = links;
    for (const key of keys) {
      const child = this.animTarget(key);
      if (child === null || child.startsWith('m:') || child === 'fog' || child === 'player') continue;
      next = next.filter((link) => link.child !== child);
      if (parentTarget === null) continue;
      if (above(parentTarget).includes(child)) {
        refused++;
        continue;
      }
      next.push({ child, parent: parentTarget });
    }
    this.sceneStep();
    const mods = { ...(project.environmentMods ?? {}) };
    if (next.length > 0) mods.links = next;
    else delete mods.links;
    project.environmentMods = mods;
    this.putScene(this.sceneEdits());
    this.sceneChanged();
    this.setStatus(refused > 0 ? tr('Объект нельзя привязать к тому, что привязано к нему самому') : parentTarget === null ? tr('Отвязано') : tr('Привязано: объект будет двигаться вместе с родителем (нужен Noodle Extensions)'));
  }

  /**
   * How a picked thing is carried along by what it hangs on, at a beat — the motions of its parent, its
   * parent's parent… (the 3D view's space; null: it isn't moved).
   */
  linkCarry(key: string, beat = this.playhead()): Matrix4 | null {
    let out: Matrix4 | null = null;
    const seen = new Set<string>();
    for (let parent = this.linkParentOf(key); parent !== null && !seen.has(parent); parent = this.linkParentOf(parent)) {
      seen.add(parent);
      const base = this.sceneValues(parent);
      if (base === null) break;
      const delta = linkDelta(this.animOf(parent), base, beat, this.outerOf(parent) ?? undefined);
      if (delta !== null) out = out === null ? delta : delta.multiply(out);
    }
    return out;
  }

  /** Where the space a picked thing's own values are in stands (null: the world). */
  private outerOf(key: string): Matrix4 | null {
    const data = this.envSceneData;
    if (data === null) return null;
    let index: number | undefined;
    if (key.startsWith('g:')) index = Number(key.slice(2));
    else {
      const object = this.sceneObjects().find((item) => `o:${item.uid}` === key);
      if (object?.kind !== 'copy' || object.source === undefined) return null;
      const game = this.gameKey(object.source);
      index = game === null ? undefined : Number(game.slice(2));
    }
    const parent = index === undefined ? -1 : (data.objects[index]?.parent ?? -1);
    return parent < 0 ? null : worldMatrix(data, parent);
  }

  /** The added objects as they are shown and written: each, then its array's others. */
  sceneRendered(): SceneObject[] {
    return expandObjects(this.sceneObjects());
  }

  /** The key of the game's object with this Chroma id (null: there's none). */
  private gameKey(id: string): string | null {
    for (const node of this.envTree()?.nodes.values() ?? []) if (node.id === id) return `g:${String(node.index)}`;
    return null;
  }

  /** After a change: a ghost stands where its original does; an array of lamps has a light ID for
   *  each of its others. */
  private tidyArrays() {
    const objects = this.project?.environmentMods?.objects ?? [];
    const taken = new Map<number, Set<number>>();
    const takenOf = (type: number) => {
      let set = taken.get(type);
      if (set === undefined) taken.set(type, (set = new Set(this.lightsByGame(type))));
      return set;
    };
    for (const object of objects) if (object.light !== undefined) takenOf(object.light.type).add(object.light.id);
    for (const object of objects) {
      if (object.ghost === true && object.source !== undefined) {
        const key = this.gameKey(object.source);
        const now = key === null ? null : this.sceneValues(key);
        if (now !== null) Object.assign(object, { position: [...now.position], rotation: [...now.rotation], scale: [...now.scale] });
      }
      if (object.array === undefined || object.light === undefined) {
        delete object.arrayLights;
        continue;
      }
      const set = takenOf(object.light.type);
      const wanted = arrayCount(object.array) - 1;
      const ids = (object.arrayLights ?? []).slice(0, wanted);
      for (const id of ids) set.add(id);
      while (ids.length < wanted) {
        let id = Math.max(100, ...set) + 1;
        while (set.has(id)) id++;
        set.add(id);
        ids.push(id);
      }
      object.arrayLights = ids;
    }
  }

  /** The light IDs of the game's own lamps of an event type (the scene's left out). */
  private lightsByGame(type: number): number[] {
    const own = new Set(this.sceneObjects().flatMap((object) => (object.light?.type === type ? [object.light.id, ...(object.arrayLights ?? [])] : [])));
    return (this.lightsByType.get(type) ?? []).filter((id) => !own.has(id));
  }

  /**
   * Makes many of the picked things (null: one again). An added object gets the array itself; a
   * game's object gets a ghost copy carrying it — the original is the array's first.
   */
  setArray(keys: readonly string[], make: ((base: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }) => SceneArray) | null, merge?: string) {
    if (this.project === null || keys.length === 0) return;
    this.sceneStep(merge);
    let objects = structuredClone(this.sceneObjects());
    const picked: string[] = [];
    for (const key of keys) {
      if (key.startsWith('o:')) {
        const object = objects.find((item) => item.uid === key.slice(2));
        if (object === undefined) continue;
        if (make !== null) object.array = make(object);
        else if (object.ghost === true) objects = objects.filter((item) => item !== object);
        else {
          delete object.array;
          delete object.arrayLights;
        }
        if (make !== null || object.ghost !== true) picked.push(key);
        continue;
      }
      const now = this.sceneValues(key);
      if (make === null || now === null || now.id === null || now.id === undefined) continue;
      const base = { position: [...now.position] as [number, number, number], rotation: [...now.rotation] as [number, number, number], scale: [...now.scale] as [number, number, number] };
      const uid = newId('o');
      objects.push({ uid, name: this.envTree()?.nodes.get(Number(key.slice(2)))?.name ?? '', kind: 'copy', source: now.id, ...base, ghost: true, array: make(base) });
      picked.push(`o:${uid}`);
    }
    this.putScene(this.sceneEdits(), objects);
    this.envSelection = picked;
    this.sceneChanged();
  }

  /** The scene's lamps among these lights: the keys of the objects they are (an array: its object). */
  sceneLampKeys(lights: readonly { type: number; id: number }[]): string[] {
    const out = new Set<string>();
    for (const object of this.sceneRendered()) if (object.light !== undefined && lights.some((light) => light.type === object.light!.type && light.id === object.light!.id)) out.add(`o:${object.of ?? object.uid}`);
    return [...out];
  }

  /** Asked from the lights' side: open the scene with these things picked (set by main). */
  showInScene: (keys: string[]) => void = () => {};

  /** An array's others made objects of their own (the array is no more; a ghost goes). */
  detachArrays(uids: readonly string[]) {
    if (this.project === null || uids.length === 0) return;
    this.sceneStep();
    const made: string[] = [];
    const objects = structuredClone(this.sceneObjects()).flatMap((object) => {
      if (!uids.includes(object.uid) || object.array === undefined) return [object];
      const { array: _array, arrayLights: _lights, ghost, ...rest } = object;
      const others = expandObjects([object]).filter((item) => item.of !== undefined).map((item, n) => {
        const { of: _of, ...plain } = item;
        return { ...plain, uid: newId('o'), name: `${object.name} ${String(n + 2)}` };
      });
      const all = ghost === true ? others : [rest, ...others];
      made.push(...all.map((item) => `o:${item.uid}`));
      return all;
    });
    this.putScene(this.sceneEdits(), objects);
    this.envSelection = made;
    this.sceneChanged();
  }

  private sceneTimer: number | null = null;

  /** The scene's changes shown in the 3D view (a moment after the last one: the environment is built
   *  anew for it); the lamps there are then counted again (shapes that are lamps get their rows). */
  private showScene(now = false) {
    if (this.sceneTimer !== null) window.clearTimeout(this.sceneTimer);
    const run = () => {
      this.sceneTimer = null;
      const before = this.preview.environmentData();
      void this.previewEnvironmentMods(this.project?.environmentMods ?? {}).then(() => {
        this.emit('selection');
        // (the view loads the environment on its own: looked at again once it has)
        let tries = 0;
        const look = () => {
          if (this.preview.environmentData() === before && tries++ < 40) {
            window.setTimeout(look, 150);
            return;
          }
          this.recountLights();
          this.emit('selection');
        };
        look();
      });
    };
    if (now) run();
    else this.sceneTimer = window.setTimeout(run, 150);
  }

  /** The environment's lamps counted again (the scene's lamps come and go). */
  private recountLights() {
    this.lightInfo = this.preview.lights();
    const next = new Map<number, number[]>();
    for (const light of this.lightInfo) {
      if (!isLightType(light.type)) continue;
      next.set(light.type, [...(next.get(light.type) ?? []), light.lightId]);
    }
    for (const list of next.values()) list.sort((a, b) => a - b);
    if (JSON.stringify([...next]) === JSON.stringify([...this.lightsByType])) return;
    this.lightsByType = next;
    this.buildRows();
    this.emit('rows');
  }

  private sceneMerge: { key: string; at: number } | null = null;

  /** One undo step for a change to the scene (`merge`: changes of one kind in a row — one step). */
  private sceneStep(merge?: string) {
    const now = performance.now();
    if (merge !== undefined && this.sceneMerge?.key === merge && now - this.sceneMerge.at < 1500) this.sceneMerge.at = now;
    else {
      this.checkpoint();
      this.sceneMerge = merge === undefined ? null : { key: merge, at: now };
    }
  }

  private sceneChanged() {
    this.dirty = true;
    this.version++;
    this.showScene();
    this.emit('selection');
  }

  /**
   * Changes the game's objects with these Chroma ids (one undo step). An edit that changes nothing any
   * more is dropped.
   */
  changeScene(ids: readonly string[], patch: (edit: SceneEdit) => void, merge?: string) {
    if (this.project === null || ids.length === 0) return;
    this.sceneStep(merge);
    const scene = structuredClone(this.sceneEdits());
    for (const id of ids) {
      let edit = scene.find((item) => item.id === id);
      if (edit === undefined) scene.push((edit = { id }));
      patch(edit);
    }
    this.putScene(scene);
    this.sceneChanged();
  }

  /** Changes the added objects with these uids (one undo step). */
  changeObjects(uids: readonly string[], patch: (object: SceneObject) => void, merge?: string) {
    if (this.project === null || uids.length === 0) return;
    this.sceneStep(merge);
    const objects = structuredClone(this.sceneObjects());
    for (const object of objects) if (uids.includes(object.uid)) patch(object);
    this.putScene(this.sceneEdits(), objects);
    this.sceneChanged();
  }

  /** Adds objects to the scene (picked after). */
  addSceneObjects(added: SceneObject[], materials?: Record<string, SceneMaterial>) {
    if (this.project === null || added.length === 0) return;
    this.sceneStep();
    this.putScene(this.sceneEdits(), [...structuredClone(this.sceneObjects()), ...added], { ...this.sceneMaterials(), ...(materials ?? {}) });
    this.envSelection = added.map((object) => `o:${object.uid}`);
    this.sceneChanged();
  }

  removeSceneObjects(uids: readonly string[]) {
    if (this.project === null || uids.length === 0) return;
    this.sceneStep();
    this.putScene(this.sceneEdits(), this.sceneObjects().filter((object) => !uids.includes(object.uid)));
    this.envSelection = this.envSelection.filter((key) => !uids.includes(key.slice(2)) || !key.startsWith('o:'));
    this.sceneChanged();
  }

  /** A material set (new or changed; `rename`: its new name — the shapes made of it follow). */
  setSceneMaterial(name: string, material: SceneMaterial | null, rename?: string, merge?: string) {
    if (this.project === null) return;
    this.sceneStep(merge);
    const materials = structuredClone(this.sceneMaterials());
    let objects = this.sceneObjects();
    if (material === null) delete materials[name];
    else if (rename !== undefined && rename !== name && rename.trim() !== '' && materials[rename] === undefined) {
      delete materials[name];
      materials[rename] = material;
      objects = structuredClone(objects).map((object) => (object.material === name ? { ...object, material: rename } : object));
    } else materials[name] = material;
    this.putScene(this.sceneEdits(), objects, materials);
    this.sceneChanged();
  }

  private envTreeCache: { data: EnvironmentData; tree: ReturnType<typeof sceneTree> } | null = null;

  /** The game's environment as a tree (null: not loaded yet). */
  envTree() {
    const data = this.envSceneData;
    if (data === null) return null;
    if (this.envTreeCache?.data !== data) this.envTreeCache = { data, tree: sceneTree(data) };
    return this.envTreeCache.tree;
  }

  /** Where a picked thing stands (its own values, as written) and whether it's hidden; `own`: a game
   *  object's values as the game has them; `id`: its Chroma id (null: it can't be changed). */
  sceneValues(key: string): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number]; hidden: boolean; own?: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }; id?: string | null; object?: SceneObject } | null {
    if (key.startsWith('o:')) {
      const object = this.sceneObjects().find((item) => item.uid === key.slice(2));
      return object === undefined ? null : { position: object.position, rotation: object.rotation, scale: object.scale, hidden: object.hidden === true, object };
    }
    // (the player: where the game puts it — it's moved by keys only)
    if (key === 'p:player') return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], hidden: false };
    if (!key.startsWith('g:')) return null;
    const data = this.envSceneData;
    const index = Number(key.slice(2));
    const own = data === null ? null : localOf(data, index);
    if (own === null) return null;
    const id = this.envTree()?.nodes.get(index)?.id ?? null;
    const edit = id === null ? undefined : this.sceneEdits().find((item) => item.id === id);
    return { position: edit?.position ?? own.position, rotation: edit?.rotation ?? own.rotation, scale: edit?.scale ?? own.scale, hidden: edit?.hidden === true, own, id };
  }

  /**
   * Places, turns, sizes or hides picked things — the game's objects and the added ones alike (one
   * undo step). `change`: what a thing gets, from what it has now ('reset': a game's object back as
   * the game has it).
   */
  applyScene(keys: readonly string[], change: (key: string, now: NonNullable<ReturnType<Editor['sceneValues']>>) => Partial<{ position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number]; hidden: boolean }> | 'reset', merge?: string) {
    if (this.project === null || keys.length === 0) return;
    const scene = structuredClone(this.sceneEdits());
    const objects = structuredClone(this.sceneObjects());
    let any = false;
    const same = (a: readonly number[], b: readonly number[]) => a.every((value, k) => Math.abs(value - b[k]!) < 1e-6);
    const anims = structuredClone(this.sceneAnims());
    const beat = this.snapBeat(this.playhead());
    let keyedAny = false;
    for (const key of keys) {
      const now = this.sceneShown(key, this.playhead(), false);
      if (now === null) continue;
      const next = change(key, now);
      // (an animated part — or any, with ⏺ on: the change is a key at the playhead, not the thing's
      // own value)
      const target = this.animTarget(key);
      if (next !== 'reset' && target !== null) {
        let keyedHere = false;
        for (const part of MOVES) {
          const value = next[part];
          if (value === undefined || !(this.animAuto || now.keyed.includes(part) || target === 'player')) continue;
          if (target === 'player' && part === 'scale') continue;
          this.keyAt(anims, target, part, beat).value = [...value];
          delete next[part];
          keyedHere = true;
        }
        keyedAny ||= keyedHere;
        if (keyedHere && Object.keys(next).length === 0) continue;
      }
      if (now.object !== undefined) {
        const object = objects.find((item) => item.uid === now.object!.uid);
        if (object === undefined || next === 'reset') continue;
        if (next.position !== undefined) object.position = next.position;
        if (next.rotation !== undefined) object.rotation = next.rotation;
        if (next.scale !== undefined) object.scale = next.scale;
        if (next.hidden !== undefined) {
          if (next.hidden) object.hidden = true;
          else delete object.hidden;
        }
        any = true;
        continue;
      }
      if (now.id === null || now.id === undefined || now.own === undefined) continue;
      let edit = scene.find((item) => item.id === now.id);
      if (edit === undefined) scene.push((edit = { id: now.id }));
      if (next === 'reset') {
        delete edit.position;
        delete edit.rotation;
        delete edit.scale;
        delete edit.hidden;
      } else {
        // (back where the game has it: no change kept for it)
        for (const part of ['position', 'rotation', 'scale'] as const) {
          const value = next[part];
          if (value === undefined) continue;
          if (same(value, now.own[part])) delete edit[part];
          else edit[part] = value;
        }
        if (next.hidden !== undefined) {
          if (next.hidden) edit.hidden = true;
          else delete edit.hidden;
        }
      }
      any = true;
    }
    if (!any && !keyedAny) return;
    this.sceneStep(merge);
    if (keyedAny) this.putAnims(anims, false);
    this.putScene(scene, objects);
    this.sceneChanged();
  }

  /**
   * The map's own environment entries (made elsewhere, not Lumatic's) taken into the scene: an entry
   * that moves, turns, sizes or hides one object by its exact id becomes a change to that object; a
   * shape with a named or its own material becomes a shape of the scene. What's taken is from then on
   * written by Lumatic (the map's own entries of it go at the next save); the rest stays the map's.
   */
  /**
   * Environment entries made into the scene where they can be (a game object's simple change by its
   * exact id, a shape of a plain material, the fog): the scene as it then is, and what was taken and
   * left. `skip`: entries left alone without counting them (Lumatic's own).
   */
  private entriesToScene(entries: readonly Record<string, unknown>[], sourceMaterials: Record<string, Record<string, unknown>> | undefined, skip: (entry: Record<string, unknown>) => boolean = () => false) {
    const tree = this.envTree();
    const custom = { materials: sourceMaterials };
    const known = new Set([...(tree?.nodes.values() ?? [])].flatMap((node) => (node.id === null ? [] : [node.id])));
    const vector = (value: unknown): [number, number, number] | undefined => (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number') ? (value as [number, number, number]) : undefined);
    const only = (entry: Record<string, unknown>, keys: string[]) => Object.keys(entry).every((key) => keys.includes(key));
    const scene = structuredClone(this.sceneEdits());
    const objects = structuredClone(this.sceneObjects());
    const materials = structuredClone(this.sceneMaterials());
    let fog: FogValues | undefined;
    const taken: Record<string, unknown>[] = [];
    const takenMaterials: Record<string, unknown> = {};
    let left = 0;
    for (const entry of entries) {
      if (skip(entry)) continue;
      // (the fog: on the environment's root, nothing else)
      const fogComponent = (entry.components as { BloomFogEnvironment?: Record<string, unknown> } | undefined)?.BloomFogEnvironment;
      if (typeof entry.id === 'string' && /\[0\]Environment\$?$/.test(entry.id) && fogComponent !== undefined && Object.keys(entry.components as object).length === 1 && only(entry, ['id', 'lookupMethod', 'components'])) {
        fog = { ...(fog ?? {}) };
        for (const name of ['attenuation', 'offset', 'startY', 'height'] as const) if (typeof fogComponent[name] === 'number') fog[name] = fogComponent[name] as number;
        taken.push(entry);
        continue;
      }
      if (typeof entry.id === 'string' && entry.lookupMethod === 'Exact' && known.has(entry.id) && only(entry, ['id', 'lookupMethod', 'active', 'localPosition', 'localRotation', 'scale'])) {
        let edit = scene.find((item) => item.id === entry.id);
        if (edit === undefined) scene.push((edit = { id: entry.id }));
        if (entry.active === false) edit.hidden = true;
        const position = vector(entry.localPosition);
        const rotation = vector(entry.localRotation);
        const scale = vector(entry.scale);
        if (position !== undefined) edit.position = position;
        if (rotation !== undefined) edit.rotation = rotation;
        if (scale !== undefined) edit.scale = scale;
        taken.push(entry);
        continue;
      }
      const geometry = entry.geometry as { type?: string; material?: unknown } | undefined;
      if (geometry !== undefined && (SHAPES as readonly string[]).includes(geometry.type ?? '') && only(entry, ['geometry', 'position', 'rotation', 'scale', 'active', 'components'])) {
        const source = typeof geometry.material === 'string' ? custom.materials?.[geometry.material] : (geometry.material as Record<string, unknown> | undefined);
        const light = (entry.components as { ILightWithId?: { type?: number; lightID?: number } } | undefined)?.ILightWithId;
        const plain = entry.components === undefined || (Object.keys(entry.components as object).length === 1 && light !== undefined);
        const color = Array.isArray(source?.color) ? (source.color as number[]) : [1, 1, 1, 1];
        if (source !== undefined && (SHADERS as readonly string[]).includes(String(source.shader)) && only(source, ['shader', 'color']) && plain) {
          let name = typeof geometry.material === 'string' ? geometry.material : `${tr('Материал')} ${String(Object.keys(materials).length + 1)}`;
          const made: SceneMaterial = { shader: source.shader as SceneMaterial['shader'], color: [color[0] ?? 1, color[1] ?? 1, color[2] ?? 1, color[3] ?? 1] };
          // (a name taken by another look: a name of its own)
          while (materials[name] !== undefined && JSON.stringify(materials[name]) !== JSON.stringify(made)) name = `${name} ·`;
          materials[name] = made;
          if (typeof geometry.material === 'string') takenMaterials[geometry.material] = source;
          objects.push({
            uid: newId('o'),
            name: `${geometry.type!} ${String(objects.length + 1)}`,
            kind: 'shape',
            shape: geometry.type as SceneObject['shape'],
            material: name,
            position: vector(entry.position) ?? [0, 0, 0],
            rotation: vector(entry.rotation) ?? [0, 0, 0],
            scale: vector(entry.scale) ?? [1, 1, 1],
            ...(entry.active === false ? { hidden: true } : {}),
            ...(isLightShader(made.shader) && light?.lightID !== undefined ? { light: { type: light.type ?? 0, id: light.lightID } } : {}),
          });
          taken.push(entry);
          continue;
        }
      }
      left++;
    }
    return { scene, objects, materials, fog, taken, takenMaterials, left };
  }

  /** A shared Chroma environment's entries (a .dat file) made into the scene where they can be. */
  importEnvironmentFile(data: { environment?: unknown; materials?: unknown; environmentName?: unknown }) {
    const project = this.project;
    if (project === null || this.envTree() === null) return;
    if (!Array.isArray(data.environment)) {
      this.setStatus(tr('В файле нет записей окружения (environment)'));
      return;
    }
    const made = this.entriesToScene(data.environment as Record<string, unknown>[], (data.materials ?? undefined) as Record<string, Record<string, unknown>> | undefined);
    if (made.taken.length === 0) {
      this.setStatus(tr('Ни одну запись файла нельзя взять в сцену ({0})', made.left));
      return;
    }
    this.sceneStep();
    if (made.fog !== undefined) project.environmentMods = { ...(project.environmentMods ?? {}), fog: { ...(project.environmentMods?.fog ?? {}), ...made.fog } };
    this.putScene(made.scene, made.objects, made.materials);
    this.sceneChanged();
    const other = typeof data.environmentName === 'string' && data.environmentName !== (this.row?.environmentId ?? 'DefaultEnvironment');
    this.setStatus(tr('Взято в сцену записей: {0}; пропущено: {1}', made.taken.length, made.left) + (other ? ` · ${tr('файл сделан для окружения {0} — объекты этого окружения могут не найтись', String(data.environmentName))}` : ''));
  }

  /** The scene as it is (for the gallery): its parts, the environment it's for. */
  sceneSnapshot(): SceneSnapshot {
    const mods = this.project?.environmentMods ?? {};
    return structuredClone({ environment: this.row?.environmentId ?? 'DefaultEnvironment', scene: mods.scene, objects: mods.objects, materials: mods.materials, anims: mods.anims, links: mods.links, fog: mods.fog, player: mods.player, motions: mods.motions });
  }

  /**
   * A scene from the gallery put into this one (`replace`: in place of it). Its own objects get new
   * uids (their keys, links and motions follow); the game objects' changes only when it was made for
   * this environment.
   */
  applySceneSnapshot(snapshot: SceneSnapshot, replace: boolean) {
    const project = this.project;
    if (project === null) return;
    const same = snapshot.environment === (this.row?.environmentId ?? 'DefaultEnvironment');
    const uids = new Map<string, string>();
    for (const object of snapshot.objects ?? []) uids.set(`o:${object.uid}`, `o:${newId('o')}`);
    const target = (value: string) => uids.get(value) ?? value;
    const ownOrSame = (value: string) => uids.has(value) || same || value === 'fog' || value === 'player' || value.startsWith('m:');
    const objects = (snapshot.objects ?? []).map((object) => ({ ...structuredClone(object), uid: uids.get(`o:${object.uid}`)!.slice(2) })).filter((object) => same || object.kind !== 'copy');
    const anims = (snapshot.anims ?? []).filter((anim) => ownOrSame(anim.target)).map((anim) => ({ ...structuredClone(anim), target: target(anim.target) }));
    const links = (snapshot.links ?? []).filter((link) => ownOrSame(link.child) && ownOrSame(link.parent)).map((link) => ({ child: target(link.child), parent: target(link.parent) }));
    const motions = (snapshot.motions ?? []).filter((motion) => ownOrSame(motion.target)).map((motion) => ({ ...structuredClone(motion), id: newId('m'), target: target(motion.target) }));
    this.sceneStep();
    const mods: EnvironmentMods = { ...(project.environmentMods ?? {}) };
    const join = <T,>(now: T[] | undefined, added: T[]) => (replace ? added : [...(now ?? []), ...added]);
    mods.anims = join(mods.anims, anims);
    mods.links = join(mods.links, links);
    mods.motions = join(mods.motions, motions);
    if (snapshot.fog !== undefined || replace) mods.fog = snapshot.fog;
    if (snapshot.player !== undefined || replace) mods.player = snapshot.player;
    project.environmentMods = mods;
    const scene = same ? (replace ? structuredClone(snapshot.scene ?? []) : [...this.sceneEdits(), ...structuredClone(snapshot.scene ?? []).filter((edit) => !this.sceneEdits().some((item) => item.id === edit.id))]) : replace ? [] : this.sceneEdits();
    this.putScene(scene, join(structuredClone(this.sceneObjects()), objects), { ...(replace ? {} : this.sceneMaterials()), ...structuredClone(snapshot.materials ?? {}) });
    this.envSelection = [];
    this.sceneChanged();
    this.setStatus(same ? tr('Сцена из галереи применена') : tr('Сцена из галереи применена: она сделана для окружения {0}, поэтому изменения его объектов пропущены — взяты свои объекты, материалы и туман', snapshot.environment));
  }

  async importMapEnvironment() {
    const map = this.map;
    const row = this.row;
    const project = this.project;
    const tree = this.envTree();
    if (map === null || row === null || project === null || tree === null) return;
    const text = await map.folder.readText(difficultyFile(row));
    if (difficultyVersion(text) !== '3') {
      this.setStatus(tr('Записи окружения берутся из сложностей формата v3 — переведите сложность в v3 (Свойства → копия в v3)'));
      return;
    }
    const custom = ((JSON.parse(text) as { customData?: Record<string, unknown> }).customData ?? {}) as { environment?: Record<string, unknown>[]; materials?: Record<string, Record<string, unknown>> };
    // (Lumatic's own entries, as written last, are not the map's)
    const ours = new Map<string, number>();
    for (const entry of project.writtenEnvironment?.environment ?? []) ours.set(JSON.stringify(entry), (ours.get(JSON.stringify(entry)) ?? 0) + 1);
    const made = this.entriesToScene(custom.environment ?? [], custom.materials, (entry) => {
      const key = JSON.stringify(entry);
      if ((ours.get(key) ?? 0) <= 0) return false;
      ours.set(key, ours.get(key)! - 1);
      return true;
    });
    const { scene, objects, materials, taken, takenMaterials, left } = made;
    if (made.fog !== undefined) project.environmentMods = { ...(project.environmentMods ?? {}), fog: { ...(project.environmentMods?.fog ?? {}), ...made.fog } };
    if (taken.length === 0) {
      this.setStatus(left === 0 ? tr('У карты нет своих записей окружения') : tr('Своих записей окружения: {0}, но ни одну нельзя взять в сцену (они остаются в карте как есть)', left));
      return;
    }
    this.sceneStep();
    this.putScene(scene, objects, materials);
    // (from now on Lumatic's: taken out of the map with what it wrote before, at the next save)
    const written = project.writtenEnvironment ?? { environment: [], materials: {}, customEvents: [], pointDefinitions: {} };
    project.writtenEnvironment = { ...written, environment: [...written.environment, ...taken], materials: { ...written.materials, ...takenMaterials } };
    this.sceneChanged();
    this.setStatus(tr('Взято в сцену записей: {0}; осталось в карте как есть: {1}', taken.length, left));
  }

  /** A light ID no lamp of this event type has yet (the game's, the scene's). */
  freeLightId(type: number, taken: readonly number[] = []): number {
    const used = new Set<number>([...(this.lightsByType.get(type) ?? []), ...this.sceneObjects().flatMap((object) => (object.light?.type === type ? [object.light.id, ...(object.arrayLights ?? [])] : [])), ...taken]);
    let id = Math.max(100, ...used) + 1;
    while (used.has(id)) id++;
    return id;
  }

  /** While the Environment window is open: every lamp on, white at 30% (what's taken away shows). */
  staticLights = false;
  /** The map's own Chroma environment while changes are being tried in the 3D view. */
  private envPreviewBase: ChromaEnvironmentData | undefined | null = null;
  private envPreviewToken = 0;

  /**
   * The environment's changes tried in the 3D view, before they're applied (nothing saved) — null: the
   * map's own again.
   */
  async previewEnvironmentMods(mods: EnvironmentMods | null) {
    const map = this.map;
    const row = this.row;
    const project = this.project;
    if (map === null || row === null || project === null) return;
    const token = ++this.envPreviewToken;
    if (mods === null) {
      if (this.envPreviewBase === null) return;
      this.mapChroma = this.envPreviewBase;
      this.envPreviewBase = null;
      this.sceneNoodle = null;
    } else {
      const original = await map.folder.readText(difficultyFile(row));
      const version = difficultyVersion(original);
      if (version === '4') return;
      const fragment = await this.environmentFragment(mods);
      if (token !== this.envPreviewToken) return;
      // (the file as saving would make it, read back as opening does)
      const root = JSON.parse(writeDifficulty(original, [], undefined, undefined, { previous: project.writtenEnvironment, next: fragment })) as Record<string, unknown>;
      const custom = version === '2' ? parseV2ChromaEnvironment(root._customData as BeatmapCustomData) : parseV3ChromaEnvironment(root.customData as BeatmapCustomData);
      const parsed = custom.chromaEnvironment;
      // (the scene's links and the player: Noodle's — shown from the same file)
      this.sceneNoodle = version === '2' ? null : parseNoodleBeatmap(custom, 3);
      for (const animation of parsed.animations) {
        animation.songBpmTime = this.toSong(animation.jsonTime);
        animation.durationSongBpmTime = this.toSong(animation.jsonTime + animation.duration) - animation.songBpmTime;
      }
      if (this.envPreviewBase === null) this.envPreviewBase = this.mapChroma;
      this.mapChroma = parsed;
    }
    this.pushNoodle();
    // (loaded again with the ring tracks on top, as usual)
    this.ringEnhancementKey = '';
    this.ringAnimationKey = '';
    this.previewChroma = undefined;
    this.rebuildPreview(true);
  }

  /**
   * The environment's changes set (`environment`: the map's environment changed too — a ready-made one
   * is built on its own): saved, and the map opened again, the 3D view and the lights as they now are.
   */
  async setEnvironmentMods(mods: EnvironmentMods, environment?: string) {
    const map = this.map;
    const row = this.row;
    const project = this.project;
    if (map === null || row === null || project === null) return;
    this.checkpoint();
    project.environmentMods = hasMods(mods) ? mods : undefined;
    this.dirty = true;
    await this.save(environment);
    if (environment !== undefined && environment !== row.environmentId) {
      const infoName = map.folder.files.find((name) => name.toLowerCase() === 'info.dat');
      const characteristic = row.infoDifficulty?.characteristic ?? 'Standard';
      if (infoName !== undefined) await map.folder.writeText(infoName, setInfoEnvironment(await map.folder.readText(infoName), environment, difficultyFile(row), characteristic === '360Degree' || characteristic === '90Degree'));
    }
    const key = row.key;
    await this.open(map.folder);
    const again = this.difficulties().find((item) => item.key === key);
    if (again !== undefined && again !== this.row) await this.openDifficulty(again);
  }

  /** `environment`: the environment the difficulty is about to get (the environment's changes are
   *  written for it). */
  async save(environment?: string) {
    const map = this.map;
    const row = this.row;
    const project = this.project;
    if (map === null || row === null || project === null || map.folder.readOnly === true) return;
    const file = difficultyFile(row);
    // (changed while it's being written: still unsaved after)
    const version = this.version;
    const original = await map.folder.readText(file);
    const events = this.bake();
    await breather();
    // the environment's changes: the ones written before out, the ones now in
    const mods = project.environmentMods;
    const fragment = await this.environmentFragment(mods, environment);
    const changes = hasMods(mods) || !isEmptyFragment(project.writtenEnvironment) ? { previous: project.writtenEnvironment, next: fragment } : undefined;
    const text = writeDifficulty(original, events, this.ringChroma(true), this.bookmarks, changes, this.objects);
    await breather();
    const lost = unsupported(this.objects, difficultyVersion(original));
    if (changes !== undefined) project.writtenEnvironment = isEmptyFragment(fragment) ? undefined : fragment;
    // (a copy of the difficulty as it was, in the map's "Lumatic backups" — when the settings keep any)
    if (settings().backups > 0) await map.folder.backup?.(file, settings().backups).catch((error: unknown) => console.error('[lumatic] backup failed', error));
    await map.folder.writeText(file, text);
    const infoName = map.folder.files.find((name) => name.toLowerCase() === 'info.dat');
    if (infoName !== undefined) {
      let info = await map.folder.readText(infoName);
      // (the mods the environment's changes need: required; the ones they needed before and put in, out)
      // (objects placed freely on the grid: Noodle Extensions)
      const need = [...new Set([...fragmentRequirements(mods), ...(usesNoodlePlaces(this.objects) ? ['Noodle Extensions'] : [])])];
      const added = project.addedRequirements ?? [];
      if (need.length > 0 || added.length > 0) {
        const had = requirementsOf(info, file);
        info = setRequirements(info, file, need, added.filter((mod) => !need.includes(mod)));
        project.addedRequirements = need.filter((mod) => added.includes(mod) || !had.includes(mod));
      }
      if (events.some((event) => event.color !== undefined || event.lightIds !== undefined) || this.ringChroma(true).enhancements.length > 0 || hasMods(mods)) info = suggestChroma(info, file);
      await map.folder.writeText(infoName, info);
    }
    project.savedAt = Date.now();
    await breather();
    await map.folder.writeText(projectFileName(file), JSON.stringify(project));
    await map.folder.refresh();
    if (this.version === version) this.dirty = false;
    const counts = `${String(this.objects.notes.length)} нот, ${String(this.objects.bombs.length)} бомб, ${String(this.objects.walls.length)} стен`;
    this.setStatus(lost.length > 0 ? `Сохранено: ${file}, но не записаны ${lost.join('; ')}` : `Сохранено: ${file} (${String(events.length)} событий, ${counts})`);
  }

  // ----- autosave -------------------------------------------------------------------------------------

  /**
   * Unsaved changes copied aside (the map itself left as it is): the difficulty as saving would write
   * it and the project, into "Lumatic backups/autosave" — ten copies a difficulty, the oldest written
   * over. Nothing when there's nothing unsaved.
   */
  async autosaveCopy(): Promise<boolean> {
    const map = this.map;
    const row = this.row;
    const project = this.project;
    if (map === null || row === null || project === null || !this.dirty || map.folder.readOnly === true) return false;
    const file = difficultyFile(row);
    const original = await map.folder.readText(file);
    const mods = project.environmentMods;
    const fragment = await this.environmentFragment(mods);
    const changes = hasMods(mods) || !isEmptyFragment(project.writtenEnvironment) ? { previous: project.writtenEnvironment, next: fragment } : undefined;
    // (in pieces with breaths between: the page keeps answering)
    const events = this.bake();
    await breather();
    const difficulty = writeDifficulty(original, events, this.ringChroma(true), this.bookmarks, changes, this.objects);
    await breather();
    // (the project as it will be once that is written — as text at once: no copy of it needed)
    const projectText = JSON.stringify(changes === undefined ? project : { ...project, writtenEnvironment: isEmptyFragment(fragment) ? undefined : fragment });
    await breather();
    const index = await readAutosaveIndex(map.folder, file);
    const slot = index.next % AUTOSAVE_SLOTS;
    const savedAt = Date.now();
    await map.folder.writeText(autosaveName(file, slot), `{"savedAt":${String(savedAt)},"file":${JSON.stringify(file)},"difficulty":${JSON.stringify(difficulty)},"project":${projectText}}`);
    index.entries = [...index.entries.filter((entry) => entry.slot !== slot), { slot, savedAt }];
    index.next = slot + 1;
    await map.folder.writeText(autosaveIndexName(file), JSON.stringify(index));
    return true;
  }

  /** An autosave of this difficulty newer than what's saved (and not turned down before): offered
   *  back — written into the map (the files there kept in backups first) and opened again. */
  private async offerAutosave(row: DifficultyRow) {
    const map = this.map;
    const project = this.project;
    if (map === null || project === null) return;
    const file = difficultyFile(row);
    const index = await readAutosaveIndex(map.folder, file);
    const latest = [...index.entries].sort((a, b) => b.savedAt - a.savedAt)[0];
    if (latest === undefined || latest.savedAt <= (project.savedAt ?? 0) + 1000 || latest.savedAt <= (index.dismissed ?? 0)) return;
    const when = new Date(latest.savedAt).toLocaleString();
    const answer = await choose(tr('Найдена автокопия'), tr('У «{0}» есть автокопия от {1} — новее того, что сохранено (возможно, Lumatic закрылся или завис, не сохранив). Восстановить её? Текущие файлы сначала будут скопированы в «Lumatic backups».', row.label, when), [tr('Восстановить'), tr('Не нужно')]);
    if (answer !== 0) {
      index.dismissed = latest.savedAt;
      await map.folder.writeText(autosaveIndexName(file), JSON.stringify(index)).catch(() => undefined);
      return;
    }
    const saved = JSON.parse(await map.folder.readText(autosaveName(file, latest.slot))) as { difficulty: string; project: Project };
    await map.folder.backup?.(file, Math.max(5, settings().backups)).catch(() => undefined);
    await map.folder.backup?.(projectFileName(file), Math.max(5, settings().backups)).catch(() => undefined);
    await map.folder.writeText(file, saved.difficulty);
    await map.folder.writeText(projectFileName(file), JSON.stringify({ ...saved.project, savedAt: Date.now() }));
    const key = row.key;
    await this.open(map.folder);
    const again = this.difficulties().find((item) => item.key === key);
    if (again !== undefined && again !== this.row) await this.openDifficulty(again);
    this.setStatus(tr('Автокопия от {0} восстановлена', when));
  }

  // ----- rows ----------------------------------------------------------------------------------------

  get groups(): LightGroup[] {
    const project = this.project;
    if (project === null) return [];
    project.groups ??= [];
    return project.groups;
  }

  buildRows() {
    this.healEffects();
    this.version++;
    const project = this.project;
    if (project === null) {
      this.rows = [];
      return;
    }
    const rows: Row[] = [];
    const openGroups = new Set(project.expandedGroups ?? []);
    const groupLabel = (type: number) => lightGroupName(type);
    const pushGroup = (group: LightGroup, depth: number, parent: string | null, forceOpen = false) => {
      const expanded = forceOpen || openGroups.has(group.id);
      rows.push({ kind: 'custom', key: `u${group.id}`, group, label: group.name, expanded, depth, parent });
      if (!expanded) return;
      const types = new Set(groupLights(group).map((light) => light.type));
      for (const item of group.items) {
        if (item.kind === 'group') pushGroup(item, depth + 1, group.id);
        else {
          const label = types.size > 1 ? `ID ${String(item.id)} · ${groupLabel(item.type)}` : `ID ${String(item.id)}`;
          rows.push({ kind: 'light', key: `l${group.id}/${lightKey(item.type, item.id)}`, type: item.type, id: item.id, label, depth: depth + 1, parent: group.id });
        }
      }
    };
    const focused = this.focus === null ? null : findGroup(this.groups, this.focus);
    if (this.focus !== null && focused === null) this.focus = null;
    if (focused !== null) {
      pushGroup(focused.group, 0, null, true);
      this.rows = rows;
      return;
    }
    // the top rows of lights — the environment's light groups (but those a group of the user's stands
    // in for) and the user's groups — in the order the user put them
    const replaced = this.replacedTypes();
    const lightTypes = new Set<number>([...this.lightsByType.keys(), ...project.clips.filter((clip) => clip.target === undefined).map((clip) => clip.type)]);
    const tops: { key: string; push: () => void }[] = [];
    const removed = project.removedTypes ?? {};
    const taken = this.takenLights();
    for (const type of [...lightTypes].sort((a, b) => a - b)) {
      if (replaced.has(type) || removed[String(type)] !== undefined) continue;
      const all = this.lightsByType.get(type) ?? [...new Set(project.clips.filter((clip) => clip.type === type).flatMap((clip) => clip.ids ?? []))].sort((a, b) => a - b);
      // (lights a group of the user's took: not here; a row left with none isn't shown)
      const lights = all.filter((id) => taken.get(type)?.has(id) !== true);
      if (lights.length === 0 && all.length > 0) continue;
      const expanded = project.expanded.includes(type);
      tops.push({
        key: `g${String(type)}`,
        push: () => {
          rows.push({ kind: 'group', key: `g${String(type)}`, type, label: groupLabel(type), expanded, lights, depth: 0 });
          if (expanded) for (const id of lights) rows.push({ kind: 'light', key: `l${lightKey(type, id)}`, type, id, label: `ID ${String(id)}`, depth: 1, parent: null });
        },
      });
    }
    for (const group of this.groups) tops.push({ key: `u${group.id}`, push: () => pushGroup(group, 0, null) });
    const order = project.rowOrder ?? [];
    const rank = (key: string) => {
      const at = order.indexOf(key);
      return at < 0 ? Number.POSITIVE_INFINITY : at;
    };
    tops.map((top, index) => ({ top, index })).sort((a, b) => rank(a.top.key) - rank(b.top.key) || a.index - b.index).forEach(({ top }) => top.push());
    // (the ring poses, the zoom's, the lasers' moves: on the rows of their events — no rows of their own)
    const rawTypes = [...new Set(project.raw.map((event) => event.type))].sort((a, b) => a - b);
    for (const type of [8, 9, 12, 13, 5, BPM_EVENT_TYPE]) if (!rawTypes.includes(type)) rawTypes.push(type);
    for (const type of rawTypes.sort((a, b) => a - b)) rows.push({ kind: 'raw', key: `r${String(type)}`, type, label: otherEventName(type), depth: 0 });
    this.rows = rows;
  }

  /** The environment's light groups a group of the user's stands in for (type → group). */
  /** The lights groups of the user's take out of their environment rows (type → ids). */
  takenLights(): Map<number, Set<number>> {
    const out = new Map<number, Set<number>>();
    const walk = (groups: readonly LightGroup[]) => {
      for (const group of groups) {
        if (group.takesLights === true) for (const light of groupLights(group)) out.set(light.type, (out.get(light.type) ?? new Set()).add(light.id));
        walk(group.items.filter((item): item is LightGroup => item.kind === 'group'));
      }
    };
    walk(this.groups);
    return out;
  }

  /** A group's lights taken out of their environment rows, or given back. */
  setTakesLights(id: string, takes: boolean) {
    const found = findGroup(this.groups, id);
    if (found === null) return;
    this.checkpoint();
    if (takes) found.group.takesLights = true;
    else delete found.group.takesLights;
    this.groupChanged();
  }

  replacedTypes(): Map<number, string> {
    const out = new Map<number, string>();
    for (const [type, id] of Object.entries(this.project?.replacedTypes ?? {})) if (findGroup(this.groups, id) !== null) out.set(Number(type), id);
    return out;
  }

  /** The keys of the top rows of lights as they stand now. */
  topRowKeys(): string[] {
    return this.focus === null ? this.rows.filter((row) => row.depth === 0 && (row.kind === 'group' || row.kind === 'custom')).map((row) => row.key) : [];
  }

  /** A top row moved to another place among the top rows (`to`: the index it goes before). */
  moveTopRow(key: string, to: number) {
    const project = this.project;
    if (project === null) return;
    const keys = this.topRowKeys();
    const from = keys.indexOf(key);
    if (from < 0 || to === from || to === from + 1) return;
    this.checkpoint();
    keys.splice(from, 1);
    keys.splice(to > from ? to - 1 : to, 0, key);
    project.rowOrder = keys;
    this.groupChanged();
  }

  /**
   * A new top group with every light of one or more of the environment's light groups (and nothing
   * else) stands in for their rows: they're hidden, the group takes the first one's place, their
   * clips show on it. (Brought back with restoreType.)
   */
  private replaceCoveredTypes(group: LightGroup) {
    const project = this.project;
    if (project === null) return;
    const lights = groupLights(group);
    const byType = new Map<number, Set<number>>();
    for (const light of lights) byType.set(light.type, (byType.get(light.type) ?? new Set()).add(light.id));
    const covered = [...byType].filter(([type, ids]) => {
      const all = this.lightsByType.get(type) ?? [];
      return all.length > 0 && all.every((id) => ids.has(id));
    });
    if (covered.length === 0 || covered.length !== byType.size) return;
    const keys = this.topRowKeys().filter((key) => key !== `u${group.id}`);
    const first = Math.min(...covered.map(([type]) => keys.indexOf(`g${String(type)}`)).filter((at) => at >= 0));
    project.replacedTypes = { ...(project.replacedTypes ?? {}) };
    for (const [type] of covered) project.replacedTypes[String(type)] = group.id;
    const hidden = new Set(covered.map(([type]) => `g${String(type)}`));
    const rest = keys.filter((key) => !hidden.has(key));
    const at = Number.isFinite(first) ? keys.slice(0, first).filter((key) => !hidden.has(key)).length : rest.length;
    rest.splice(at, 0, `u${group.id}`);
    project.rowOrder = rest;
    project.expanded = project.expanded.filter((type) => !covered.some(([covering]) => covering === type));
  }

  /** Brings back a light group's own row (it goes back just before the group that stood in for it). */
  restoreType(type: number) {
    const project = this.project;
    const id = project?.replacedTypes?.[String(type)];
    if (project === null || id === undefined) return;
    this.checkpoint();
    const keys = this.topRowKeys();
    const at = keys.indexOf(`u${id}`);
    keys.splice(at < 0 ? keys.length : at, 0, `g${String(type)}`);
    project.rowOrder = keys;
    const next = { ...(project.replacedTypes ?? {}) };
    delete next[String(type)];
    project.replacedTypes = next;
    this.groupChanged();
  }

  /** Takes a light group of the environment off the timeline (its events stay; brought back with
   *  bringBackType). */
  removeType(type: number) {
    const project = this.project;
    if (project === null) return;
    this.checkpoint();
    const keys = this.topRowKeys();
    const at = keys.indexOf(`g${String(type)}`);
    project.removedTypes = { ...(project.removedTypes ?? {}), [String(type)]: at < 0 ? keys.length : at };
    project.rowOrder = keys.filter((key) => key !== `g${String(type)}`);
    project.expanded = project.expanded.filter((item) => item !== type);
    this.groupChanged();
  }

  /** The light groups of the environment taken off the timeline. */
  removedTypes(): number[] {
    return Object.keys(this.project?.removedTypes ?? {}).map(Number).sort((a, b) => a - b);
  }

  /** Brings a light group taken off the timeline back to where it was. */
  bringBackType(type: number) {
    const project = this.project;
    const at = project?.removedTypes?.[String(type)];
    if (project === null || at === undefined) return;
    this.checkpoint();
    const keys = this.topRowKeys();
    keys.splice(Math.min(at, keys.length), 0, `g${String(type)}`);
    project.rowOrder = keys;
    const next = { ...(project.removedTypes ?? {}) };
    delete next[String(type)];
    project.removedTypes = next;
    this.groupChanged();
  }

  toggleExpanded(type: number) {
    const project = this.project;
    if (project === null) return;
    project.expanded = project.expanded.includes(type) ? project.expanded.filter((item) => item !== type) : [...project.expanded, type];
    this.buildRows();
    this.emit('rows');
  }

  toggleGroupExpanded(id: string, open?: boolean) {
    const project = this.project;
    if (project === null) return;
    const list = project.expandedGroups ?? [];
    const isOpen = list.includes(id);
    if (open === isOpen) return;
    project.expandedGroups = isOpen ? list.filter((item) => item !== id) : [...list, id];
    this.buildRows();
    this.emit('rows');
  }

  /** Into a group: the timeline shows only it, its subgroups and lights (null: back out). */
  enterGroup(id: string | null) {
    this.focus = id;
    this.buildRows();
    this.emit('rows');
  }

  /** The groups from the top down to the one gone into. */
  focusPath(): LightGroup[] {
    return this.focus === null ? [] : (findGroup(this.groups, this.focus)?.path ?? []);
  }

  /** The lights a row stands for. */
  rowLights(row: Row): LightRef[] {
    if (row.kind === 'group') return row.lights.map((id) => ({ kind: 'light', type: row.type, id }));
    if (row.kind === 'light') return [{ kind: 'light', type: row.type, id: row.id }];
    if (row.kind === 'custom') return groupLights(row.group);
    return [];
  }

  /** The clips a row shows: every clip lighting any of its lights, lowest rank first. */
  rowClips(row: Row): ShownClip[] {
    const project = this.project;
    if (project === null || !isLightRow(row)) return [];
    const cached = this.rowCache.get(row.key);
    if (cached !== undefined && cached.version === this.version) return cached.clips;
    const groups = this.groups;
    const found: { clip: LightClip; partial: boolean; rank: number; role: ShownClip['role']; effect?: Effect }[] = [];
    const rowPriority = row.kind === 'group' ? 0 : row.kind === 'light' ? 9 : Math.min(8, findGroup(groups, row.group.id)?.depth ?? 1);
    const members = row.kind === 'custom' ? groupLights(row.group) : [];
    const memberIds = new Map<number, number[]>();
    for (const light of members) memberIds.set(light.type, [...(memberIds.get(light.type) ?? []), light.id]);
    const hidden = new Set(this.effects.filter((effect) => effect.id !== this.openEffect).map((effect) => effect.id));
    const replaced = this.replacedTypes();
    const proxies = new Map<string, Effect>();
    const candidates: LightClip[] = [];
    for (const clip of project.clips) if (clip.group === undefined || !hidden.has(clip.group)) candidates.push(clip);
    for (const effect of this.effects) {
      if (effect.id === this.openEffect) continue;
      const proxy = this.effectProxy(effect);
      proxies.set(proxy.id, effect);
      candidates.push(proxy);
      // (a group of events: shown on every row its events are on — the same block)
      if (effect.kind === 'group') {
        const seen = new Set([`${String(proxy.type)}|${String(proxy.ids)}|${proxy.target ?? ''}`]);
        for (const child of project.clips) {
          if (child.group !== effect.id) continue;
          const key = `${String(child.type)}|${String(child.ids)}|${child.target ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const { target: _target, scope: _scope, ...rest } = proxy;
          void _target;
          void _scope;
          candidates.push({ ...rest, type: child.type, ids: child.ids === null ? null : [...child.ids], ...(child.target === undefined ? {} : { target: child.target }), ...(child.scope === undefined ? {} : { scope: child.scope }) });
        }
      }
      // (a GLS block over several groups: shown on each of their rows — the same block)
      for (const lane of effect.gls?.lanes ?? []) {
        const { target: _target, scope: _scope, ...rest } = proxy;
        void _target;
        void _scope;
        candidates.push({ ...rest, type: lane.type, ids: lane.ids === null ? null : [...lane.ids], ...(lane.target === undefined ? {} : { target: lane.target }), ...(lane.ids !== null && lane.ids.length === 1 && lane.target === undefined ? { scope: 'light' as const } : {}) });
      }
    }
    for (const clip of candidates) {
      const lights = clipLights(clip, groups);
      let touched = false;
      let partial = false;
      if (row.kind === 'group') {
        if (!lights.has(row.type)) continue;
        const ids = lights.get(row.type)!;
        // (only the lights the row has: those a group took out of it don't count)
        touched = ids === null || ids.some((id) => row.lights.includes(id));
        partial = ids !== null && !(row.lights.length > 0 && row.lights.every((id) => ids.includes(id)));
      } else if (row.kind === 'light') {
        if (!lights.has(row.type)) continue;
        const ids = lights.get(row.type)!;
        touched = ids === null || ids.includes(row.id);
      } else {
        let count = 0;
        for (const [type, ids] of memberIds) {
          if (!lights.has(type)) continue;
          const lit = lights.get(type)!;
          count += lit === null ? ids.length : ids.filter((id) => lit.includes(id)).length;
        }
        touched = count > 0;
        partial = count < members.length;
      }
      if (!touched) continue;
      // (a block over several groups shows once on a row both touch)
      if (proxies.has(clip.id) && found.some((item) => item.clip.id === clip.id)) continue;
      const priority = clipPriority(clip, groups);
      let role: ShownClip['role'];
      if (row.kind === 'group') role = priority === 0 ? 'own' : 'inner';
      else if (row.kind === 'light') role = clip.scope === 'light' || (clip.target === undefined && clip.ids !== null) ? 'own' : 'background';
      // (a group standing in for a light group of the environment: that one's clips are its own)
      else role = clip.target === row.group.id || (clip.target === undefined && clip.scope !== 'light' && replaced.get(clip.type) === row.group.id) ? 'own' : priority > rowPriority ? 'inner' : 'background';
      found.push({ clip, partial, rank: clipRank(clip, groups), role, effect: proxies.get(clip.id) });
    }
    const ranks = [...new Set(found.map((item) => item.rank))].sort((a, b) => a - b);
    const clips = found
      .sort((a, b) => a.rank - b.rank || a.clip.start - b.clip.start)
      .map((item) => ({ clip: item.clip, partial: item.partial, level: ranks.indexOf(item.rank), role: item.role, ...(item.effect === undefined ? {} : { effect: item.effect }) }));
    this.rowCache.set(row.key, { version: this.version, clips });
    return clips;
  }

  pickLight(type: number, id: number) {
    this.pickedLight = { type, id };
    if (!this.lightSelection.has(lightKey(type, id))) this.flashLights([{ kind: 'light', type, id }]);
    this.emit('selection');
  }

  /** Lights picked for grouping; `context`: the user's group they were picked in (its rows). */
  selectLights(keys: Iterable<string>, mode: 'replace' | 'add' | 'toggle' = 'replace', context: string | null = null) {
    if (mode === 'replace' || context !== this.lightSelectionContext) this.lightSelectionContext = context;
    if (mode === 'replace') this.lightSelection = new Set(keys);
    else for (const key of keys) {
      if (mode === 'toggle' && this.lightSelection.has(key)) this.lightSelection.delete(key);
      else this.lightSelection.add(key);
    }
    this.flashLights(this.selectedLights());
    this.emit('lights');
  }

  selectedLights(): LightRef[] {
    return [...this.lightSelection].map((key) => {
      const [type, id] = key.split(':').map(Number);
      return { kind: 'light', type: type!, id: id! };
    });
  }

  // ----- groups ----------------------------------------------------------------------------------------

  /** Effects left running over a group that is no more (deleted in an older version): put over the
   *  lights their events are on, so they can be picked and removed again. */
  private healEffects() {
    const project = this.project;
    if (project === null) return;
    for (const effect of [...(project.effects ?? [])]) {
      if (effect.target === undefined || findGroup(this.groups, effect.target) !== null) continue;
      const byType = new Map<number, number[] | null>();
      for (const clip of project.clips) {
        if (clip.group !== effect.id || clip.target !== undefined) continue;
        const have = byType.get(clip.type);
        byType.set(clip.type, clip.ids === null || have === null ? null : [...new Set([...(have ?? []), ...clip.ids])]);
      }
      delete effect.target;
      [...byType].forEach(([type, ids], at) => {
        if (at === 0) {
          effect.type = type;
          effect.ids = ids;
          return;
        }
        const part: Effect = { ...structuredClone(effect), id: newId('e'), type, ids };
        (project.effects ??= []).push(part);
        for (const clip of project.clips) if (clip.group === effect.id && clip.type === type) clip.group = part.id;
      });
    }
  }

  /** What each group lit when its effects were last made (its lights, in order). */
  private groupLit = new Map<string, string>();

  private groupChanged() {
    // (a group's lights changed: the effects running over it are made anew for what it is now —
    // else their events stay on lights the group no longer has, and can't be reached)
    const project = this.project;
    if (project !== null) {
      const lit = new Map<string, string>();
      const walk = (group: LightGroup) => {
        lit.set(group.id, JSON.stringify(group.items.map((item) => (item.kind === 'group' ? item.id : lightKey(item.type, item.id)))) + groupLights(group).map((light) => lightKey(light.type, light.id)).join(','));
        for (const item of group.items) if (item.kind === 'group') walk(item);
      };
      for (const group of this.groups) walk(group);
      for (const effect of project.effects ?? []) {
        if (effect.target === undefined || !lit.has(effect.target)) continue;
        const before = this.groupLit.get(effect.target);
        if (before !== undefined && before !== lit.get(effect.target)) this.regenerate(effect);
      }
      this.groupLit = lit;
    }
    this.buildRows();
    this.changed(true);
    this.emit('rows');
  }

  /**
   * A group from the picked lights. When they all sit right inside one group of the user's, they
   * are wrapped into a subgroup there, where the first of them was; otherwise a new group of its own.
   */
  groupSelectedLights(name: string): LightGroup | null {
    const project = this.project;
    const lights = this.selectedLights();
    if (project === null || lights.length === 0) return null;
    this.checkpoint();
    const group: LightGroup = { kind: 'group', id: newId('g'), name, items: [] };
    const holder = this.commonParent(lights);
    if (holder !== null) {
      project.expandedGroups = [...new Set([...(project.expandedGroups ?? []), holder.id])];
      const keys = new Set(lights.map((light) => lightKey(light.type, light.id)));
      const at = holder.items.findIndex((item) => item.kind === 'light' && keys.has(lightKey(item.type, item.id)));
      // (in the order they stand in the group)
      group.items = holder.items.filter((item): item is LightRef => item.kind === 'light' && keys.has(lightKey(item.type, item.id))).map((item) => ({ ...item }));
      holder.items = holder.items.filter((item) => !(item.kind === 'light' && keys.has(lightKey(item.type, item.id))));
      holder.items.splice(Math.min(at, holder.items.length), 0, group);
    } else {
      group.items = lights.map((light) => ({ ...light }));
      this.groups.push(group);
      this.replaceCoveredTypes(group);
    }
    project.expandedGroups = [...new Set([...(project.expandedGroups ?? []), group.id])];
    this.lightSelection.clear();
    this.groupChanged();
    return group;
  }

  /** The user's group the lights were picked in, when every one of them sits right inside it. */
  private commonParent(lights: LightRef[]): LightGroup | null {
    if (this.lightSelectionContext === null) return null;
    const group = findGroup(this.groups, this.lightSelectionContext)?.group;
    if (group === undefined) return null;
    const direct = new Set(group.items.filter((child): child is LightRef => child.kind === 'light').map((child) => lightKey(child.type, child.id)));
    return lights.every((light) => direct.has(lightKey(light.type, light.id))) ? group : null;
  }

  /** A new top group with the given items (ring presets, groups from lights). */
  addGroup(name: string, items: GroupItem[], open = true): LightGroup {
    const project = this.project!;
    this.checkpoint();
    const group: LightGroup = { kind: 'group', id: newId('g'), name, items };
    this.groups.push(group);
    this.replaceCoveredTypes(group);
    if (open) project.expandedGroups = [...new Set([...(project.expandedGroups ?? []), group.id])];
    this.groupChanged();
    return group;
  }

  renameGroup(id: string, name: string) {
    const found = findGroup(this.groups, id);
    if (found === null || name.trim() === '') return;
    this.checkpoint();
    found.group.name = name.trim();
    this.groupChanged();
  }

  /**
   * Removes a group. Its clips stay where they were: they go on lighting the same lights (as
   * clips of the event types). `keepItems`: a subgroup's lights go up into its parent (ungroup).
   */
  deleteGroup(id: string, keepItems: boolean) {
    const project = this.project;
    const found = findGroup(this.groups, id);
    if (project === null || found === null) return;
    this.checkpoint();
    const groups = this.groups;
    const doomed = new Set<string>();
    const collect = (group: LightGroup) => {
      doomed.add(group.id);
      for (const item of group.items) if (item.kind === 'group') collect(item);
    };
    if (keepItems) doomed.add(id);
    else collect(found.group);
    // the effects running over it: over its lights directly (one an event type; none left: gone)
    const moved: Effect[] = [];
    const split = new Map<string, Map<number, string>>();
    for (const effect of [...(project.effects ?? [])]) {
      if (effect.target === undefined || !doomed.has(effect.target)) continue;
      const group = findGroup(groups, effect.target)?.group;
      const byType = new Map<number, number[]>();
      for (const light of group === undefined ? [] : groupLights(group)) byType.set(light.type, [...(byType.get(light.type) ?? []), light.id]);
      delete effect.target;
      if (byType.size === 0) {
        project.effects = (project.effects ?? []).filter((item) => item !== effect);
        project.clips = project.clips.filter((clip) => clip.group !== effect.id);
        project.raw = project.raw.filter((event) => event.group !== effect.id);
        continue;
      }
      const ids = new Map<number, string>();
      [...byType].forEach(([type, list], at) => {
        const one: Effect = at === 0 ? effect : { ...structuredClone(effect), id: newId('e') };
        one.type = type;
        one.ids = list;
        if (at > 0) (project.effects ??= []).push(one);
        ids.set(type, one.id);
        moved.push(one);
      });
      split.set(effect.id, ids);
    }
    // the clips drawn on it: onto its lights directly
    const replaced: LightClip[] = [];
    project.clips = project.clips.filter((clip) => {
      if (clip.target === undefined || !doomed.has(clip.target)) return true;
      for (const [type, ids] of clipLights(clip, groups)) {
        const copy = cloneClip(clip, { type, ids: ids === null ? null : [...ids], id: replaced.length === 0 ? clip.id : undefined });
        delete copy.target;
        if (ids !== null && ids.length === 1) copy.scope = 'light';
        replaced.push(copy);
      }
      return false;
    });
    project.clips.push(...replaced);
    // (a hand-changed effect split by event type: its events go with the part of their type)
    for (const clip of project.clips) {
      const part = clip.group === undefined ? undefined : split.get(clip.group)?.get(clip.type);
      if (part !== undefined) clip.group = part;
    }
    // the light groups it stood in for: their rows back where it was
    const standIns = Object.entries(project.replacedTypes ?? {}).filter(([, groupId]) => doomed.has(groupId));
    if (standIns.length > 0) {
      const keys = this.topRowKeys();
      const at = keys.indexOf(`u${found.group.id}`);
      if (at >= 0) keys.splice(at, 0, ...standIns.map(([type]) => `g${type}`));
      project.rowOrder = keys;
      const next = { ...(project.replacedTypes ?? {}) };
      for (const [type] of standIns) delete next[type];
      project.replacedTypes = next;
    }
    const holder = parentOf(groups, found.group);
    if (holder !== null) {
      const at = holder.items.indexOf(found.group);
      holder.items.splice(at, 1, ...(keepItems && found.depth > 1 ? found.group.items : []));
    }
    if (this.focus !== null && doomed.has(this.focus)) this.focus = null;
    for (const effect of moved) this.regenerate(effect);
    this.groupChanged();
  }

  /** Puts lights into a group (at its end; ones already in it stay where they are). */
  addLightsToGroup(id: string, lights: LightRef[]) {
    const found = findGroup(this.groups, id);
    if (found === null || lights.length === 0) return;
    this.checkpoint();
    const have = new Set(groupLights(found.group).map((light) => lightKey(light.type, light.id)));
    for (const light of lights) if (!have.has(lightKey(light.type, light.id))) found.group.items.push({ kind: 'light', type: light.type, id: light.id });
    this.groupChanged();
  }

  /** Takes lights out of a group and all of its subgroups. */
  removeLightsFromGroup(id: string, lights: LightRef[]) {
    const found = findGroup(this.groups, id);
    if (found === null || lights.length === 0) return;
    this.checkpoint();
    const keys = new Set(lights.map((light) => lightKey(light.type, light.id)));
    const strip = (group: LightGroup) => {
      group.items = group.items.filter((item) => item.kind === 'group' || !keys.has(lightKey(item.type, item.id)));
      for (const item of group.items) if (item.kind === 'group') strip(item);
    };
    strip(found.group);
    this.groupChanged();
  }

  /** Moves one item of a group (a light or a subgroup) to another place among its siblings. */
  moveGroupItem(parentId: string, from: number, to: number) {
    const found = findGroup(this.groups, parentId);
    if (found === null) return;
    const items = found.group.items;
    if (from < 0 || from >= items.length || to < 0 || to > items.length || to === from || to === from + 1) return;
    this.checkpoint();
    const [item] = items.splice(from, 1);
    items.splice(to > from ? to - 1 : to, 0, item!);
    this.groupChanged();
  }

  /** Sorts a group's own items (subgroups by where their lights are on average). */
  sortGroup(id: string, key: SortKey) {
    const found = findGroup(this.groups, id);
    if (found === null) return;
    this.checkpoint();
    const items = found.group.items;
    if (key === 'reverse') items.reverse();
    else {
      const center = this.center(groupLights(found.group));
      const measure = (item: GroupItem): number => {
        if (key === 'id') return item.kind === 'light' ? item.type * 100000 + item.id : Math.min(...groupLights(item).map((light) => light.type * 100000 + light.id));
        const position = this.center(item.kind === 'light' ? [item] : groupLights(item));
        if (key === 'x') return position[0];
        if (key === 'y') return position[1];
        if (key === 'z') return this.depthOf(position);
        return angleOf(position[0] - center[0], position[1] - center[1]);
      };
      const order = items.map((item) => ({ item, value: measure(item) }));
      order.sort((a, b) => a.value - b.value);
      found.group.items = order.map((entry) => entry.item);
    }
    this.groupChanged();
  }

  /** How far ahead of the player a point is (the environments look down -z or +z). */
  depthOf(position: readonly number[]) {
    return position[2]! * this.forward;
  }

  /** Which way along z is ahead: +1 or -1 (from where the environment's lights are). */
  get forward() {
    const mean = this.lightInfo.reduce((sum, light) => sum + light.position[2], 0) / Math.max(1, this.lightInfo.length);
    return mean < 0 ? -1 : 1;
  }

  /** Where some lights are, on average (from the environment's layout). */
  center(lights: readonly LightRef[]): [number, number, number] {
    const points = lights.map((light) => this.lightInfo.find((info) => info.type === light.type && info.lightId === light.id)?.position).filter((point) => point !== undefined);
    if (points.length === 0) return [0, 0, 0];
    return [0, 1, 2].map((axis) => points.reduce((sum, point) => sum + point[axis]!, 0) / points.length) as [number, number, number];
  }

  /** The ring groups of the environment that light group `type` has lights in. */
  ringTypes(): number[] {
    const types = new Set<number>();
    for (const light of this.lightInfo) if (light.ring !== null && this.lightsByType.has(light.type)) types.add(light.type);
    return [...types].sort((a, b) => a - b);
  }

  /**
   * The ring presets: the lights of event type `type` that sit on rings, as subgroups — one per
   * ring, nearest first ('rings'), or one per line through all of them: the first light of every
   * ring, the second… going round from the top ('lines').
   */
  ringPreset(type: number, mode: 'rings' | 'lines'): LightGroup | null {
    const onRings = this.lightInfo.filter((light) => light.type === type && light.ring !== null && this.lightsByType.has(type));
    if (onRings.length === 0) return null;
    const rings = new Map<string, typeof onRings>();
    for (const light of onRings) {
      const key = `${String(light.ring!.group)}:${String(light.ring!.index)}`;
      rings.set(key, [...(rings.get(key) ?? []), light]);
    }
    const ordered = [...rings.values()]
      .map((lights) => {
        const cx = lights.reduce((sum, light) => sum + light.position[0], 0) / lights.length;
        const cy = lights.reduce((sum, light) => sum + light.position[1], 0) / lights.length;
        const z = lights.reduce((sum, light) => sum + this.depthOf(light.position), 0) / lights.length;
        const index = lights[0]!.ring!.group * 1000 + lights[0]!.ring!.index;
        const round = lights
          .map((light) => ({ light, angle: angleOf(light.position[0] - cx, light.position[1] - cy) }))
          .sort((a, b) => a.angle - b.angle || a.light.lightId - b.light.lightId)
          .map((entry) => entry.light);
        return { z, index, round };
      })
      // (the rings in their own order: the nearest first)
      .sort((a, b) => a.index - b.index || a.z - b.z);
    const ref = (light: (typeof onRings)[number]): LightRef => ({ kind: 'light', type: light.type, id: light.lightId });
    let items: GroupItem[];
    if (mode === 'rings') {
      items = ordered.map((ring, index) => ({ kind: 'group', id: newId('g'), name: `Кольцо ${String(index + 1)}`, items: ring.round.map(ref) }));
    } else {
      const count = Math.max(...ordered.map((ring) => ring.round.length));
      items = [];
      for (let line = 0; line < count; line++) {
        const lights = ordered.map((ring) => ring.round[line]).filter((light) => light !== undefined).map(ref);
        if (lights.length > 0) items.push({ kind: 'group', id: newId('g'), name: `Линия ${String(line + 1)}`, items: lights });
      }
    }
    const name = `${lightGroupName(type)}: ${mode === 'rings' ? 'по кольцам' : 'по линиям'}`;
    return this.addGroup(name, items);
  }

  /** The lights of an event type, sorted (by depth / height / left to right / ID). */
  private sortedLights(type: number, key: 'z' | 'y' | 'x' | 'id' = 'z'): LightRef[] {
    const lights = (this.lightsByType.get(type) ?? []).map((id): LightRef => ({ kind: 'light', type, id }));
    const info = (light: LightRef) => this.lightInfo.find((item) => item.type === light.type && item.lightId === light.id)?.position ?? [0, 0, 0];
    const value = (light: LightRef) => (key === 'id' ? light.id : key === 'x' ? info(light)[0] : key === 'y' ? info(light)[1] : this.depthOf(info(light)));
    return lights.sort((a, b) => value(a) - value(b) || a.id - b.id);
  }

  /**
   * Laser templates: the left and right lasers (or any two event types) as pairs — the nearest left
   * with the nearest right, and so on ('pairs', each a subgroup); or one side then the other
   * ('sides', two subgroups). For one type whose lights stand on both sides (the back lasers), its
   * left and right halves.
   */
  laserPreset(mode: 'pairs' | 'sides', leftType: number, rightType: number | null): LightGroup | null {
    let left: LightRef[];
    let right: LightRef[];
    if (rightType === null) {
      const all = this.sortedLights(leftType, 'z');
      const x = (light: LightRef) => this.lightInfo.find((item) => item.type === light.type && item.lightId === light.id)?.position[0] ?? 0;
      left = all.filter((light) => x(light) < 0).sort((a, b) => Math.abs(x(a)) - Math.abs(x(b)) || a.id - b.id);
      right = all.filter((light) => x(light) >= 0).sort((a, b) => Math.abs(x(a)) - Math.abs(x(b)) || a.id - b.id);
    } else {
      left = this.sortedLights(leftType, 'z');
      right = this.sortedLights(rightType, 'z');
    }
    if (left.length + right.length === 0) return null;
    const title = rightType === null ? lightGroupName(leftType) : `${lightGroupName(leftType)} + ${lightGroupName(rightType)}`;
    let items: GroupItem[];
    if (mode === 'pairs') {
      items = [];
      for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const pair = [left[i], right[i]].filter((light) => light !== undefined);
        items.push({ kind: 'group', id: newId('g'), name: `Пара ${String(i + 1)}`, items: pair });
      }
    } else {
      items = [
        { kind: 'group', id: newId('g'), name: 'Левые', items: left },
        { kind: 'group', id: newId('g'), name: 'Правые', items: right },
      ];
    }
    return this.addGroup(`${title}: ${mode === 'pairs' ? 'парами' : 'по сторонам'}`, items);
  }

  /** The lights the laser speed events turn (the rotating lasers), left and right, near to far. */
  movingLasers(): { left: LightRef[]; right: LightRef[] } {
    const moving = (light: LightRef) => this.lightInfo.some((item) => item.type === light.type && item.lightId === light.id && item.moving);
    const x = (light: LightRef) => this.lightInfo.find((item) => item.type === light.type && item.lightId === light.id)?.position[0] ?? 0;
    const types = [...this.lightsByType.keys()].filter((type) => this.sortedLights(type, 'z').some(moving));
    const all = types.flatMap((type) => this.sortedLights(type, 'z').filter(moving));
    // (by their event type where it says the side — 2 left, 3 right — else by where they stand)
    const side = (light: LightRef) => (light.type === 2 ? 'left' : light.type === 3 ? 'right' : x(light) < 0 ? 'left' : 'right');
    return { left: all.filter((light) => side(light) === 'left'), right: all.filter((light) => side(light) === 'right') };
  }

  /** A group of only the rotating lasers: by side, or in pairs (the nearest left with the nearest right…). */
  movingLasersPreset(mode: 'pairs' | 'sides'): LightGroup | null {
    const { left, right } = this.movingLasers();
    if (left.length + right.length === 0) return null;
    const items: GroupItem[] =
      mode === 'pairs'
        ? Array.from({ length: Math.max(left.length, right.length) }, (_, i) => ({ kind: 'group' as const, id: newId('g'), name: `Пара ${String(i + 1)}`, items: [left[i], right[i]].filter((light): light is LightRef => light !== undefined) }))
        : [
            { kind: 'group', id: newId('g'), name: 'Левые', items: left },
            { kind: 'group', id: newId('g'), name: 'Правые', items: right },
          ];
    // (the lasers leave the environment's rows: those keep only the other lights)
    const group = this.addGroup(`Подвижные лазеры: ${mode === 'pairs' ? 'парами' : 'по сторонам'}`, items);
    group.takesLights = true;
    this.groupChanged();
    return group;
  }

  /** One group of an event type's lights in the order of where they are. */
  orderedPreset(type: number, key: 'z' | 'y' | 'x'): LightGroup | null {
    const lights = this.sortedLights(type, key);
    if (lights.length === 0) return null;
    const how = key === 'z' ? 'от ближних к дальним' : key === 'y' ? 'снизу вверх' : 'слева направо';
    return this.addGroup(`${lightGroupName(type)}: ${how}`, lights);
  }

  // ----- edits -------------------------------------------------------------------------------------

  private snapshot() {
    const project = this.project;
    if (project === null) return '';
    // (an effect's events made from its settings aren't kept — they're made again on undo: a vibrato
    // is thousands of them, and each change wrote them all out)
    const made = new Set((project.effects ?? []).filter((effect) => effect.custom !== true).map((effect) => effect.id));
    const clips = made.size === 0 ? project.clips : project.clips.filter((clip) => clip.group === undefined || !made.has(clip.group));
    const raw = made.size === 0 ? project.raw : project.raw.filter((event) => event.group === undefined || !made.has(event.group));
    return JSON.stringify({ clips, raw, groups: project.groups ?? [], effects: project.effects ?? [], ringBlocks: project.ringBlocks ?? [], bookmarks: project.bookmarks ?? [], rowOrder: project.rowOrder ?? [], replacedTypes: project.replacedTypes ?? {}, removedTypes: project.removedTypes ?? {}, presets: project.presets ?? null, scene: project.environmentMods?.scene ?? [], sceneObjects: project.environmentMods?.objects ?? [], sceneMaterials: project.environmentMods?.materials ?? {}, sceneAnims: project.environmentMods?.anims ?? [], sceneMore: sceneExtras(project.environmentMods) });
  }

  /** Call before a change (one undo step). */
  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
  }

  /** A group of events (a copy of a map's preset) changed while gone into: presets.ts keeps its other
   *  copies the same. */
  groupEditedHook: ((group: Effect) => void) | null = null;

  /** After a change: redraw, preview again. */
  changed(rebuildNow = false) {
    this.syncTiming(true);
    this.version++;
    this.dirty = true;
    this.previewExtra = null;
    this.noteHandEdits();
    const open = this.openEffect === null ? undefined : this.effectById(this.openEffect);
    if (open !== undefined && open.kind === 'group' && open.presetSync === true) this.groupEditedHook?.(open);
    this.rebuildPreview(rebuildNow);
    this.emit('clips');
  }

  /** The last checkpoint wasn't needed after all (a click that didn't change anything). */
  undoDiscard() {
    this.undoStack.pop();
  }

  undo() {
    if (this.tab === 'notes') {
      this.undoNotes();
      return;
    }
    const state = this.undoStack.pop();
    if (state === undefined || this.project === null) return;
    this.redoStack.push(this.snapshot());
    this.restore(state);
  }

  redo() {
    if (this.tab === 'notes') {
      this.redoNotes();
      return;
    }
    const state = this.redoStack.pop();
    if (state === undefined || this.project === null) return;
    this.undoStack.push(this.snapshot());
    this.restore(state);
  }

  private restore(state: string, notify = true) {
    const project = this.project;
    if (project === null) return;
    const data = JSON.parse(state) as { clips: LightClip[]; raw: RawEvent[]; groups: LightGroup[]; effects?: Effect[]; ringBlocks?: RingBlock[]; bookmarks?: Bookmark[]; rowOrder?: string[]; replacedTypes?: Record<string, string>; removedTypes?: Record<string, number>; presets?: unknown[] | null; scene?: SceneEdit[]; sceneObjects?: SceneObject[]; sceneMaterials?: Record<string, SceneMaterial>; sceneAnims?: SceneAnim[]; sceneMore?: ReturnType<typeof sceneExtras> };
    project.bookmarks = data.bookmarks ?? [];
    // (the scene editor's changes: as they were, shown again)
    if (JSON.stringify([project.environmentMods?.scene ?? [], project.environmentMods?.objects ?? [], project.environmentMods?.materials ?? {}, project.environmentMods?.anims ?? [], sceneExtras(project.environmentMods)]) !== JSON.stringify([data.scene ?? [], data.sceneObjects ?? [], data.sceneMaterials ?? {}, data.sceneAnims ?? [], data.sceneMore ?? sceneExtras(undefined)])) {
      // (the links, the fog, the player, the motions: as they were)
      const more = data.sceneMore ?? sceneExtras(undefined);
      const mods: EnvironmentMods = { ...(project.environmentMods ?? {}) };
      for (const name of ['links', 'fog', 'player', 'motions'] as const) {
        if (more[name] === undefined) delete mods[name];
        else (mods as Record<string, unknown>)[name] = structuredClone(more[name]);
      }
      project.environmentMods = mods;
      this.putAnims(data.sceneAnims ?? [], false);
      this.putScene(data.scene ?? [], data.sceneObjects ?? [], data.sceneMaterials ?? {});
      const uids = new Set((data.sceneObjects ?? []).map((object) => object.uid));
      this.envSelection = this.envSelection.filter((key) => !key.startsWith('o:') || uids.has(key.slice(2)));
      this.showScene();
    }
    // (the map's presets: as they were — the other difficulties' copies too)
    if (data.presets !== undefined && JSON.stringify(data.presets ?? null) !== JSON.stringify(project.presets ?? null)) {
      if (data.presets === null) delete project.presets;
      else this.setMapPresets(data.presets);
      window.dispatchEvent(new Event('lumatic-presets'));
    }
    const rowsChanged = JSON.stringify(project.rowOrder ?? []) !== JSON.stringify(data.rowOrder ?? []) || JSON.stringify(project.replacedTypes ?? {}) !== JSON.stringify(data.replacedTypes ?? {}) || JSON.stringify(project.removedTypes ?? {}) !== JSON.stringify(data.removedTypes ?? {});
    project.rowOrder = data.rowOrder ?? [];
    project.replacedTypes = data.replacedTypes ?? {};
    project.removedTypes = data.removedTypes ?? {};
    project.clips = data.clips;
    project.raw = data.raw;
    this.syncTiming(false);
    project.effects = data.effects ?? [];
    // (the events their settings make: made again — they aren't in the snapshot)
    for (const effect of project.effects) if (effect.custom !== true) this.regenerate(effect);
    const hadPoses = (project.ringBlocks ?? []).length > 0;
    project.ringBlocks = data.ringBlocks ?? [];
    if (this.openEffect !== null && !project.effects.some((effect) => effect.id === this.openEffect)) this.openEffect = null;
    const groupsChanged = JSON.stringify(project.groups ?? []) !== JSON.stringify(data.groups);
    project.groups = data.groups;
    const ids = new Set([...data.clips.map((clip) => clip.id), ...data.raw.map((event) => event.id), ...project.effects.map((effect) => effect.id), ...project.ringBlocks.map((block) => block.id)]);
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
    if (groupsChanged || rowsChanged || hadPoses !== project.ringBlocks.length > 0) {
      this.buildRows();
      this.emit('rows');
    }
    if (notify) this.changed(true);
  }

  newClip(type: number, ids: number[] | null, start: number, end: number): LightClip {
    const brush = this.brush;
    return {
      id: newId(),
      type,
      ids,
      start,
      end,
      startMode: brush.startMode,
      fadeIn: brush.fadeIn,
      endMode: brush.endMode,
      ...(brush.fadeOut !== undefined && brush.fadeOut > 0 ? { fadeOut: brush.fadeOut } : {}),
      color: { ...brush.color },
      endColor: brush.endColor === null ? null : { ...brush.endColor },
      layer: brush.layer,
      ...(brush.hsv ? { hsv: true } : {}),
    };
  }

  /** A new clip (the brush's) on a row of the timeline: lighting what the row stands for. */
  newClipForRow(row: Row, start: number, end: number): LightClip | null {
    const clip = this.plainClipForRow(row, start, end);
    // (drawn inside an effect that is gone into: it becomes one of its events)
    const open = this.openEffect === null ? undefined : this.effectById(this.openEffect);
    if (clip !== null && open !== undefined) {
      clip.group = open.id;
      clip.layer = open.layer;
    }
    return clip;
  }

  private plainClipForRow(row: Row, start: number, end: number): LightClip | null {
    if (!isLightRow(row)) return null;
    // (a row some of whose lights a group took: only the ones left)
    if (row.kind === 'group') return this.newClip(row.type, this.takenLights().has(row.type) ? [...row.lights] : null, start, end);
    if (row.kind === 'light') return { ...this.newClip(row.type, [row.id], start, end), scope: 'light' };
    const first = groupLights(row.group)[0];
    return { ...this.newClip(first?.type ?? 0, null, start, end), target: row.group.id };
  }

  /** Puts a clip onto another row (what it lights becomes what that row stands for). */
  retarget(clip: LightClip, row: Row) {
    if (!isLightRow(row)) return;
    delete clip.target;
    delete clip.scope;
    if (row.kind === 'group') {
      clip.type = row.type;
      clip.ids = this.takenLights().has(row.type) ? [...row.lights] : null;
    } else if (row.kind === 'light') {
      clip.type = row.type;
      clip.ids = [row.id];
      clip.scope = 'light';
    } else {
      clip.type = groupLights(row.group)[0]?.type ?? clip.type;
      clip.ids = null;
      clip.target = row.group.id;
    }
  }

  addClip(clip: LightClip) {
    const project = this.project;
    if (project === null) return;
    this.checkpoint();
    project.clips.push(clip);
    this.selection = new Set([clip.id]);
    this.changed();
  }

  clipById(id: string) {
    return this.project?.clips.find((clip) => clip.id === id);
  }

  rawById(id: string) {
    return this.project?.raw.find((event) => event.id === id);
  }

  selectedRaw(): RawEvent[] {
    return this.project?.raw.filter((event) => this.selection.has(event.id)) ?? [];
  }

  selectedClips(): LightClip[] {
    return this.project?.clips.filter((clip) => this.selection.has(clip.id)) ?? [];
  }

  select(ids: Iterable<string>, mode: 'replace' | 'add' | 'toggle' | 'remove' = 'replace') {
    this.posePick = null;
    if (mode === 'replace') this.selection = new Set(ids);
    else for (const id of ids) {
      if (mode === 'remove' || (mode === 'toggle' && this.selection.has(id))) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.emit('selection');
  }

  /** Changes these other events (ring turns, zoom, laser speed — the inspector). */
  updateRaw(ids: readonly string[], patch: (event: RawEvent) => void) {
    const events = this.project?.raw.filter((event) => ids.includes(event.id)) ?? [];
    if (events.length === 0) return;
    this.checkpoint();
    for (const event of events) patch(event);
    this.changed();
  }

  /** Changes the selected clips (the inspector). */
  updateSelected(patch: (clip: LightClip) => void) {
    const clips = this.selectedClips();
    if (clips.length === 0) return;
    this.checkpoint();
    for (const clip of clips) patch(clip);
    this.changed();
  }

  deleteSelection() {
    const project = this.project;
    if (project === null || this.selection.size === 0) return;
    this.checkpoint();
    const effects = new Set(this.effects.filter((effect) => this.selection.has(effect.id)).map((effect) => effect.id));
    project.effects = this.effects.filter((effect) => !effects.has(effect.id));
    if (this.openEffect !== null && effects.has(this.openEffect)) this.openEffect = null;
    project.clips = project.clips.filter((clip) => !this.selection.has(clip.id) && (clip.group === undefined || !effects.has(clip.group)));
    project.raw = project.raw.filter((event) => !this.selection.has(event.id) && (event.group === undefined || !effects.has(event.group)));
    project.ringBlocks = this.ringBlocks.filter((block) => !this.selection.has(block.id));
    this.selection.clear();
    this.changed();
  }

  selectAll() {
    const project = this.project;
    if (project === null) return;
    const hidden = new Set(this.effects.filter((effect) => effect.id !== this.openEffect).map((effect) => effect.id));
    this.select([...project.clips.filter((clip) => clip.group === undefined || !hidden.has(clip.group)).map((clip) => clip.id), ...project.raw.filter((event) => event.group === undefined || !hidden.has(event.group)).map((event) => event.id), ...this.effects.filter((effect) => effect.id !== this.openEffect).map((effect) => effect.id), ...this.ringBlocks.map((block) => block.id)]);
  }

  copy() {
    const project = this.project;
    if (project === null) return;
    const clips = this.selectedClips().map((clip) => cloneClip(clip, { id: clip.id }));
    const raw = project.raw.filter((event) => this.selection.has(event.id)).map((event) => ({ ...event }));
    const effects = this.selectedEffects().map((effect) => ({ effect: structuredClone(effect), children: this.effectChildren(effect.id).map((clip) => cloneClip(clip, { id: clip.id })), raw: this.effectRaw(effect.id).map((event) => structuredClone(event)) }));
    const ringBlocks = this.selectedRingBlocks().map((block) => structuredClone(block));
    // (where each was: for pasting into other rows, the rows kept in their order)
    const from = new Map<string, string>();
    for (const id of [...clips.map((clip) => clip.id), ...effects.map((item) => item.effect.id)]) {
      const row = this.ownRowOf(id);
      if (row !== null) from.set(id, row.key);
    }
    const rows = this.rows.map((row) => row.key).filter((key) => [...from.values()].includes(key));
    if (clips.length + raw.length + effects.length + ringBlocks.length > 0) this.clipboard = { clips, raw, effects, ringBlocks, from, rows };
  }

  /** What there is to paste: how many things, from how many rows (null: nothing). */
  clipboardInfo(): { count: number; rows: number } | null {
    const board = this.clipboard;
    if (board === null) return null;
    return { count: board.clips.length + board.raw.length + board.effects.length + board.ringBlocks.length, rows: board.rows.length };
  }

  /** The row a clip or an effect stands on as its own. */
  private ownRowOf(id: string): Row | null {
    return this.rows.find((row) => isLightRow(row) && this.rowClips(row).some((shown) => shown.clip.id === id && shown.role === 'own')) ?? null;
  }

  /** Pastes at `at` (the first copied thing lands there). `into`: the row (its key) the topmost row
   *  copied from goes to — the others to the rows under it, in their order; none: each where it was. */
  paste(at: number, into: string | null = null) {
    const project = this.project;
    const board = this.clipboard;
    if (project === null || board === null) return;
    // the rows things go to
    const lightRows = this.rows.filter(isLightRow);
    const start = into === null ? -1 : lightRows.findIndex((row) => row.key === into);
    const intoRow = into === null ? undefined : this.rows.find((row) => row.key === into);
    const rowFor = (id: string): LightRow | null => {
      if (start < 0) return null;
      const from = board.from.get(id);
      const k = from === undefined ? 0 : Math.max(0, board.rows.indexOf(from));
      return lightRows[Math.min(lightRows.length - 1, start + k)] ?? null;
    };
    // (other events onto another row of them: when they are all of one kind)
    const rawTypes = new Set(board.raw.map((event) => event.type));
    const rawType = intoRow?.kind === 'raw' && rawTypes.size === 1 ? intoRow.type : null;
    const first = Math.min(...board.clips.map((clip) => clip.start), ...board.raw.map((event) => event.beat), ...board.effects.map((item) => item.effect.start), ...board.ringBlocks.map((block) => block.start));
    const shift = at - first;
    this.checkpoint();
    const pasted: string[] = [];
    for (const clip of board.clips) {
      const copy = cloneClip(clip, { start: clip.start + shift, end: clip.end + shift });
      const row = rowFor(clip.id);
      if (row !== null) this.retarget(copy, row);
      project.clips.push(copy);
      pasted.push(copy.id);
    }
    for (const event of board.raw) {
      const copy = { ...event, id: newId('r'), beat: event.beat + shift, ...(rawType !== null ? { type: rawType } : {}) };
      project.raw.push(copy);
      pasted.push(copy.id);
    }
    for (const { effect, children, raw } of board.effects) {
      const copy: Effect = { ...structuredClone(effect), id: newId('e'), start: effect.start + shift, end: effect.end + shift };
      const row = rowFor(effect.id);
      const target = row === null ? null : this.targetOfRow(row);
      this.effects.push(copy);
      if (target !== null) {
        // (on another row: made anew for its lights — events changed by hand don't fit them)
        delete copy.target;
        Object.assign(copy, target);
        delete copy.custom;
        this.regenerate(copy);
      } else {
        for (const child of children) project.clips.push(cloneClip(child, { start: child.start + shift, end: child.end + shift, group: copy.id }));
        for (const event of raw) project.raw.push({ ...structuredClone(event), id: newId('r'), beat: event.beat + shift, group: copy.id });
      }
      pasted.push(copy.id);
    }
    for (const block of board.ringBlocks) {
      const copy = cloneRingBlock(block, { start: block.start + shift, end: block.end + shift });
      this.ringBlocks.push(copy);
      pasted.push(copy.id);
    }
    this.selection = new Set(pasted);
    this.changed();
  }

  duplicateSelection() {
    const spans = [...this.selectedClips(), ...this.selectedEffects(), ...this.selectedRingBlocks()];
    if (spans.length === 0) return;
    const start = Math.min(...spans.map((clip) => clip.start));
    const end = Math.max(...spans.map((clip) => clip.end));
    this.copy();
    this.paste(start + (end - start));
  }

  // ----- mirroring ------------------------------------------------------------------------------------

  /** The row a clip stands on as its own (null: none shown). */
  private ownRow(clip: LightClip): Row | null {
    return this.rows.find((row) => isLightRow(row) && this.rowClips(row).some((shown) => shown.clip.id === clip.id && shown.role === 'own')) ?? null;
  }

  /** How many rows the selected clips stand on (mirroring across them needs two). */
  selectionLanes() {
    return new Set(this.selectedClips().map((clip) => this.ownRow(clip)?.key).filter((key) => key !== undefined)).size;
  }

  /**
   * The selected clips mirrored across the rows they stand on: the clip on the first of those rows
   * goes to the last, the second to the one before it… — a wave drawn by hand runs the other way.
   * Times stay. Returns how many clips moved.
   */
  mirrorAcrossRows(): number {
    const clips = this.selectedClips();
    const placed = clips.map((clip) => ({ clip, row: this.ownRow(clip) })).filter((item): item is { clip: LightClip; row: Row } => item.row !== null);
    const lanes = [...new Set(placed.map((item) => item.row))].sort((a, b) => this.rows.indexOf(a) - this.rows.indexOf(b));
    if (lanes.length < 2) return 0;
    this.checkpoint();
    for (const { clip, row } of placed) this.retarget(clip, lanes[lanes.length - 1 - lanes.indexOf(row)]!);
    this.changed();
    return placed.length;
  }

  /**
   * The selected events put on the other side and/or given the other side's colour: left lasers ↔
   * right ones (and the other left / right pairs: extra lights, laser speeds), a group named "Left…"
   * ↔ the one named "Right…", other lights mirrored within their row (the first ↔ the last); the
   * colour: left ↔ right of the scheme. Returns how many changed.
   */
  mirrorSides(mode: 'both' | 'side' | 'color'): number {
    const project = this.project;
    if (project === null) return 0;
    const clips = this.selectedClips();
    const raw = this.selectedRaw();
    if (clips.length + raw.length === 0) return 0;
    this.checkpoint();
    const pairs = new Map<number, number>([[2, 3], [3, 2], [6, 7], [7, 6], [10, 11], [11, 10], [12, 13], [13, 12]]);
    const side = mode !== 'color';
    const colour = mode !== 'side';
    // (a group's mirror: the one whose name has the other side's word in place of this one's)
    const words: [RegExp, string][] = [
      [/лев/iu, 'прав'],
      [/прав/iu, 'лев'],
      [/left/iu, 'right'],
      [/right/iu, 'left'],
    ];
    const allGroups: LightGroup[] = [];
    const walk = (list: readonly LightGroup[]) => {
      for (const group of list) {
        allGroups.push(group);
        walk(group.items.filter((item): item is LightGroup => item.kind === 'group'));
      }
    };
    walk(this.groups);
    const mirrorGroup = (id: string) => {
      const group = allGroups.find((item) => item.id === id);
      if (group === undefined) return null;
      for (const [word, other] of words) {
        if (!word.test(group.name)) continue;
        const wanted = group.name.replace(word, (found) => (found[0] === found[0]!.toUpperCase() ? other[0]!.toUpperCase() + other.slice(1) : other)).toLowerCase();
        const found = allGroups.find((item) => item.id !== id && item.name.toLowerCase() === wanted);
        if (found !== undefined) return found.id;
      }
      return null;
    };
    const sideOf = (ref: ClipColor): ClipColor => (ref.ref === 'left' ? { ...ref, ref: 'right' } : ref.ref === 'right' ? { ...ref, ref: 'left' } : ref);
    for (const clip of clips) {
      if (side) {
        if (clip.target !== undefined) {
          const other = mirrorGroup(clip.target);
          if (other !== null) clip.target = other;
        } else {
          const lights = this.lightsByType.get(clip.type) ?? [];
          const to = pairs.get(clip.type);
          if (to !== undefined && (this.lightsByType.get(to)?.length ?? 0) > 0) {
            // (the same place on the other side: by its place in the row)
            const others = this.lightsByType.get(to) ?? [];
            clip.ids = clip.ids === null ? null : clip.ids.map((id) => others[Math.max(0, lights.indexOf(id))] ?? id);
            clip.type = to;
          } else if (clip.ids !== null && lights.length > 1) clip.ids = clip.ids.map((id) => (lights.includes(id) ? lights[lights.length - 1 - lights.indexOf(id)]! : id));
        }
      }
      if (colour) {
        clip.color = sideOf(clip.color);
        if (clip.endColor !== null) clip.endColor = sideOf(clip.endColor);
      }
    }
    if (side) for (const event of raw) event.type = pairs.get(event.type) ?? event.type;
    this.changed();
    return clips.length + raw.length;
  }

  /** The map's colours. */
  palette(): Rgb[] {
    return this.project?.palette ?? [];
  }

  /** The map's colours changed: in this project (saved with it) and in the other difficulties' ones
   *  straight away. */
  setPalette(colors: readonly Rgb[]) {
    const project = this.project;
    if (project === null) return;
    const list = colors.map((rgb) => [...rgb] as Rgb);
    project.palette = list;
    this.dirty = true;
    this.emit('selection');
    this.shareWithMap('palette', list);
  }

  /** The map's presets (presets.ts). */
  mapPresets(): unknown[] {
    return this.project?.presets ?? [];
  }

  /** The map's presets changed: in this project and the other difficulties' ones straight away. */
  setMapPresets(presets: readonly unknown[]) {
    const project = this.project;
    if (project === null) return;
    project.presets = structuredClone([...presets]);
    this.dirty = true;
    this.shareWithMap('presets', project.presets);
  }

  /** Something the whole map has (its palette, its presets) written into its other difficulties'
   *  projects too. */
  private shareWithMap(key: 'palette' | 'presets', value: unknown) {
    const map = this.map;
    if (map === null) return;
    const current = this.row === null ? '' : projectFileName(difficultyFile(this.row));
    void (async () => {
      for (const name of map.folder.files.filter((item) => /\.(lumatic|chroeditor)\.json$/iu.test(item) && item !== current)) {
        try {
          const other = JSON.parse(await map.folder.readText(name)) as Record<string, unknown>;
          other[key] = value;
          await map.folder.writeText(name, JSON.stringify(other));
        } catch {
          // (not readable: left as it is)
        }
      }
    })();
  }

  /** A colour copied off an event (its gradient's end and blend with it). */
  copiedColor: { color: ClipColor; endColor: ClipColor | null; hsv: boolean } | null = null;

  copyColor(clip: LightClip) {
    this.copiedColor = { color: structuredClone(clip.color), endColor: clip.endColor === null ? null : structuredClone(clip.endColor), hsv: clip.hsv === true };
    this.setStatus('Цвет скопирован');
  }

  /** The copied colour put on the selected events. */
  pasteColor() {
    const copied = this.copiedColor;
    const clips = this.selectedClips();
    if (copied === null || clips.length === 0) return;
    this.checkpoint();
    for (const clip of clips) {
      clip.color = structuredClone(copied.color);
      clip.endColor = copied.endColor === null ? null : structuredClone(copied.endColor);
      if (copied.hsv) clip.hsv = true;
      else delete clip.hsv;
    }
    this.changed();
  }

  /** Every event on the row this one stands on (its own ones). */
  selectRowOf(clip: LightClip) {
    const row = this.ownRow(clip);
    if (row === null) return;
    this.select(this.rowClips(row).filter((shown) => shown.role === 'own').map((shown) => shown.clip.id));
  }

  /** Every event of this one's colour (the scheme's same colour, or nearly the same colour of its own). */
  selectSameColor(clip: LightClip) {
    const project = this.project;
    if (project === null) return;
    const same = (a: ClipColor) => a.ref === clip.color.ref && (a.ref !== 'custom' || (a.rgb ?? [1, 1, 1]).every((v, k) => Math.abs(v - (clip.color.rgb ?? [1, 1, 1])[k]!) < 0.04));
    const hidden = new Set(this.effects.filter((effect) => effect.id !== this.openEffect).map((effect) => effect.id));
    this.select(project.clips.filter((item) => (item.group === undefined || !hidden.has(item.group)) && same(item.color)).map((item) => item.id));
  }

  /** The selected clips and other events mirrored in time over the stretch they cover: what came
   *  first comes last; fading in turns into fading out, gradients run the other way. */
  mirrorInTime() {
    const project = this.project;
    if (project === null) return;
    const clips = this.selectedClips();
    const raw = project.raw.filter((event) => this.selection.has(event.id));
    if (clips.length + raw.length === 0) return;
    const start = Math.min(...clips.map((clip) => clip.start), ...raw.map((event) => event.beat));
    const end = Math.max(...clips.map((clip) => clip.end), ...raw.map((event) => event.beat));
    this.checkpoint();
    for (const clip of clips) {
      const [from, to] = [start + end - clip.end, start + end - clip.start];
      const fadesIn = clip.startMode === 'fadeIn';
      const fadesOut = clip.endMode === 'fade';
      clip.start = from;
      clip.end = to;
      if (fadesOut && !fadesIn) {
        clip.startMode = 'fadeIn';
        clip.fadeIn = to - from;
        clip.endMode = 'off';
      } else if (fadesIn && !fadesOut) {
        clip.startMode = 'on';
        clip.endMode = 'fade';
      }
      if (clip.endColor !== null) [clip.color, clip.endColor] = [clip.endColor, clip.color];
    }
    for (const event of raw) event.beat = start + end - event.beat;
    this.changed();
  }

  private trying: { state: string; selection: string[] } | null = null;

  /** Something is being tried in a window (startTrying … finishTrying). */
  isTrying() {
    return this.trying !== null;
  }

  /** Trying out a change (the dialogs of the light and of the hits): one undo step for all the
   *  tries, each try made on the clips as they were. */
  startTrying() {
    if (this.project === null || this.trying !== null) return;
    this.checkpoint();
    this.trying = { state: this.undoStack[this.undoStack.length - 1]!, selection: [...this.selection] };
  }

  /** The selected clips' light changed (brighter, another hue, a gradient over them, pulses, a
   *  flutter — see `adjustClips`). Returns how many clips there are now. */
  adjustSelection(adjustment: Adjustment): number {
    const project = this.project;
    if (project === null) return 0;
    const trying = this.trying;
    if (trying !== null) {
      this.restore(trying.state, false);
      this.selection = new Set(trying.selection);
    }
    const clips = this.selectedClips();
    if (clips.length === 0) return 0;
    if (trying === null) this.checkpoint();
    const added = adjustClips(clips, adjustment, this.scheme(), (clip) => this.ownRow(clip)?.key ?? '');
    project.clips.push(...added);
    for (const clip of added) this.selection.add(clip.id);
    this.changed();
    return clips.length + added.length;
  }

  /** One try of a ring block (the steps dialog): the blocks as they were before the tries, and this
   *  one put in (or in place of the one with its id). */
  tryRingBlock(block: RingBlock) {
    const project = this.project;
    const trying = this.trying;
    if (project === null || trying === null) return;
    this.restore(trying.state, false);
    project.ringBlocks = [...this.ringBlocks.filter((item) => item.id !== block.id), structuredClone(block)];
    this.selection = new Set([block.id]);
    this.changed();
  }

  /** One try of new other events (the lasers window): the events as they were before the tries, and
   *  these (selected). */
  tryRaw(events: RawEvent[]) {
    const project = this.project;
    const trying = this.trying;
    if (project === null || trying === null) return;
    this.restore(trying.state, false);
    project.raw.push(...events);
    this.selection = new Set(events.map((event) => event.id));
    this.changed();
  }

  /** One try of new clips (the hits of the song): the clips as they were before the tries, and these
   *  (selected). */
  tryClips(clips: LightClip[]) {
    const project = this.project;
    const trying = this.trying;
    if (project === null || trying === null) return;
    this.restore(trying.state, false);
    project.clips.push(...clips);
    this.selection = new Set(clips.map((clip) => clip.id));
    this.changed();
  }

  /** The tries done: kept (one undo step) or the clips put back as they were. */
  finishTrying(keep: boolean) {
    const trying = this.trying;
    if (trying === null) return;
    this.trying = null;
    if (keep) return;
    this.restore(trying.state);
    this.selection = new Set(trying.selection);
    this.undoDiscard();
    this.emit('selection');
  }

  /** The clips that match: of these rows (keys; none: any), this colour, within these beats. */
  /**
   * "Select by…": the light events of these rows, of this colour, within these beats. An effect's own
   * events stay inside it: the effect is picked instead, as the timeline shows it (`effects`). `other`:
   * the ring, laser and boost events within the beats too.
   */
  clipsMatching(criteria: { rows: string[]; color: ClipColor['ref'] | 'any'; from: number; to: number; effects: boolean; other?: boolean }): string[] {
    const project = this.project;
    if (project === null) return [];
    const rows = this.rows.filter((row) => isLightRow(row) && (criteria.rows.length === 0 || criteria.rows.includes(row.key)));
    const shown = new Set(rows.flatMap((row) => this.rowClips(row).filter((item) => item.role === 'own').map((item) => item.clip.id)));
    const closed = new Set(this.effects.filter((effect) => effect.id !== this.openEffect).map((effect) => effect.id));
    const inRows = new Set(rows.flatMap((row) => this.rowClips(row).map((item) => item.clip.id)));
    const rowKeys = new Set(rows.map((row) => row.key));
    const effectInRows = new Map<string, boolean>();
    const effectPicked = (effect: string, clip: string) => {
      if (criteria.rows.length === 0 || inRows.has(clip)) return true;
      if (!effectInRows.has(effect)) effectInRows.set(effect, rowKeys.has(this.ownRowOf(effect)?.key ?? ''));
      return effectInRows.get(effect)!;
    };
    const out = new Set<string>();
    for (const clip of project.clips) {
      if (clip.end <= criteria.from || clip.start >= criteria.to) continue;
      if (criteria.color !== 'any' && clip.color.ref !== criteria.color) continue;
      if (clip.group !== undefined && closed.has(clip.group)) {
        // (an effect's event: the effect picked — when one of its events is in a picked row)
        if (criteria.effects && effectPicked(clip.group, clip.id)) out.add(clip.group);
        continue;
      }
      if (criteria.rows.length === 0 || shown.has(clip.id)) out.add(clip.id);
    }
    if (criteria.effects) {
      // (effects with no events of their own here — sound, rings: by their stretch)
      for (const effect of this.effects) if (effect.id !== this.openEffect && effect.end > criteria.from && effect.start < criteria.to && this.effectChildren(effect.id).length === 0 && criteria.rows.length === 0) out.add(effect.id);
    }
    if (criteria.other === true) {
      for (const event of project.raw) if (event.group === undefined && event.type !== BPM_EVENT_TYPE && event.beat >= criteria.from && event.beat < criteria.to) out.add(event.id);
      for (const block of this.ringBlocks) if (block.end > criteria.from && block.start < criteria.to) out.add(block.id);
    }
    return [...out];
  }

  // ----- effects -------------------------------------------------------------------------------------

  get effects(): Effect[] {
    const project = this.project;
    if (project === null) return [];
    project.effects ??= [];
    return project.effects;
  }

  effectById(id: string) {
    return this.effects.find((effect) => effect.id === id);
  }

  effectChildren(id: string): LightClip[] {
    const clips = this.project?.clips;
    if (clips === undefined) return [];
    // (all effects' events found in one pass, kept until the show changes: the timeline asks for every
    // effect in view on every frame)
    const cache = this.childrenCache;
    if (cache === null || cache.version !== this.version || cache.clips !== clips || cache.count !== clips.length) {
      const byEffect = new Map<string, LightClip[]>();
      for (const clip of clips) if (clip.group !== undefined) (byEffect.get(clip.group) ?? byEffect.set(clip.group, []).get(clip.group)!).push(clip);
      this.childrenCache = { version: this.version, clips, count: clips.length, byEffect };
    }
    return [...(this.childrenCache!.byEffect.get(id) ?? [])];
  }

  private childrenCache: { version: number; clips: LightClip[]; count: number; byEffect: Map<string, LightClip[]> } | null = null;

  /** Whether the colour boost is on at `beat` (the show's boost events, type 5: 1 on, 0 off). */
  boostAt(beat: number): boolean {
    const raw = this.project?.raw;
    if (raw === undefined) return false;
    const cache = this.boostCache;
    let switches = cache !== null && cache.version === this.version && cache.raw === raw && cache.count === raw.length ? cache.switches : null;
    if (switches === null) {
      switches = raw.filter((event) => event.type === 5).map((event) => ({ beat: event.beat, on: event.value === 1 })).sort((a, b) => a.beat - b.beat);
      this.boostCache = { version: this.version, raw, count: raw.length, switches };
    }
    // (the last switch at or before the beat — found by halving: asked once per event drawn)
    let low = 0;
    let high = switches.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (switches[middle]!.beat <= beat + 1e-9) low = middle + 1;
      else high = middle;
    }
    return low > 0 && switches[low - 1]!.on;
  }

  private boostCache: { version: number; raw: RawEvent[]; count: number; switches: { beat: number; on: boolean }[] } | null = null;

  /**
   * How fast the rings turn along the song: for every 1/8 beat (map beats), the fastest ring of any ring
   * system, in degrees a second — worked out with the game's own ring motion from the show's ring
   * events. Past ~1500°/s a ring (the same every 90°) turns more than a sixth of that between a
   * headset's frames, and it reads as a jumble — differently on a monitor and in each headset.
   */
  ringSpeeds(): { step: number; speeds: Float32Array } | null {
    if (this.project === null || this.ringInfo.length === 0) return null;
    const cached = this.ringSpeedCache;
    if (cached !== null && cached.version === this.version) return cached.result;
    // (worked out a moment after the show stops changing — the last one shown meanwhile)
    if (this.ringSpeedTimer === 0) {
      this.ringSpeedTimer = window.setTimeout(() => {
        this.ringSpeedTimer = 0;
        this.ringSpeedCache = { version: this.version, result: this.measureRingSpeeds() };
        this.emit('time');
      }, cached === null ? 0 : 300);
    }
    return cached?.result ?? null;
  }

  private ringSpeedTimer = 0;

  private measureRingSpeeds(): { step: number; speeds: Float32Array } {
    const events: BasicEvent[] = this.previewEvents()
      .filter((event) => event.type === RING_EVENT_TYPE)
      .map((event) => ({ jsonTime: event.beat, songBpmTime: this.toSong(event.beat), type: event.type, value: event.value, floatValue: event.floatValue, ...(event.customData === undefined ? {} : { customData: event.customData as BasicEvent['customData'] }) }))
      .sort((a, b) => a.songBpmTime - b.songBpmTime);
    const step = 0.125;
    const end = Math.max(this.endBeat, ...events.map((event) => event.jsonTime + 8));
    const speeds = new Float32Array(Math.ceil(end / step) + 1);
    if (events.length > 0) {
      const h = 1 / 32;
      for (const system of this.ringInfo) {
        const sampler = createRingRotationSampler(events, this.songBpm, new Array<number>(system.rings).fill(0), system.rotation, deterministicRingRandom(system.seed));
        for (let k = 0; k < speeds.length; k++) {
          const beat = k * step;
          const a = [...sampler(this.toSong(beat))];
          const b = sampler(this.toSong(beat + h));
          const seconds = Math.max(1e-6, this.beatToSeconds(beat + h) - this.beatToSeconds(beat));
          let fastest = 0;
          for (let i = 0; i < a.length; i++) fastest = Math.max(fastest, Math.abs((b[i] ?? 0) - (a[i] ?? 0)) / seconds);
          // (not the rings' own turn into place as the song starts)
          if (beat >= 2) speeds[k] = Math.max(speeds[k]!, fastest);
        }
      }
    }
    return { step, speeds };
  }

  /** The fastest the rings turn between two beats (degrees a second; 0: not known). */
  ringSpeedBetween(from: number, to: number) {
    const profile = this.ringSpeeds();
    if (profile === null) return 0;
    let fastest = 0;
    for (let k = Math.max(0, Math.floor(from / profile.step)); k <= Math.min(profile.speeds.length - 1, Math.ceil(to / profile.step)); k++) fastest = Math.max(fastest, profile.speeds[k]!);
    return fastest;
  }

  private ringSpeedCache: { version: number; result: { step: number; speeds: Float32Array } } | null = null;

  /** The ring events a GLS block made. */
  effectRaw(id: string) {
    return this.project?.raw.filter((event) => event.group === id) ?? [];
  }

  /** What making effects needs from the map and the environment. */
  effectExtras(): EffectExtras {
    const systems = this.preview.ringSystems().filter((system) => system.rotates);
    return {
      secondsPerBeat: 60 / this.songBpm,
      ringCount: (name) => (name === '' ? Math.max(1, ...systems.map((system) => system.rings)) : (systems.find((system) => system.name === name)?.rings ?? 1)),
      itemsOf: (target) => this.effectItemsOf(target),
      ...(this.spectrogram === null ? {} : { sound: this.spectrogram }),
      beatToSeconds: (beat) => this.beatToSeconds(beat),
    };
  }

  /** An effect's events as they would be made now. */
  buildEffectEvents(effect: Effect) {
    return buildEffect(effect, this.effectItemsOf(effect), this.scheme(), this.effectExtras());
  }

  selectedEffects(): Effect[] {
    return this.effects.filter((effect) => this.selection.has(effect.id));
  }

  scheme(): SchemeColors {
    const colors = this.preview.colors;
    return { left: [...colors.environmentLeft], right: [...colors.environmentRight], white: [...colors.environmentWhite] };
  }

  effectItemsOf(effect: Pick<Effect, 'target' | 'type' | 'ids'>) {
    return effectItems(effect, this.lightsByType, (id) => findGroup(this.groups, id)?.group ?? null);
  }

  /** The effect's events made anew from its settings (not for one changed by hand). */
  private regenerate(effect: Effect) {
    const project = this.project;
    if (project === null || effect.custom === true) return;
    project.clips = project.clips.filter((clip) => clip.group !== effect.id);
    project.raw = project.raw.filter((event) => event.group !== effect.id);
    const made = this.buildEffectEvents(effect);
    project.clips.push(...made.clips);
    project.raw.push(...made.raw.map((event) => ({ ...event, id: newId('r'), group: effect.id })));
  }

  /** The row an effect would go on → what it runs over (null: not a light row). */
  targetOfRow(row: Row): Pick<Effect, 'target' | 'type' | 'ids'> | null {
    if (!isLightRow(row)) return null;
    if (row.kind === 'group') return { type: row.type, ids: this.takenLights().has(row.type) ? [...row.lights] : null };
    if (row.kind === 'light') return { type: row.type, ids: [row.id] };
    return { target: row.group.id, type: groupLights(row.group)[0]?.type ?? 0, ids: null };
  }

  /** An effect (not yet in the show) on a row, from `start` to `end`. */
  makeEffect(kind: EffectKind, params: Partial<EffectParams>, row: Row, start: number, end: number, name = KIND_NAMES[kind]): Effect | null {
    const target = this.targetOfRow(row);
    if (target === null) return null;
    return {
      id: newId('e'),
      // (in the language picked: the name stays as it was made)
      name: translate(name),
      kind,
      ...target,
      start,
      end: Math.max(end, start + 0.25),
      layer: this.brush.layer,
      params: { ...defaultParams(this.brush.color), ...structuredClone(params) },
      ...(kind === 'gls' ? { gls: defaultGls(this.brush.color) } : {}),
    };
  }

  /** The events an effect would make (not put anywhere). */
  previewEffectChildren(effect: Effect): LightClip[] {
    return this.buildEffectEvents(effect).clips;
  }

  addEffect(effect: Effect) {
    if (this.project === null) return;
    this.checkpoint();
    this.effects.push(effect);
    this.fitEffect(effect);
    this.regenerate(effect);
    this.selection = new Set([effect.id]);
    this.changed();
  }

  /** A stand-in clip for drawing an effect on the rows (and picking it there). */
  effectProxy(effect: Effect): LightClip {
    const p = effect.params;
    return {
      id: effect.id,
      type: effect.type,
      ids: effect.ids === null ? null : [...effect.ids],
      ...(effect.target === undefined ? {} : { target: effect.target }),
      ...(effect.ids !== null && effect.ids.length === 1 && effect.target === undefined ? { scope: 'light' as const } : {}),
      start: effect.start,
      end: effect.end,
      startMode: 'on',
      fadeIn: 0.5,
      endMode: 'stay',
      color: effect.kind === 'gls' ? (effect.gls?.boxes.find((box) => box.kind === 'color')?.blocks?.[0]?.color ?? effect.gls?.boxes.find((box) => box.kind === 'color')?.events[0]?.color ?? p.color) : p.color,
      endColor: effect.kind === 'gls' ? null : p.color2,
      layer: effect.layer,
    };
  }

  /** Opens a GLS block's editor (set by the app). */
  glsEditorHook: ((id: string) => void) | null = null;

  /** While a GLS block is edited: what the inspector on the right shows instead of the brush — the
   *  picked block (edited as a clip is), or something of its own (a ring turn). */
  glsInspect: GlsInspect | null = null;

  /** A ring or zoom pose picked by its mark on the timeline: its settings in the panel on the right. */
  posePick: { blockId: string; poseId: string } | null = null;

  /** A pose picked (null: none) — what else was picked let go. */
  pickPose(pick: { blockId: string; poseId: string } | null) {
    this.posePick = pick;
    // (a Lumatic event on its own: its block picked too — moved, copied, deleted as one; a pose in a
    // group: only it, the group stays)
    if (pick !== null) {
      const block = this.ringBlockById(pick.blockId);
      this.selection = new Set(block !== undefined && block.poses.length === 1 && block.steps === undefined && block.glitch === undefined ? [block.id] : []);
    }
    this.emit('selection');
  }

  /** Changes one effect (one undo step) and makes its events anew. */
  updateEffect(id: string, patch: (effect: Effect) => void) {
    const effect = this.effectById(id);
    if (effect === undefined) return;
    this.checkpoint();
    patch(effect);
    this.regenerate(effect);
    this.changed();
  }

  /** Changes the selected effects (one undo step) and makes their events anew. */
  updateEffects(patch: (effect: Effect) => void) {
    const effects = this.selectedEffects();
    if (effects.length === 0) return;
    this.checkpoint();
    for (const effect of effects) {
      patch(effect);
      this.fitEffect(effect);
      this.regenerate(effect);
    }
    this.changed();
  }

  /** An effect too short for what its settings ask: made as long as it needs (never shortened —
   *  that's left to the hand). */
  private fitEffect(effect: Effect) {
    const needed = effectNeededLength(effect, this.effectItemsOf(effect).length);
    if (needed > effect.end - effect.start + 1e-6) effect.end = effect.start + needed;
  }

  /** Effects by sound among these, moved: made anew from the song where they are now (part of the
   *  move's undo step). */
  remakeSoundEffects(ids: readonly string[]) {
    let any = false;
    for (const id of ids) {
      const effect = this.effectById(id);
      if (effect === undefined || effect.kind !== 'sound' || effect.custom === true) continue;
      this.regenerate(effect);
      any = true;
    }
    if (any) this.changed();
  }

  /** Dragging an effect: from where it was (`origin`) by `delta` beats, its events with it. */
  moveEffect(effect: Effect, origin: { start: number; end: number; children: Map<string, { start: number; end: number }> }, delta: number) {
    effect.start = origin.start + delta;
    effect.end = origin.end + delta;
    for (const clip of this.effectChildren(effect.id)) {
      const from = origin.children.get(clip.id);
      if (from === undefined) continue;
      clip.start = from.start + delta;
      clip.end = from.end + delta;
    }
    for (const event of this.effectRaw(effect.id)) {
      const from = origin.children.get(event.id);
      if (from !== undefined) event.beat = from.start + delta;
    }
  }

  /** Stretching an effect: made anew for its new length — or, changed by hand, its events
   *  stretched along. */
  resizeEffect(effect: Effect, origin: { start: number; end: number; children: Map<string, { start: number; end: number }> }, start: number, end: number) {
    effect.start = start;
    effect.end = Math.max(start + 1 / 16, end);
    // (a copy of a preset stretched: as much longer than the preset as it is now)
    if (effect.preset !== undefined) {
      const preset = (this.project?.presets ?? []).find((item) => (item as { id?: string }).id === effect.preset) as { length?: number } | undefined;
      if (preset?.length !== undefined && preset.length > 0) effect.presetScale = (effect.end - effect.start) / preset.length;
    }
    if (effect.custom === true) {
      const scale = (effect.end - effect.start) / Math.max(1e-6, origin.end - origin.start);
      for (const clip of this.effectChildren(effect.id)) {
        const from = origin.children.get(clip.id);
        if (from === undefined) continue;
        clip.start = effect.start + (from.start - origin.start) * scale;
        clip.end = effect.start + (from.end - origin.start) * scale;
      }
      for (const event of this.effectRaw(effect.id)) {
        const from = origin.children.get(event.id);
        if (from !== undefined) event.beat = effect.start + (from.start - origin.start) * scale;
      }
    } else this.regenerate(effect);
  }

  /** An effect dragged onto another row: it runs over that now. */
  retargetEffect(effect: Effect, row: Row) {
    if (effect.custom === true) return;
    const target = this.targetOfRow(row);
    if (target === null) return;
    delete effect.target;
    Object.assign(effect, target);
    this.regenerate(effect);
  }

  /** Into an effect: its events shown on the rows (and its group gone into). Null: back out. */
  enterEffect(id: string | null) {
    const effect = id === null ? undefined : this.effectById(id);
    this.openEffect = effect?.id ?? null;
    if (effect !== undefined) {
      // (a group's events lie on several rows: none gone into)
      if (effect.kind === 'group') {
        // (shown where they are)
      } else if (effect.target !== undefined) {
        this.focus = effect.target;
        this.buildRows();
      } else if (this.project !== null && !this.project.expanded.includes(effect.type)) {
        this.project.expanded.push(effect.type);
        this.buildRows();
      }
      this.selection = new Set(this.effectChildren(effect.id).map((clip) => clip.id));
    } else this.selection.clear();
    this.version++;
    this.emit('rows');
    this.emit('selection');
  }

  /** Back to what its settings make (hand changes dropped). */
  resetEffect(id: string) {
    const effect = this.effectById(id);
    if (effect === undefined) return;
    this.checkpoint();
    effect.custom = false;
    this.regenerate(effect);
    this.changed();
  }

  /** Copies of effects (and their events) right where they are — no undo step of its own (Alt+drag). */
  cloneEffectsInPlace(effects: readonly Effect[]): string[] {
    const project = this.project;
    if (project === null) return [];
    return effects.map((effect) => {
      const copy: Effect = { ...structuredClone(effect), id: newId('e') };
      this.effects.push(copy);
      for (const child of this.effectChildren(effect.id)) project.clips.push(cloneClip(child, { group: copy.id }));
      for (const event of this.effectRaw(effect.id)) project.raw.push({ ...structuredClone(event), id: newId('r'), group: copy.id });
      return copy.id;
    });
  }

  /**
   * The selected events (plain ones — not an effect's) made one block that looks and moves like an
   * effect: a group of events named `name`, its events kept as they are (gone into to change them,
   * taken apart to have them loose again). Returns the group, or null when there was nothing to group.
   */
  groupSelection(name: string): Effect | null {
    const project = this.project;
    if (project === null) return null;
    const clips = this.selectedClips().filter((clip) => clip.group === undefined);
    const raw = this.selectedRaw().filter((event) => event.group === undefined);
    if (clips.length + raw.length === 0) return null;
    this.checkpoint();
    const effect = this.groupOf(name, clips, raw);
    this.selection = new Set([effect.id]);
    this.changed();
    return effect;
  }

  /** A group made of these events (no undo step of its own). */
  groupOf(name: string, clips: readonly LightClip[], raw: readonly RawEvent[]): Effect {
    const first = clips[0];
    const start = Math.min(...clips.map((clip) => clip.start), ...raw.map((event) => event.beat));
    const end = Math.max(...clips.map((clip) => clip.end), ...raw.map((event) => event.beat + 0.25));
    const effect: Effect = {
      id: newId('e'),
      name,
      kind: 'group',
      type: first?.type ?? raw[0]?.type ?? 0,
      ids: first?.ids === null || first === undefined ? null : [...first.ids],
      ...(first?.target === undefined ? {} : { target: first.target }),
      start,
      end: Math.max(start + 1 / 16, end),
      layer: Math.max(1, ...clips.map((clip) => clip.layer)),
      params: defaultParams(first?.color ?? this.brush.color),
      custom: true,
    };
    this.effects.push(effect);
    for (const clip of clips) clip.group = effect.id;
    for (const event of raw) event.group = effect.id;
    return effect;
  }

  /** Takes an effect apart: its events stay as ordinary clips. */
  explodeEffect(id: string) {
    const project = this.project;
    const effect = this.effectById(id);
    if (project === null || effect === undefined) return;
    this.checkpoint();
    const children = this.effectChildren(id);
    for (const clip of children) {
      delete clip.group;
      delete clip.slot;
    }
    for (const event of this.effectRaw(id)) delete event.group;
    project.effects = this.effects.filter((item) => item.id !== id);
    if (this.openEffect === id) this.openEffect = null;
    this.selection = new Set(children.map((clip) => clip.id));
    this.changed();
  }

  /** While an effect is gone into: its events changed by hand make it a hand-made one, and a
   *  hand-made one spans its events. */
  private noteHandEdits() {
    const open = this.openEffect === null ? undefined : this.effectById(this.openEffect);
    if (open !== undefined && open.custom !== true) {
      const made = this.buildEffectEvents(open);
      const rawSignature = (events: readonly Omit<RawEvent, 'id'>[]) => JSON.stringify(events.map((event) => [Math.round(event.beat * 1e4), event.type, event.value, event.customData]).sort());
      if (childrenSignature(made.clips) !== childrenSignature(this.effectChildren(open.id)) || rawSignature(made.raw) !== rawSignature(this.effectRaw(open.id))) open.custom = true;
    }
    for (const effect of this.effects) {
      if (effect.custom !== true) continue;
      const children = this.effectChildren(effect.id);
      if (children.length === 0) continue;
      effect.start = Math.min(...children.map((clip) => clip.start));
      effect.end = Math.max(...children.map((clip) => clip.end));
    }
  }

  /** Other events put in at once (ring forms…), one undo step. */
  addRaw(events: Omit<RawEvent, 'id'>[]) {
    const project = this.project;
    if (project === null || events.length === 0) return;
    this.checkpoint();
    const added = events.map((event) => ({ ...structuredClone(event), id: newId('r') }));
    project.raw.push(...added);
    this.selection = new Set(added.map((event) => event.id));
    this.changed();
  }

  /** The row the library puts things on: the one picked last, or a sensible one. */
  libraryRow(): Row | null {
    const rows = this.rows.filter(isLightRow);
    return rows.find((row) => row.key === this.activeRow) ?? rows.find((row) => row.kind === 'custom') ?? rows.find((row) => row.kind === 'group' && row.type === 1) ?? rows[0] ?? null;
  }

  setActiveRow(key: string | null) {
    if (this.activeRow === key) return;
    this.activeRow = key;
    this.emit('selection');
  }

  // ----- bookmarks ------------------------------------------------------------------------------------

  get bookmarks(): Bookmark[] {
    const project = this.project;
    if (project === null) return [];
    project.bookmarks ??= [];
    return project.bookmarks;
  }

  addBookmark(beat: number, name: string): Bookmark | null {
    if (this.project === null) return null;
    this.checkpoint();
    const palette: Rgb[] = [[0.35, 0.75, 1], [1, 0.55, 0.3], [0.5, 1, 0.5], [1, 0.4, 0.75], [1, 0.9, 0.35], [0.7, 0.55, 1]];
    const bookmark: Bookmark = { id: newId('m'), beat, name, color: palette[this.bookmarks.length % palette.length]! };
    this.bookmarks.push(bookmark);
    this.changed();
    return bookmark;
  }

  /** Changes a bookmark (one undo step; `undoStep` false: while it is being dragged). */
  updateBookmark(id: string, patch: (bookmark: Bookmark) => void, undoStep = true) {
    const bookmark = this.bookmarks.find((item) => item.id === id);
    if (bookmark === undefined) return;
    if (undoStep) this.checkpoint();
    patch(bookmark);
    this.changed();
  }

  deleteBookmark(id: string) {
    const project = this.project;
    if (project === null) return;
    this.checkpoint();
    project.bookmarks = this.bookmarks.filter((item) => item.id !== id);
    this.changed();
  }

  /** The bookmark before / after the song's place (for jumping between them). */
  nextBookmark(direction: 1 | -1) {
    const now = this.playhead();
    const sorted = [...this.bookmarks].sort((a, b) => a.beat - b.beat);
    return direction > 0 ? sorted.find((item) => item.beat > now + 1e-3) : sorted.reverse().find((item) => item.beat < now - 1e-3);
  }

  // ----- playback speed ---------------------------------------------------------------------------------

  /** How fast the song plays (1: as it is; the pitch goes with it). */
  rate = 1;

  setRate(rate: number) {
    this.rate = rate;
    this.clock?.setRate(rate);
    this.emit('time');
  }

  /** The speed a step (10 %) up or down (the − / + keys), 10 %…200 %. */
  stepRate(up: boolean) {
    const rate = Math.min(2, Math.max(0.1, Math.round((this.rate + (up ? 0.1 : -0.1)) * 100) / 100));
    this.setRate(rate);
    this.setStatus(`Скорость: ${String(Math.round(rate * 100))}%`);
  }

  // ----- ring poses -----------------------------------------------------------------------------------

  get ringBlocks(): RingBlock[] {
    const project = this.project;
    if (project === null) return [];
    project.ringBlocks ??= [];
    return project.ringBlocks;
  }

  ringBlockById(id: string) {
    return this.ringBlocks.find((block) => block.id === id);
  }

  selectedRingBlocks(): RingBlock[] {
    return this.ringBlocks.filter((block) => this.selection.has(block.id));
  }

  addRingBlock(block: RingBlock) {
    if (this.project === null) return;
    this.checkpoint();
    block.name = translate(block.name);
    this.ringBlocks.push(block);
    fitRingBlock(block);
    this.selection = new Set([block.id]);
    this.changed();
  }

  /** Changes one ring pose block (one undo step). */
  updateRingBlock(id: string, patch: (block: RingBlock) => void, fit = true) {
    const block = this.ringBlockById(id);
    if (block === undefined) return;
    this.checkpoint();
    patch(block);
    if (fit) fitRingBlock(block);
    this.changed();
  }

  /** Copies of ring blocks right where they are — no undo step of its own (Alt+drag). */
  cloneRingBlocksInPlace(blocks: readonly RingBlock[]): string[] {
    return blocks.map((block) => {
      const copy = cloneRingBlock(block);
      this.ringBlocks.push(copy);
      return copy.id;
    });
  }

  /** The 3D view's environment for the ring tracks: loaded again when which rings are on tracks
   *  changes, its animations swapped in place otherwise. */
  private syncRingTracks() {
    const row = this.row;
    if (row === null) return;
    const { enhancements, animations } = this.ringChroma();
    if (this.geometryRings.size > 0) this.syncRingParents(animations);
    const enhancementKey = JSON.stringify(enhancements);
    const animationKey = JSON.stringify(animations);
    if (enhancementKey === this.ringEnhancementKey && animationKey === this.ringAnimationKey) return;
    const reload = enhancementKey !== this.ringEnhancementKey;
    this.ringEnhancementKey = enhancementKey;
    this.ringAnimationKey = animationKey;
    const base = this.mapChroma ?? { ...structuredClone(EMPTY_CHROMA_ENVIRONMENT), version: 3 as const };
    if (enhancements.length === 0) {
      if (this.previewChroma !== this.mapChroma) {
        this.previewChroma = this.mapChroma;
        void this.preview.setEnvironment(row.environmentId ?? 'DefaultEnvironment', this.mapChroma);
      }
      return;
    }
    // (read back with ChroPaper's own parser: the view plays exactly what gets written)
    const ours = parseV3ChromaEnvironment(chromaCustomData(enhancements, animations, false) as BeatmapCustomData).chromaEnvironment;
    for (const animation of ours.animations) {
      animation.songBpmTime = this.toSong(animation.jsonTime);
      animation.durationSongBpmTime = this.toSong(animation.jsonTime + animation.duration) - animation.songBpmTime;
    }
    const merged = [...base.animations, ...ours.animations].sort((a, b) => a.songBpmTime - b.songBpmTime);
    if (reload || this.previewChroma === undefined || this.previewChroma === this.mapChroma) {
      this.previewChroma = { ...base, enhancements: [...base.enhancements, ...ours.enhancements], animations: merged };
      void this.preview.setEnvironment(row.environmentId ?? 'DefaultEnvironment', this.previewChroma);
    } else {
      this.previewChroma.animations = merged;
      this.preview.view.refreshChromaAnimations();
    }
  }

  /** The map's Noodle data (as the file has it). */
  private mapNoodle: NoodleBeatmapData | null = null;
  private ringParentKey = '';

  /** Rings drawn from geometry turn as Noodle parents: the 3D view's Noodle data with the ring poses'
   *  turns as they are now (the file's — the poses saved before — out). */
  private syncRingParents(animations: RingAnimation[]) {
    const key = JSON.stringify(animations);
    if (key === this.ringParentKey || this.mapNoodle === null) return;
    this.ringParentKey = key;
    const parsed = parseV3ChromaEnvironment(chromaCustomData([], animations, false) as BeatmapCustomData);
    const ours = parseNoodleBeatmap(parsed, 3).trackEvents.map((event, index) => {
      const songBpmTime = this.toSong(event.jsonTime);
      return { ...event, order: 1e6 + index, songBpmTime, durationSongBpmTime: this.toSong(event.jsonTime + event.duration) - songBpmTime };
    });
    this.ringNoodle = ours;
    this.pushNoodle();
  }

  /** The ring parents' events (see `syncRingParents`). */
  private ringNoodle: NoodleBeatmapData['trackEvents'] = [];
  /** The Noodle data of the environment being tried (the scene's links, the player). */
  private sceneNoodle: NoodleBeatmapData | null = null;

  /** The 3D view's Noodle data: the file's, with the ring parents' and the scene's (being tried) in
   *  place of the ones saved before. */
  private pushNoodle() {
    const base = this.mapNoodle;
    if (base === null) return;
    const ours = (tracks: readonly string[]) => tracks.some((track) => track.startsWith('lumatic'));
    const scene = this.sceneNoodle;
    const time = <T extends { jsonTime: number; songBpmTime: number; order?: number }>(list: readonly T[], index0: number): T[] =>
      list.map((event, index) => ({ ...event, order: index0 + index, songBpmTime: this.toSong(event.jsonTime) }));
    const sceneTracks = scene === null ? [] : time(scene.trackEvents.filter((event) => ours(event.tracks)), 2e6).map((event) => ({ ...event, durationSongBpmTime: this.toSong(event.jsonTime + event.duration) - event.songBpmTime }));
    const trackEvents = [...base.trackEvents.filter((event) => !event.tracks.some((track) => track.startsWith(TRACK_PREFIX)) && (scene === null || !ours(event.tracks))), ...this.ringNoodle, ...sceneTracks].sort((a, b) => a.songBpmTime - b.songBpmTime);
    const parentEvents = scene === null ? base.parentEvents : [...base.parentEvents.filter((event) => !ours([event.parentTrack])), ...time(scene.parentEvents.filter((event) => ours([event.parentTrack])), 3e6)].sort((a, b) => a.songBpmTime - b.songBpmTime);
    const playerEvents = scene === null ? base.playerEvents : [...base.playerEvents.filter((event) => !ours([event.track])), ...time(scene.playerEvents.filter((event) => ours([event.track])), 4e6)].sort((a, b) => a.songBpmTime - b.songBpmTime);
    this.preview.setNoodle({ ...base, trackEvents, parentEvents, playerEvents });
  }

  // ----- trying things out ----------------------------------------------------------------------------

  /** Plays something in the 3D view only, over and over from `start` to `end`. */
  startTrial(extra: { clips: LightClip[]; raw: RawEvent[]; start: number; end: number; songLoop?: boolean }) {
    this.previewExtra = extra;
    this.rebuildPreview(true);
    this.seek(Math.max(0, extra.start - 0.5));
    if (!this.isPlaying()) this.togglePlay();
    this.emit('time');
  }

  /** The picked stretch of the song played over and over (again: stopped). Without one: a hint. */
  toggleLoop() {
    if (this.previewExtra?.songLoop === true) {
      this.stopTrial();
      this.setStatus(tr('Проигрывание по кругу остановлено'));
      return;
    }
    const range = this.songRange;
    if (range === null || Math.abs(range.end - range.start) < 1e-6) {
      this.setStatus(tr('Выделите участок песни: Shift + протянуть по линейке или спектрограмме'));
      return;
    }
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    // (the notes side: the objects picked with the stretch let go — it plays, nothing to edit)
    if (this.tab === 'notes' && this.noteSelection.size > 0) this.selectNotes([]);
    this.startTrial({ clips: [], raw: [], start: start + 0.5, end: end - 1, songLoop: true });
    this.setStatus(tr('По кругу: доли {0}–{1}. L или Esc — стоп', Math.round(start * 1000) / 1000, Math.round(end * 1000) / 1000));
  }

  stopTrial() {
    if (this.previewExtra === null) return;
    this.previewExtra = null;
    if (this.isPlaying()) this.togglePlay();
    this.rebuildPreview(true);
    this.emit('time');
  }

  /** Called every frame: loops the try-out. */
  tickTrial() {
    const extra = this.previewExtra;
    if (extra === null || !this.isPlaying()) return;
    if (this.playhead() > extra.end + 1) this.seek(Math.max(0, extra.start - 0.5), true);
  }

  // ----- the notes side ------------------------------------------------------------------------------

  /** Opens the lights or the notes side. */
  setTab(tab: 'lights' | 'notes') {
    if (tab === this.tab) return;
    this.tab = tab;
    this.rebuildPreview(true);
    this.emit('all');
  }

  /** An object of the notes side by its id, with its kind. */
  objectById(id: string) {
    for (const kind of Object.keys(this.objects) as ObjectKind[]) {
      const item = (this.objects[kind] as { id: string }[]).find((entry) => entry.id === id);
      if (item !== undefined) return { kind, item: item as MapObjects[typeof kind][number] };
    }
    return null;
  }

  private issuesKey = '';
  private issues: MapIssue[] = [];
  /** What the map checker finds in the difficulty's notes (worked out again only after a change). */
  mapIssues(): MapIssue[] {
    const disabled = settings().disabledChecks;
    const standards = settings().checkSources;
    const key = `${String(this.noteVersion)}|${this.row?.key ?? ''}|${String(this.duration)}|${disabled.join(',')}|${standards.join(',')}`;
    if (key !== this.issuesKey) {
      this.issuesKey = key;
      const info = this.row?.infoDifficulty;
      const halfJump = info === undefined ? undefined : jumpOf(this.songBpm, info.noteJumpSpeed > 0 ? info.noteJumpSpeed : 16, info.noteStartBeatOffset).half;
      this.issues = checkMap({ objects: this.objects, seconds: (beat) => this.beatToSeconds(beat), songSeconds: this.duration, difficulty: info?.difficulty, disabled, standards, halfJump });
    }
    return this.issues;
  }

  private rollsKey = -1;
  private rolls = new Map<string, number>();
  /** How the game turns a note (degrees, 0 = down), windows and stacks lined up as it does. */
  noteRoll(id: string) {
    if (this.rollsKey !== this.noteVersion) {
      this.rollsKey = this.noteVersion;
      this.rolls = noteRolls(this.objects.notes);
    }
    return this.rolls.get(id);
  }

  /** The difficulty's fake walls (Noodle), shown on the track. */
  fakeWalls: MapWall[] = [];

  /** Whether the user chose to ignore this find. */
  isIgnored(issue: MapIssue) {
    return this.project?.ignoredIssues?.includes(issue.key) === true;
  }

  /** The finds not ignored. */
  activeIssues() {
    const ignored = new Set(this.project?.ignoredIssues ?? []);
    return this.mapIssues().filter((issue) => !ignored.has(issue.key));
  }

  /** Ignores a find (or stops ignoring it); kept with the map's project file. */
  ignoreIssue(issue: MapIssue, ignore: boolean) {
    const project = this.project;
    if (project === null) return;
    const list = new Set(project.ignoredIssues ?? []);
    if (ignore) list.add(issue.key);
    else list.delete(issue.key);
    project.ignoredIssues = [...list];
    this.dirty = true;
    this.emit('selection');
  }

  /**
   * The selected walls as a strobe, if they are one: walls of one shape and length one after another
   * at one step (null: not a strobe).
   */
  selectedStrobe() {
    const walls = this.objects.walls.filter((wall) => this.noteSelection.has(wall.id)).sort((a, b) => a.b - b.b);
    if (walls.length < 2 || walls.length !== this.noteSelection.size) return null;
    const first = walls[0]!;
    const step = walls[1]!.b - first.b;
    if (!(step > 1e-4)) return null;
    for (let i = 1; i < walls.length; i++) {
      const wall = walls[i]!;
      if (wall.x !== first.x || wall.y !== first.y || wall.w !== first.w || wall.h !== first.h || Math.abs(wall.d - first.d) > 1e-4 || Math.abs(wall.b - walls[i - 1]!.b - step) > 1e-3) return null;
    }
    return { walls, from: first.b, to: walls[walls.length - 1]!.b + step, step, fill: first.d / step, shape: { x: first.x, y: first.y, w: first.w, h: first.h } };
  }

  /** The whole strobe a wall is part of (walls of its shape and length at one step before and after it). */
  strobeAround(id: string) {
    const wall = this.objects.walls.find((item) => item.id === id);
    if (wall === undefined) return [];
    const like = this.objects.walls.filter((other) => other.x === wall.x && other.y === wall.y && other.w === wall.w && other.h === wall.h && Math.abs(other.d - wall.d) < 1e-4).sort((a, b) => a.b - b.b);
    const at = like.indexOf(wall);
    const gap = (i: number) => (like[i + 1]?.b ?? Infinity) - (like[i]?.b ?? -Infinity);
    const step = Math.min(gap(at), gap(at - 1));
    if (!Number.isFinite(step) || step <= 1e-4) return [wall];
    let lo = at;
    let hi = at;
    while (lo > 0 && Math.abs(gap(lo - 1) - step) < 1e-3) lo--;
    while (hi < like.length - 1 && Math.abs(gap(hi) - step) < 1e-3) hi++;
    return like.slice(lo, hi + 1);
  }

  /** Makes the selected strobe again with other settings (one undo step; merged while typing). */
  restrobe(patch: { from: number; to: number; step: number; fill: number; shape: { x: number; y: number; w: number; h: number } }) {
    const current = this.selectedStrobe();
    if (current === null || !(patch.step > 0) || !(patch.to > patch.from)) return;
    const made = strobeWalls(patch.shape, patch.from, patch.to, patch.step, patch.fill).map((item) => ({ ...item, id: newId('n') }));
    if (made.length === 0) return;
    this.noteCheckpoint('restrobe');
    this.removeObjects(new Set(current.walls.map((wall) => wall.id)));
    this.objects.walls.push(...made);
    this.noteSelection = new Set(made.map((wall) => wall.id));
    this.notesChanged();
  }

  /** The selected objects with their kinds. */
  selectedObjects() {
    return allObjects(this.objects).filter(({ item }) => this.noteSelection.has(item.id));
  }

  /** The notes side's objects within a stretch of beats (walls, arcs and chains reaching into it). */
  objectsInRange(start: number, end: number): string[] {
    const from = Math.min(start, end) - 1e-6;
    const to = Math.max(start, end) + 1e-6;
    return allObjects(this.objects)
      .filter(({ kind, item }) => {
        const [a, b] = objectSpan(kind, item);
        // (a point inside, ends included; a span overlapping it, not just touching an end)
        return b - a < 1e-6 ? a >= from && a <= to : b > from + 2e-6 && a < to - 2e-6;
      })
      .map(({ item }) => item.id);
  }

  selectNotes(ids: Iterable<string>, mode: 'replace' | 'add' | 'toggle' = 'replace') {
    if (mode === 'replace') this.noteSelection = new Set(ids);
    else for (const id of ids) {
      if (mode === 'toggle' && this.noteSelection.has(id)) this.noteSelection.delete(id);
      else this.noteSelection.add(id);
    }
    this.emit('selection');
  }

  private noteSnapshot() {
    return JSON.stringify(this.objects);
  }

  /** The last undo step's merge key and when it was taken (steps of one kind in a row: one step). */
  private noteMerge: { key: string; at: number } | null = null;

  /** Call before a change to the objects (one undo step of the notes side). `merge`: changes of the
   *  same kind coming one after another (an arrow turned notch by notch) make one step. */
  noteCheckpoint(merge?: string) {
    const now = performance.now();
    if (merge !== undefined && this.noteMerge?.key === merge && now - this.noteMerge.at < 1200) {
      this.noteMerge.at = now;
      return;
    }
    this.noteMerge = merge === undefined ? null : { key: merge, at: now };
    const state = this.noteSnapshot();
    // (nothing changed since the last step: no step of its own)
    if (this.noteUndo.at(-1) !== state) this.noteUndo.push(state);
    if (this.noteUndo.length > 300) this.noteUndo.shift();
    this.noteRedo = [];
  }

  /** The last checkpoint wasn't needed. */
  noteUndoDiscard() {
    this.noteUndo.pop();
    this.noteMerge = null;
  }

  /** After a change to the objects: drawn again, the 3D view too. */
  notesChanged(rebuildNow = false) {
    this.noteVersion++;
    this.dirty = true;
    this.rebuildPreview(rebuildNow);
    this.emit('clips');
  }

  private restoreNotes(state: string) {
    this.objects = JSON.parse(state) as MapObjects;
    const ids = new Set(allObjects(this.objects).map(({ item }) => item.id));
    for (const id of [...this.noteSelection]) if (!ids.has(id)) this.noteSelection.delete(id);
    this.notesChanged(true);
  }

  /** One press: one change of the notes undone (steps that changed nothing passed over). */
  undoNotes() {
    const now = this.noteSnapshot();
    let state = this.noteUndo.pop();
    while (state !== undefined && state === now) state = this.noteUndo.pop();
    if (state === undefined) return;
    this.noteMerge = null;
    this.noteRedo.push(now);
    this.restoreNotes(state);
  }

  redoNotes() {
    const now = this.noteSnapshot();
    let state = this.noteRedo.pop();
    while (state !== undefined && state === now) state = this.noteRedo.pop();
    if (state === undefined) return;
    this.noteMerge = null;
    this.noteUndo.push(now);
    this.restoreNotes(state);
  }

  /** Puts objects in (one undo step); they become the selection. */
  /** A Lumatic ring event (a pose, a spin, the lasers' move) turned into the Chroma events it writes —
   *  their numbers then edited as they are (one undo step). */
  ringBlockToRaw(blockId: string) {
    const project = this.project;
    if (project === null) return;
    const made = this.poseEvents().filter((event) => event.group === blockId);
    this.checkpoint();
    const raw: RawEvent[] = made.map(({ group: _group, ...event }) => ({ id: newId('r'), beat: event.beat, type: event.type, value: event.value, floatValue: event.floatValue, ...(event.customData === undefined ? {} : { customData: structuredClone(event.customData) }) }));
    project.raw.push(...raw);
    project.ringBlocks = this.ringBlocks.filter((block) => block.id !== blockId);
    this.posePick = null;
    this.selection = new Set(raw.map((event) => event.id));
    this.changed();
  }

  /** Ring and zoom events made the game's own: Chroma's numbers taken off (raw events), a Lumatic
   *  event replaced by one plain event where it starts (one undo step). */
  toGameEvents(ids: readonly string[]) {
    const project = this.project;
    if (project === null) return;
    const raws = project.raw.filter((event) => ids.includes(event.id) && (event.type === RING_EVENT_TYPE || event.type === ZOOM_EVENT_TYPE));
    const blocks = this.ringBlocks.filter((block) => ids.includes(block.id) && !isLasers(block));
    if (raws.length === 0 && blocks.length === 0) return;
    this.checkpoint();
    for (const event of raws) {
      delete event.customData;
      event.value = 0;
      event.floatValue = 1;
    }
    const made: RawEvent[] = blocks.map((block) => ({ id: newId('r'), beat: block.start, type: isTurn(block) ? RING_EVENT_TYPE : ZOOM_EVENT_TYPE, value: 0, floatValue: 1 }));
    project.raw.push(...made);
    const gone = new Set(blocks.map((block) => block.id));
    project.ringBlocks = this.ringBlocks.filter((block) => !gone.has(block.id));
    this.posePick = null;
    this.selection = new Set([...raws.map((event) => event.id), ...made.map((event) => event.id)]);
    this.changed();
  }

  /** Chroma's (or the game's) ring and zoom events made Lumatic's: each a pose with its move — its
   *  turn from where the first ring was (by its rotation and direction), its step, its speed's time,
   *  its wave's (one undo step). */
  rawToRingEvent(ids: readonly string[]) {
    const project = this.project;
    if (project === null) return;
    const events = project.raw.filter((event) => ids.includes(event.id) && (event.type === RING_EVENT_TYPE || event.type === ZOOM_EVENT_TYPE));
    if (events.length === 0) return;
    this.checkpoint();
    const made: RingBlock[] = [];
    for (const event of events) {
      const data = (event.customData ?? {}) as Record<string, unknown>;
      const get = (key: string) => (typeof data[key] === 'number' ? (data[key] as number) : typeof data[`_${key}`] === 'number' ? (data[`_${key}`] as number) : undefined);
      const secondsPerBeat = 60 / this.bpmAt(event.beat);
      const duration = Math.round(chromaMoveBeats(event, secondsPerBeat) * 1000) / 1000;
      const filter = data.nameFilter ?? data._nameFilter;
      if (event.type === ZOOM_EVENT_TYPE) {
        const zoom = this.zoomInfo.find((system) => system.name === filter) ?? this.zoomInfo[0];
        const block = newZoomBlock(zoom, event.beat, event.beat + Math.max(0.25, duration), typeof filter === 'string' ? filter : '');
        block.poses = [newPose(0, { step: get('step') ?? zoom?.initialStep ?? 2, duration })];
        made.push(block);
        continue;
      }
      const system = this.ringInfo.find((item) => item.name === filter) ?? this.ringInfo[0];
      const rings = system?.rings ?? 1;
      const turned = (get('rotation') ?? system?.rotation.rotation ?? 90) * (get('direction') === 1 ? -1 : 1);
      const prop = get('prop') ?? system?.rotation.propagationSpeed ?? 1;
      // (the wave: `prop` rings a tick — the pose's wave the time it takes over all of them)
      const delay = prop >= rings ? 0 : Math.round(((rings / Math.max(0.01, prop)) * ringTickSeconds()) / secondsPerBeat * 1000) / 1000;
      const block = newRingBlock(typeof filter === 'string' && this.ringInfo.length > 1 ? filter : (system?.name ?? ''), 'event', event.beat, event.beat + Math.max(0.25, duration));
      block.poses = [newPose(0, { shape: 'spiral', relative: true, angle: turned, step: get('step') ?? system?.rotation.step ?? 0, duration, delay })];
      fitRingBlock(block);
      made.push(block);
    }
    project.raw = project.raw.filter((event) => !events.includes(event));
    project.ringBlocks = [...this.ringBlocks, ...made];
    const first = made[0]!;
    this.selection = new Set(made.map((block) => block.id));
    this.posePick = made.length === 1 ? { blockId: first.id, poseId: first.poses[0]!.id } : null;
    this.changed();
  }

  /** The notes the generator made last (so "another" puts its next pattern in their place). */
  private generated: { beat: number; red: number; blue: number; index: number; ids: string[] } | null = null;

  /**
   * So many red and blue notes made up at the cursor's beat (note-generator): fitting the notes before
   * them, the notes of those colours there put aside. `another`: the next pattern in place of the one
   * made last (the same undo step).
   */
  generateNotes(red: number, blue: number, another: boolean) {
    const beat = this.snapBeat(this.playhead());
    const last = this.generated;
    const again = another && last !== null && Math.abs(last.beat - beat) < 1e-6 && last.red === red && last.blue === blue && last.ids.some((id) => this.objectById(id) !== undefined);
    const madeBefore = new Set(again ? last.ids : []);
    const notes = this.objects.notes.filter((note) => !madeBefore.has(note.id));
    const patterns = generatePatterns({ beat, red, blue, notes, bombs: this.objects.bombs });
    if (patterns.length === 0) {
      this.setStatus(tr('Нет подходящего паттерна на доле {0}', Math.round(beat * 1000) / 1000));
      return;
    }
    const index = again ? (last.index + 1) % patterns.length : 0;
    if (!again) this.noteCheckpoint();
    // (the notes of the colours made, at the beat — and the pattern made before — out)
    const making = new Set<number>([...(red > 0 ? [0] : []), ...(blue > 0 ? [1] : [])]);
    const out = new Set([...madeBefore, ...this.objects.notes.filter((note) => Math.abs(note.b - beat) < 1e-6 && making.has(note.c)).map((note) => note.id)]);
    this.removeObjects(out);
    const made = patterns[index]!.map((item) => ({ id: newId('n'), b: beat, x: item.x, y: item.y, c: item.c, d: item.d, a: 0 }));
    this.objects.notes.push(...made);
    this.noteSelection = new Set(made.map((note) => note.id));
    this.generated = { beat, red, blue, index, ids: made.map((note) => note.id) };
    this.notesChanged();
    this.setStatus(tr('Ноты на доле {0}: вариант {1} из {2}', Math.round(beat * 1000) / 1000, index + 1, patterns.length));
  }

  addObjects(items: { kind: ObjectKind; item: MapObjects[ObjectKind][number] }[], select = true) {
    if (items.length === 0) return;
    this.noteCheckpoint();
    for (const { kind, item } of items) (this.objects[kind] as unknown[]).push(item);
    if (select) this.noteSelection = new Set(items.map(({ item }) => item.id));
    this.notesChanged();
  }

  /** Takes objects out (without an undo step of its own: call noteCheckpoint first). */
  removeObjects(ids: ReadonlySet<string>) {
    for (const kind of Object.keys(this.objects) as ObjectKind[]) {
      (this.objects as Record<ObjectKind, { id: string }[]>)[kind] = (this.objects[kind] as { id: string }[]).filter((item) => !ids.has(item.id));
    }
    for (const id of ids) this.noteSelection.delete(id);
  }

  /** The selected walls as strobes up to a beat (each wall the first of its strobe; one undo step). */
  strobeSelectedWalls(until: number, step: number, fill: number) {
    const walls = this.objects.walls.filter((wall) => this.noteSelection.has(wall.id));
    const made = walls.flatMap((wall) => strobeWalls({ x: wall.x, y: wall.y, w: wall.w, h: wall.h }, wall.b, Math.max(until, wall.b + step), step, fill).map((item) => ({ ...item, id: newId('n') })));
    if (made.length === 0) return;
    this.noteCheckpoint();
    this.removeObjects(new Set(walls.map((wall) => wall.id)));
    this.objects.walls.push(...made);
    this.noteSelection = new Set(made.map((wall) => wall.id));
    this.notesChanged();
  }

  deleteNoteSelection() {
    if (this.noteSelection.size === 0) return;
    this.noteCheckpoint();
    this.removeObjects(new Set(this.noteSelection));
    this.notesChanged();
  }

  /** Changes the selected objects (one undo step). */
  updateObjects(ids: Iterable<string>, patch: (kind: ObjectKind, item: MapObjects[ObjectKind][number]) => void, merge?: string) {
    const wanted = new Set(ids);
    const found = allObjects(this.objects).filter(({ item }) => wanted.has(item.id));
    if (found.length === 0) return;
    const before = JSON.stringify(found.map(({ item }) => item));
    // (worked out on copies first: a change that changes nothing makes no undo step)
    const probe = found.map(({ kind, item }) => {
      const copy = structuredClone(item);
      patch(kind, copy);
      return copy;
    });
    if (JSON.stringify(probe) === before) return;
    this.noteCheckpoint(merge);
    for (const { kind, item } of found) patch(kind, item);
    this.notesChanged();
  }

  copyNotes() {
    const picked = this.selectedObjects();
    if (picked.length === 0) return;
    this.noteClipboard = picked.map(({ kind, item }) => ({ kind, item: structuredClone(item) }));
    this.setStatus(`Скопировано объектов: ${String(picked.length)}`);
  }

  cutNotes() {
    this.copyNotes();
    this.deleteNoteSelection();
  }

  notesClipboardSize() {
    return this.noteClipboard?.length ?? 0;
  }

  /** The copied objects put in with the first of them at `at` (beats). */
  pasteNotes(at: number) {
    const board = this.noteClipboard;
    if (board === null || board.length === 0) return;
    const first = Math.min(...board.map(({ item }) => item.b));
    const shift = at - first;
    const made = board.map(({ kind, item }) => {
      const copy = { ...structuredClone(item), id: newId('n'), b: item.b + shift } as MapObjects[ObjectKind][number];
      if ('tb' in copy) copy.tb += shift;
      return { kind, item: copy };
    });
    this.addObjects(made);
  }

  /** The arrows' direction for new notes — and the selected notes' too. */
  setNoteDirection(direction: number) {
    const notes = this.objects.notes.filter((note) => this.noteSelection.has(note.id));
    // a dot again: the dot turned an eighth on (the picked dots, else the tool's)
    if (direction === 8 && (notes.length > 0 ? notes.every((note) => note.d === 8) : this.noteTool.direction === 8 && this.noteTool.kind !== 'bomb' && this.noteTool.kind !== 'wall')) {
      if (notes.length > 0) {
        this.updateObjects(notes.map((note) => note.id), (kind, item) => {
          if (kind === 'notes') (item as { a: number }).a = ((((item as { a: number }).a ?? 0) + 45) % 360 + 360) % 360;
        });
        this.setStatus(tr('Точка повёрнута на {0}°', (((notes[0]!.a ?? 0) % 360) + 360) % 360));
      } else {
        this.noteTool = { ...this.noteTool, angle: ((this.noteTool.angle ?? 0) + 45) % 360 };
        this.setStatus(tr('Точка повёрнута на {0}°', this.noteTool.angle ?? 0));
        this.emit('selection');
      }
      return;
    }
    this.noteTool = { ...this.noteTool, kind: this.noteTool.kind === 'bomb' || this.noteTool.kind === 'wall' ? 'red' : this.noteTool.kind, direction, ...(direction === 8 ? { angle: 0 } : {}) };
    if (notes.length > 0) this.updateObjects(notes.map((note) => note.id), (kind, item) => {
      if (kind === 'notes') (item as { d: number }).d = direction;
    });
    else this.emit('selection');
  }

  /** The two selected notes, earlier first (null: not two notes, or both at one beat). */
  private selectedPair() {
    const notes = this.objects.notes.filter((note) => this.noteSelection.has(note.id)).sort((a, b) => a.b - b.b);
    if (notes.length !== 2 || Math.abs(notes[1]!.b - notes[0]!.b) < 1e-6) return null;
    return [notes[0]!, notes[1]!] as const;
  }

  /** An arc from the first of two selected notes to the second (the notes stay: an arc leads between
   *  them). */
  makeArc(): boolean {
    const pair = this.selectedPair();
    if (pair === null) {
      this.setStatus('Для дуги выделите две ноты на разных долях');
      return false;
    }
    const [head, tail] = pair;
    const arc = { id: newId('n'), c: head.c, b: head.b, x: head.x, y: head.y, d: head.d, mu: 1, tb: tail.b, tx: tail.x, ty: tail.y, tc: tail.d, tmu: 1, m: 0 };
    this.addObjects([{ kind: 'arcs', item: arc }]);
    this.setStatus('Дуга добавлена: её изгиб и сила — справа');
    return true;
  }

  /** A chain from the first of two selected notes to where the second is (the chain's head takes the
   *  first note's place; the second only marks where it ends). */
  makeChain(): boolean {
    const pair = this.selectedPair();
    const picked = this.objects.notes.filter((note) => this.noteSelection.has(note.id));
    const single = pair === null && picked.length === 1 ? picked[0]! : null;
    if (pair === null && single === null) {
      this.setStatus('Для цепи выделите ноту (хвост встанет по её стрелке) или две ноты на разных долях: начало и конец');
      return false;
    }
    if (difficultyVersionOf(this) === '2') {
      this.setStatus('В формате v2 цепей нет — переведите сложность в v3');
      return false;
    }
    // (one note: its tail two cells along the arrow; two: from the first to the second, the head's
    // arrow turned to the tail)
    const chain =
      single !== null
        ? { id: newId('n'), ...chainFromNote(single, Math.max(1 / 16, Math.min(0.5, this.snap || 0.25))) }
        : { id: newId('n'), c: pair![0].c, b: pair![0].b, x: pair![0].x, y: pair![0].y, d: directionOf(pair![1].x - pair![0].x, pair![1].y - pair![0].y, pair![0].d === 8 ? 1 : pair![0].d), tb: pair![1].b, tx: pair![1].x, ty: pair![1].y, sc: 5, s: 1 };
    this.noteCheckpoint();
    this.removeObjects(new Set(single !== null ? [single.id] : [pair![0].id, pair![1].id]));
    this.objects.chains.push(chain);
    this.noteSelection = new Set([chain.id]);
    this.notesChanged();
    this.setStatus('Цепь добавлена: голову и хвост можно тянуть мышью, число звеньев — справа или Alt+колесо');
    return true;
  }

  /** Every object of the notes side selected. */
  selectAllNotes() {
    this.selectNotes(allObjects(this.objects).map(({ item }) => item.id));
  }

  /** The 3D view's lights when the quick switch has them off: every lamp lit white at 30 %, nothing
   *  moving — the environment never goes dark. */
  private dimLights(): OutEvent[] {
    return [...this.lightsByType.keys()].map((type) => ({ beat: 0, type, value: 1, floatValue: 0.3, color: [1, 1, 1, 1] as [number, number, number, number] }));
  }

  // ----- preview --------------------------------------------------------------------------------------

  private shownNotes = -1;

  rebuildPreview(now = false) {
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    const run = () => {
      this.rebuildTimer = null;
      try {
        this.syncRingTracks();
        const track = this.tab === 'notes' && this.noteView === 'track';
        const show = !track && (this.tab === 'notes' || settings().notes);
        this.preview.setNotesMode(track ? 'hide' : this.tab === 'notes' ? 'show' : 'auto');
        const key = show ? this.noteVersion : -2;
        if (key !== this.shownNotes) {
          this.shownNotes = key;
          this.preview.setObjects(show ? engineObjects(this.objects, this.toSong) : null);
        }
        // (the tempo changes aren't lights: the view has the timing on its own)
        this.preview.setEvents(settings().previewLights && !this.staticLights ? this.previewEvents().filter((event) => event.type !== BPM_EVENT_TYPE) : this.dimLights());
      } catch (error) {
        console.error('[chroeditor] preview rebuild failed', error);
      }
    };
    if (now) run();
    else this.rebuildTimer = window.setTimeout(run, 40);
  }

  /** What the 3D view shows (kept until the show or what's tried out changes). */
  private previewEvents(): OutEvent[] {
    const cached = this.previewCache;
    if (cached !== null && cached.version === this.version && cached.extra === this.previewExtra && cached.project === this.project) return cached.events;
    const events = this.bakeForPreview();
    this.previewCache = { version: this.version, extra: this.previewExtra, project: this.project, events };
    return events;
  }

  private previewCache: { version: number; extra: Editor['previewExtra']; project: Project | null; events: OutEvent[] } | null = null;

  // ----- picked lights flash in the 3D view ------------------------------------------------------------

  /** Lights just picked (rows, groups, the mini map): they flash and fade out in the 3D view where the
   *  song is — whether it plays or not. Only the view sees it: nothing goes into the show. */
  private flash: { lights: LightRef[]; startedAt: number } | null = null;
  private flashFrame = 0;

  flashLights(lights: readonly LightRef[]) {
    if (this.project === null || lights.length === 0) return;
    this.flash = { lights: [...lights], startedAt: performance.now() };
    if (this.flashFrame === 0) this.flashFrame = requestAnimationFrame(this.flashStep);
  }

  /** (each frame of a flash: the 3D view lights the picked lights over the show, dimming — nothing
   *  rebuilt, so a show with many events doesn't stutter) */
  private readonly flashStep = () => {
    this.flashFrame = 0;
    const flash = this.flash;
    if (flash === null) return;
    const t = Math.min(1, (performance.now() - flash.startedAt) / FLASH_MS);
    if (t >= 1) {
      this.flash = null;
      this.preview.setHighlight(null);
      return;
    }
    this.preview.setHighlight(flash.lights, resolveRgb(this.brush.color, this.scheme()), 1.2 * (1 - t) ** 2);
    this.flashFrame = requestAnimationFrame(this.flashStep);
  };
}

/** How long a picked light's flash takes to fade out. */
const FLASH_MS = 1100;
const FIRST_RING_KEY = 'chroeditor.gameFirstRing';

/** The angle of a point around a centre, going clockwise from the top (0…2π). */
function angleOf(dx: number, dy: number) {
  // (lights straight above the centre sit a hair either side of it: those count as the top)
  const angle = Math.atan2(Math.abs(dx) < 1e-4 ? 0 : dx, dy);
  return angle < -1e-6 ? angle + Math.PI * 2 : Math.max(0, angle);
}

/** The open difficulty's file format, as read when it was opened. */
function difficultyVersionOf(editor: Editor): '2' | '3' | '4' {
  return editor.fileVersion;
}

// ----- autosave files ---------------------------------------------------------------------------------

const AUTOSAVE_SLOTS = 10;

/** A breath for the page between two long pieces of work (a frame drawn, the keys and mouse answered). */
function breather() {
  return new Promise<void>((resolve) => setTimeout(resolve, 16));
}
const AUTOSAVE_FOLDER = 'Lumatic backups/autosave';
const autosaveName = (file: string, slot: number) => `${AUTOSAVE_FOLDER}/${file}.${String(slot)}.json`;
const autosaveIndexName = (file: string) => `${AUTOSAVE_FOLDER}/${file}.index.json`;

interface AutosaveIndex {
  next: number;
  entries: { slot: number; savedAt: number }[];
  /** The newest one offered back and turned down. */
  dismissed?: number;
}

async function readAutosaveIndex(folder: MapFolder, file: string): Promise<AutosaveIndex> {
  try {
    const index = JSON.parse(await folder.readText(autosaveIndexName(file))) as AutosaveIndex;
    return { next: Number(index.next) || 0, entries: Array.isArray(index.entries) ? index.entries : [], ...(index.dismissed === undefined ? {} : { dismissed: index.dismissed }) };
  } catch {
    return { next: 0, entries: [] };
  }
}

/** The event type the timeline keeps the tempo changes as (v2 maps' own; v3: written as bpmEvents). */
export const BPM_EVENT_TYPE = 100;

/** The first beat where two timings part (null: the same throughout). */
function firstTimingChange(a: readonly { jsonTime: number; bpm: number }[], b: readonly { jsonTime: number; bpm: number }[], songBpm: number): number | null {
  const toSongA = createBpmConverter(a as never, songBpm);
  const toSongB = createBpmConverter(b as never, songBpm);
  const beats = [...new Set([0, ...a.map((event) => event.jsonTime), ...b.map((event) => event.jsonTime)])].sort((x, y) => x - y);
  for (let i = 0; i < beats.length; i++) {
    const at = beats[i]!;
    const next = beats[i + 1] ?? at + 1;
    // (the same pace there: the same right after it)
    if (Math.abs(toSongA(next) - toSongB(next)) > 1e-6 || Math.abs(toSongA(at) - toSongB(at)) > 1e-6) return at;
  }
  return null;
}
