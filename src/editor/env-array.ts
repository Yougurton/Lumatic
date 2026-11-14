import { Quaternion, Vector3 } from 'three';
import { chromaRotation, dataRotation } from './env-scene';

/**
 * Many of one object: the object itself is the first, the rest are worked out from it — in a row, round
 * a point, as a grid, along a bent line, or scattered in a box. Kept as numbers (not as so many separate
 * objects), so the count or the step can be changed later.
 *
 * All in Chroma's numbers (metres, degrees x/y/z), in the space the object's own values are in.
 */
export type SceneArray =
  | { kind: 'row'; count: number; step: [number, number, number]; turn: [number, number, number]; grow: number }
  | { kind: 'circle'; count: number; axis: 0 | 1 | 2; centre: [number, number, number]; angle: number; face: boolean }
  | { kind: 'grid'; counts: [number, number, number]; steps: [number, number, number] }
  | { kind: 'line'; count: number; end: [number, number, number]; bend: [number, number, number] }
  | { kind: 'scatter'; count: number; size: [number, number, number]; turn: number; sizeFrom: number; sizeTo: number; seed: number };

export type ArrayKind = SceneArray['kind'];
export const ARRAY_KINDS: readonly ArrayKind[] = ['row', 'circle', 'grid', 'line', 'scatter'];

export interface Placing {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

/** At most so many of one object (a slip of the hand must not make a million). */
export const ARRAY_LIMIT = 500;

const whole = (value: number, min: number) => Math.max(min, Math.round(Number.isFinite(value) ? value : min));

/** How many there are in all, the object itself counted. */
export function arrayCount(array: SceneArray): number {
  const count = array.kind === 'grid' ? whole(array.counts[0], 1) * whole(array.counts[1], 1) * whole(array.counts[2], 1) : whole(array.count, 1);
  return Math.min(ARRAY_LIMIT, count);
}

/** What a new array of a kind starts as, for an object standing at `base`. */
export function defaultArray(kind: ArrayKind, base: Placing): SceneArray {
  if (kind === 'row') return { kind, count: 5, step: [2, 0, 0], turn: [0, 0, 0], grow: 1 };
  if (kind === 'circle') return { kind, count: 8, axis: 1, centre: [round(base.position[0] - 5), base.position[1], base.position[2]], angle: 360, face: true };
  if (kind === 'grid') return { kind, counts: [3, 1, 3], steps: [2, 2, 2] };
  if (kind === 'line') return { kind, count: 8, end: [0, 0, 20], bend: [0, 4, 0] };
  return { kind, count: 12, size: [10, 4, 10], turn: 180, sizeFrom: 0.6, sizeTo: 1.4, seed: 1 };
}

const round = (value: number) => {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const round3 = (values: readonly number[]): [number, number, number] => [round(values[0] ?? 0), round(values[1] ?? 0), round(values[2] ?? 0)];

/** A small repeatable random source (the same seed: the same scatter). */
function random(seed: number) {
  let state = (Math.round(seed) >>> 0) + 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A turn by Chroma's degrees about one of Chroma's axes, as the data's quaternion (as `dataRotation`
 *  has it: x and y the other way). */
function aboutAxis(axis: 0 | 1 | 2, degrees: number): Quaternion {
  const turn: [number, number, number] = [0, 0, 0];
  turn[axis] = degrees;
  return new Quaternion().fromArray(dataRotation(turn));
}

/** Chroma's place as the data's vector, and back (z the other way). */
const toData = (position: readonly number[]) => new Vector3(position[0] ?? 0, position[1] ?? 0, -(position[2] ?? 0));
const fromData = (vector: Vector3): [number, number, number] => round3([vector.x, vector.y, -vector.z]);

/** Where the others stand: every one of the array but the object itself (which stands at `base`). */
export function arrayPlacings(base: Placing, array: SceneArray): Placing[] {
  const out: Placing[] = [];
  const total = arrayCount(array);
  if (array.kind === 'row') {
    for (let n = 1; n < total; n++) {
      out.push({
        position: round3(base.position.map((value, k) => value + array.step[k]! * n)),
        rotation: round3(base.rotation.map((value, k) => value + array.turn[k]! * n)),
        scale: round3(base.scale.map((value) => value * Math.pow(Math.max(0.01, array.grow), n))),
      });
    }
  } else if (array.kind === 'circle') {
    // (a full round: the last doesn't land on the first; a part of one: the last stands at its end)
    const full = Math.abs(Math.abs(array.angle) - 360) < 1e-6;
    const each = total <= 1 ? 0 : array.angle / (full ? total : total - 1);
    const centre = toData(array.centre);
    const arm = toData(base.position).sub(centre);
    const own = new Quaternion().fromArray(dataRotation(base.rotation));
    for (let n = 1; n < total; n++) {
      const turn = aboutAxis(array.axis, each * n);
      const position = fromData(arm.clone().applyQuaternion(turn).add(centre));
      const rotation = array.face ? chromaRotation(turn.clone().multiply(own).toArray()) : ([...base.rotation] as [number, number, number]);
      out.push({ position, rotation, scale: [...base.scale] });
    }
  } else if (array.kind === 'grid') {
    const counts = array.counts.map((value) => whole(value, 1));
    for (let y = 0; y < counts[1]!; y++) {
      for (let z = 0; z < counts[2]!; z++) {
        for (let x = 0; x < counts[0]!; x++) {
          if ((x === 0 && y === 0 && z === 0) || out.length >= total - 1) continue;
          out.push({ position: round3([base.position[0] + x * array.steps[0], base.position[1] + y * array.steps[1], base.position[2] + z * array.steps[2]]), rotation: [...base.rotation], scale: [...base.scale] });
        }
      }
    }
  } else if (array.kind === 'line') {
    // (a bent line from the object to `end` beyond it: the bend pulls its middle aside)
    const control = array.end.map((value, k) => value / 2 + array.bend[k]! * 2);
    for (let n = 1; n < total; n++) {
      const t = n / (total - 1);
      out.push({ position: round3(base.position.map((value, k) => value + 2 * (1 - t) * t * control[k]! + t * t * array.end[k]!)), rotation: [...base.rotation], scale: [...base.scale] });
    }
  } else {
    const next = random(array.seed);
    for (let n = 1; n < total; n++) {
      const position = round3(base.position.map((value, k) => value + (next() - 0.5) * array.size[k]!));
      const rotation = round3(base.rotation.map((value) => value + (next() * 2 - 1) * array.turn));
      const size = array.sizeFrom + next() * (array.sizeTo - array.sizeFrom);
      out.push({ position, rotation, scale: round3(base.scale.map((value) => value * Math.max(0.01, size))) });
    }
  }
  return out;
}

/** A placing mirrored left to right (x the other way; turned the other way about y and z). */
export function mirrored(placing: Placing): Placing {
  return { position: round3([-placing.position[0], placing.position[1], placing.position[2]]), rotation: round3([placing.rotation[0], -placing.rotation[1], -placing.rotation[2]]), scale: [...placing.scale] };
}
