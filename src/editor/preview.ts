import { onSettings, settings } from './settings';
import type { InfoColorScheme } from '../engine/core/beatmap/info';
import { createDifficulty, type BasicEvent, type BpmEvent, type Difficulty } from '../engine/core/beatmap/types';
import type { NoodleBeatmapData } from '../engine/core/noodle-data';
import { createBpmConverter } from '../engine/core/beatmap/bpm';
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
  }

  setTiming(songBpm: number, bpmEvents: BpmEvent[], colorScheme: InfoColorScheme | undefined) {
    this.songBpm = songBpm;
    this.bpmEvents = bpmEvents;
    this.colorScheme = colorScheme;
  }

  async setEnvironment(id: string, chromaEnvironment?: ChromaEnvironmentData) {
    const result = await this.view.setEnvironment(id, chromaEnvironment);
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

  get colors(): ColorScheme {
    return this.view.currentColors;
  }

  /** Lights lit over the show (the editor's picked lights flashing); null: none. */
  setHighlight(lights: readonly { type: number; id: number }[] | null, color?: Rgb, strength?: number) {
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
  }

  /** The difficulty's notes, walls, arcs and chains (null: none shown). */
  private objects: Pick<Difficulty, 'notes' | 'obstacles' | 'arcs' | 'chains'> | null = null;

  setObjects(objects: Pick<Difficulty, 'notes' | 'obstacles' | 'arcs' | 'chains'> | null) {
    this.objects = objects;
  }

  /** How fast the notes come and how far ahead they appear (the difficulty's NJS and offset). */
  private jump = { speed: 16, offset: 0 };

  setJump(speed: number, offset: number) {
    this.jump = { speed: speed > 0 ? speed : 16, offset };
  }

  /** The lightshow as events (jsonTime beats). */
  setEvents(events: readonly OutEvent[]) {
    const toSong = createBpmConverter(this.bpmEvents, this.songBpm);
    const difficulty = createDifficulty('3.3.0');
    difficulty.bpmEvents = this.bpmEvents;
    if (this.noodle !== null) difficulty.noodle = this.noodle;
    if (this.objects !== null) Object.assign(difficulty, this.objects);
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
}
