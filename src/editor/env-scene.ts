import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { environmentLookupIds } from '../engine/renderer/environment/chroma-environment';
import type { EnvironmentData } from '../engine/renderer/environment/types';

/**
 * The scene editor's view of an environment: its objects as a tree (as the game has them — names,
 * parents), each with the id Chroma finds it by, where it stands (its own position, turn and size, as
 * Chroma's numbers: metres, degrees x/y/z) and the box its mesh fills.
 *
 * The data keeps positions as the 3D view has them (z the other way from the game's) and turns as
 * quaternions; Chroma's numbers are converted here, both ways.
 */

export interface SceneNode {
  /** Its place among the environment's objects. */
  index: number;
  name: string;
  parent: number;
  children: number[];
  /** The id Chroma finds it by (null: it has none — it can't be changed). */
  id: string | null;
  /** Has a mesh of its own (something to see and to click). */
  mesh: boolean;
  /** How many objects are under it, itself not counted. */
  below: number;
}

/** The environment's objects as a tree (the ones Chroma made left out); the roots' indices. */
export function sceneTree(data: EnvironmentData): { nodes: Map<number, SceneNode>; roots: number[] } {
  const ids = environmentLookupIds(data);
  const nodes = new Map<number, SceneNode>();
  data.objects.forEach((object, index) => {
    if (object.chromaGenerated === true) return;
    nodes.set(index, { index, name: object.name, parent: object.parent, children: [], id: ids.get(index)?.[0] ?? null, mesh: object.mesh !== undefined && object.rendererEnabled !== false, below: 0 });
  });
  const roots: number[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parent);
    if (parent === undefined) roots.push(node.index);
    else parent.children.push(node.index);
  }
  const count = (index: number): number => {
    const node = nodes.get(index)!;
    node.below = node.children.reduce((sum, child) => sum + 1 + count(child), 0);
    return node.below;
  };
  for (const root of roots) count(root);
  return { nodes, roots };
}

const DEG = 180 / Math.PI;
const tidy = (value: number) => {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** A turn (the data's quaternion) as Chroma's degrees about x, y, z. */
export function chromaRotation(quaternion: readonly number[]): [number, number, number] {
  const euler = new Euler().setFromQuaternion(new Quaternion().fromArray(quaternion as number[]), 'YXZ');
  return [tidy(-euler.x * DEG), tidy(-euler.y * DEG), tidy(euler.z * DEG)];
}

/** Chroma's degrees about x, y, z as the data's quaternion. */
export function dataRotation(rotation: readonly number[]): [number, number, number, number] {
  const q = new Quaternion().setFromEuler(new Euler(-(rotation[0] ?? 0) / DEG, -(rotation[1] ?? 0) / DEG, (rotation[2] ?? 0) / DEG, 'YXZ'));
  return [q.x, q.y, q.z, q.w];
}

/** A place (the data's: z towards the viewer) as Chroma's (z ahead), and back — the same flip. */
export const flipZ = (position: readonly number[]): [number, number, number] => [tidy(position[0] ?? 0), tidy(position[1] ?? 0), tidy(-(position[2] ?? 0))];

/** An object's own place, turn and size as Chroma's numbers. */
export function localOf(data: EnvironmentData, index: number): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } | null {
  const object = data.objects[index];
  if (object === undefined) return null;
  return { position: flipZ(object.position), rotation: chromaRotation(object.rotation), scale: [tidy(object.scale[0]), tidy(object.scale[1]), tidy(object.scale[2])] };
}

/** An object's place in the world (the 3D view's space). */
export function worldMatrix(data: EnvironmentData, index: number): Matrix4 {
  const object = data.objects[index];
  if (object === undefined) return new Matrix4();
  const matrix = new Matrix4().compose(new Vector3().fromArray(object.position), new Quaternion().fromArray(object.rotation), new Vector3().fromArray(object.scale));
  return object.parent < 0 ? matrix : worldMatrix(data, object.parent).multiply(matrix);
}

/** Whether an object and everything above it is switched on. */
export function shown(data: EnvironmentData, index: number): boolean {
  for (let at = index; at >= 0; at = data.objects[at]!.parent) {
    const object = data.objects[at];
    if (object === undefined || !object.active) return false;
  }
  return true;
}

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

const meshBoxes = new WeakMap<EnvironmentData, Map<string, Box | null>>();

/** The box a mesh fills (in its own space; null: it has no points). */
function meshBox(data: EnvironmentData, name: string): Box | null {
  let cache = meshBoxes.get(data);
  if (cache === undefined) meshBoxes.set(data, (cache = new Map()));
  const known = cache.get(name);
  if (known !== undefined) return known;
  const positions = data.meshes[name]?.positions;
  let box: Box | null = null;
  if (positions !== undefined && positions.length >= 3) {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const value = positions[i + k]!;
        if (value < min[k]!) min[k] = value;
        if (value > max[k]!) max[k] = value;
      }
    }
    box = { min, max };
  }
  cache.set(name, box);
  return box;
}

/** The box an object's own mesh fills, in its own space (null: it has no mesh). */
export function objectBox(data: EnvironmentData, index: number): Box | null {
  const object = data.objects[index];
  if (object?.mesh === undefined) return null;
  return meshBox(data, object.mesh);
}

/**
 * The boxes to show for an object: its own mesh's, or — a holder without one — its children's (down
 * to `depth` levels), each with where it stands in the world.
 */
export function shownBoxes(data: EnvironmentData, index: number, children: (index: number) => readonly number[], depth = 3): { box: Box; matrix: Matrix4 }[] {
  const own = objectBox(data, index);
  if (own !== null) return [{ box: own, matrix: worldMatrix(data, index) }];
  if (depth <= 0) return [];
  return children(index).flatMap((child) => shownBoxes(data, child, children, depth - 1));
}

/**
 * Where a ray (origin and direction, the 3D view's space) enters a box standing by `matrix`: how far
 * along the ray (null: it misses).
 */
export function rayBox(origin: Vector3, direction: Vector3, box: Box, matrix: Matrix4): number | null {
  const inverse = matrix.clone().invert();
  if (!Number.isFinite(inverse.elements[0]!)) return null;
  const o = origin.clone().applyMatrix4(inverse);
  const d = direction.clone().transformDirection(inverse);
  // (transformDirection normalises: the distance along the ray is found again in the world below)
  let near = -Infinity;
  let far = Infinity;
  const from = [o.x, o.y, o.z];
  const way = [d.x, d.y, d.z];
  for (let k = 0; k < 3; k++) {
    // (a flat mesh: given a little thickness to be hit at all)
    const pad = box.max[k]! - box.min[k]! < 1e-4 ? 0.01 : 0;
    const lo = box.min[k]! - pad;
    const hi = box.max[k]! + pad;
    if (Math.abs(way[k]!) < 1e-9) {
      if (from[k]! < lo || from[k]! > hi) return null;
      continue;
    }
    let t0 = (lo - from[k]!) / way[k]!;
    let t1 = (hi - from[k]!) / way[k]!;
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return null;
  }
  if (far < 0) return null;
  const local = new Vector3(from[0]! + way[0]! * Math.max(near, 0), from[1]! + way[1]! * Math.max(near, 0), from[2]! + way[2]! * Math.max(near, 0));
  return local.applyMatrix4(matrix).distanceTo(origin);
}

/** Chroma's own place, turn and size for an object standing by `world` under the parent standing by
 *  `parentWorld` (the 3D view's space). */
export function localFromWorld(world: Matrix4, parentWorld: Matrix4): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } {
  const local = parentWorld.clone().invert().multiply(world);
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  local.decompose(position, quaternion, scale);
  return { position: flipZ([position.x, position.y, position.z]), rotation: chromaRotation([quaternion.x, quaternion.y, quaternion.z, quaternion.w]), scale: [tidy(scale.x), tidy(scale.y), tidy(scale.z)] };
}
