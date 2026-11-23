import { type Object3D, Vector3, Vector4 } from 'three';

/**
 * The game's "SDF points" (SDFArrayManager, the global _SDFPointArray): a few points of the environment
 * with a radius each, moved and sized by the map (a light translation group, an FX group). Surfaces
 * whose emission comes from them (Coldplay's ribbons and spheres) glow where a point reaches them.
 *
 * One environment is shown at a time, so the points are kept once and every material reads the same
 * uniform. As the game passes them: xyz — the point's place in the world, w — the root of its radius.
 */

export const SDF_POINT_COUNT = 4;

export const sdfPointUniform = { value: Array.from({ length: SDF_POINT_COUNT }, () => new Vector4(0, 0, 0, 0)) };

interface SdfPoint {
  node: Object3D;
  /** The root of its radius: the environment's own until the FX group sets it. */
  sqrtRadius: number;
  initial: number;
}

let points: SdfPoint[] = [];
const position = new Vector3();

/** The environment's points, in the order the game has them (none: an environment without them). */
export function setSdfPoints(items: readonly { node: Object3D; sqrtRadius: number }[]) {
  points = items.slice(0, SDF_POINT_COUNT).map((item) => ({ ...item, initial: item.sqrtRadius }));
  for (const vector of sdfPointUniform.value) vector.set(0, 0, 0, 0);
}

/** (no value: back to the environment's own) */
export function setSdfPointRadius(node: Object3D, sqrtRadius?: number) {
  const point = points.find((item) => item.node === node);
  if (point !== undefined) point.sqrtRadius = sqrtRadius ?? point.initial;
}

/** Every frame: the points where they are now. */
export function updateSdfPoints() {
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    point.node.getWorldPosition(position);
    sdfPointUniform.value[i]!.set(position.x, position.y, position.z, point.sqrtRadius);
  }
}

export const hasSdfPoints = () => points.length > 0;
