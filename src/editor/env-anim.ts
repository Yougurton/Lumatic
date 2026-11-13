import { Matrix4, Quaternion, Vector3 } from 'three';
import { easingFromName } from '../engine/core/easing';
import { chromaRotation, dataRotation } from './env-scene';

/**
 * The scene's animation as the scene editor keeps it: keys on beats of the song — what a thing is at
 * that beat. Between two keys it goes from one to the other (the later key's easing says how). Before
 * the first key it is as it is set without animation; after the last it stays as the last key has it.
 *
 * What can be animated:
 * - an object ("o:<uid>" — an added one, or a game object's Chroma id): its place, turn and size, and —
 *   a lamp — how bright its colour is and how much it glows in the fog;
 * - a material ("m:<name>"): its colour;
 * - the fog ("fog"): its density, offset, lower edge and height;
 * - the player ("player"): where it stands and how it's turned.
 *
 * Written into the map as a track on the thing and one event a part: AnimateTrack (places, turns,
 * sizes, colours) or AnimateComponent (fog, lamps), from the first key to the last, the beats turned into
 * shares of that length.
 */
export type AnimPart = 'position' | 'rotation' | 'scale' | 'color' | 'attenuation' | 'offset' | 'startY' | 'height' | 'alpha' | 'bloom';
/** An object's place, turn and size. */
export const ANIM_PARTS: readonly AnimPart[] = ['position', 'rotation', 'scale'];
export const FOG_PARTS: readonly AnimPart[] = ['attenuation', 'offset', 'startY', 'height'];
export const TUBE_PARTS: readonly AnimPart[] = ['alpha', 'bloom'];
export const ALL_PARTS: readonly AnimPart[] = [...ANIM_PARTS, 'color', ...FOG_PARTS, ...TUBE_PARTS];
/** How many numbers a part's value has. */
export const PART_SIZE: Record<AnimPart, number> = { position: 3, rotation: 3, scale: 3, color: 4, attenuation: 1, offset: 1, startY: 1, height: 1, alpha: 1, bloom: 1 };
/** The parts written with AnimateComponent: the component and its field. */
const COMPONENT: Partial<Record<AnimPart, [string, string]>> = {
  attenuation: ['BloomFogEnvironment', 'attenuation'],
  offset: ['BloomFogEnvironment', 'offset'],
  startY: ['BloomFogEnvironment', 'startY'],
  height: ['BloomFogEnvironment', 'height'],
  alpha: ['TubeBloomPrePassLight', 'colorAlphaMultiplier'],
  bloom: ['TubeBloomPrePassLight', 'bloomFogIntensityMultiplier'],
};

export interface AnimKey {
  id: string;
  beat: number;
  value: number[];
  /** How it comes to this key from the one before (none: evenly). */
  easing?: string;
}

export interface SceneAnim {
  /** "o:<uid>", a game object's Chroma id, "m:<material>", "fog" or "player". */
  target: string;
  keys: Partial<Record<AnimPart, AnimKey[]>>;
  /** How many more times a part's keys play, one run after another (none: once). */
  repeat?: Partial<Record<AnimPart, number>>;
  /** Parts that go along a smooth curve through their keys (not straight from one to the next). */
  spline?: Partial<Record<AnimPart, boolean>>;
}

/** The parts a thing has (`tube`: an object that is a lamp). */
export function partsOf(target: string, tube = false): readonly AnimPart[] {
  if (target.startsWith('m:')) return ['color'];
  if (target === 'fog') return FOG_PARTS;
  if (target === 'player') return ['position', 'rotation'];
  return tube ? [...ANIM_PARTS, ...TUBE_PARTS] : ANIM_PARTS;
}

/** How many times a part plays in all. */
export const animRuns = (anim: SceneAnim | undefined, part: AnimPart) => 1 + Math.max(0, Math.round(anim?.repeat?.[part] ?? 0));

/** A turn from one key to the next that is half a round or more about an axis: the game would take it
 *  the short way (a whole round: not at all), so it is taken axis by axis instead. */
const longTurn = (from: readonly number[], to: readonly number[]) => from.some((value, k) => Math.abs((to[k] ?? 0) - value) >= 180 - 1e-6);

export const sortedKeys = (keys: readonly AnimKey[] | undefined) => [...(keys ?? [])].sort((a, b) => a.beat - b.beat);

/** Whether an animation has any key at all. */
export const hasKeys = (anim: SceneAnim | undefined) => anim !== undefined && ALL_PARTS.some((part) => (anim.keys[part] ?? []).length > 0);

const round = (value: number) => {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** The beats a part plays over: from its first key to its last, all its runs counted (null: no keys). */
export function partSpan(anim: SceneAnim | undefined, part: AnimPart): { from: number; to: number; length: number } | null {
  const keys = sortedKeys(anim?.keys[part]);
  const first = keys[0];
  if (first === undefined) return null;
  const length = keys[keys.length - 1]!.beat - first.beat;
  return { from: first.beat, to: first.beat + length * animRuns(anim, part), length };
}

/** A Catmull-Rom curve's point between b and c (a, d: the keys around them). */
const catmull = (a: number, b: number, c: number, d: number, t: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);

/** A part's value at a beat (null: before its first key, or it has none — the thing's own value). */
export function animValue(anim: SceneAnim | undefined, part: AnimPart, beat: number): number[] | null {
  const keys = sortedKeys(anim?.keys[part]);
  const first = keys[0];
  if (first === undefined || beat < first.beat - 1e-6) return null;
  // (played again and again: the beat is taken back into the first run)
  const length = keys[keys.length - 1]!.beat - first.beat;
  const runs = animRuns(anim, part);
  if (runs > 1 && length > 1e-9 && beat < first.beat + length * runs - 1e-6) beat = first.beat + ((beat - first.beat) % length);
  let at = 0;
  while (at + 1 < keys.length && keys[at + 1]!.beat <= beat + 1e-6) at++;
  const from = keys[at]!;
  const to = keys[at + 1];
  if (to === undefined || to.beat - from.beat < 1e-9) return [...from.value];
  const t = easingFromName(to.easing)(Math.min(1, Math.max(0, (beat - from.beat) / (to.beat - from.beat))));
  if (part === 'rotation' && !longTurn(from.value, to.value)) {
    // (turns go the short way round, as the game takes them)
    const a = new Quaternion().fromArray(dataRotation(from.value));
    const b = new Quaternion().fromArray(dataRotation(to.value));
    return chromaRotation(a.slerp(b, t).toArray());
  }
  if (anim?.spline?.[part] === true && part !== 'rotation') {
    const before = keys[at - 1] ?? from;
    const after = keys[at + 2] ?? to;
    return from.value.map((value, k) => round(catmull(before.value[k]!, value, to.value[k]!, after.value[k]!, t)));
  }
  return from.value.map((value, k) => round(value + ((to.value[k] ?? value) - value) * t));
}

/** The track an animated or linked thing is on. */
export function animTrack(target: string): string {
  if (target.startsWith('o:')) return `lumaticAnim_${target.slice(2).replace(/[^A-Za-z0-9_]/g, '_')}`;
  if (target === 'fog') return 'lumaticFog';
  if (target === 'player') return 'lumaticPlayer';
  let hash = 0;
  for (let i = 0; i < target.length; i++) hash = (Math.imul(hash, 31) + target.charCodeAt(i)) >>> 0;
  return `lumatic${target.startsWith('m:') ? 'Mat' : 'Anim'}_g${hash.toString(36)}`;
}

/** The track the motion of a parent's children is on (see `linkEvents`). */
export const linkTrack = (target: string) => animTrack(target).replace(/^lumatic(Anim)?/, 'lumaticLink');

/** A part's points as the map has them: values, then the share of the event's length, then flags. */
function partPoints(anim: SceneAnim, part: AnimPart, keys: AnimKey[], spanFrom: number, spanLength: number): (number | string)[][] {
  const share = (beat: number) => (spanLength <= 0 ? 0 : round((beat - spanFrom) / spanLength));
  const spline = anim.spline?.[part] === true && part !== 'rotation';
  const points: (number | string)[][] = [];
  keys.forEach((key, at) => {
    const before = keys[at - 1];
    if (part === 'rotation' && before !== undefined && longTurn(before.value, key.value) && key.beat > before.beat) {
      // (a long turn: points on the way — a quarter round apart at most, more when it's eased, the
      // easing being in where they stand)
      const most = Math.max(...key.value.map((value, k) => Math.abs(value - before.value[k]!)));
      const eased = key.easing !== undefined && key.easing !== 'easeLinear';
      const pieces = Math.max(Math.ceil(most / 90), eased ? 12 : 1);
      const ease = easingFromName(key.easing);
      for (let n = 1; n <= pieces; n++) {
        const t = ease(n / pieces);
        points.push([...key.value.map((value, k) => round(before.value[k]! + (value - before.value[k]!) * t)), share(before.beat + ((key.beat - before.beat) * n) / pieces)]);
      }
      return;
    }
    const flags = [...(at > 0 && key.easing !== undefined && key.easing !== 'easeLinear' ? [key.easing] : []), ...(spline ? ['splineCatmullRom'] : [])];
    points.push([...key.value.map(round), share(key.beat), ...flags]);
  });
  return points;
}

/**
 * The events of an animation, on `track`. `world`: the thing is placed in the world (a shape, the
 * player) — its place and turn are written as such; otherwise as its own (local) ones.
 */
export function animEvents(anim: SceneAnim, world: boolean, track = animTrack(anim.target)): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const names: Partial<Record<AnimPart, string>> = { position: world ? 'position' : 'localPosition', rotation: world ? 'rotation' : 'localRotation', scale: 'scale', color: 'color' };
  for (const part of ALL_PARTS) {
    const keys = sortedKeys(anim.keys[part]);
    const first = keys[0];
    const span = partSpan(anim, part);
    if (first === undefined || span === null) continue;
    const runs = animRuns(anim, part);
    const component = COMPONENT[part];
    if (component === undefined) {
      const points = partPoints(anim, part, keys, first.beat, span.length);
      out.push({ b: round(first.beat), t: 'AnimateTrack', d: { track, duration: round(span.length), ...(runs > 1 && span.length > 0 ? { repeat: runs - 1 } : {}), [names[part]!]: span.length <= 0 ? [points[0]!] : points } });
      continue;
    }
    // (AnimateComponent has no repeat: the runs written one after another)
    const total = span.to - span.from;
    const all = runs > 1 && span.length > 0 ? Array.from({ length: runs }, (_, run) => keys.map((key) => ({ ...key, beat: key.beat + span.length * run }))).flat() : keys;
    const points = partPoints(anim, part, all, first.beat, total);
    out.push({ b: round(first.beat), t: 'AnimateComponent', d: { track, duration: round(total), [component[0]]: { [component[1]]: total <= 0 ? [points[0]!] : points } } });
  }
  return out;
}

export interface Placing {
  position: readonly number[];
  rotation: readonly number[];
  scale: readonly number[];
}

/** A place, turn and size (Chroma's numbers) as a matrix of the 3D view's space. */
export function placingMatrix(placing: Placing): Matrix4 {
  return new Matrix4().compose(new Vector3(placing.position[0], placing.position[1], -(placing.position[2] ?? 0)), new Quaternion().fromArray(dataRotation(placing.rotation)), new Vector3().fromArray(placing.scale as number[]));
}

/**
 * How far a parent has gone from where it stands without animation, at a beat — the motion its
 * children are carried along by (the 3D view's space; null: it hasn't moved). `outer`: where the space
 * its own values are in stands (the world: none).
 */
export function linkDelta(anim: SceneAnim | undefined, base: Placing, beat: number, outer?: Matrix4): Matrix4 | null {
  if (anim === undefined) return null;
  const values = ANIM_PARTS.map((part) => animValue(anim, part, beat));
  if (values.every((value) => value === null)) return null;
  const now = placingMatrix({ position: values[0] ?? base.position, rotation: values[1] ?? base.rotation, scale: values[2] ?? base.scale });
  const delta = now.multiply(placingMatrix(base).invert());
  return outer === undefined ? delta : outer.clone().multiply(delta).multiply(outer.clone().invert());
}

/**
 * A parent's motion written onto the track its children hang on (`linkTrack`): sampled — a quarter of a
 * beat apart, and on every key — as places, turns and sizes from where it stands. Its children (put on
 * that track with AssignTrackParent, keeping where they stand) go along with it.
 */
export function linkEvents(anim: SceneAnim | undefined, base: Placing, track: string, outer?: Matrix4): Record<string, unknown>[] {
  if (anim === undefined) return [];
  const spans = ANIM_PARTS.map((part) => partSpan(anim, part)).filter((span) => span !== null);
  if (spans.length === 0) return [];
  const from = Math.min(...spans.map((span) => span.from));
  const to = Math.max(...spans.map((span) => span.to));
  const beats = new Set<number>();
  const step = Math.max(0.25, (to - from) / 400);
  for (let beat = from; beat < to; beat += step) beats.add(round(beat));
  beats.add(round(to));
  for (const part of ANIM_PARTS) for (const key of anim.keys[part] ?? []) if (key.beat >= from && key.beat <= to) beats.add(round(key.beat));
  const sorted = [...beats].sort((a, b) => a - b);
  const length = to - from;
  const position: number[][] = [];
  const rotation: number[][] = [];
  const scale: number[][] = [];
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  for (const beat of sorted) {
    const delta = linkDelta(anim, base, beat, outer) ?? new Matrix4();
    delta.decompose(p, q, s);
    const share = length <= 0 ? 0 : round((beat - from) / length);
    position.push([round(p.x), round(p.y), round(-p.z), share]);
    rotation.push([...chromaRotation(q.toArray()), share]);
    scale.push([round(s.x), round(s.y), round(s.z), share]);
  }
  const one = length <= 0;
  return [{ b: round(from), t: 'AnimateTrack', d: { track, duration: round(length), position: one ? [position[0]!] : position, rotation: one ? [rotation[0]!] : rotation, scale: one ? [scale[0]!] : scale } }];
}

/** An animation moved over to one of an array's others: as far aside, as much more turned, as many
 *  times bigger as that one is from the object itself. */
export function offsetAnim(anim: SceneAnim, base: Placing, other: Placing, target: string): SceneAnim {
  const out: SceneAnim = { ...structuredClone(anim), target, keys: {} };
  for (const part of ALL_PARTS) {
    const keys = anim.keys[part];
    if (keys === undefined) continue;
    out.keys[part] = keys.map((key) => {
      const value = key.value.map((number, k) => {
        if (part === 'position' || part === 'rotation') return round(number + (other[part][k]! - base[part][k]!));
        if (part === 'scale') return Math.abs(base.scale[k]!) < 1e-9 ? number : round((number * other.scale[k]!) / base.scale[k]!);
        return number;
      });
      return { ...key, value };
    });
  }
  return out;
}
