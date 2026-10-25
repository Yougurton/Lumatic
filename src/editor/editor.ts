import { createBpmConverter } from '../engine/core/beatmap/bpm';
import type { BpmEvent } from '../engine/core/beatmap/types';
import { createAudioClock, createSilentClock, type SongClock } from '../engine/core/clock/song-clock';
import type { DifficultyRow } from '../engine/mapfile/viewer-types';
import { bakeLights, rawEvents, type OutEvent, type SchemeColors } from './bake';
import { importEvents } from './import';
import { difficultyFile, loadMap, loadProject, projectFileName, suggestChroma, writeDifficulty, type LoadedMap } from './map-io';
import { cloneClip, isLightType, newId, type ClipColor, type EndMode, type LightClip, type Project, type RawEvent, type StartMode } from './model';
import { lightGroupName, otherEventName } from './names';
import type { MapFolder } from './platform';
import type { LightInfo, Preview } from './preview';
import { computeSpectrogram, type Spectrogram } from './spectrogram';

/**
 * The editor's state and everything that changes it: the open map and difficulty, the project
 * (clips, raw events), the selection, undo/redo, the song's clock, the rows of the timeline. Views
 * (timeline, inspector, mini map, preview) read it and are told to redraw through `onChange`.
 */

export type Row =
  | { kind: 'group'; key: string; type: number; label: string; expanded: boolean; lights: number[] }
  | { kind: 'light'; key: string; type: number; id: number; label: string }
  | { kind: 'raw'; key: string; type: number; label: string };

export interface Brush {
  color: ClipColor;
  endColor: ClipColor | null;
  startMode: StartMode;
  fadeIn: number;
  endMode: EndMode;
  layer: number;
  hsv: boolean;
}

type Listener = (what: 'all' | 'clips' | 'selection' | 'time' | 'rows') => void;

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
  status = '';
  dirty = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  private clipboard: { clips: LightClip[]; raw: RawEvent[] } | null = null;
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
    await this.openDifficulty(rows[0]!);
    void this.loadSong();
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
    await this.preview.setEnvironment(environment, difficulty.chromaEnvironment);
    this.lightInfo = this.preview.lights();
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
    if (saved !== null) this.project = saved;
    else {
      const lastBeat = Math.max(0, ...difficulty.events.map((event) => event.jsonTime), ...difficulty.notes.map((note) => note.jsonTime));
      const { clips, raw } = importEvents(difficulty.events, this.lightsByType, lastBeat + 8, this.songBpm / 60);
      this.project = { format: 'chroeditor', version: 1, difficulty: file, environment, clips, raw, expanded: [] };
    }
    this.selection.clear();
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
    const clock = this.clock;
    this.preview.setBeatSource(() => clock.currentBeat());
    this.emit('all');
    if (buffer !== null) {
      this.spectrogram = await computeSpectrogram(buffer);
      this.emit('time');
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
    const colors = this.preview.colors;
    const scheme: SchemeColors = { left: [...colors.environmentLeft], right: [...colors.environmentRight], white: [...colors.environmentWhite] };
    return [...bakeLights(project.clips, this.lightsByType, scheme, 60 / this.songBpm), ...rawEvents(project.raw)].sort((a, b) => a.beat - b.beat);
  }

  async save() {
    const map = this.map;
    const row = this.row;
    const project = this.project;
    if (map === null || row === null || project === null) return;
    const file = difficultyFile(row);
    const original = await map.folder.readText(file);
    const events = this.bake();
    const text = writeDifficulty(original, events);
    await map.folder.writeText(file, text);
    await map.folder.writeText(projectFileName(file), JSON.stringify(project));
    if (events.some((event) => event.color !== undefined || event.lightIds !== undefined)) {
      const infoName = map.folder.files.find((name) => name.toLowerCase() === 'info.dat');
      if (infoName !== undefined) await map.folder.writeText(infoName, suggestChroma(await map.folder.readText(infoName), file));
    }
    await map.folder.refresh();
    this.dirty = false;
    this.setStatus(`Сохранено: ${file} (${String(events.length)} событий)`);
  }

  // ----- rows ----------------------------------------------------------------------------------------

  buildRows() {
    const project = this.project;
    if (project === null) {
      this.rows = [];
      return;
    }
    const lightTypes = new Set<number>([...this.lightsByType.keys(), ...project.clips.map((clip) => clip.type)]);
    const rows: Row[] = [];
    for (const type of [...lightTypes].sort((a, b) => a - b)) {
      const lights = this.lightsByType.get(type) ?? [...new Set(project.clips.filter((clip) => clip.type === type).flatMap((clip) => clip.ids ?? []))].sort((a, b) => a - b);
      const expanded = project.expanded.includes(type);
      rows.push({ kind: 'group', key: `g${String(type)}`, type, label: lightGroupName(type), expanded, lights });
      if (expanded) for (const id of lights) rows.push({ kind: 'light', key: `l${String(type)}:${String(id)}`, type, id, label: `ID ${String(id)}` });
    }
    const rawTypes = [...new Set(project.raw.map((event) => event.type))].sort((a, b) => a - b);
    for (const type of [8, 9, 12, 13, 5]) if (!rawTypes.includes(type)) rawTypes.push(type);
    for (const type of rawTypes.sort((a, b) => a - b)) rows.push({ kind: 'raw', key: `r${String(type)}`, type, label: otherEventName(type) });
    this.rows = rows;
  }

  toggleExpanded(type: number) {
    const project = this.project;
    if (project === null) return;
    project.expanded = project.expanded.includes(type) ? project.expanded.filter((item) => item !== type) : [...project.expanded, type];
    this.buildRows();
    this.emit('rows');
  }

  pickLight(type: number, id: number) {
    this.pickedLight = { type, id };
    const light = this.lightInfo.find((item) => item.type === type && item.lightId === id);
    this.preview.highlight(light?.position ?? null);
    this.emit('selection');
  }

  // ----- edits -------------------------------------------------------------------------------------

  private snapshot() {
    const project = this.project;
    return project === null ? '' : JSON.stringify({ clips: project.clips, raw: project.raw });
  }

  /** Call before a change (one undo step). */
  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
  }

  /** After a change: redraw, preview again. */
  changed(rebuildNow = false) {
    this.dirty = true;
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
    const data = JSON.parse(state) as { clips: LightClip[]; raw: RawEvent[] };
    project.clips = data.clips;
    project.raw = data.raw;
    const ids = new Set([...data.clips.map((clip) => clip.id), ...data.raw.map((event) => event.id)]);
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
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
    project.clips = project.clips.filter((clip) => !this.selection.has(clip.id));
    project.raw = project.raw.filter((event) => !this.selection.has(event.id));
    this.selection.clear();
    this.changed();
  }

  selectAll() {
    const project = this.project;
    if (project === null) return;
    this.select([...project.clips.map((clip) => clip.id), ...project.raw.map((event) => event.id)]);
  }

  copy() {
    const project = this.project;
    if (project === null) return;
    const clips = this.selectedClips().map((clip) => cloneClip(clip, { id: clip.id }));
    const raw = project.raw.filter((event) => this.selection.has(event.id)).map((event) => ({ ...event }));
    if (clips.length + raw.length > 0) this.clipboard = { clips, raw };
  }

  /** Pastes at `at` (the first copied thing lands there). */
  paste(at: number) {
    const project = this.project;
    const board = this.clipboard;
    if (project === null || board === null) return;
    const first = Math.min(...board.clips.map((clip) => clip.start), ...board.raw.map((event) => event.beat));
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
    this.selection = new Set(pasted);
    this.changed();
  }

  duplicateSelection() {
    const clips = this.selectedClips();
    if (clips.length === 0) return;
    const start = Math.min(...clips.map((clip) => clip.start));
    const end = Math.max(...clips.map((clip) => clip.end));
    this.copy();
    this.paste(start + (end - start));
  }

  // ----- preview --------------------------------------------------------------------------------------

  rebuildPreview(now = false) {
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    const run = () => {
      this.rebuildTimer = null;
      try {
        this.preview.setEvents(this.bake());
      } catch (error) {
        console.error('[chroeditor] preview rebuild failed', error);
      }
    };
    if (now) run();
    else this.rebuildTimer = window.setTimeout(run, 40);
  }
}
