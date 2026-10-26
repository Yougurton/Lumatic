import { createBpmConverter } from '../engine/core/beatmap/bpm';
import type { BeatmapCustomData, BpmEvent } from '../engine/core/beatmap/types';
import { EMPTY_CHROMA_ENVIRONMENT, parseV3ChromaEnvironment, type ChromaEnvironmentData } from '../engine/core/chroma-environment';
import { createAudioClock, createSilentClock, type SongClock } from '../engine/core/clock/song-clock';
import type { DifficultyRow } from '../engine/mapfile/viewer-types';
import { bakeLights, rawEvents, type OutEvent, type SchemeColors } from './bake';
import { importEvents } from './import';
import { difficultyFile, loadMap, loadProject, projectFileName, readBookmarks, suggestChroma, writeDifficulty, type LoadedMap } from './map-io';
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
import { buildEffect, childrenSignature, defaultParams, effectItems, KIND_NAMES, type Effect, type EffectExtras, type EffectKind, type EffectParams } from './effects';
import { defaultGls } from './gls';
import { lightGroupName, otherEventName } from './names';
import type { MapFolder } from './platform';
import type { LightInfo, Preview } from './preview';
import { computeSpectrogram, type Spectrogram } from './spectrogram';
import { readPreview, writePreview } from './map-settings';
import { chromaCustomData, cloneRingBlock, poseRingEvents, poseZoomEvents, type ZoomSystemInfo, ringAnimations, ringEnhancements, type RingAnimation, type RingBlock, type RingEnhancement, type RingSystemInfo } from './rings';

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
  | { kind: 'poses'; key: string; label: string; depth: number; ring: 'rotation' | 'zoom' };

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
  layer: number;
  hsv: boolean;
}

type Listener = (what: 'all' | 'clips' | 'selection' | 'time' | 'rows' | 'lights') => void;

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
  tool: { kind: 'clip' } | { kind: 'effect'; name: string; effect: EffectKind; params: Partial<EffectParams> } = { kind: 'clip' };
  /** The row effects and ring forms from the library go onto (its key). */
  activeRow: string | null = null;
  /** Something tried out in the 3D view only (not in the show): played over and over. */
  previewExtra: { clips: LightClip[]; raw: RawEvent[]; start: number; end: number } | null = null;
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
  dirty = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  private clipboard: { clips: LightClip[]; raw: RawEvent[]; effects: { effect: Effect; children: LightClip[]; raw: RawEvent[] }[]; ringBlocks: RingBlock[] } | null = null;
  private rebuildTimer: number | null = null;
  private toSong: (jsonTime: number) => number = (beat) => beat;

  constructor(readonly preview: Preview) {}

  onChange(listener: Listener) {
    this.listeners.add(listener);
  }

  emit(what: Parameters<Listener>[0]) {
    for (const listener of this.listeners) listener(what);
  }

  setStatus(text: string) {
    this.status = text;
    this.emit('time');
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
    return this.clock === null ? 0 : this.secondsToBeat(this.clock.currentTime());
  }

  get endBeat() {
    return this.secondsToBeat(this.duration);
  }

  isPlaying() {
    return this.clock?.isPlaying() === true;
  }

  togglePlay() {
    if (this.clock === null) return;
    if (this.clock.isPlaying()) this.clock.pause();
    else {
      void this.clock.unlockAudio();
      this.clock.play();
    }
    this.emit('time');
  }

  seek(beat: number) {
    if (this.clock === null) return;
    this.clock.seek(Math.max(0, Math.min(this.duration, this.beatToSeconds(beat))));
    this.emit('time');
  }

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
    this.ringEnhancementKey = '';
    this.ringAnimationKey = '';
    await this.preview.setEnvironment(environment, difficulty.chromaEnvironment);
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
    const fileBookmarks = readBookmarks(await map.folder.readText(file).catch(() => ''));
    if (saved !== null) this.project = { ...saved, groups: saved.groups ?? [], expandedGroups: saved.expandedGroups ?? [], effects: saved.effects ?? [], ringBlocks: saved.ringBlocks ?? [], bookmarks: saved.bookmarks ?? fileBookmarks };
    else {
      const lastBeat = Math.max(0, ...difficulty.events.map((event) => event.jsonTime), ...difficulty.notes.map((note) => note.jsonTime));
      const { clips, raw } = importEvents(difficulty.events, this.lightsByType, lastBeat + 8, this.songBpm / 60);
      this.project = { format: 'chroeditor', version: 1, difficulty: file, environment, clips, raw, expanded: [], groups: [], expandedGroups: [], effects: [], ringBlocks: [], bookmarks: fileBookmarks };
    }
    this.selection.clear();
    this.lightSelection.clear();
    this.focus = null;
    this.openEffect = null;
    this.previewExtra = null;
    this.activeRow = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.buildRows();
    this.rebuildPreview(true);
    this.setStatus(`${map.parsed.mapMeta.title} — ${row.label} (${environment})`);
    this.emit('all');
  }

  private async loadSong() {
    const map = this.map;
    if (map === null) return;
    this.clock?.dispose();
    this.clock = null;
    this.spectrogram = null;
    const audio = map.parsed.audioData;
    let buffer: AudioBuffer | null = null;
    if (audio !== null) {
      const result = await createAudioClock({
        audioData: audio,
        songBpm: this.songBpm,
        onBuffer: (decoded) => {
          buffer = decoded;
        },
      });
      if (result.isOk()) this.clock = result.value;
    }
    if (this.clock === null) this.clock = createSilentClock(this.beatToSeconds(this.endBeatOfProject()) + 10, this.songBpm);
    if (map.parsed.mapMeta.songTimeOffset !== 0) this.clock.setAudioOffset(map.parsed.mapMeta.songTimeOffset);
    this.duration = this.clock.duration;
    if (this.rate !== 1) this.clock.setRate(this.rate);
    const clock = this.clock;
    this.preview.setBeatSource(() => clock.currentBeat());
    this.emit('all');
    // (the spectrogram comes when it's ready)
    this.spectrogram = null;
    if (buffer !== null) {
      void computeSpectrogram(buffer).then((spectrogram) => {
        if (this.map !== map) return;
        this.spectrogram = spectrogram;
        this.emit('time');
      });
    }
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
    return this.bakeWith(project.clips, project.raw);
  }

  /** What the 3D view shows: the show, and whatever is being tried out. */
  bakeForPreview(): OutEvent[] {
    const project = this.project;
    const extra = this.previewExtra;
    if (project === null || extra === null) return this.bake();
    return this.bakeWith([...project.clips, ...extra.clips], [...project.raw, ...extra.raw]);
  }

  private bakeWith(clips: readonly LightClip[], raw: readonly RawEvent[]): OutEvent[] {
    const other = rawEvents(raw);
    const rings = other.filter((event) => event.type === RING_EVENT_TYPE).sort((a, b) => a.beat - b.beat);
    const poses = [...poseRingEvents(this.ringBlocks, rings, this.ringInfo, RING_EVENT_TYPE, this.toSong, 60 / this.songBpm), ...poseZoomEvents(this.ringBlocks, this.zoomInfo, ZOOM_EVENT_TYPE, 60 / this.songBpm)].map(({ group: _group, ...event }) => event);
    // (the poses' ring events before the show's own at the same moment: of two at once, the first wins)
    return [...bakeLights(clips, this.lightsByType, this.scheme(), 60 / this.songBpm, this.groups), ...poses, ...other].sort((a, b) => a.beat - b.beat);
  }

  /** The ring poses' ring events (for drawing them on the rings' row). */
  poseEvents() {
    const project = this.project;
    if (project === null) return [];
    const rings = rawEvents(project.raw).filter((event) => event.type === RING_EVENT_TYPE).sort((a, b) => a.beat - b.beat);
    return [...poseRingEvents(this.ringBlocks, rings, this.ringInfo, RING_EVENT_TYPE, this.toSong, 60 / this.songBpm), ...poseZoomEvents(this.ringBlocks, this.zoomInfo, ZOOM_EVENT_TYPE, 60 / this.songBpm)];
  }

  /** The Chroma environment the ring poses on tracks need: the rings on tracks, their turns
   *  (`forGame`: the rings found where the game puts them for this player — gameFirstRing). */
  ringChroma(forGame = false): { enhancements: RingEnhancement[]; animations: RingAnimation[] } {
    const first = forGame ? this.gameFirstRing : null;
    return { enhancements: ringEnhancements(this.ringBlocks, this.ringInfo, first ?? undefined), animations: ringAnimations(this.ringBlocks, this.ringInfo) };
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

  async save() {
    const map = this.map;
    const row = this.row;
    const project = this.project;
    if (map === null || row === null || project === null) return;
    const file = difficultyFile(row);
    const original = await map.folder.readText(file);
    const events = this.bake();
    const text = writeDifficulty(original, events, this.ringChroma(true), this.bookmarks);
    await map.folder.writeText(file, text);
    await map.folder.writeText(projectFileName(file), JSON.stringify(project));
    if (events.some((event) => event.color !== undefined || event.lightIds !== undefined) || this.ringChroma(true).enhancements.length > 0) {
      const infoName = map.folder.files.find((name) => name.toLowerCase() === 'info.dat');
      if (infoName !== undefined) await map.folder.writeText(infoName, suggestChroma(await map.folder.readText(infoName), file));
    }
    await map.folder.refresh();
    this.dirty = false;
    this.setStatus(`Сохранено: ${file} (${String(events.length)} событий)`);
  }

  // ----- rows ----------------------------------------------------------------------------------------

  get groups(): LightGroup[] {
    const project = this.project;
    if (project === null) return [];
    project.groups ??= [];
    return project.groups;
  }

  buildRows() {
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
    for (const type of [...lightTypes].sort((a, b) => a - b)) {
      if (replaced.has(type) || removed[String(type)] !== undefined) continue;
      const lights = this.lightsByType.get(type) ?? [...new Set(project.clips.filter((clip) => clip.type === type).flatMap((clip) => clip.ids ?? []))].sort((a, b) => a - b);
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
    if (this.ringInfo.length > 0 || this.ringBlocks.some((block) => block.kind !== 'zoom')) rows.push({ kind: 'poses', key: 'poses', label: 'Позы колец', depth: 0, ring: 'rotation' });
    if (this.zoomInfo.length > 0 || this.ringBlocks.some((block) => block.kind === 'zoom')) rows.push({ kind: 'poses', key: 'zoomposes', label: 'Зум колец', depth: 0, ring: 'zoom' });
    const rawTypes = [...new Set(project.raw.map((event) => event.type))].sort((a, b) => a - b);
    for (const type of [8, 9, 12, 13, 5]) if (!rawTypes.includes(type)) rawTypes.push(type);
    for (const type of rawTypes.sort((a, b) => a - b)) rows.push({ kind: 'raw', key: `r${String(type)}`, type, label: otherEventName(type), depth: 0 });
    this.rows = rows;
  }

  /** The environment's light groups a group of the user's stands in for (type → group). */
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
    }
    for (const clip of candidates) {
      const lights = clipLights(clip, groups);
      let touched = false;
      let partial = false;
      if (row.kind === 'group') {
        if (!lights.has(row.type)) continue;
        const ids = lights.get(row.type)!;
        touched = ids === null || ids.length > 0;
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

  private groupChanged() {
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
    return project === null ? '' : JSON.stringify({ clips: project.clips, raw: project.raw, groups: project.groups ?? [], effects: project.effects ?? [], ringBlocks: project.ringBlocks ?? [], bookmarks: project.bookmarks ?? [], rowOrder: project.rowOrder ?? [], replacedTypes: project.replacedTypes ?? {}, removedTypes: project.removedTypes ?? {} });
  }

  /** Call before a change (one undo step). */
  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
  }

  /** After a change: redraw, preview again. */
  changed(rebuildNow = false) {
    this.version++;
    this.dirty = true;
    this.previewExtra = null;
    this.noteHandEdits();
    this.rebuildPreview(rebuildNow);
    this.emit('clips');
  }

  /** The last checkpoint wasn't needed after all (a click that didn't change anything). */
  undoDiscard() {
    this.undoStack.pop();
  }

  undo() {
    const state = this.undoStack.pop();
    if (state === undefined || this.project === null) return;
    this.redoStack.push(this.snapshot());
    this.restore(state);
  }

  redo() {
    const state = this.redoStack.pop();
    if (state === undefined || this.project === null) return;
    this.undoStack.push(this.snapshot());
    this.restore(state);
  }

  private restore(state: string) {
    const project = this.project;
    if (project === null) return;
    const data = JSON.parse(state) as { clips: LightClip[]; raw: RawEvent[]; groups: LightGroup[]; effects?: Effect[]; ringBlocks?: RingBlock[]; bookmarks?: Bookmark[]; rowOrder?: string[]; replacedTypes?: Record<string, string>; removedTypes?: Record<string, number> };
    project.bookmarks = data.bookmarks ?? [];
    const rowsChanged = JSON.stringify(project.rowOrder ?? []) !== JSON.stringify(data.rowOrder ?? []) || JSON.stringify(project.replacedTypes ?? {}) !== JSON.stringify(data.replacedTypes ?? {}) || JSON.stringify(project.removedTypes ?? {}) !== JSON.stringify(data.removedTypes ?? {});
    project.rowOrder = data.rowOrder ?? [];
    project.replacedTypes = data.replacedTypes ?? {};
    project.removedTypes = data.removedTypes ?? {};
    project.clips = data.clips;
    project.raw = data.raw;
    project.effects = data.effects ?? [];
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
    this.changed(true);
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
    if (row.kind === 'group') return this.newClip(row.type, null, start, end);
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
      clip.ids = null;
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

  select(ids: Iterable<string>, mode: 'replace' | 'add' | 'toggle' = 'replace') {
    if (mode === 'replace') this.selection = new Set(ids);
    else for (const id of ids) {
      if (mode === 'toggle' && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.emit('selection');
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
    if (clips.length + raw.length + effects.length + ringBlocks.length > 0) this.clipboard = { clips, raw, effects, ringBlocks };
  }

  /** Pastes at `at` (the first copied thing lands there). */
  paste(at: number) {
    const project = this.project;
    const board = this.clipboard;
    if (project === null || board === null) return;
    const first = Math.min(...board.clips.map((clip) => clip.start), ...board.raw.map((event) => event.beat), ...board.effects.map((item) => item.effect.start), ...board.ringBlocks.map((block) => block.start));
    const shift = at - first;
    this.checkpoint();
    const pasted: string[] = [];
    for (const clip of board.clips) {
      const copy = cloneClip(clip, { start: clip.start + shift, end: clip.end + shift });
      project.clips.push(copy);
      pasted.push(copy.id);
    }
    for (const event of board.raw) {
      const copy = { ...event, id: newId('r'), beat: event.beat + shift };
      project.raw.push(copy);
      pasted.push(copy.id);
    }
    for (const { effect, children, raw } of board.effects) {
      const copy: Effect = { ...structuredClone(effect), id: newId('e'), start: effect.start + shift, end: effect.end + shift };
      this.effects.push(copy);
      for (const child of children) project.clips.push(cloneClip(child, { start: child.start + shift, end: child.end + shift, group: copy.id }));
      for (const event of raw) project.raw.push({ ...structuredClone(event), id: newId('r'), beat: event.beat + shift, group: copy.id });
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

  effectChildren(id: string) {
    return this.project?.clips.filter((clip) => clip.group === id) ?? [];
  }

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
  private targetOfRow(row: Row): Pick<Effect, 'target' | 'type' | 'ids'> | null {
    if (!isLightRow(row)) return null;
    if (row.kind === 'group') return { type: row.type, ids: null };
    if (row.kind === 'light') return { type: row.type, ids: [row.id] };
    return { target: row.group.id, type: groupLights(row.group)[0]?.type ?? 0, ids: null };
  }

  /** An effect (not yet in the show) on a row, from `start` to `end`. */
  makeEffect(kind: EffectKind, params: Partial<EffectParams>, row: Row, start: number, end: number, name = KIND_NAMES[kind]): Effect | null {
    const target = this.targetOfRow(row);
    if (target === null) return null;
    return {
      id: newId('e'),
      name,
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
      color: effect.kind === 'gls' ? (effect.gls?.boxes.find((box) => box.kind === 'color')?.events[0]?.color ?? p.color) : p.color,
      endColor: effect.kind === 'gls' ? null : p.color2,
      layer: effect.layer,
    };
  }

  /** Opens a GLS block's editor (set by the app). */
  glsEditorHook: ((id: string) => void) | null = null;

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
      this.regenerate(effect);
    }
    this.changed();
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
      if (effect.target !== undefined) {
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
    this.ringBlocks.push(block);
    this.selection = new Set([block.id]);
    this.changed();
  }

  /** Changes one ring pose block (one undo step). */
  updateRingBlock(id: string, patch: (block: RingBlock) => void) {
    const block = this.ringBlockById(id);
    if (block === undefined) return;
    this.checkpoint();
    patch(block);
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

  // ----- trying things out ----------------------------------------------------------------------------

  /** Plays something in the 3D view only, over and over from `start` to `end`. */
  startTrial(extra: { clips: LightClip[]; raw: RawEvent[]; start: number; end: number }) {
    this.previewExtra = extra;
    this.rebuildPreview(true);
    this.seek(Math.max(0, extra.start - 0.5));
    if (!this.isPlaying()) this.togglePlay();
    this.emit('time');
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
    if (this.playhead() > extra.end + 1) this.seek(Math.max(0, extra.start - 0.5));
  }

  // ----- preview --------------------------------------------------------------------------------------

  rebuildPreview(now = false) {
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    const run = () => {
      this.rebuildTimer = null;
      try {
        this.syncRingTracks();
        this.preview.setEvents([...this.previewEvents(), ...this.flashEvents()]);
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

  /** (each frame of a flash: the view gets the show with the flash where the song is now) */
  private readonly flashStep = () => {
    this.flashFrame = 0;
    if (this.flash === null) return;
    if (performance.now() - this.flash.startedAt >= FLASH_MS) this.flash = null;
    this.rebuildPreview(true);
    if (this.flash !== null) this.flashFrame = requestAnimationFrame(this.flashStep);
  };

  /** The flash as it is now: the picked lights lit in the brush's colour at the song's place, dimming
   *  from frame to frame (a light event at exactly that moment covers whatever the show does there). */
  private flashEvents(): OutEvent[] {
    const flash = this.flash;
    if (flash === null) return [];
    const t = Math.min(1, (performance.now() - flash.startedAt) / FLASH_MS);
    const brightness = 1.2 * (1 - t) ** 2;
    const [r, g, b] = resolveRgb(this.brush.color, this.scheme());
    // (a hair before the song's place: worked back from seconds, the beat can come out a rounding
    // error past the view's own, and an event after it isn't lit yet)
    const beat = this.playhead() - 1e-6;
    const byType = new Map<number, number[]>();
    for (const light of flash.lights) byType.set(light.type, [...(byType.get(light.type) ?? []), light.id]);
    return [...byType].map(([type, ids]) => ({ beat, type, value: 1, floatValue: brightness, color: [r, g, b, 1], lightIds: ids }));
  }
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
