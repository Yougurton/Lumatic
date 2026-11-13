import type { EnvironmentData } from '../engine/renderer/environment/types';
import catalog from './custom-environments.json';
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
    if (isLightShader(material.shader) && object.light !== undefined) command.components = { ILightWithId: { type: object.light.type, lightID: object.light.id } };
  }
  if (object.hidden === true) command.active = false;
  return command;
}

/** The commands of the added objects and the materials they use. */
export function objectsFragment(mods: EnvironmentMods): { environment: Record<string, unknown>[]; materials: Record<string, unknown> } {
  const materials = mods.materials ?? {};
  const environment: Record<string, unknown>[] = [];
  const used = new Set<string>();
  for (const object of mods.objects ?? []) {
    const command = objectCommand(object, materials);
    if (command === null) continue;
    environment.push(command);
    if (object.kind === 'shape' && object.material !== undefined) used.add(object.material);
  }
  return { environment, materials: Object.fromEntries([...used].map((name) => [name, { shader: materials[name]!.shader, color: materials[name]!.color.map(round) }])) };
}

/**
 * One object of the environment changed in the scene editor: found by its exact Chroma id; hidden, or
 * put, turned and sized (its own — local — values, as Chroma's: metres, degrees x/y/z).
 */
export interface SceneEdit {
  id: string;
  hidden?: boolean;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

/** A scene edit as Chroma's environment command (null: it changes nothing). */
export function sceneCommand(edit: SceneEdit): Record<string, unknown> | null {
  const command: Record<string, unknown> = { id: edit.id, lookupMethod: 'Exact' };
  if (edit.hidden === true) command.active = false;
  if (edit.position !== undefined) command.localPosition = edit.position.map(round);
  if (edit.rotation !== undefined) command.localRotation = edit.rotation.map(round);
  if (edit.scale !== undefined) command.scale = edit.scale.map(round);
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
  if ((mods.scene ?? []).some((edit) => sceneCommand(edit) !== null) || (mods.objects ?? []).length > 0) out.add('Chroma');
  return [...out];
}

/** The ring systems drawn from geometry (their rings' object names). */
export function geometrySystems(mods: EnvironmentMods | undefined): string[] {
  return Object.entries(mods?.rings ?? {}).flatMap(([ring, look]) => (look.geometry === true ? [ring] : []));
}

export function hasMods(mods: EnvironmentMods | undefined) {
  return mods !== undefined && (mods.preset !== undefined || (mods.hidden ?? []).length > 0 || Object.keys(mods.rings ?? {}).length > 0 || (mods.scene ?? []).some((edit) => sceneCommand(edit) !== null) || (mods.objects ?? []).length > 0);
}

