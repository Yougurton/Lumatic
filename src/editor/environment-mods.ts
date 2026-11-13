import type { EnvironmentData } from '../engine/renderer/environment/types';
import catalog from './custom-environments.json';
import { Matrix4 } from 'three';
import { environmentLookupIds } from '../engine/renderer/environment/chroma-environment';
import { animEvents, animTrack, baseMotionEvents, hasKeys, linkEvents, linkTrack, motionEvents, offsetAnim, type Placing, type SceneAnim, type SceneMotion } from './env-anim';
import { localOf, worldMatrix } from './env-scene';
import { arrayPlacings, type SceneArray } from './env-array';
import { GEOMETRY_RING_MATERIALS, geometryRingFragment } from './geometry-rings';

/**
 * Changes to the environment a map carries in its custom data (Chroma environment enhancements):
 * a ready-made environment (MadChase's, Phøenix's, Lonely's — see public/custom-envs/licenses), parts taken away, the
 * rings and their lights made bigger. They're kept in the project and written into the difficulty as
 * one fragment; the fragment written before is taken out again first (told apart by being equal to
 * it), so the map's own entries stay as they are.
 */

export interface EnvironmentMods {
  /** A ready-made environment (PRESETS id). */
  preset?: string;
  /** Parts of the environment taken away (their names, as environmentParts lists them). */
  hidden?: string[];
  /** Per ring system (the rings' object name, "SmallTrackLaneRing(Clone)"): how much bigger the
   *  rings, and their lights thicker and longer (1: as they are). */
  rings?: Record<string, RingLook>;
  /** The scene editor's changes to single objects of the game's environment. */
  scene?: SceneEdit[];
  /** Objects the scene editor added: copies of the game's objects and shapes of its own. */
  objects?: SceneObject[];
  /** The scene editor's animations: keys on beats, an object each. */
  anims?: SceneAnim[];
  /** Ready motions: blocks on objects' timelines. */
  motions?: SceneMotion[];
  /** Objects hung on others: they go along with their parent's motion. */
  links?: SceneLink[];
  /** The fog, as the scene editor sets it (what's not set: as the environment has it). */
  fog?: FogValues;
  /** The player: whether its turns and uneven moves are allowed (they make people sick). */
  player?: { risky?: boolean };
  /** The materials its shapes are made of, by name. */
  materials?: Record<string, SceneMaterial>;
}

export const SHAPES = ['Cube', 'Sphere', 'Cylinder', 'Capsule', 'Plane', 'Quad', 'Triangle'] as const;
export type Shape = (typeof SHAPES)[number];

/** Chroma's shaders for a shape's material; the two "light" ones make it a lamp the lights' events
 *  drive. */
export const SHADERS = ['Standard', 'Glowing', 'OpaqueLight', 'TransparentLight', 'BaseWater', 'BTSPillar', 'BillieWater', 'WaterfallMirror', 'InterscopeConcrete', 'InterscopeCar'] as const;
export type Shader = (typeof SHADERS)[number];
export const isLightShader = (shader: string) => shader === 'OpaqueLight' || shader === 'TransparentLight';

export interface SceneMaterial {
  shader: Shader;
  /** Red, green, blue, alpha (0…1). */
  color: [number, number, number, number];
  /** The track its colour can be animated by (none: it can't). */
  track?: string;
  /** The shader's keywords instead of its own (for those who know them). */
  keywords?: string[];
  /** Coloured as the player's notes, sabers, walls or lights are ("baseNote0Color"…): its own colour's
   *  alpha still says how bright. */
  playerColor?: string;
}

/** A material as Chroma has it. */
export function materialCommand(material: SceneMaterial): Record<string, unknown> {
  return { shader: material.shader, color: material.color.map(round), ...(material.track === undefined ? {} : { track: material.track }), ...(material.keywords === undefined ? {} : { shaderKeywords: material.keywords }) };
}

/**
 * An object the scene editor added. A copy: another of a game's object (found by its exact Chroma id),
 * placed by its own (local) values as the original is. A shape: one of Chroma's primitives, placed in
 * the world (metres, degrees), made of a named material — a lamp when the material is a light one
 * (`light`: the event type that drives it and its light ID).
 */
export interface SceneObject {
  uid: string;
  name: string;
  kind: 'copy' | 'shape';
  /** A copy: the original's Chroma id. */
  source?: string;
  shape?: Shape;
  material?: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  hidden?: boolean;
  light?: { type: number; id: number };
  /** Many of it: the others are worked out from it (see env-array). */
  array?: SceneArray;
  /** A lamp's others: their light IDs, in the array's order. */
  arrayLights?: number[];
  /** A copy standing where the game's original does and not written itself: only its array's others
   *  are (the original is the array's first). */
  ghost?: boolean;
  /** A lamp: its own settings. */
  tube?: TubeValues;
  /** One of an array's others (made by `expandObjects`, never kept): the uid of the object it's of. */
  of?: string;
}

/** The added objects as they are written and shown: each, then its array's others (a ghost itself
 *  left out). */
export function expandObjects(objects: readonly SceneObject[]): SceneObject[] {
  const out: SceneObject[] = [];
  for (const object of objects) {
    if (object.ghost !== true) out.push(object);
    if (object.array === undefined) continue;
    arrayPlacings(object, object.array).forEach((placing, n) => {
      const { array: _array, arrayLights: _lights, ghost: _ghost, ...rest } = object;
      out.push({ ...rest, ...placing, uid: `${object.uid}#${String(n + 1)}`, of: object.uid, ...(object.light === undefined ? {} : { light: { type: object.light.type, id: object.arrayLights?.[n] ?? object.light.id } }) });
    });
  }
  return out;
}

/** An added object as Chroma's environment command (null: nothing to write — a shape without its
 *  material). */
export function objectCommand(object: SceneObject, materials: Record<string, SceneMaterial>): Record<string, unknown> | null {
  const command: Record<string, unknown> = {};
  if (object.kind === 'copy') {
    if (object.source === undefined) return null;
    Object.assign(command, { id: object.source, lookupMethod: 'Exact', duplicate: 1, localPosition: object.position.map(round), localRotation: object.rotation.map(round), scale: object.scale.map(round) });
  } else {
    const material = object.material === undefined ? undefined : materials[object.material];
    if (object.shape === undefined || object.material === undefined || material === undefined) return null;
    Object.assign(command, { geometry: { type: object.shape, material: object.material }, position: object.position.map(round), rotation: object.rotation.map(round), scale: object.scale.map(round) });
    if (isLightShader(material.shader) && object.light !== undefined) {
      const tube = tubeComponent(object.tube);
      command.components = { ILightWithId: { type: object.light.type, lightID: object.light.id }, ...(tube === null ? {} : { TubeBloomPrePassLight: tube }) };
    }
  }
  if (object.hidden === true) command.active = false;
  return command;
}

/** The commands of the added objects and the materials they use. */
export function objectsFragment(mods: EnvironmentMods): { environment: Record<string, unknown>[]; materials: Record<string, unknown> } {
  const materials = mods.materials ?? {};
  const environment: Record<string, unknown>[] = [];
  const used = new Set<string>();
  const tracked = trackedTargets(mods);
  for (const object of expandObjects(mods.objects ?? [])) {
    const command = objectCommand(object, materials);
    if (command === null) continue;
    // (an animated or hung object: on a track of its own — its array's others too, each its own)
    if (tracked.has(`o:${object.of ?? object.uid}`)) command.track = animTrack(`o:${object.uid}`);
    environment.push(command);
    if (object.kind === 'shape' && object.material !== undefined) used.add(object.material);
  }
  // (a material whose colour is animated: on its track)
  const out = Object.fromEntries([...used].map((name) => [name, materialCommand(materials[name]!)]));
  for (const name of used) if (tracked.has(`m:${name}`)) out[name]!.track = materialTrack(name, materials[name]!);
  return { environment, materials: out };
}

/** The track a material's colour is animated on: its own, or one made for it. */
export const materialTrack = (name: string, material: SceneMaterial) => material.track ?? animTrack(`m:${name}`);

/** The things that need a track: the animated ones, and the ones hung on others. */
export function trackedTargets(mods: EnvironmentMods): Set<string> {
  const out = new Set((mods.anims ?? []).filter((anim) => hasKeys(anim)).map((anim) => anim.target));
  for (const link of mods.links ?? []) out.add(link.child);
  for (const motion of mods.motions ?? []) out.add(motion.target);
  for (const [name, material] of Object.entries(mods.materials ?? {})) if (material.playerColor !== undefined) out.add(`m:${name}`);
  return out;
}

/**
 * One object of the environment changed in the scene editor: found by its exact Chroma id; hidden, or
 * put, turned and sized (its own — local — values, as Chroma's: metres, degrees x/y/z).
 */
/** One thing hung on another ("o:<uid>" or a game object's Chroma id, both). */
export interface SceneLink {
  child: string;
  parent: string;
}

export interface FogValues {
  attenuation?: number;
  offset?: number;
  startY?: number;
  height?: number;
}

/** A lamp's own settings: how bright its colour is, how much it glows in the fog (1: as it is). */
export interface TubeValues {
  alpha?: number;
  bloom?: number;
}

/** The Chroma component of a lamp's settings (null: none set). */
export function tubeComponent(tube: TubeValues | undefined): Record<string, number> | null {
  if (tube === undefined || (tube.alpha === undefined && tube.bloom === undefined)) return null;
  return { ...(tube.alpha === undefined ? {} : { colorAlphaMultiplier: round(tube.alpha) }), ...(tube.bloom === undefined ? {} : { bloomFogIntensityMultiplier: round(tube.bloom) }) };
}

/** The environment's root object — the one the fog is on (any environment's). */
export const FOG_ID = '^[^.\\[]+\\.\\[0\\]Environment$';

export interface SceneEdit {
  id: string;
  hidden?: boolean;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /** A lamp of the game: its own settings. */
  tube?: TubeValues;
}

/** A scene edit as Chroma's environment command (null: it changes nothing). */
export function sceneCommand(edit: SceneEdit): Record<string, unknown> | null {
  const command: Record<string, unknown> = { id: edit.id, lookupMethod: 'Exact' };
  if (edit.hidden === true) command.active = false;
  if (edit.position !== undefined) command.localPosition = edit.position.map(round);
  if (edit.rotation !== undefined) command.localRotation = edit.rotation.map(round);
  if (edit.scale !== undefined) command.scale = edit.scale.map(round);
  const tube = tubeComponent(edit.tube);
  if (tube !== null) command.components = { TubeBloomPrePassLight: tube };
  return Object.keys(command).length > 2 ? command : null;
}

export interface RingLook {
  size?: number;
  thickness?: number;
  length?: number;
  /** Drawn from Chroma geometry (each ring its own track for every player; needs Noodle Extensions). */
  geometry?: boolean;
}

/** Custom data of a difficulty (v3 keys). */
export interface EnvironmentFragment {
  environment: Record<string, unknown>[];
  materials: Record<string, unknown>;
  customEvents: Record<string, unknown>[];
  pointDefinitions: Record<string, unknown>;
}

export const EMPTY_FRAGMENT: EnvironmentFragment = { environment: [], materials: {}, customEvents: [], pointDefinitions: {} };

export function isEmptyFragment(fragment: EnvironmentFragment | undefined) {
  return (
    fragment === undefined ||
    (fragment.environment.length === 0 && fragment.customEvents.length === 0 && Object.keys(fragment.materials).length === 0 && Object.keys(fragment.pointDefinitions).length === 0)
  );
}

// ----- ready-made environments ------------------------------------------------------------------------

/** A ready-made environment (made by scripts/custom-environments.py from its author's repository). */
export interface Preset {
  id: string;
  /** Whose collection it's from (PRESET_COLLECTIONS). */
  collection: string;
  name: string;
  /** Who made it. */
  author: string;
  /** The game's environment it's built on. */
  environment: string;
  /** What it is. */
  summary: string;
  /** Which lights do what (the author's notes). */
  lights: string;
  /** Needs Noodle Extensions too (not only Chroma). */
  noodle: boolean;
  /** Goes into v2 difficulties too (plain environment entries only). */
  v2: boolean;
  /** Has the author's picture. */
  picture: boolean;
}

export interface PresetCollection {
  id: string;
  name: string;
  author: string;
  source: string;
  license: string;
}

export const PRESETS: Preset[] = catalog.environments;
export const PRESET_COLLECTIONS: PresetCollection[] = catalog.collections;

/** A ready-made environment by its id (the ones before 0.12 had MadChase's names only). */
export function findPreset(id: string | undefined): Preset | undefined {
  if (id === undefined) return undefined;
  return PRESETS.find((item) => item.id === id) ?? PRESETS.find((item) => item.id === `madchase-${id}`);
}

const presetCache = new Map<string, Promise<EnvironmentFragment & { environmentName: string }>>();

export function loadPreset(id: string) {
  const preset = findPreset(id);
  let loading = presetCache.get(id);
  if (loading === undefined) {
    loading = fetch(`custom-envs/${preset?.id ?? id}.json`).then(async (response) => {
      if (!response.ok) throw new Error(`Нет окружения ${id}`);
      const data = (await response.json()) as Record<string, unknown>;
      return {
        environmentName: String(data.environmentName ?? ''),
        environment: (data.environment as Record<string, unknown>[] | undefined) ?? [],
        materials: (data.materials as Record<string, unknown> | undefined) ?? {},
        customEvents: (data.customEvents as Record<string, unknown>[] | undefined) ?? [],
        pointDefinitions: (data.pointDefinitions as Record<string, unknown> | undefined) ?? {},
      };
    });
    presetCache.set(id, loading);
    loading.catch(() => presetCache.delete(id));
  }
  return loading;
}

// ----- the environment's parts ------------------------------------------------------------------------

export interface EnvironmentPart {
  /** Its name (without Unity's " (n)"): what hides it. */
  name: string;
  /** How many objects of that name. */
  count: number;
  /** Has lights in it. */
  lights: boolean;
}

/** What makes the environment work rather than show: never offered. */
const MACHINERY = /^(?:CoreLighting|BasicEventEffectController|Light(?:Color|Rotation|Translation)GroupEffectManager|FloatFxGroupEffectManager|Sink Object|PlayersPlace|.*TrackLaneRings\d*|.*GroupEffectManager)$/u;

const baseName = (name: string) => name.replace(/ \(\d+\)$/u, '');

/** The parts right under the environment's root object, by name. */
export function environmentParts(data: EnvironmentData): EnvironmentPart[] {
  const root = data.objects.findIndex((object) => object.parent === -1 && object.name === 'Environment' && object.chromaGenerated !== true);
  if (root < 0) return [];
  const parts = new Map<string, EnvironmentPart>();
  data.objects.forEach((object, index) => {
    if (object.parent !== root || object.chromaGenerated === true) return;
    const name = baseName(object.name);
    if (MACHINERY.test(name)) return;
    const part = parts.get(name) ?? { name, count: 0, lights: false };
    part.count++;
    part.lights ||= hasLights(data, index);
    parts.set(name, part);
  });
  return [...parts.values()];
}

const LIGHT_COMPONENTS = ['ParametricBloomFogLightController', 'MaterialLightController', 'SpriteLightController', 'InstancedMaterialLightController', 'TubeBloomPrePassLight'] as const;

function hasLights(data: EnvironmentData, index: number): boolean {
  const object = data.objects[index];
  if (object === undefined) return false;
  if (LIGHT_COMPONENTS.some((component) => (object.components as Record<string, unknown[] | undefined> | undefined)?.[component]?.length)) return true;
  return data.objects.some((child, childIndex) => child.parent === index && hasLights(data, childIndex));
}

export interface RingSystemParts {
  /** The rings' object name ("SmallTrackLaneRing(Clone)"). */
  ring: string;
  /** Its manager (its name: the ring system's — Chroma's nameFilter, the ring poses' system). */
  manager: number;
  system: string;
  count: number;
  /** The light tubes in a ring: their name and own scale (the ones of one name and scale go together). */
  lights: { name: string; scale: [number, number, number] }[];
  /** A ring's own scale. */
  scale: [number, number, number];
}

/** The environment's ring systems: their rings and the light tubes in them. */
export function ringSystemParts(data: EnvironmentData): RingSystemParts[] {
  const out: RingSystemParts[] = [];
  for (const object of data.objects) {
    for (const manager of object.components?.TrackLaneRingsManager ?? []) {
      if (!manager.enabled || manager.Rings.length === 0) continue;
      const first = manager.Rings[0]!.obj;
      const ring = data.objects[first];
      if (ring === undefined) continue;
      const lights = new Map<string, { name: string; scale: [number, number, number] }>();
      const walk = (index: number) => {
        data.objects.forEach((child, childIndex) => {
          if (child.parent !== index) return;
          if ((child.components?.ParametricBloomFogLightController ?? []).length > 0) {
            const item = { name: baseName(child.name), scale: [...child.scale] as [number, number, number] };
            lights.set(`${item.name}|${item.scale.join()}`, item);
          }
          walk(childIndex);
        });
      };
      walk(first);
      out.push({ ring: ring.name, manager: data.objects.indexOf(object), system: object.name, count: manager.Rings.length, lights: [...lights.values()], scale: [...ring.scale] as [number, number, number] });
    }
  }
  return out;
}

// ----- the fragment ----------------------------------------------------------------------------------

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const round = (value: number) => Math.round(value * 10000) / 10000;

/** The ids of a part of the environment (any place among its siblings, any " (n)"). */
function partId(environment: string, name: string) {
  return `^${escapeRegex(environment)}\\.\\[\\d+\\]Environment\\.\\[\\d+\\]${escapeRegex(name)}(?: \\(\\d+\\))?$`;
}

/** The ids of the rings of a system — wherever the game puts them (any place: not tied to the game's
 *  version or mods). */
function ringId(environment: string, ring: string) {
  return `^(?:GameCore|${escapeRegex(environment)})\\.\\[\\d+\\]${escapeRegex(ring)}$`;
}

/** The ids of a light tube (by name) anywhere in the rings of a system. */
function ringLightId(environment: string, ring: string, light: string) {
  return `^(?:GameCore|${escapeRegex(environment)})\\.\\[\\d+\\]${escapeRegex(ring)}(?:\\.\\[\\d+\\][^.]+)*\\.\\[\\d+\\]${escapeRegex(light)}(?: \\(\\d+\\))?$`;
}

/** What the changes write into the difficulty (v3 keys). `preset`: the ready-made environment's data. */
export function modsFragment(mods: EnvironmentMods | undefined, data: EnvironmentData | null, preset?: EnvironmentFragment): EnvironmentFragment {
  const fragment: EnvironmentFragment = { environment: [], materials: {}, customEvents: [], pointDefinitions: {} };
  if (mods === undefined) return fragment;
  if (preset !== undefined) {
    fragment.environment.push(...structuredClone(preset.environment));
    Object.assign(fragment.materials, structuredClone(preset.materials));
    fragment.customEvents.push(...structuredClone(preset.customEvents));
    Object.assign(fragment.pointDefinitions, structuredClone(preset.pointDefinitions));
  }
  // (the scene editor's changes: after the ready-made environment, so they have the last word)
  for (const edit of mods.scene ?? []) {
    const command = sceneCommand(edit);
    if (command !== null) fragment.environment.push(command);
  }
  // the animations and the links: a track on each such thing of the game, their events
  sceneMotion(fragment, mods, data);
  if (data === null) {
    addObjects(fragment, mods);
    return fragment;
  }
  const environment = data.id;
  for (const name of mods.hidden ?? []) fragment.environment.push({ id: partId(environment, name), lookupMethod: 'Regex', active: false });
  const systems = ringSystemParts(data);
  const geometryIds = new Map<number, number>();
  for (const [ring, look] of Object.entries(mods.rings ?? {})) {
    const system = systems.find((item) => item.ring === ring);
    if (system === undefined) continue;
    if (look.geometry === true) {
      const geometry = geometryRingFragment(data, system.manager, system.system, ringId(environment, ring), geometryIds);
      fragment.environment.push(...geometry.environment);
      fragment.customEvents.push(...geometry.customEvents);
      Object.assign(fragment.materials, GEOMETRY_RING_MATERIALS);
      continue;
    }
    const size = look.size ?? 1;
    if (Math.abs(size - 1) > 1e-6) fragment.environment.push({ id: ringId(environment, ring), lookupMethod: 'Regex', scale: system.scale.map((value) => round(value * size)) });
    const thickness = look.thickness ?? 1;
    const length = look.length ?? 1;
    if (Math.abs(thickness - 1) < 1e-6 && Math.abs(length - 1) < 1e-6) continue;
    // (a tube's length is along its own y)
    for (const light of system.lights) {
      fragment.environment.push({ id: ringLightId(environment, ring, light.name), lookupMethod: 'Regex', scale: [round(light.scale[0] * thickness), round(light.scale[1] * length), round(light.scale[2] * thickness)] });
    }
  }
  addObjects(fragment, mods);
  return fragment;
}

/**
 * The scene's motion: tracks on the game's things that are animated or hung on others; the fog and the
 * lamps' settings; the events — animations (an array's others each as far aside), the player, the
 * links (a parent's motion onto the track its children hang on).
 */
function sceneMotion(fragment: EnvironmentFragment, mods: EnvironmentMods, data: EnvironmentData | null) {
  const objects = mods.objects ?? [];
  const tracked = trackedTargets(mods);
  const anims = new Map((mods.anims ?? []).filter((anim) => hasKeys(anim)).map((anim) => [anim.target, anim]));
  // (where the game's things stand: their own values, and the space those are in)
  const ids = new Map<string, number>();
  if (data !== null) for (const [index, list] of environmentLookupIds(data)) for (const id of list) if (!ids.has(id)) ids.set(id, index);
  const placeOf = (target: string): { base: Placing; outer?: Matrix4; world: boolean } | null => {
    if (target.startsWith('o:')) {
      const object = objects.find((item) => `o:${item.uid}` === target);
      if (object === undefined) return null;
      if (object.kind === 'shape') return { base: object, world: true };
      const index = object.source === undefined ? undefined : ids.get(object.source);
      const parent = index === undefined || data === null ? -1 : data.objects[index]!.parent;
      return { base: object, world: false, ...(parent >= 0 ? { outer: worldMatrix(data!, parent) } : {}) };
    }
    const index = ids.get(target);
    const own = index === undefined || data === null ? null : localOf(data, index);
    const edit = (mods.scene ?? []).find((item) => item.id === target);
    const base = { position: edit?.position ?? own?.position ?? [0, 0, 0], rotation: edit?.rotation ?? own?.rotation ?? [0, 0, 0], scale: edit?.scale ?? own?.scale ?? [1, 1, 1] };
    const parent = index === undefined || data === null ? -1 : data.objects[index]!.parent;
    return { base, world: false, ...(parent >= 0 ? { outer: worldMatrix(data!, parent) } : {}) };
  };
  // the game's things on tracks
  for (const target of tracked) {
    if (target.startsWith('o:') || target.startsWith('m:') || target === 'fog' || target === 'player') continue;
    const own = fragment.environment.find((entry) => entry.id === target && entry.lookupMethod === 'Exact' && entry.duplicate === undefined && entry.track === undefined);
    if (own !== undefined) own.track = animTrack(target);
    else fragment.environment.push({ id: target, lookupMethod: 'Exact', track: animTrack(target) });
  }
  // the fog
  const fog = Object.fromEntries(Object.entries(mods.fog ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => [key, round(value)]));
  if (Object.keys(fog).length > 0 || anims.has('fog')) fragment.environment.push({ id: FOG_ID, lookupMethod: 'Regex', ...(Object.keys(fog).length > 0 ? { components: { BloomFogEnvironment: fog } } : {}), ...(anims.has('fog') ? { track: animTrack('fog') } : {}) });
  // the materials coloured as the player's things
  for (const [name, material] of Object.entries(mods.materials ?? {})) {
    if (material.playerColor === undefined) continue;
    fragment.customEvents.push({ b: 0, t: 'AnimateTrack', d: { track: materialTrack(name, material), duration: 0, color: [material.playerColor, [1, 1, 1, round(material.color[3]), 'opMul']] } });
  }
  // the animations
  const motions = mods.motions ?? [];
  for (const motion of motions) if (!anims.has(motion.target)) anims.set(motion.target, { target: motion.target, keys: {} });
  for (const anim of anims.values()) {
    if (anim.target.startsWith('m:')) {
      const name = anim.target.slice(2);
      const material = mods.materials?.[name];
      if (material !== undefined) fragment.customEvents.push(...animEvents(anim, true, materialTrack(name, material)));
      continue;
    }
    if (anim.target === 'fog') {
      fragment.customEvents.push(...animEvents(anim, true));
      continue;
    }
    if (anim.target === 'player') {
      fragment.customEvents.push({ b: 0, t: 'AssignPlayerToTrack', d: { track: animTrack('player'), target: 'Root' } }, ...animEvents(anim, true));
      continue;
    }
    const place = placeOf(anim.target);
    if (place === null) continue;
    const object = anim.target.startsWith('o:') ? objects.find((item) => `o:${item.uid}` === anim.target) : undefined;
    const own = motions.filter((motion) => motion.target === anim.target);
    // (keys and ready motions: the parts with motions sampled together, the rest as keys)
    const write = (thing: SceneAnim, base: Placing, track: string) => {
      const moved = motionEvents(thing, own, base, place.world, track);
      fragment.customEvents.push(...animEvents(thing, place.world, track, moved.parts), ...moved.events, ...baseMotionEvents(own, base, place.world, track));
    };
    if (object?.ghost !== true) write(anim, place.base, animTrack(anim.target));
    // (an array's others: each its own track, as far aside as it stands)
    if (object?.array !== undefined) for (const other of expandObjects([object]).filter((item) => item.of !== undefined)) write(offsetAnim(anim, object, other, `o:${other.uid}`), other, animTrack(`o:${other.uid}`));
  }
  // the links: each parent's children on a track of its own, that track carried by its motion
  const byParent = new Map<string, string[]>();
  for (const link of mods.links ?? []) byParent.set(link.parent, [...(byParent.get(link.parent) ?? []), link.child]);
  const tracksOf = (target: string): string[] => {
    const object = target.startsWith('o:') ? objects.find((item) => `o:${item.uid}` === target) : undefined;
    if (object === undefined) return [animTrack(target)];
    return expandObjects([object]).map((item) => animTrack(`o:${item.uid}`));
  };
  for (const [parent, children] of byParent) {
    const track = linkTrack(parent);
    const place = placeOf(parent);
    fragment.customEvents.push({ b: 0, t: 'AssignTrackParent', d: { childrenTracks: children.flatMap(tracksOf), parentTrack: track, worldPositionStays: true } });
    if (place !== null) fragment.customEvents.push(...linkEvents(anims.get(parent), place.base, track, place.outer));
    // (a parent hung on another itself: its children's track goes along with that one too)
    const above = (mods.links ?? []).find((link) => link.child === parent);
    if (above !== undefined) fragment.customEvents.push({ b: 0, t: 'AssignTrackParent', d: { childrenTracks: [track], parentTrack: linkTrack(above.parent), worldPositionStays: true } });
  }
}

/** The scene editor's own objects: the last of the fragment (the 3D view tells them by that). */
function addObjects(fragment: EnvironmentFragment, mods: EnvironmentMods) {
  const added = objectsFragment(mods);
  fragment.environment.push(...added.environment);
  Object.assign(fragment.materials, added.materials);
}

// ----- into a difficulty's custom data ------------------------------------------------------------------

const V2_KEYS: Record<string, string> = { id: '_id', lookupMethod: '_lookupMethod', active: '_active', scale: '_scale', position: '_position', localPosition: '_localPosition', rotation: '_rotation', localRotation: '_localRotation', track: '_track', duplicate: '_duplicate' };

/** An environment entry with v2 keys (only the plain ones: what fits v2). */
function v2Entry(entry: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'components') {
      // (v2 has a light ID for an object, nothing else of its components)
      const components = value as Record<string, Record<string, unknown> | undefined>;
      const light = components.ILightWithId;
      if (Object.keys(components).length !== 1 || light === undefined || Object.keys(light).some((name) => name !== 'lightID')) return null;
      if (light.lightID !== undefined) out._lightID = light.lightID;
      continue;
    }
    const v2 = V2_KEYS[key];
    if (v2 === undefined) return null;
    // (v2 positions are in lanes of 0.6 m)
    out[v2] = key === 'position' || key === 'localPosition' ? (value as number[]).map((item) => Math.round((item / 0.6) * 1e6) / 1e6) : value;
  }
  return out;
}

/** Whether a fragment can go into a v2 difficulty (plain environment entries only). */
export function fitsV2(fragment: EnvironmentFragment) {
  return fragment.customEvents.length === 0 && Object.keys(fragment.materials).length === 0 && Object.keys(fragment.pointDefinitions).length === 0 && fragment.environment.every((entry) => v2Entry(entry) !== null);
}

const json = (value: unknown) => JSON.stringify(value);

/** Takes the entries equal to the ones in `items` out of `list` (each once). */
function without(list: unknown[], items: readonly unknown[]) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(json(item), (counts.get(json(item)) ?? 0) + 1);
  return list.filter((item) => {
    const key = json(item);
    const left = counts.get(key) ?? 0;
    if (left === 0) return true;
    counts.set(key, left - 1);
    return false;
  });
}

/**
 * A difficulty's root custom data with `previous` taken out and `next` put in (v2: the keys turned
 * into v2 ones — only what fits v2 goes in).
 */
export function replaceFragment(custom: Record<string, unknown>, previous: EnvironmentFragment | undefined, next: EnvironmentFragment, v2: boolean): Record<string, unknown> {
  const out = { ...custom };
  const keys = v2
    ? { environment: '_environment', materials: '_materials', customEvents: '_customEvents', pointDefinitions: '_pointDefinitions' }
    : { environment: 'environment', materials: 'materials', customEvents: 'customEvents', pointDefinitions: 'pointDefinitions' };
  const entries = (fragment: EnvironmentFragment | undefined) =>
    v2 ? (fragment?.environment ?? []).flatMap((entry) => v2Entry(entry) ?? []) : (fragment?.environment ?? []);
  const environment = [...without(Array.isArray(out[keys.environment]) ? (out[keys.environment] as unknown[]) : [], entries(previous)), ...entries(next)];
  if (environment.length > 0) out[keys.environment] = environment;
  else delete out[keys.environment];
  if (v2) return out;
  const events = [...without(Array.isArray(out[keys.customEvents]) ? (out[keys.customEvents] as unknown[]) : [], previous?.customEvents ?? []), ...next.customEvents].sort(
    (a, b) => Number((a as { b?: number }).b ?? 0) - Number((b as { b?: number }).b ?? 0),
  );
  if (events.length > 0) out[keys.customEvents] = events;
  else delete out[keys.customEvents];
  for (const key of ['materials', 'pointDefinitions'] as const) {
    const map = { ...((out[keys[key]] as Record<string, unknown> | undefined) ?? {}) };
    for (const [name, value] of Object.entries(previous?.[key] ?? {})) if (json(map[name]) === json(value)) delete map[name];
    Object.assign(map, next[key]);
    if (Object.keys(map).length > 0) out[keys[key]] = map;
    else delete out[keys[key]];
  }
  return out;
}

/** The mods a fragment needs the player to have (beyond the plain game). */
export function fragmentRequirements(mods: EnvironmentMods | undefined): string[] {
  if (mods === undefined) return [];
  const preset = findPreset(mods.preset);
  const out = new Set<string>();
  if (preset !== undefined) for (const mod of ['Chroma', ...(preset.noodle ? ['Noodle Extensions'] : [])]) out.add(mod);
  if (geometrySystems(mods).length > 0) for (const mod of ['Chroma', 'Noodle Extensions']) out.add(mod);
  if ((mods.scene ?? []).some((edit) => sceneCommand(edit) !== null) || (mods.objects ?? []).length > 0 || (mods.anims ?? []).some((anim) => hasKeys(anim)) || Object.keys(mods.fog ?? {}).length > 0 || (mods.motions ?? []).length > 0) out.add('Chroma');
  if ((mods.links ?? []).length > 0 || (mods.anims ?? []).some((anim) => anim.target === 'player' && hasKeys(anim))) for (const mod of ['Chroma', 'Noodle Extensions']) out.add(mod);
  return [...out];
}

/** The ring systems drawn from geometry (their rings' object names). */
export function geometrySystems(mods: EnvironmentMods | undefined): string[] {
  return Object.entries(mods?.rings ?? {}).flatMap(([ring, look]) => (look.geometry === true ? [ring] : []));
}

export function hasMods(mods: EnvironmentMods | undefined) {
  return mods !== undefined && (mods.preset !== undefined || (mods.hidden ?? []).length > 0 || Object.keys(mods.rings ?? {}).length > 0 || (mods.scene ?? []).some((edit) => sceneCommand(edit) !== null) || (mods.objects ?? []).length > 0 || (mods.anims ?? []).some((anim) => hasKeys(anim)) || (mods.links ?? []).length > 0 || (mods.motions ?? []).length > 0 || Object.values(mods.fog ?? {}).some((value) => value !== undefined));
}

