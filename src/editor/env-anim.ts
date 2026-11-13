import { Quaternion } from 'three';
import { easingFromName } from '../engine/core/easing';
import { chromaRotation, dataRotation } from './env-scene';

/**
 * An object's animation as the scene editor keeps it: keys on beats of the song — where the object
 * stands, how it's turned, how big it is at that beat. Between two keys it goes from one to the other
 * (the later key's easing says how). Before the first key it stands as it is set without animation;
 * after the last it stays as the last key has it.
 *
 * Written into the map as a track on the object and one AnimateTrack event a part (from the first key
 * to the last, the beats turned into shares of that length).
 */
export type AnimPart = 'position' | 'rotation' | 'scale';
export const ANIM_PARTS: readonly AnimPart[] = ['position', 'rotation', 'scale'];

export interface AnimKey {
  id: string;
  beat: number;
  value: [number, number, number];
  /** How it comes to this key from the one before (none: evenly). */
  easing?: string;
}

export interface SceneAnim {
  /** "o:<uid>": an added object; otherwise a game object's Chroma id. */
  target: string;
  keys: Partial<Record<AnimPart, AnimKey[]>>;
  /** How many more times a part's keys play, one run after another (none: once). */
  repeat?: Partial<Record<AnimPart, number>>;
}

/** How many times a part plays in all. */
export const animRuns = (anim: SceneAnim | undefined, part: AnimPart) => 1 + Math.max(0, Math.round(anim?.repeat?.[part] ?? 0));

/** A turn from one key to the next that is half a round or more about an axis: the game would take it
 *  the short way (a whole round: not at all), so it is taken axis by axis instead. */
const longTurn = (from: readonly number[], to: readonly number[]) => from.some((value, k) => Math.abs(to[k]! - value) >= 180 - 1e-6);

export const sortedKeys = (keys: readonly AnimKey[] | undefined) => [...(keys ?? [])].sort((a, b) => a.beat - b.beat);

/** Whether an animation has any key at all. */
export const hasKeys = (anim: SceneAnim | undefined) => anim !== undefined && ANIM_PARTS.some((part) => (anim.keys[part] ?? []).length > 0);

const round = (value: number) => {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** A part's value at a beat (null: before its first key, or it has none — the object's own value). */
export function animValue(anim: SceneAnim | undefined, part: AnimPart, beat: number): [number, number, number] | null {
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
  return [0, 1, 2].map((k) => round(from.value[k]! + (to.value[k]! - from.value[k]!) * t)) as [number, number, number];
}

/** The track an animated thing is on. */
export function animTrack(target: string): string {
  if (target.startsWith('o:')) return `lumaticAnim_${target.slice(2)}`;
  let hash = 0;
  for (let i = 0; i < target.length; i++) hash = (Math.imul(hash, 31) + target.charCodeAt(i)) >>> 0;
  return `lumaticAnim_g${hash.toString(36)}`;
}

/**
 * The AnimateTrack events of an animation. `world`: the thing is placed in the world (a shape) — its
 * place and turn are written as such; otherwise as its own (local) ones.
 */
export function animEvents(anim: SceneAnim, world: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const names: Record<AnimPart, string> = world ? { position: 'position', rotation: 'rotation', scale: 'scale' } : { position: 'localPosition', rotation: 'localRotation', scale: 'scale' };
  for (const part of ANIM_PARTS) {
    const keys = sortedKeys(anim.keys[part]);
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (first === undefined || last === undefined) continue;
    const length = last.beat - first.beat;
    const share = (beat: number) => (length <= 0 ? 0 : round((beat - first.beat) / length));
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
      points.push([...key.value.map(round), share(key.beat), ...(at > 0 && key.easing !== undefined && key.easing !== 'easeLinear' ? [key.easing] : [])]);
    });
    const runs = animRuns(anim, part);
    out.push({ b: round(first.beat), t: 'AnimateTrack', d: { track: animTrack(anim.target), duration: round(length), ...(runs > 1 && length > 0 ? { repeat: runs - 1 } : {}), [names[part]]: length <= 0 ? [points[0]!] : points } });
  }
  return out;
}
