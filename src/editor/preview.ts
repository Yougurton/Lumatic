import { onSettings, setSettings, settings } from './settings';
import type { InfoColorScheme } from '../engine/core/beatmap/info';
import { createDifficulty, type BasicEvent, type BpmEvent, type Difficulty } from '../engine/core/beatmap/types';
import type { NoodleBeatmapData } from '../engine/core/noodle-data';
import { createBpmConverter, songBpmTimeToSeconds } from '../engine/core/beatmap/bpm';
import { setRingTickRate } from '../engine/core/lighting/ring-motion';
import type { PreviewSnapshot, PreviewTick } from './preview-state';
import type { ChromaEnvironmentData } from '../engine/core/chroma-environment';
import type { ColorScheme, Rgb } from '../engine/core/colors';
import { buildMapRenderData } from '../engine/core/placement/map-render-data';
import { DEFAULT_REPLAY_CAMERA_SETTINGS } from '../engine/core/viewer-settings';
import { MapView } from '../engine/renderer/map-view';
import { RendererLifecycle } from '../engine/renderer/renderer-lifecycle';
import type { OutEvent } from './bake';

/**
 * The 3D view: ChroPaper's renderer showing the environment with the lightshow as it is being
 * edited (lights only — the notes would only get in the way). Every edit rebuilds the light
 * timelines (the cheap path ChroPaper's live lightshow uses).
 */

export interface LightInfo {
  type: number;
  lightId: number;
  position: [number, number, number];
  ring: { group: number; index: number } | null;
  /** On something the laser speed events turn (a rotating laser). */
  moving: boolean;
}

export class Preview {
  readonly view: MapView;
  private readonly lifecycle = new RendererLifecycle();
  private songBpm = 120;
  private bpmEvents: BpmEvent[] = [];
  private colorScheme: InfoColorScheme | undefined;
  private environment: { id: string; chromaEnvironment?: ChromaEnvironmentData } | null = null;
  private environmentVersion = 0;
  private appliedEnvironmentVersion = -1;
  private initialized = false;
  private events: readonly OutEvent[] = [];
  private spectrumSource: ((seconds: number) => Float32Array | null) | null = null;
  private remoteSpectrum: Float32Array | null = null;
  private remoteBeat = 0;
  private remoteBeatRate = 0;
  private remoteBeatAt = 0;
  private highlight: PreviewTick['highlight'] = null;
  revision = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.lifecycle.attach(canvas);
    // (the floor's reflections are made with the view: a change waits for a restart)
    this.view = new MapView({ mirrorQuality: settings().mirror });
    this.lifecycle.setView(this.view);
    this.applySettings();
    onSettings(() => this.applySettings());
    this.view.setReplayCameraSettings({ ...DEFAULT_REPLAY_CAMERA_SETTINGS });
  }

  /** The settings' 3D view: the platform, the screen distortion, the notes and walls. */
  /** The notes in the game's view: shown, hidden (the notes side's track has them), or as the
   *  settings say. */
  private notesMode: 'auto' | 'show' | 'hide' = 'auto';

  setNotesMode(mode: 'auto' | 'show' | 'hide') {
    if (mode === this.notesMode) return;
    this.notesMode = mode;
    this.applySettings();
  }

  private applySettings() {
    const { platform, distortion, notes } = settings();
    const shown = this.notesMode === 'show' || (this.notesMode === 'auto' && notes);
    this.view.setLightshowMode(shown ? 'full' : 'full-lightshow');
    this.view.setShowPlayerPlatform(platform);
    this.view.setScreenDisplacementEffects(distortion);
    this.revision++;
  }

  setActive(active: boolean) {
    this.lifecycle.setActive(active);
  }

  setTiming(songBpm: number, bpmEvents: BpmEvent[], colorScheme: InfoColorScheme | undefined) {
    this.songBpm = songBpm;
    this.bpmEvents = bpmEvents;
    this.colorScheme = colorScheme;
    this.revision++;
  }

  async setEnvironment(id: string, chromaEnvironment?: ChromaEnvironmentData) {
    this.environment = { id, ...(chromaEnvironment === undefined ? {} : { chromaEnvironment }) };
    this.environmentVersion++;
    this.revision++;
    const result = await this.view.setEnvironment(id, chromaEnvironment);
    this.outlines.clear();
    // (the light groups' sizes and axes come from the environment: whoever shows them asks again)
    this.boxGroupsVersion++;
    return result.isOk();
  }

  /** The environment's lights (after setEnvironment). */
  lights(): LightInfo[] {
    return this.view.lightLayout();
  }

  /** The ring systems (big / small rings…). */
  environmentData() {
    return this.view.environmentData();
  }

  ringSystems() {
    return this.view.ringSystems();
  }

  /** One ring of a ring system seen down the tunnel (see MapView.ringOutline). */
  ringOutline(system = 0) {
    // (kept till the environment changes: the ring editor draws it every frame)
    // (none found — the environment still loading: asked again next time)
    if (!this.outlines.has(system)) {
      const found = this.view.ringOutline(system);
      if (found === null) return null;
      this.outlines.set(system, found);
    }
    return this.outlines.get(system) ?? null;
  }

  private outlines = new Map<number, ReturnType<MapView['ringOutline']>>();

  get colors(): ColorScheme {
    return this.view.currentColors;
  }

  /** Lights lit over the show (the editor's picked lights flashing); null: none. */
  setHighlight(lights: readonly { type: number; id: number }[] | null, color?: Rgb, strength?: number) {
    this.highlight = lights === null || lights.length === 0 ? null : { lights: lights.map((light) => ({ ...light })), ...(color === undefined ? {} : { color: [...color] }), ...(strength === undefined ? {} : { strength }) };
    this.view.setHighlight(lights, color, strength);
  }

  /** The beat (song time, in beats of the song's own BPM) the view shows. */
  setBeatSource(source: () => number) {
    this.view.setBeatSource(source);
  }

  /** The map's Noodle data the environment needs (its tracks' parents: AssignTrackParent). */
  private noodle: NoodleBeatmapData | null = null;

  setNoodle(noodle: NoodleBeatmapData | null) {
    this.noodle = noodle;
    this.revision++;
  }

  /** The difficulty's notes, walls, arcs and chains (null: none shown). */
  private objects: Pick<Difficulty, 'notes' | 'obstacles' | 'arcs' | 'chains'> | null = null;

  setObjects(objects: Pick<Difficulty, 'notes' | 'obstacles' | 'arcs' | 'chains'> | null) {
    this.objects = objects;
    this.revision++;
  }

  /** How fast the notes come and how far ahead they appear (the difficulty's NJS and offset). */
  private jump = { speed: 16, offset: 0 };

  setJump(speed: number, offset: number) {
    this.jump = { speed: speed > 0 ? speed : 16, offset };
    this.revision++;
  }

  /** The map's own group lighting (the event box groups of a GLS environment's map), as the engine
   *  parsed them: played as they are, with the editor's events (null: none). */
  private boxGroups: Pick<Difficulty, 'lightColorEventBoxGroups' | 'lightRotationEventBoxGroups' | 'lightTranslationEventBoxGroups' | 'fxEventBoxGroups'> | null = null;

  /** Changes whenever the map's groups or the environment do (for what is made from them and cached). */
  boxGroupsVersion = 0;

  /** The groups as set (null: none). */
  boxGroupsSet() {
    return this.boxGroups;
  }

  setBoxGroups(groups: Pick<Difficulty, 'lightColorEventBoxGroups' | 'lightRotationEventBoxGroups' | 'lightTranslationEventBoxGroups' | 'fxEventBoxGroups'> | null) {
    this.boxGroupsVersion++;
    this.revision++;
    this.boxGroups =
      groups === null
        ? null
        : {
            lightColorEventBoxGroups: groups.lightColorEventBoxGroups,
            lightRotationEventBoxGroups: groups.lightRotationEventBoxGroups,
            lightTranslationEventBoxGroups: groups.lightTranslationEventBoxGroups,
            fxEventBoxGroups: groups.fxEventBoxGroups,
          };
  }

  /** The lightshow as events (jsonTime beats). */
  setEvents(events: readonly OutEvent[]) {
    this.events = events;
    this.revision++;
    const toSong = createBpmConverter(this.bpmEvents, this.songBpm);
    const difficulty = createDifficulty('3.3.0');
    difficulty.bpmEvents = this.bpmEvents;
    if (this.noodle !== null) difficulty.noodle = this.noodle;
    if (this.objects !== null) Object.assign(difficulty, this.objects);
    if (this.boxGroups !== null) Object.assign(difficulty, this.boxGroups);
    difficulty.events = events.map((event): BasicEvent => {
      const customData: Record<string, unknown> = { ...(event.customData ?? {}) };
      if (event.color !== undefined) customData.color = event.color;
      if (event.lightIds !== undefined) customData.lightID = event.lightIds;
      if (event.hsv === true) customData.lerpType = 'HSV';
      return {
        jsonTime: event.beat,
        songBpmTime: toSong(event.beat),
        type: event.type,
        value: event.value,
        floatValue: event.floatValue,
        ...(Object.keys(customData).length > 0 ? { customData: customData as BasicEvent['customData'] } : {}),
      };
    });
    difficulty.events.sort((a, b) => a.songBpmTime - b.songBpmTime);
    const data = buildMapRenderData(difficulty, {
      noteJumpSpeed: this.jump.speed,
      noteStartBeatOffset: this.jump.offset,
      songBpm: this.songBpm,
      legacyNoodleV2Semantics: false,
      environmentRemoval: [],
    });
    this.view.updateLightshow(data, this.colorScheme);
  }

  setSpectrumSource(source: ((seconds: number) => Float32Array | null) | null) {
    this.spectrumSource = source;
    this.view.setSpectrumSource(source);
  }

  snapshot(): PreviewSnapshot {
    return {
      revision: this.revision,
      environmentVersion: this.environmentVersion,
      songBpm: this.songBpm,
      bpmEvents: this.bpmEvents,
      colorScheme: this.colorScheme,
      environment: this.environment,
      noodle: this.noodle,
      objects: this.objects,
      jump: this.jump,
      boxGroups: this.boxGroups,
      events: this.events,
      notesMode: this.notesMode,
      options: {
        platform: settings().platform,
        distortion: settings().distortion,
        notes: settings().notes,
        ringTicks: settings().ringTicks,
        trackScale: settings().trackScale,
        trackBehind: settings().trackBehind,
        visionLine: settings().visionLine,
        fps: settings().fps,
        previewLights: settings().previewLights,
      },
      horizontalFov: this.view.horizontalFieldOfView,
      freeCamera: this.view.freeCameraPose(),
    };
  }

  tick(beat: number, playing = false, beatRate = 0): PreviewTick {
    const songBeat = createBpmConverter(this.bpmEvents, this.songBpm)(beat);
    const spectrum = this.spectrumSource?.(songBpmTimeToSeconds(songBeat, this.songBpm)) ?? null;
    return { beat, playing, beatRate: playing ? beatRate : 0, spectrum: spectrum === null ? null : Array.from(spectrum), highlight: this.highlight };
  }

  async applySnapshot(state: PreviewSnapshot) {
    setRingTickRate(state.options.ringTicks);
    setSettings({ ...state.options });
    this.setTiming(state.songBpm, state.bpmEvents, state.colorScheme);
    this.setNotesMode(state.notesMode);
    this.setNoodle(state.noodle);
    this.setObjects(state.objects);
    this.setJump(state.jump.speed, state.jump.offset);
    this.setBoxGroups(state.boxGroups);
    this.view.setHorizontalFov(state.horizontalFov);
    if (!this.initialized) {
      this.view.setFreeCamera(state.freeCamera);
      this.initialized = true;
    }
    if (state.environment !== null && state.environmentVersion !== this.appliedEnvironmentVersion) {
      const loaded = await this.setEnvironment(state.environment.id, state.environment.chromaEnvironment);
      if (loaded) this.appliedEnvironmentVersion = state.environmentVersion;
    }
    this.setEvents(state.events);
  }

  applyTick(state: PreviewTick) {
    this.remoteBeat = state.beat;
    this.remoteBeatRate = state.beatRate;
    this.remoteBeatAt = performance.now();
    this.remoteSpectrum = state.spectrum === null ? null : Float32Array.from(state.spectrum);
    this.view.setBeatSource(() => this.remoteBeat + ((performance.now() - this.remoteBeatAt) / 1000) * this.remoteBeatRate);
    this.view.setSpectrumSource(() => this.remoteSpectrum);
    this.setHighlight(state.highlight?.lights ?? null, state.highlight?.color, state.highlight?.strength);
  }
}
