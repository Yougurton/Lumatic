import { Result } from 'better-result';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  Euler,
  MeshBasicMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  PlaneGeometry,
  Vector2,
  WebGLRenderTarget,
  Group,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  type WebGLRenderer,
} from 'three';

import { HeckBaseProviderRuntime } from '../core/animation/base-provider';
import { songBpmTimeToSeconds } from '../core/beatmap/bpm';
import type { InfoColorScheme } from '../core/beatmap/info';
import type { ChromaEnvironmentData } from '../core/chroma-environment';
import type { EnvironmentData } from './environment/types';
import { DEFAULT_COLORS, resolveColorScheme, type ColorScheme, type Rgb } from '../core/colors';
import { isForcedLightshowMode, type LightshowMode } from '../core/lighting/basic-light';
import type { RingPositionConfig, RingRotationConfig } from '../core/lighting/ring-motion';
import { sampleNoodlePlayerTrack } from '../core/noodle-runtime';
import { applyReplayHeightEvents, applyReplayNoteEvents, type MapRenderData } from '../core/placement/map-render-data';
import type { HitScoreVisualizerConfig } from '../core/replay/hit-score-visualizer';
import type { Replay, ReplayHeightEvent, ReplayNoteEvent } from '../core/replay/types';
import {
  DEFAULT_REPLAY_CAMERA_SETTINGS,
  type ReplayCameraSettings,
  type ReplaySaberSettings,
} from '../core/viewer-settings';
import { BloomfogPipeline } from './bloomfog/pipeline';
import { fixedCameraPosition, GAMEPLAY_CAMERA_FAR } from './camera';
import {
  EnvironmentLoadAborted,
  environmentLoadFailure,
  type EnvironmentLoadFailure,
} from './environment/environment-error';
import { environmentLookupIds } from './environment/chroma-environment';
import { loadEnvironment } from './environment/environment-loader';
import type { EnvironmentLightBinding, LoadedEnvironment } from './environment/environment-runtime';
import { EnvironmentLightRuntime } from './map/environment-light-runtime';
import { MapObjectRenderer } from './map/map-object-renderer';
import { NoodlePlayerTransform } from './map/noodle-player-transform';
import { createMirrorMaterial, createSkyboxMaterial } from './materials/scene-materials';
import { collectMirrorConsumers, hasVisibleMirrorConsumer } from './mirror/mirror-consumers';
import {
  AFTER_SCREEN_DISPLACEMENT_LAYER,
  MAIN_ONLY_LAYER,
  PlanarMirror,
  SCREEN_DISPLACEMENT_LAYER,
} from './mirror/planar-mirror';
import { PostBloomPipeline } from './post-bloom/pipeline';
import { DEFAULT_QUALITY } from './quality';
import type { RenderView } from './renderer-lifecycle';
import { ReplayOrthographicOverlay } from './replay/orthographic-overlay';
import type { ReplayCameraMode } from './replay/replay-camera';
import { ReplayView } from './replay/replay-view';

/** No notes, bombs, walls, arcs or chains, and nothing that reshapes the environment — just
 *  lighting events (see MapView.updateLightshow). */
function isLightingOnly(data: MapRenderData) {
  return (
    data.notes.length === 0 &&
    data.bombs.length === 0 &&
    data.walls.length === 0 &&
    data.arcs.length === 0 &&
    data.chainLinks.length === 0 &&
    data.environmentRemoval.length === 0 &&
    data.chromaEnvironment === undefined
  );
}

function sameColorScheme(a: ColorScheme, b: ColorScheme) {
  if (a === b) return true;
  for (const key of Object.keys(a) as (keyof ColorScheme)[]) {
    const left = a[key];
    const right = b[key];
    if (left[0] !== right[0] || left[1] !== right[1] || left[2] !== right[2]) return false;
  }
  return true;
}

function fullscreenTriangle() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return geometry;
}

// Mouse-parallax easing (see setParallaxJelly): angular frequency range for the damped spring, and
// a fixed damping ratio below 1 (underdamped) so higher "jelly" settings visibly overshoot/wobble
// a little before settling, rather than just arriving late.
const PARALLAX_JELLY_MAX_OMEGA = 40; // near-instant catch-up at low jelly amounts
const PARALLAX_JELLY_MIN_OMEGA = 2.5; // slow, pronounced wobble at maximum jelly
const PARALLAX_DAMPING_RATIO = 0.45;

export class MapView implements RenderView {
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(
    DEFAULT_REPLAY_CAMERA_SETTINGS.replayCameraFov,
    1,
    0.1,
    GAMEPLAY_CAMERA_FAR,
  );
  private readonly playerCameraRoot = new Group();
  private readonly playerCameraHead = new Group();
  private readonly noodlePlayerTransform = new NoodlePlayerTransform();
  // Mouse-parallax for the wallpaper's static/forced-lightshow camera: playerCameraRoot is never
  // touched by the normal per-frame update in forced-lightshow mode (see update()), so it's free
  // to use here as a small extra offset/tilt applied on top of the otherwise-fixed camera.
  private readonly parallaxEuler = new Euler(0, 0, 0, 'YXZ');
  private readonly parallaxOffset = new Vector3();
  private readonly parallaxQuaternion = new Quaternion();
  private parallaxTargetX = 0;
  private parallaxTargetY = 0;
  private parallaxCurrentX = 0;
  private parallaxCurrentY = 0;
  private parallaxVelocityX = 0;
  private parallaxVelocityY = 0;
  private parallaxJelly = 0; // 0..1; 0 = snap straight to target (identical to no smoothing at all)
  private parallaxLastFrameTime: number | null = null;
  private readonly mapRoot = new Group();
  private readonly baseProviders = new HeckBaseProviderRuntime(
    (name, beat) => this.baseProvider(name, beat),
    (beat) => songBpmTimeToSeconds(beat, this.data?.songBpm ?? 120),
  );

  private readonly pipeline: BloomfogPipeline;
  private readonly postBloom: PostBloomPipeline;
  private readonly mirror: PlanarMirror;
  private readonly skybox: Mesh;
  private readonly replayView: ReplayView;
  private headsetRequested = false;
  private readonly replayOrthographicOverlay = new ReplayOrthographicOverlay();
  private readonly mapObjects: MapObjectRenderer;
  private readonly environmentLights = new EnvironmentLightRuntime();
  private environment: LoadedEnvironment | null = null;
  private environmentMirrorConsumers: Mesh[] = [];
  private environmentRequest: {
    id: string;
    chromaEnvironment?: ChromaEnvironmentData;
    controller: AbortController;
    result: Promise<Result<void, EnvironmentLoadFailure>>;
  } | null = null;

  private lightshowMode: LightshowMode = 'full';
  // Off until setShowWalls says otherwise, so forced-lightshow modes keep their original
  // "no map objects at all" behaviour for anything that never calls it.
  private showWallsInLightshow = false;
  private colors: ColorScheme = DEFAULT_COLORS;
  private songDuration = 0;
  private menuLightshowSeed: number | null = null;
  private orthoCameraEnabled = DEFAULT_REPLAY_CAMERA_SETTINGS.orthoCameraEnabled;
  private screenDisplacementEffects = true;
  // Whether to show the platform the player normally stands on (see setShowPlayerPlatform). Defaults
  // to shown — main.ts pushes the wallpaper's actual default (hidden) through setShowPlayerPlatform
  // right after construction, same as it does for screenDisplacementEffects above.
  private showPlayerPlatform = true;

  private data: MapRenderData | null = null;
  private beatSource: () => number = () => 0;
  /** Drawn over the finished picture (the editor's note track); `overlayUpdate` runs before. */
  readonly overlayScene = new Scene();
  overlayUpdate: (() => void) | null = null;
  private overlayTarget: WebGLRenderTarget | null = null;
  private overlayQuad: Mesh | null = null;
  private readonly overlayQuadScene = new Scene();
  private readonly overlayCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  /** A field of view across (degrees) kept whatever the view's shape (null: the usual one). */
  private horizontalFov: number | null = null;
  private usualFov: number | null = null;

  setHorizontalFov(degrees: number | null) {
    if (degrees !== null && this.usualFov === null) this.usualFov = this.camera.fov;
    this.horizontalFov = degrees;
    if (degrees === null && this.usualFov !== null) {
      this.camera.fov = this.usualFov;
      this.usualFov = null;
      this.camera.updateProjectionMatrix();
    }
  }

  /** The camera the view is seen through (for picking things in it). */
  get viewCamera(): PerspectiveCamera {
    return this.camera;
  }

  /** A camera flown by hand (world position, turn left/right and up/down in radians); null: the
   *  player's. */
  private freeCamera: { position: [number, number, number]; yaw: number; pitch: number } | null = null;
  private readonly freeEuler = new Euler(0, 0, 0, 'YXZ');
  private readonly playerCameraLocal = new Vector3();

  constructor(
    quality = DEFAULT_QUALITY,
    private readonly onEnvironmentLoadSettled: () => void = () => undefined,
    private readonly orthoOverlayElement: () => HTMLElement | null = () => null,
  ) {
    this.pipeline = new BloomfogPipeline();
    this.postBloom = new PostBloomPipeline();
    this.mirror = new PlanarMirror(quality, 6, 400);
    this.camera.position.set(...fixedCameraPosition(DEFAULT_REPLAY_CAMERA_SETTINGS.previewCameraDistance));
    this.playerCameraLocal.copy(this.camera.position);
    this.scene.matrixAutoUpdate = false;
    this.scene.matrixWorldAutoUpdate = false;
    this.camera.layers.enable(MAIN_ONLY_LAYER);
    this.camera.layers.enable(SCREEN_DISPLACEMENT_LAYER);
    this.camera.layers.enable(AFTER_SCREEN_DISPLACEMENT_LAYER);
    this.playerCameraHead.add(this.camera);
    this.playerCameraRoot.add(this.playerCameraHead);
    this.scene.add(this.playerCameraRoot);

    const fog = this.pipeline.fogUniforms;
    this.mapObjects = new MapObjectRenderer(this.mapRoot, fog, this.postBloom.screenDisplacementTexture, this.camera);

    this.skybox = new Mesh(fullscreenTriangle(), createSkyboxMaterial(fog));
    this.skybox.frustumCulled = false;
    this.skybox.renderOrder = -1000;
    this.scene.add(this.skybox);

    this.mirror.mesh.material = createMirrorMaterial(fog, this.mirror.reflectionTexture);
    this.mirror.mesh.position.set(0, 0, -150);
    this.mirror.mesh.visible = false;
    this.scene.add(this.mirror.mesh);

    this.scene.add(this.mapRoot);
    const directionalLights = this.environmentLights.directionalLights;
    this.replayView = new ReplayView(
      this.camera,
      fog,
      {
        directions: directionalLights.directions,
        colors: directionalLights.colors,
        positions: directionalLights.positions,
        radii: directionalLights.radii,
      },
      () => {
        this.mirror.updateMaterials(this.scene);
      },
    );
    this.replayView.hudRoot.traverse((object) => {
      object.layers.set(MAIN_ONLY_LAYER);
    });
    this.scene.add(this.replayView.hudRoot);
    this.scene.add(this.replayView.root);
    this.mirror.updateMaterials(this.scene);
    // The replay headset model is only ever shown with a replay loaded, so it's fetched on the
    // first setReplay() with one instead of up front (the wallpaper never loads replays, and the
    // model isn't shipped with it — loading it eagerly only produced a failed request).
  }

  setEnvironment(id: string, chromaEnvironment?: ChromaEnvironmentData): Promise<Result<void, EnvironmentLoadFailure>> {
    if (this.environment?.data.id === id && this.environment.chromaEnvironment === chromaEnvironment) {
      this.environmentRequest?.controller.abort();
      this.environmentRequest = null;
      return Promise.resolve(Result.ok(undefined));
    }
    if (this.environmentRequest?.id === id && this.environmentRequest.chromaEnvironment === chromaEnvironment) {
      return this.environmentRequest.result;
    }
    this.environmentRequest?.controller.abort();
    const controller = new AbortController();
    const result = this.loadAndApplyEnvironment(id, controller, chromaEnvironment);
    this.environmentRequest = { id, chromaEnvironment, controller, result };
    return result;
  }

  private async loadAndApplyEnvironment(
    id: string,
    controller: AbortController,
    chromaEnvironment?: ChromaEnvironmentData,
  ): Promise<Result<void, EnvironmentLoadFailure>> {
    const loadResult = await Result.tryPromise({
      try: () =>
        loadEnvironment(
          id,
          {
            fog: this.pipeline.fogUniforms,
            reflectionTexture: this.mirror.reflectionTexture,
            directionalLights: {
              directions: { value: this.environmentLights.directionalLights.directions },
              colors: { value: this.environmentLights.directionalLights.colors },
              positions: { value: this.environmentLights.directionalLights.positions },
              radii: { value: this.environmentLights.directionalLights.radii },
            },
            songTime: this.environmentLights.songTime,
          },
          controller.signal,
          chromaEnvironment,
        ),
      catch: (cause) => environmentLoadFailure(id, cause),
    });
    if (loadResult.isErr()) {
      if (this.environmentRequest?.controller === controller) {
        this.environmentRequest = null;
        this.onEnvironmentLoadSettled();
      }
      return Result.err(loadResult.error);
    }

    const environment = loadResult.value;
    if (controller.signal.aborted || this.environmentRequest?.controller !== controller) {
      environment.dispose();
      return Result.err(
        new EnvironmentLoadAborted({
          environmentId: id,
          message: `environment ${id} load was cancelled`,
        }),
      );
    }
    if (this.environment !== null) {
      this.scene.remove(this.environment.root);
      this.environment.dispose();
    }
    this.environment = environment;
    this.environmentRequest = null;
    this.environmentMirrorConsumers = collectMirrorConsumers(environment.root);
    this.scene.add(environment.root);
    this.applyPlayerPlatformVisibility();
    this.environmentLights.setEnvironment(environment);
    this.mirror.updateMaterials(this.scene);
    this.pipeline.setFogParams(environment.data.fogParams);
    const hasCustomEnvironment =
      chromaEnvironment !== undefined &&
      (Object.keys(chromaEnvironment.materials).length > 0 ||
        chromaEnvironment.enhancements.length > 0 ||
        chromaEnvironment.animations.length > 0 ||
        chromaEnvironment.componentAnimations.length > 0 ||
        chromaEnvironment.fogTrackEvents.length > 0);
    this.pipeline.setBackgroundGradient(hasCustomEnvironment ? null : environment.backgroundGradient);
    this.onEnvironmentLoadSettled();
    return Result.ok(undefined);
  }

  // ----- For the editor (chroeditor) ----------------------------------------------------------

  /** Things the editor draws in the environment's space (a lamp's highlight). */
  readonly overlayRoot = new Group();
  private overlayAdded = false;

  /** The environment's data as loaded (with what the map's Chroma environment made of it). */
  environmentData(): EnvironmentData | null {
    return this.environment?.data ?? null;
  }

  /** The environment's ring systems: their names (what Chroma's nameFilter picks), how many rings,
   *  whether ring events turn them / move them; the ring motion's settings and seed (for working
   *  out where rings stand), and per ring the ids Chroma's environment lookups find it by. */
  ringSystems(): {
    name: string;
    rings: number;
    rotates: boolean;
    zooms: boolean;
    rotation?: RingRotationConfig;
    position?: RingPositionConfig;
    seed: number;
    ringIds: string[][];
  }[] {
    const environment = this.environment;
    if (environment === null) return [];
    const data = environment.data;
    const lookupIds = environmentLookupIds(data);
    // (the rings' objects, in the order buildRingGroups takes them)
    const ringObjects: number[][] = [];
    data.objects.forEach((object) => {
      for (const manager of object.components?.TrackLaneRingsManager ?? []) {
        if (!manager.enabled) continue;
        const rings = manager.Rings.flatMap((reference) => {
          const ring = data.objects[reference.obj]?.components?.TrackLaneRing?.[reference.componentIndex ?? 0];
          return ring === undefined || !ring.enabled ? [] : [reference.obj];
        });
        if (rings.length > 0) ringObjects.push(rings);
      }
    });
    return environment.ringGroups.map((group, index) => ({
      name: group.rotationConfig?.name ?? group.positionConfig?.name ?? '',
      rings: group.rings.length,
      rotates: group.rotationConfig !== undefined,
      zooms: group.positionConfig !== undefined,
      ...(group.rotationConfig === undefined ? {} : { rotation: group.rotationConfig }),
      ...(group.positionConfig === undefined ? {} : { position: group.positionConfig }),
      seed: group.seed,
      ringIds: (ringObjects[index] ?? []).map((object) => lookupIds.get(object) ?? []),
    }));
  }

  /** The environment's Chroma track animations were changed in place (the editor's ring poses):
   *  played from now on without loading the environment again. */
  refreshChromaAnimations() {
    this.environmentLights.refreshChromaTracks();
  }

  /** The environment's lights as events address them: per event type, each light ID, where it is
   *  in the world, and the ring (group, index from the camera) it rides on, if any. */
  lightLayout(): { type: number; lightId: number; position: [number, number, number]; ring: { group: number; index: number } | null; moving: boolean }[] {
    const environment = this.environment;
    if (environment === null) return [];
    if (!this.overlayAdded) {
      this.scene.add(this.overlayRoot);
      this.overlayAdded = true;
    }
    environment.root.updateMatrixWorld(true);
    const ringOf = (node: Object3D): { group: number; index: number } | null => {
      for (let current: Object3D | null = node; current !== null; current = current.parent) {
        for (let group = 0; group < environment.ringGroups.length; group++) {
          const index = environment.ringGroups[group]!.rings.findIndex((ring) => ring.target === current);
          if (index >= 0) return { group, index };
        }
      }
      return null;
    };
    // (lights on something the laser speed events turn: the rotating lasers)
    const turning = new Set<Object3D>(environment.rotations.map((rotation) => rotation.target));
    const moves = (node: Object3D) => {
      for (let current: Object3D | null = node; current !== null; current = current.parent) if (turning.has(current)) return true;
      return false;
    };
    const out = new Map<string, { type: number; lightId: number; position: [number, number, number]; ring: { group: number; index: number } | null; moving: boolean; count: number }>();
    const inactive = (node: Object3D) => {
      for (let current: Object3D | null = node; current !== null; current = current.parent) if (current.userData.inactive === true) return true;
      return false;
    };
    const add = (bindings: EnvironmentLightBinding[], node: Object3D, local: Vector3) => {
      if (inactive(node)) return;
      const world = node.localToWorld(local.clone());
      const ring = ringOf(node);
      for (const binding of bindings) {
        const remapped = new Map<number, number>();
        for (const [source, target] of binding.lightIdRemap) if (!remapped.has(source)) remapped.set(source, target);
        // the one id a map lights it by (as Chroma finds lights): the smallest of the environment's
        // table that points to it; with none, its own place in the game's list — unless the table
        // uses that number for another light (then nothing reaches it)
        const ids = new Set<number>();
        const keys = [...remapped].filter(([, target]) => target === binding.lightId).map(([source]) => source);
        if (keys.length > 0) ids.add(Math.min(...keys));
        else if (!remapped.has(binding.lightId)) ids.add(binding.lightId);
        for (const id of ids) {
          const key = `${String(binding.eventType)}|${String(id)}`;
          const known = out.get(key);
          if (known === undefined) out.set(key, { type: binding.eventType, lightId: id, position: [world.x, world.y, world.z], ring, moving: moves(node), count: 1 });
          else {
            // (a light made of several pieces: their middle)
            const n = known.count + 1;
            known.position = [
              known.position[0] + (world.x - known.position[0]) / n,
              known.position[1] + (world.y - known.position[1]) / n,
              known.position[2] + (world.z - known.position[2]) / n,
            ];
            known.count = n;
            known.ring ??= ring;
          }
        }
      }
    };
    for (const segment of environment.lightSegments) {
      const middle = new Vector3(
        (segment.localStart[0] + segment.localEnd[0]) / 2,
        (segment.localStart[1] + segment.localEnd[1]) / 2,
        (segment.localStart[2] + segment.localEnd[2]) / 2,
      );
      add(segment.bindings, segment.node, middle);
    }
    for (const light of environment.materialLights) {
      if (light.node === undefined) continue;
      add(light.bindings, light.node, new Vector3());
      for (const input of light.combined?.inputs ?? []) add(input.bindings, light.node, new Vector3());
    }
    return [...out.values()].map(({ count: _count, ...rest }) => rest);
  }

  setBeatSource(source: () => number) {
    this.beatSource = source;
  }

  /** x and y are expected pre-scaled to the desired final range (e.g. by intensity/inversion) —
   *  this just clamps to a sane range and stores it as the *target*; render() eases towards it
   *  every frame (see setParallaxJelly) rather than snapping straight to it. Only takes effect
   *  while in a forced lightshow mode (see render()); harmless to call otherwise. */
  setParallax(x: number, y: number) {
    this.parallaxTargetX = Math.min(1, Math.max(-1, x));
    this.parallaxTargetY = Math.min(1, Math.max(-1, y));
  }

  /** 0 = camera snaps straight to the parallax target every frame (no lag at all). Above 0, a
   *  damped-spring simulation eases the camera towards the target with some gentle overshoot —
   *  higher values make it slower and wobblier ("jelly"), lower values catch up almost instantly. */
  setParallaxJelly(amount: number) {
    this.parallaxJelly = Math.min(1, Math.max(0, amount));
  }

  startMenuLightshow(seed: number) {
    const startedAt = performance.now();
    this.menuLightshowSeed = seed;
    this.beatSource = () => (performance.now() - startedAt) / 500;
    // (No MAIN_MENU_CAMERA_DISTANCE override here: in the wallpaper the "Distance" setting applies
    // to the idle screen too — and the override outlived it, pinning the camera for the screensaver.)
    this.environmentLights.setMenuLightshow(seed);
  }

  setLightshowMode(mode: LightshowMode) {
    this.lightshowMode = mode;
    this.environmentLights.setLightshowMode(mode);
    this.applyMapObjectVisibility();
    this.replayView.setLightshowMode(mode);
    this.mapObjects.invalidate();
  }

  /** Forced-lightshow modes (what the wallpaper always runs in) normally hide the whole map-object
   *  root and skip building objects entirely — which is why walls never appeared in the wallpaper
   *  no matter what setShowWalls said. Walls are now the one exception: when they're enabled, the
   *  root stays visible and the object renderer builds walls only (no notes/bombs/chains/arcs). */
  private applyMapObjectVisibility() {
    const forced = isForcedLightshowMode(this.lightshowMode);
    this.mapRoot.visible = !forced || this.showWallsInLightshow;
    this.mapObjects.setWallsOnly(forced);
  }

  clear() {
    this.clearMap();
    this.setSongDuration(null);
    this.setReplay(null);
    if (this.menuLightshowSeed !== null) this.startMenuLightshow(this.menuLightshowSeed);
  }

  setReplay(replay: Replay | null, hitScoreVisualizer?: HitScoreVisualizerConfig | null) {
    if (replay !== null && !this.headsetRequested) {
      this.headsetRequested = true;
      void this.replayView.loadHeadset();
    }
    this.replayView.setReplay(replay, hitScoreVisualizer);
    this.baseProviders.reset();
    this.mapObjects.invalidate();
  }

  setHitScoreVisualizer(hitScoreVisualizer: HitScoreVisualizerConfig | null) {
    this.replayView.setHitScoreVisualizer(hitScoreVisualizer);
  }

  setSongDuration(duration: number | null) {
    this.songDuration = duration ?? 0;
    this.replayView.setSongDuration(duration);
  }

  appendReplayNoteEvents(events: ReplayNoteEvent[]) {
    if (this.data !== null && events.length > 0) {
      applyReplayNoteEvents(this.data, events);
      this.mapObjects.invalidate();
    }
    this.replayView.refreshTimeline();
  }

  appendReplayHeightEvents(events: ReplayHeightEvent[]) {
    if (this.data === null || events.length === 0) return;
    applyReplayHeightEvents(this.data, events);
    this.mapObjects.invalidate();
  }

  setReplayCameraMode(mode: ReplayCameraMode) {
    this.replayView.setCameraMode(mode);
  }

  setReplayCameraSettings(settings: ReplayCameraSettings) {
    this.orthoCameraEnabled = settings.orthoCameraEnabled;
    this.replayOrthographicOverlay.setView(settings.orthoCameraView);
    this.replayView.setCameraSettings(settings);
  }

  setReplaySaberSettings(settings: ReplaySaberSettings) {
    this.replayView.setSaberSettings(settings);
  }

  setScreenDisplacementEffects(enabled: boolean) {
    this.screenDisplacementEffects = enabled;
    this.postBloom.setScreenDisplacementEnabled(enabled);
    this.mapObjects.setScreenDisplacementEffects(enabled);
  }

  /** Shows/hides the "PlayersPlace" platform of whatever environment is currently loaded — with no
   *  actual player standing on it, it can just read as clutter floating in frame. Takes effect on
   *  the environment that's loaded right now (if any) and every one loaded afterwards; the setting
   *  itself persists across environment/track changes until called again. */
  /** Lights shown lit over the show, by event type and map light ID (see EnvironmentLights). */
  setHighlight(lights: readonly { type: number; id: number }[] | null, color?: Rgb, strength?: number) {
    this.environmentLights.setHighlight(lights, color, strength);
  }

  setShowPlayerPlatform(enabled: boolean) {
    this.showPlayerPlatform = enabled;
    this.applyPlayerPlatformVisibility();
  }

  private applyPlayerPlatformVisibility() {
    if (this.environment === null) return;
    for (const node of this.environment.playerPlatformNodes) node.visible = this.showPlayerPlatform;
  }

  /** Shows/hides walls (obstacles) for whatever map is currently loaded and every one loaded
   *  afterwards, same persistence model as setScreenDisplacementEffects — main.ts is what decides
   *  the actual effective value (a WE checkbox that only has any effect on maps requiring Noodle
   *  Extensions — see applyShowWalls there). */
  /** The light colors currently in effect (environment scheme plus any override) — lets the
   *  wallpaper's screensaver reproduce a light's exact current color when it hands over smoothly. */
  get currentColors(): ColorScheme {
    return this.colors;
  }

  setShowWalls(enabled: boolean) {
    this.showWallsInLightshow = enabled;
    this.mapObjects.setShowWalls(enabled);
    this.applyMapObjectVisibility();
  }

  setPreviewNotesLookAtPlayer(enabled: boolean) {
    this.mapObjects.setPreviewNotesLookAtPlayer(enabled);
  }

  setPreviewHitNotes(enabled: boolean) {
    this.mapObjects.setPreviewHitNotes(enabled);
  }

  setPreviewHitLine(enabled: boolean) {
    this.mapObjects.setPreviewHitLine(enabled);
  }

  setMap(data: MapRenderData, override?: InfoColorScheme) {
    this.replayView.setPreviewCameraDistanceOverride(null);
    this.clearMap();
    this.data = data;
    this.replayView.setMapHasNotes(data.notes.length > 0);
    this.replayView.setNoodleTrailLocalSpace(data.noodle.localSpaceSaberTrail);

    const colors = this.resolveMapColors(override);
    this.colors = colors;
    this.baseProviders.reset();
    this.environmentLights.setMap(data, colors);
    this.replayView.setColors(colors);
    this.mapObjects.setMap(data, colors);
    this.mirror.updateMaterials(this.scene);
  }

  /** Cheaper setMap for a live, lighting-only show (the wallpaper's screensaver mode rebuilds its
   *  generated event list many times a second): when neither the current nor the new data has any
   *  gameplay objects or environment changes, only the lighting timelines are rebuilt — the map
   *  object meshes/materials (which setMap tears down and recreates) and the mirror's full scene
   *  scan stay as they are. Anything else goes through the full setMap. */
  updateLightshow(data: MapRenderData, override?: InfoColorScheme) {
    const current = this.data;
    if (current === null || !isLightingOnly(current) || !isLightingOnly(data) || current.songBpm !== data.songBpm) {
      this.setMap(data, override);
      return;
    }
    this.data = data;
    const colors = this.resolveMapColors(override);
    if (!sameColorScheme(colors, this.colors)) {
      this.colors = colors;
      this.replayView.setColors(colors);
      this.mapObjects.setColors(colors);
    }
    this.baseProviders.reset();
    this.environmentLights.setMap(data, this.colors);
  }

  refreshMapColors(override?: InfoColorScheme) {
    if (this.data === null) return;
    const colors = this.resolveMapColors(override);
    this.colors = colors;
    this.baseProviders.reset();
    this.environmentLights.setColors(colors);
    this.replayView.setColors(colors);
    this.mapObjects.setColors(colors);
  }

  /** Whether a map's color scheme gives the lights colors of its own on the current environment
   *  (not just the environment's defaults restated) — the wallpaper leaves those maps' colors be. */
  hasOwnLightColors(scheme?: InfoColorScheme): boolean {
    if (scheme === undefined || this.environment === null) return false;
    const own = this.resolveMapColors(scheme);
    const standard = this.resolveMapColors(undefined);
    const differs = (a: readonly number[], b: readonly number[]) => a.some((value, index) => Math.abs(value - (b[index] ?? 0)) > 0.02);
    return (
      differs(own.environmentLeft, standard.environmentLeft) ||
      differs(own.environmentRight, standard.environmentRight) ||
      differs(own.environmentLeftBoost, standard.environmentLeftBoost) ||
      differs(own.environmentRightBoost, standard.environmentRightBoost)
    );
  }

  /** The environment's own colours (no map colours over them). */
  environmentColors() {
    return this.resolveMapColors(undefined);
  }

  private resolveMapColors(override?: InfoColorScheme) {
    return this.environment === null ? DEFAULT_COLORS : resolveColorScheme(this.environment.data.colorScheme, override);
  }

  private clearMap() {
    this.mapObjects.clear();
    this.data = null;
    this.replayView.setMapHasNotes(false);
    this.replayView.setNoodleTrailLocalSpace(false);
    this.environmentLights.clearMap();
    this.mirror.updateMaterials(this.scene);
  }

  private baseProvider(name: string, beat: number): readonly number[] | undefined {
    const data = this.data;
    const color = (value: Rgb): readonly [number, number, number, number] => [value[0], value[1], value[2], 1];
    const colors = this.colors;
    if (name === 'baseNote0Color') return color(data?.leftHanded === true ? colors.rightNote : colors.leftNote);
    if (name === 'baseNote1Color') return color(data?.leftHanded === true ? colors.leftNote : colors.rightNote);
    if (name === 'baseObstaclesColor') return color(colors.obstacle);
    if (name === 'baseSaberAColor') return color(colors.leftNote);
    if (name === 'baseSaberBColor') return color(colors.rightNote);
    if (name === 'baseEnvironmentColor0') return color(colors.environmentLeft);
    if (name === 'baseEnvironmentColor1') return color(colors.environmentRight);
    if (name === 'baseEnvironmentColorW') return color(colors.environmentWhite);
    if (name === 'baseEnvironmentColor0Boost') return color(colors.environmentLeftBoost);
    if (name === 'baseEnvironmentColor1Boost') return color(colors.environmentRightBoost);
    if (name === 'baseEnvironmentColorWBoost') return color(colors.environmentWhiteBoost);
    const seconds = songBpmTimeToSeconds(beat, data?.songBpm ?? 120);
    if (name === 'baseSongTime') return [seconds];
    if (name === 'baseSongLength') return [this.songDuration];
    if (name === 'basePlayerHeight') return [this.playerHeightAt(seconds)];
    if (data !== null) {
      const movement = data.movementStateAt?.(beat);
      if (name === 'baseNoteJumpMovementSpeed') return [movement?.noteJumpSpeed ?? data.noteJumpSpeed ?? 0];
      if (name === 'baseNoteJumpStartBeatOffset') return [data.noteStartBeatOffset ?? 0];
      if (name === 'baseJumpDistance') return [movement?.jumpDistance ?? 0];
    }
    return this.replayView.baseProvider(name, seconds);
  }

  private playerHeightAt(time: number) {
    const data = this.data;
    if (data === null) return 1.8;
    let low = 0;
    let high = data.replayHeights.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((data.replayHeights[middle]?.time ?? Number.POSITIVE_INFINITY) <= time) low = middle + 1;
      else high = middle;
    }
    return data.replayHeights[low - 1]?.height ?? data.initialPlayerHeight;
  }

  private update(now: number) {
    const data = this.data;
    if (this.environment !== null) {
      const fog = this.environmentLights.update(now, this.baseProviders);
      if (fog !== undefined) this.pipeline.setFogParams(fog);
    }
    this.resetPlayerCameraRig();
    if (data === null) return;
    if (isForcedLightshowMode(this.lightshowMode)) {
      if (this.showWallsInLightshow) {
        // Noodle maps can move the player (AssignPlayerToTrack + AnimateTrack) — e.g. lifting them
        // 15-20 m up for whole sections. Map objects are placed relative to that moved player, so
        // the camera rig has to follow the same player tracks it does in normal mode, or every wall
        // ends up offset by exactly that amount (the "walls sit too high" bug). render()'s mouse
        // parallax is layered on top of this rather than replacing it.
        this.noodlePlayerTransform.apply(
          this.playerCameraRoot,
          sampleNoodlePlayerTrack(data.noodle, 'Root', now, this.baseProviders, data.leftHanded),
          data.leftHanded,
        );
        this.noodlePlayerTransform.apply(
          this.playerCameraHead,
          sampleNoodlePlayerTrack(data.noodle, 'Head', now, this.baseProviders, data.leftHanded),
          data.leftHanded,
        );
        // Walls-only object pass — see applyMapObjectVisibility.
        this.mapObjects.update(now, this.replayView, this.baseProviders);
      }
      return;
    }
    const replayTime = songBpmTimeToSeconds(now, data.songBpm);
    const rootTrack = sampleNoodlePlayerTrack(data.noodle, 'Root', now, this.baseProviders, data.leftHanded);
    const headTrack = sampleNoodlePlayerTrack(data.noodle, 'Head', now, this.baseProviders, data.leftHanded);
    if (!this.replayView.hasReplay || this.replayView.cameraMode === 'static') {
      this.noodlePlayerTransform.apply(this.playerCameraRoot, rootTrack, data.leftHanded);
      this.noodlePlayerTransform.apply(this.playerCameraHead, headTrack, data.leftHanded);
    }
    this.replayView.update(
      replayTime,
      this.replayView.hasReplay
        ? {
            root: rootTrack,
            head: headTrack,
            leftHand: sampleNoodlePlayerTrack(data.noodle, 'LeftHand', now, this.baseProviders, data.leftHanded),
            rightHand: sampleNoodlePlayerTrack(data.noodle, 'RightHand', now, this.baseProviders, data.leftHanded),
          }
        : undefined,
      data.leftHanded,
    );
    this.mapObjects.update(now, this.replayView, this.baseProviders);
  }

  private resetPlayerCameraRig() {
    this.playerCameraRoot.position.set(0, 0, 0);
    this.playerCameraRoot.quaternion.identity();
    this.playerCameraRoot.scale.set(1, 1, 1);
    this.playerCameraHead.position.set(0, 0, 0);
    this.playerCameraHead.quaternion.identity();
    this.playerCameraHead.scale.set(1, 1, 1);
  }

  /** Flies the camera (null: back to where the player stands). */
  setFreeCamera(pose: { position: [number, number, number]; yaw: number; pitch: number } | null) {
    this.freeCamera = pose === null ? null : { position: [...pose.position], yaw: pose.yaw, pitch: pose.pitch };
    if (pose === null) {
      this.camera.position.copy(this.playerCameraLocal);
      this.camera.quaternion.identity();
    }
  }

  /** Where the camera is and where it looks (yaw, pitch in radians), in the world. */
  cameraPose(): { position: [number, number, number]; yaw: number; pitch: number } {
    if (this.freeCamera !== null) return { position: [...this.freeCamera.position], yaw: this.freeCamera.yaw, pitch: this.freeCamera.pitch };
    this.scene.updateMatrixWorld();
    const position = new Vector3();
    const quaternion = new Quaternion();
    this.camera.getWorldPosition(position);
    this.camera.getWorldQuaternion(quaternion);
    const euler = new Euler().setFromQuaternion(quaternion, 'YXZ');
    return { position: [position.x, position.y, position.z], yaw: euler.y, pitch: euler.x };
  }

  render(renderer: WebGLRenderer) {
    const now = this.environment === null && this.data === null ? 0 : this.beatSource();
    this.update(now);
    if (isForcedLightshowMode(this.lightshowMode)) {
      const maxOffset = 0.3; // meters
      const maxTilt = 0.05; // radians (~3°) — subtle, not disorienting
      const now = performance.now();
      const dt = this.parallaxLastFrameTime === null ? 0 : Math.min((now - this.parallaxLastFrameTime) / 1000, 0.1);
      this.parallaxLastFrameTime = now;

      if (this.parallaxJelly <= 0 || dt === 0) {
        // No smoothing requested (or first frame): jump straight to the target, matching the
        // original snap-instantly behaviour exactly.
        this.parallaxCurrentX = this.parallaxTargetX;
        this.parallaxCurrentY = this.parallaxTargetY;
        this.parallaxVelocityX = 0;
        this.parallaxVelocityY = 0;
      } else {
        // Damped-spring easing (semi-implicit Euler): higher "jelly" lowers the spring's angular
        // frequency (slower to catch up) while keeping it underdamped (zeta < 1), so the camera
        // visibly overshoots and settles with a couple of soft wobbles instead of snapping.
        const omega = PARALLAX_JELLY_MAX_OMEGA + (PARALLAX_JELLY_MIN_OMEGA - PARALLAX_JELLY_MAX_OMEGA) * this.parallaxJelly;
        const omegaSquared = omega * omega;
        this.parallaxVelocityX +=
          dt * (omegaSquared * (this.parallaxTargetX - this.parallaxCurrentX) - 2 * PARALLAX_DAMPING_RATIO * omega * this.parallaxVelocityX);
        this.parallaxCurrentX += dt * this.parallaxVelocityX;
        this.parallaxVelocityY +=
          dt * (omegaSquared * (this.parallaxTargetY - this.parallaxCurrentY) - 2 * PARALLAX_DAMPING_RATIO * omega * this.parallaxVelocityY);
        this.parallaxCurrentY += dt * this.parallaxVelocityY;
      }

      // Added on top of whatever update() left on the rig (identity, or a Noodle player-track pose
      // when walls are shown) instead of overwriting it.
      this.parallaxOffset.set(this.parallaxCurrentX * maxOffset, this.parallaxCurrentY * -maxOffset, 0);
      this.playerCameraRoot.position.add(this.parallaxOffset);
      this.parallaxEuler.set(this.parallaxCurrentY * -maxTilt, this.parallaxCurrentX * maxTilt, 0, 'YXZ');
      this.parallaxQuaternion.setFromEuler(this.parallaxEuler);
      this.playerCameraRoot.quaternion.multiply(this.parallaxQuaternion);
    }
    if (this.horizontalFov !== null) {
      const aspect = Math.max(0.2, this.camera.aspect);
      const vertical = (2 * Math.atan(Math.tan((this.horizontalFov * Math.PI) / 360) / aspect) * 180) / Math.PI;
      const fov = Math.max(42, Math.min(75, vertical));
      if (Math.abs(fov - this.camera.fov) > 0.01) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
    }
    if (this.freeCamera !== null) {
      this.resetPlayerCameraRig();
      this.camera.position.set(...this.freeCamera.position);
      this.freeEuler.set(this.freeCamera.pitch, this.freeCamera.yaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this.freeEuler);
    }
    this.scene.updateMatrixWorld();
    if (this.environment?.applyConstraints() === true) this.scene.updateMatrixWorld();
    this.environment?.syncInstancedMeshes();
    if (this.environment !== null) this.environmentLights.updateWorldLights(now);
    if (hasVisibleMirrorConsumer(this.environmentMirrorConsumers, this.camera)) {
      this.mirror.render(renderer, this.scene, this.camera, (mirrorRenderer, mirrorCamera) => {
        this.pipeline.render(mirrorRenderer, mirrorCamera, this.environmentLights.lightSegments);
      });
    }
    this.pipeline.render(renderer, this.camera, this.environmentLights.lightSegments);
    this.postBloom.render(renderer, this.scene, this.camera, this.mapRoot.visible && this.mapObjects.wallsVisible);
    // (the editor's own things — its note track — over the finished picture, with their own depth)
    if (this.overlayScene.children.some((child) => child.visible && child.children.length > 0)) {
      this.overlayUpdate?.();
      this.overlayScene.updateMatrixWorld();
      // (the screen has no depth of its own: drawn into a target that has, then laid over it)
      const size = renderer.getDrawingBufferSize(new Vector2());
      if (this.overlayTarget === null) {
        this.overlayTarget = new WebGLRenderTarget(size.x, size.y, { samples: 4 });
        this.overlayQuad = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ map: this.overlayTarget.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor }));
        this.overlayQuadScene.add(this.overlayQuad);
      }
      if (this.overlayTarget.width !== size.x || this.overlayTarget.height !== size.y) this.overlayTarget.setSize(size.x, size.y);
      const previousTarget = renderer.getRenderTarget();
      const autoClear = renderer.autoClear;
      const clipping = renderer.localClippingEnabled;
      const clearColor = renderer.getClearColor(new Color());
      const clearAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(this.overlayTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.autoClear = false;
      renderer.localClippingEnabled = true;
      renderer.render(this.overlayScene, this.camera);
      renderer.setRenderTarget(previousTarget);
      renderer.render(this.overlayQuadScene, this.overlayCamera);
      renderer.setClearColor(clearColor, clearAlpha);
      renderer.autoClear = autoClear;
      renderer.localClippingEnabled = clipping;
    }
    if (this.orthoCameraEnabled && this.replayView.hasReplay && !isForcedLightshowMode(this.lightshowMode)) {
      const element = this.orthoOverlayElement();
      if (element !== null) this.renderOrthographicOverlay(renderer, element, now);
    }
  }

  private renderOrthographicOverlay(renderer: WebGLRenderer, element: HTMLElement, beat: number) {
    const environmentRoot = this.environment?.root;
    const environmentVisible = environmentRoot?.visible ?? false;
    const skyboxVisible = this.skybox.visible;
    const mirrorVisible = this.mirror.mesh.visible;
    const hudVisible = this.replayView.hudRoot.visible;
    const fog = this.pipeline.fogUniforms;
    const fogAttenuation = fog._CustomFogAttenuation.value;
    const fogHeight = fog._CustomFogHeightFogHeight.value;
    const fogStartY = fog._CustomFogHeightFogStartY.value;

    try {
      if (environmentRoot !== undefined) environmentRoot.visible = false;
      this.skybox.visible = false;
      this.mirror.mesh.visible = false;
      this.replayView.hudRoot.visible = false;
      this.replayView.setOrthographicOverlayRendering(true);
      fog._CustomFogAttenuation.value = 0;
      fog._CustomFogHeightFogHeight.value = 1;
      fog._CustomFogHeightFogStartY.value = -1_000_000;
      if (this.screenDisplacementEffects) this.mapObjects.setScreenDisplacementEffects(false);
      this.replayOrthographicOverlay.setHalfJumpDistance(this.data?.movementStateAt?.(beat).halfJumpDistance);
      this.replayOrthographicOverlay.render(renderer, this.scene, element);
    } finally {
      if (this.screenDisplacementEffects) this.mapObjects.setScreenDisplacementEffects(true);
      fog._CustomFogAttenuation.value = fogAttenuation;
      fog._CustomFogHeightFogHeight.value = fogHeight;
      fog._CustomFogHeightFogStartY.value = fogStartY;
      this.replayView.setOrthographicOverlayRendering(false);
      this.replayView.hudRoot.visible = hudVisible;
      this.mirror.mesh.visible = mirrorVisible;
      this.skybox.visible = skyboxVisible;
      if (environmentRoot !== undefined) environmentRoot.visible = environmentVisible;
    }
  }

  contextRestored() {
    this.pipeline.invalidate();
  }

  setSize(width: number, height: number) {
    this.replayView.setCameraAspect(width / Math.max(height, 1));
    this.postBloom.setSize(width, height);
  }

  dispose() {
    this.environmentRequest?.controller.abort();
    this.environmentRequest = null;
    if (this.environment !== null) {
      this.scene.remove(this.environment.root);
      this.environment.dispose();
    }
    this.mapObjects.dispose();
    this.replayView.dispose();
    this.replayOrthographicOverlay.dispose();
    for (const object of [this.skybox, this.mirror.mesh]) {
      if (!Array.isArray(object.material)) object.material.dispose();
    }
    this.skybox.geometry.dispose();
    this.mirror.dispose();
    this.pipeline.dispose();
    this.postBloom.dispose();
  }
}
