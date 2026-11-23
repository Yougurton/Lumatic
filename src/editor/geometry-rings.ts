import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

import type { EnvironmentData, EnvironmentObjectData, ObjectReference } from '../engine/renderer/environment/types';
import { ringTrack } from './rings';

/**
 * A ring system drawn from Chroma geometry instead of the game's rings: every ring's frame made of
 * cubes (its mesh cut into bars around the ring's middle), its light tubes as light cubes with the
 * light IDs the game's have, all of a ring put on the ring's own track (Noodle's AssignTrackParent) —
 * the track the ring poses turn ('tracks' blocks). Unlike the game's rings, these are found by nobody's
 * place in the game's scene: they work the same for every player and game version. The game's rings
 * are taken away.
 *
 * Worked out in the environment data's space (the 3D view's), written in Unity's (Chroma's).
 */

export interface GeometryRingPiece {
  kind: 'frame' | 'light';
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  /** Light pieces: which light of the ring it is (its event type is that light's). */
  light?: { object: number; component: 'ParametricBloomFogLightController' | 'MaterialLightController'; index: number };
}

export const FRAME_MATERIAL = 'chroeditorRingFrame';
export const LIGHT_MATERIAL = 'chroeditorRingLight';
const PARTS = 'chroeditorGeoParts';
const BASE = 'chroeditorGeoBase';

const round = (value: number) => Math.round(value * 1000) / 1000;

function localMatrix(object: EnvironmentObjectData) {
  return new Matrix4().compose(new Vector3(...object.position), new Quaternion(...object.rotation), new Vector3(...object.scale));
}

/** An object's matrix in its ring's space. */
function inRing(data: EnvironmentData, index: number, ring: number) {
  const matrix = new Matrix4();
  for (let current = index; current !== ring && current >= 0; current = data.objects[current]!.parent) matrix.premultiply(localMatrix(data.objects[current]!));
  return matrix;
}

function worldMatrix(data: EnvironmentData, index: number) {
  const matrix = new Matrix4();
  for (let current = index; current >= 0; current = data.objects[current]!.parent) matrix.premultiply(localMatrix(data.objects[current]!));
  return matrix;
}

/**
 * A cube (Unity's: 1 a side, centred) placed so, as Chroma takes it: position, Euler angles (Unity's
 * order), scale. (The environment data is the 3D view's: z the other way round from Unity's.)
 */
function cubeTransform(center: Vector3, rotation: Quaternion, size: Vector3) {
  const euler = new Euler().setFromQuaternion(rotation, 'YXZ');
  const degrees = (value: number) => round((value * 180) / Math.PI);
  return {
    position: [round(center.x), round(center.y), round(-center.z)] as [number, number, number],
    rotation: [degrees(-euler.x), degrees(-euler.y), degrees(euler.z)] as [number, number, number],
    scale: [round(Math.max(size.x, 0.001)), round(Math.max(size.y, 0.001)), round(Math.max(size.z, 0.001))] as [number, number, number],
  };
}

/** The objects in a ring (depth first, children in order). */
function subtree(data: EnvironmentData, root: number) {
  const children = new Map<number, number[]>();
  data.objects.forEach((object, index) => {
    const list = children.get(object.parent) ?? [];
    list.push(index);
    children.set(object.parent, list);
  });
  const out: number[] = [];
  const walk = (index: number) => {
    for (const child of children.get(index) ?? []) {
      if (!data.objects[child]!.active) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Bars standing in for a mesh (in ring space): a frame around the ring's middle cut into sides, any
 *  other part one box. */
function meshBars(points: Vector3[], triangles: [number, number, number][]): { center: Vector3; rotation: Quaternion; size: Vector3 }[] {
  // the mesh's connected parts
  const parent = points.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  const key = (point: Vector3) => `${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`;
  const same = new Map<string, number>();
  points.forEach((point, index) => {
    const known = same.get(key(point));
    if (known === undefined) same.set(key(point), index);
    else parent[find(index)] = find(known);
  });
  for (const [a, b, c] of triangles) {
    parent[find(b)] = find(a);
    parent[find(c)] = find(a);
  }
  const parts = new Map<number, [number, number, number][]>();
  for (const triangle of triangles) {
    const root = find(triangle[0]);
    parts.set(root, [...(parts.get(root) ?? []), triangle]);
  }
  const out: { center: Vector3; rotation: Quaternion; size: Vector3 }[] = [];
  for (const part of parts.values()) {
    const used = [...new Set(part.flat())].map((index) => points[index]!);
    // around the middle (the ring's axis): a frame
    const angles = used.map((point) => Math.atan2(point.y, point.x)).sort((a, b) => a - b);
    let gap = 0;
    angles.forEach((angle, index) => (gap = Math.max(gap, (angles[(index + 1) % angles.length]! - angle + 2 * Math.PI) % (2 * Math.PI) || 0)));
    const around = angles.length > 3 && gap < Math.PI / 2 && Math.min(...used.map((point) => Math.hypot(point.x, point.y))) > 1e-3;
    if (!around) {
      out.push(box(used, 0));
      continue;
    }
    // cut into sides: the number of sides and where they start that leave the least box area
    let best: { score: number; bars: { center: Vector3; rotation: Quaternion; size: Vector3 }[] } | null = null;
    for (const sides of [3, 4, 6, 8]) {
      const span = (2 * Math.PI) / sides;
      for (let offset = 0; offset < span; offset += Math.PI / 90) {
        const groups: Vector3[][] = Array.from({ length: sides }, () => []);
        for (const triangle of part) {
          const middle = new Vector3();
          for (const index of triangle) middle.add(points[index]!);
          middle.divideScalar(3);
          const side = Math.floor((((Math.atan2(middle.y, middle.x) - offset) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / span) % sides;
          groups[side]!.push(...triangle.map((index) => points[index]!));
        }
        const bars = groups.flatMap((group, side) => (group.length === 0 ? [] : [box(group, offset + (side + 0.5) * span + Math.PI / 2)]));
        const score = bars.reduce((sum, bar) => sum + bar.size.x * bar.size.y, 0) * (1 + 0.03 * sides);
        if (best === null || score < best.score) best = { score, bars };
      }
    }
    out.push(...best!.bars);
  }
  return out;
}

/** The box around points, its sides along `angle` (in the ring's plane) and the ring's axis. */
function box(points: Vector3[], angle: number) {
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), angle);
  const inverse = rotation.clone().invert();
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const point of points) {
    const local = point.clone().applyQuaternion(inverse);
    min.min(local);
    max.max(local);
  }
  return { center: min.clone().add(max).multiplyScalar(0.5).applyQuaternion(rotation), rotation, size: max.clone().sub(min) };
}

/** The pieces of a ring (the first one of a system: they're all alike), in its space. */
export function ringPieces(data: EnvironmentData, ring: number): GeometryRingPiece[] {
  const pieces: GeometryRingPiece[] = [];
  const objects = subtree(data, ring);
  objects.forEach((index, order) => {
    const object = data.objects[index]!;
    const matrix = inRing(data, index, ring);
    const light = object.components?.ParametricBloomFogLightController?.[0];
    if (light !== undefined && light.enabled) {
      // (its box: a child the light sizes, the mesh 2 a side)
      const boxObject = data.objects.findIndex((child) => child.parent === index && child.mesh !== undefined);
      const boxMatrix = boxObject < 0 ? matrix : inRing(data, boxObject, ring);
      const position = new Vector3();
      const rotation = new Quaternion();
      const scale = new Vector3();
      boxMatrix.decompose(position, rotation, scale);
      if (boxObject < 0) scale.set(light.Width / 2, light.Length / 2, light.Width / 2);
      pieces.push({ kind: 'light', ...cubeTransform(position, rotation, scale.multiplyScalar(2)), light: { object: order, component: 'ParametricBloomFogLightController', index: 0 } });
      return;
    }
    const mesh = object.mesh === undefined ? undefined : data.meshes[object.mesh];
    if (mesh === undefined || object.rendererEnabled === false || data.objects[object.parent]?.components?.ParametricBloomFogLightController !== undefined) return;
    const points: Vector3[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) points.push(new Vector3(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]).applyMatrix4(matrix));
    const triangles: [number, number, number][] = [];
    for (let i = 0; i < mesh.indices.length; i += 3) triangles.push([mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!]);
    const lit = object.components?.MaterialLightController?.[0];
    for (const bar of meshBars(points, triangles)) {
      pieces.push(
        lit !== undefined && lit.enabled
          ? { kind: 'light', ...cubeTransform(bar.center, bar.rotation, bar.size), light: { object: order, component: 'MaterialLightController', index: 0 } }
          : { kind: 'frame', ...cubeTransform(bar.center, bar.rotation, bar.size) },
      );
    }
  });
  return pieces;
}

/** The event type a ring's light answers to. */
function lightAddress(data: EnvironmentData, reference: ObjectReference): { type: number } | null {
  const controller =
    reference.component === 'ParametricBloomFogLightController'
      ? data.objects[reference.obj]?.components?.ParametricBloomFogLightController?.[reference.componentIndex ?? 0]
      : data.objects[reference.obj]?.components?.MaterialLightController?.[reference.componentIndex ?? 0];
  if (controller === undefined) return null;
  for (const object of data.objects) {
    for (const effect of object.components?.BasicLightEffect ?? []) {
      if (!effect.lightEntries.some((entry) => entry.obj === reference.obj && entry.component === reference.component && (entry.componentIndex ?? 0) === (reference.componentIndex ?? 0))) continue;
      return { type: effect.ID };
    }
  }
  return null;
}

/** Where the geometry rings' light IDs start (free in every environment: the game's rings keep
 *  theirs even taken away, so these get their own — the same in the game and the editor). */
export const GEOMETRY_LIGHT_ID = 5001;

/**
 * The custom data drawing a ring system from geometry (v3 keys): the game's rings away, every ring's
 * pieces on its parts track, those under the ring's track, that under its place. `ids`: the next free
 * light ID per event type (shared by the systems drawn so).
 */
export function geometryRingFragment(data: EnvironmentData, manager: number, system: string, hideId: string, ids: Map<number, number> = new Map()) {
  const rings = data.objects[manager]?.components?.TrackLaneRingsManager?.[0]?.Rings.map((reference) => reference.obj) ?? [];
  const environment: Record<string, unknown>[] = [{ id: hideId, lookupMethod: 'Regex', active: false }];
  const customEvents: Record<string, unknown>[] = [];
  if (rings.length === 0) return { environment, customEvents };
  const pieces = ringPieces(data, rings[0]!);
  rings.forEach((ring, index) => {
    const parts = `${PARTS}:${system}:${String(index)}`;
    const base = `${BASE}:${system}:${String(index)}`;
    const objects = subtree(data, ring);
    for (const piece of pieces) {
      const entry: Record<string, unknown> = {
        geometry: { type: 'Cube', material: piece.kind === 'light' ? LIGHT_MATERIAL : FRAME_MATERIAL },
        track: parts,
        position: piece.position,
        rotation: piece.rotation,
        scale: piece.scale,
      };
      if (piece.light !== undefined) {
        const object = objects[piece.light.object];
        const address = object === undefined ? null : lightAddress(data, { obj: object, component: piece.light.component, componentIndex: piece.light.index });
        if (address === null) continue;
        const id = ids.get(address.type) ?? GEOMETRY_LIGHT_ID;
        ids.set(address.type, id + 1);
        entry.components = { ILightWithId: { type: address.type, lightID: id } };
      }
      environment.push(entry);
    }
    // the ring's place (as the game has it, without the turn about its own axis the ring events gave it)
    const position = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    worldMatrix(data, ring).decompose(position, rotation, scale);
    const axis = new Vector3(0, 0, 1).applyQuaternion(rotation);
    if (axis.distanceTo(new Vector3(0, 0, 1)) < 1e-3) rotation.identity();
    const place = cubeTransform(position, rotation, scale);
    customEvents.push(
      { b: 0, t: 'AnimateTrack', d: { track: base, duration: 0, position: place.position, rotation: place.rotation, scale: place.scale } },
      { b: 0, t: 'AssignTrackParent', d: { childrenTracks: [parts], parentTrack: ringTrack(system, index) } },
      { b: 0, t: 'AssignTrackParent', d: { childrenTracks: [ringTrack(system, index)], parentTrack: base } },
    );
  });
  return { environment, customEvents };
}

export const GEOMETRY_RING_MATERIALS = {
  [FRAME_MATERIAL]: { shader: 'Standard', color: [0.12, 0.12, 0.14, 1] },
  [LIGHT_MATERIAL]: { shader: 'OpaqueLight' },
};
