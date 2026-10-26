import type { InfoColorScheme } from '../engine/core/beatmap/info';
import { createDifficulty, type BasicEvent, type BpmEvent } from '../engine/core/beatmap/types';
import type { NoodleBeatmapData } from '../engine/core/noodle-data';
import { createBpmConverter } from '../engine/core/beatmap/bpm';
import type { ChromaEnvironmentData } from '../engine/core/chroma-environment';
import type { ColorScheme } from '../engine/core/colors';
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
}

export class Preview {
  readonly view: MapView;
  private readonly lifecycle = new RendererLifecycle();
  private songBpm = 120;
  private bpmEvents: BpmEvent[] = [];
  private colorScheme: InfoColorScheme | undefined;

  constructor(canvas: HTMLCanvasElement) {
    this.lifecycle.attach(canvas);
    this.view = new MapView({ mirrorQuality: 'medium' });
    this.lifecycle.setView(this.view);
    this.view.setLightshowMode('full-lightshow');
    this.view.setShowPlayerPlatform(false);
    this.view.setScreenDisplacementEffects(true);
    this.view.setReplayCameraSettings({ ...DEFAULT_REPLAY_CAMERA_SETTINGS });
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

  /** The beat (song time, in beats of the song's own BPM) the view shows. */
  setBeatSource(source: () => number) {
    this.view.setBeatSource(source);
  }

  /** The map's Noodle data the environment needs (its tracks' parents: AssignTrackParent). */
  private noodle: NoodleBeatmapData | null = null;

  setNoodle(noodle: NoodleBeatmapData | null) {
    this.noodle = noodle;
  }

  /** The lightshow as events (jsonTime beats). */
  setEvents(events: readonly OutEvent[]) {
    const toSong = createBpmConverter(this.bpmEvents, this.songBpm);
    const difficulty = createDifficulty('3.3.0');
    difficulty.bpmEvents = this.bpmEvents;
    if (this.noodle !== null) difficulty.noodle = this.noodle;
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
      noteJumpSpeed: 16,
      noteStartBeatOffset: 0,
      songBpm: this.songBpm,
      legacyNoodleV2Semantics: false,
      environmentRemoval: [],
    });
    this.view.updateLightshow(data, this.colorScheme);
  }
}
