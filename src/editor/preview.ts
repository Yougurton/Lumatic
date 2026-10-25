import {
  AdditiveBlending,
  CanvasTexture,
  Sprite,
  SpriteMaterial,
} from 'three';

import type { InfoColorScheme } from '../engine/core/beatmap/info';
import { createDifficulty, type BasicEvent, type BpmEvent } from '../engine/core/beatmap/types';
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
 * timelines (the cheap path ChroPaper's live lightshow uses). Also the editor's own things in the
 * scene: the green glow on a lamp picked in the timeline.
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
  private glow: { sprite: Sprite; startedAt: number } | null = null;
  private glowTexture: CanvasTexture | null = null;

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

  get colors(): ColorScheme {
    return this.view.currentColors;
  }

  /** The beat (song time, in beats of the song's own BPM) the view shows. */
  setBeatSource(source: () => number) {
    this.view.setBeatSource(source);
  }

  /** The lightshow as events (jsonTime beats). */
  setEvents(events: readonly OutEvent[]) {
    const toSong = createBpmConverter(this.bpmEvents, this.songBpm);
    const difficulty = createDifficulty('3.3.0');
    difficulty.bpmEvents = this.bpmEvents;
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

  /** A green glow on a lamp, fading out (a light picked in the timeline). */
  highlight(position: [number, number, number] | null) {
    if (this.glow !== null) {
      this.view.overlayRoot.remove(this.glow.sprite);
      this.glow.sprite.material.dispose();
      this.glow = null;
    }
    if (position === null) return;
    this.glowTexture ??= glowTexture();
    const material = new SpriteMaterial({ map: this.glowTexture, color: 0x33ff77, transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false });
    const sprite = new Sprite(material);
    sprite.position.set(...position);
    sprite.scale.set(3, 3, 1);
    sprite.renderOrder = 10_000;
    sprite.matrixAutoUpdate = true;
    sprite.updateMatrixWorld(true);
    this.view.overlayRoot.add(sprite);
    this.view.overlayRoot.updateMatrixWorld(true);
    this.glow = { sprite, startedAt: performance.now() };
    const step = () => {
      const glow = this.glow;
      if (glow === null || glow.sprite !== sprite) return;
      const t = (performance.now() - glow.startedAt) / 1600;
      material.opacity = Math.max(0, 1 - t);
      const scale = 3 + t * 2;
      sprite.scale.set(scale, scale, 1);
      sprite.updateMatrixWorld(true);
      if (t < 1) requestAnimationFrame(step);
      else this.highlight(null);
    };
    requestAnimationFrame(step);
  }
}

function glowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return new CanvasTexture(canvas);
}
