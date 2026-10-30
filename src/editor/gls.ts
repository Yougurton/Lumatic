import type { SchemeColors } from './bake';
import { resolveRgb } from './bake';
import { newId, type ClipColor, type LightClip, type RawEvent, type Rgb } from './model';

/**
 * A Group Lighting System block for the classic environments — Beat Saber's v3 "event box groups"
 * (https://beatsaber.com/documentation/the-group-lighting-event-system/) made out of plain light
 * events with Chroma light IDs, so it plays on every environment.
 *
 * Like the game's: a block on a group holds boxes, each picking some of the group's elements with
 * a filter (sections, or step and offset; reversed, in chunks, at random, limited), spreading its
 * events over them in time (wave / step) and in brightness (wave / step, eased, the first event
 * too or not), and carrying its own lane of events — instant, fade (transition), extend; a colour, a
 * brightness, a strobe. Where boxes pick the same element, the upper box wins. Rotation boxes turn
 * the rings (Chroma ring events: an angle, loops, a direction, spread over the rings as a step, the
 * wave as propagation, the easing as speed) — the classic environments' lasers can't be posed.
 *
 * The group's elements are its own items in their order: its subgroups (rings, lines, pairs) or its
 * lights — or, on an event type's row, that type's lights by ID.
 */

export type GlsTransition = 'instant' | 'fade' | 'extend';
export type GlsEasing = 'none' | 'linear' | 'inQuad' | 'outQuad' | 'inOutQuad';
export type GlsSpread = 'wave' | 'step';

export interface GlsColorEvent {
  id: string;
  /** Beats from the block's start. */
  beat: number;
  transition: GlsTransition;
  color: ClipColor;
  /** 0…(about 1.2). */
  brightness: number;
  /** Flashes per beat (0: none). */
  strobe: number;
}

export interface GlsRotationEvent {
  id: string;
  beat: number;
  /** How far the rings turn (degrees). */
  angle: number;
  /** Whole turns on top. */
  loops: number;
  direction: 'cw' | 'ccw';
  easing: GlsEasing;
}

export interface GlsFilter {
  type: 'division' | 'step';
  /** division: how many sections, and which one (from 0). */
  sections: number;
  section: number;
  /** step: every `step`-th element from `offset` (step 0: that one only). */
  step: number;
  offset: number;
  reverse: boolean;
  /** Elements taken together in this many chunks (0: each on its own). */
  chunks: number;
  random: 'none' | 'shuffle' | 'pick';
  seed: number;
  /** The share of the picked elements kept (1: all). */
  limit: number;
}

export interface GlsBox {
  id: string;
  kind: 'color' | 'rotation';
  filter: GlsFilter;
  /** Time spread: wave — the whole spread across the elements; step — per element. */
  beatSpread: GlsSpread;
  beatValue: number;
  /** Brightness (colour boxes) or angle (rotation boxes) spread. */
  valueSpread: GlsSpread;
  value: number;
  affectFirst: boolean;
  easing: GlsEasing;
  events: GlsColorEvent[];
  rotations: GlsRotationEvent[];
  /** rotation boxes: which ring system (Chroma nameFilter; empty: all). */
  rings: string;
}

export interface GlsData {
  boxes: GlsBox[];
}

export function defaultFilter(): GlsFilter {
  return { type: 'division', sections: 1, section: 0, step: 1, offset: 0, reverse: false, chunks: 0, random: 'none', seed: 1, limit: 1 };
}

export function newColorBox(color: ClipColor): GlsBox {
  return {
    id: newId('b'),
    kind: 'color',
    filter: defaultFilter(),
    beatSpread: 'wave',
    beatValue: 1,
    valueSpread: 'wave',
    value: 0,
    affectFirst: false,
    easing: 'linear',
    events: [
      { id: newId('v'), beat: 0, transition: 'instant', color: { ...color }, brightness: 1, strobe: 0 },
      { id: newId('v'), beat: 1, transition: 'fade', color: { ...color }, brightness: 0, strobe: 0 },
    ],
    rotations: [],
    rings: '',
  };
}

export function newRotationBox(): GlsBox {
  return {
    id: newId('b'),
    kind: 'rotation',
    filter: defaultFilter(),
    beatSpread: 'wave',
    beatValue: 1,
    valueSpread: 'wave',
    value: 90,
    affectFirst: true,
    easing: 'outQuad',
    events: [],
    rotations: [{ id: newId('v'), beat: 0, angle: 90, loops: 0, direction: 'cw', easing: 'outQuad' }],
    rings: '',
  };
}

export function defaultGls(color: ClipColor): GlsData {
  return { boxes: [newColorBox(color)] };
}

export function ease(kind: GlsEasing, t: number) {
  const x = Math.min(1, Math.max(0, t));
  if (kind === 'none') return x >= 1 ? 1 : 0;
  if (kind === 'inQuad') return x * x;
  if (kind === 'outQuad') return 1 - (1 - x) * (1 - x);
  if (kind === 'inOutQuad') return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
  return x;
}

function seeded(seed: number) {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/**
 * The elements a box picks, as units in the order its events spread over them (a unit: one element,
 * or a chunk of them taken together).
 */
export function filterUnits(filter: GlsFilter, count: number): number[][] {
  let units: number[][] = [];
  if (filter.chunks > 0 && filter.chunks < count) {
    for (let c = 0; c < filter.chunks; c++) {
      const from = Math.floor((c * count) / filter.chunks);
      const to = Math.floor(((c + 1) * count) / filter.chunks);
      if (to > from) units.push(Array.from({ length: to - from }, (_, i) => from + i));
    }
  } else units = Array.from({ length: count }, (_, i) => [i]);
  if (filter.reverse) units.reverse();
  const n = units.length;
  let picked: number[][];
  if (filter.type === 'division') {
    const sections = Math.max(1, Math.round(filter.sections));
    const section = Math.min(sections - 1, Math.max(0, Math.round(filter.section)));
    picked = units.slice(Math.floor((section * n) / sections), Math.floor(((section + 1) * n) / sections));
  } else {
    const offset = Math.max(0, Math.round(filter.offset));
    const step = Math.max(0, Math.round(filter.step));
    picked = [];
    if (step === 0) {
      if (units[offset] !== undefined) picked.push(units[offset]);
    } else for (let i = offset; i < n; i += step) picked.push(units[i]!);
  }
  const keep = Math.max(picked.length === 0 ? 0 : 1, Math.ceil(Math.min(1, Math.max(0, filter.limit)) * picked.length));
  if (filter.random === 'none') return picked.slice(0, keep);
  const next = seeded(filter.seed);
  const shuffled = picked.map((unit, index) => ({ unit, index, value: next() })).sort((a, b) => a.value - b.value);
  if (filter.random === 'shuffle') return shuffled.slice(0, keep).map((entry) => entry.unit);
  // pick: a random few, kept in their own order
  return shuffled
    .slice(0, keep)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.unit);
}

/** Time and value spread for the k-th of m units. */
function spreadOf(mode: GlsSpread, value: number, k: number, m: number, easing: GlsEasing | null, last: boolean) {
  if (mode === 'step') return value * k;
  const fraction = last ? (m > 1 ? k / (m - 1) : 0) : m > 0 ? k / m : 0;
  return value * (easing === null ? fraction : ease(easing, fraction));
}

interface Frame {
  beat: number;
  transition: GlsTransition;
  color: ClipColor;
  brightness: number;
  strobe: number;
}

function mix(a: ClipColor, b: ClipColor, t: number, scheme: SchemeColors): ClipColor {
  if (a.ref === b.ref && a.ref !== 'custom') return { ref: a.ref, brightness: 1 };
  const from = resolveRgb(a, scheme);
  const to = resolveRgb(b, scheme);
  const rgb: Rgb = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
  return { ref: 'custom', rgb, brightness: 1 };
}

const withBrightness = (color: ClipColor, brightness: number): ClipColor => ({ ...color, ...(color.rgb === undefined ? {} : { rgb: [...color.rgb] as Rgb }), brightness: Math.max(0, brightness) });

/**
 * One element's light from a box's frames (beats absolute): clips, ending at `end` (where the block
 * ends, the light goes back to what is under it).
 */
function framesToClips(frames: Frame[], end: number, scheme: SchemeColors, make: (start: number, stop: number) => LightClip): LightClip[] {
  const out: LightClip[] = [];
  // extend: holds what was before until here (a fade after it starts from here)
  const resolved: Frame[] = [];
  for (const frame of frames) {
    // (a fade that arrives right at the block's end still counts: the light gets there as it ends)
    if (frame.beat > end + 1e-6 || (frame.beat >= end - 1e-6 && frame.transition !== 'fade')) break;
    const previous = resolved.at(-1);
    if (frame.transition === 'extend') {
      if (previous !== undefined) resolved.push({ ...previous, beat: frame.beat, transition: 'instant' });
    } else resolved.push(frame);
  }
  for (let j = 0; j < resolved.length; j++) {
    const frame = resolved[j]!;
    const next = resolved[j + 1];
    const stop = next?.beat ?? end;
    if (stop - frame.beat < 1e-6) continue;
    const fadesIn = next !== undefined && next.transition === 'fade';
    const b0 = frame.brightness;
    const b1 = fadesIn ? next.brightness : b0;
    if (b0 <= 0 && b1 <= 0) continue;
    if (frame.strobe > 0) {
      // strobe: on and off at its rate (fading along if the next event fades)
      const period = 1 / frame.strobe;
      for (let t = frame.beat; t < stop - 1e-6; t += period) {
        const share = (t - frame.beat) / Math.max(1e-6, stop - frame.beat);
        const brightness = b0 + (b1 - b0) * share;
        if (brightness <= 0.001) continue;
        const color = fadesIn ? mix(frame.color, next.color, share, scheme) : frame.color;
        const clip = make(t, Math.min(stop, t + period / 2));
        clip.color = withBrightness(color, brightness);
        clip.startMode = 'on';
        clip.endMode = 'off';
        out.push(clip);
      }
      continue;
    }
    const clip = make(frame.beat, stop);
    const isLast = next === undefined;
    if (b0 <= 0) {
      // up out of the dark
      clip.startMode = 'fadeIn';
      clip.fadeIn = stop - frame.beat;
      clip.color = withBrightness(next!.color, b1);
      clip.endMode = 'stay';
    } else {
      clip.startMode = 'on';
      clip.color = withBrightness(frame.color, b0);
      if (fadesIn) {
        if (b1 <= 0) {
          clip.endMode = 'fade';
          const sameColor = next.color.ref === frame.color.ref && next.color.ref !== 'custom';
          if (!sameColor) clip.endColor = withBrightness(next.color, b0);
        } else {
          clip.endColor = withBrightness(next.color, b1);
          clip.endMode = 'stay';
        }
      } else clip.endMode = isLast ? 'off' : next.brightness > 0 ? 'stay' : 'off';
    }
    out.push(clip);
  }
  return out;
}

export interface GlsContext {
  scheme: SchemeColors;
  /** How many elements the block's target has, and what each is (for clip targets). */
  items: number;
  makeClip: (item: number, start: number, end: number) => LightClip;
  /** Rings per ring system, for rotation boxes (name → count; '' : all). */
  ringCount: (system: string) => number;
  secondsPerBeat: number;
}

/**
 * How long the block has to be for all its boxes' events to fit (beats): each element's last event
 * where the time spread puts it, a ring turn's beat (and a hair, so it's inside).
 */
export function glsNeededLength(data: GlsData, items: number): number {
  let needed = 0;
  for (const box of data.boxes) {
    if (box.kind === 'color') {
      const last = Math.max(0, ...box.events.map((event) => event.beat));
      if (box.events.length === 0) continue;
      const m = filterUnits(box.filter, items).length;
      for (let k = 0; k < m; k++) needed = Math.max(needed, spreadOf(box.beatSpread, box.beatValue, k, m, null, false) + last);
    } else if (box.rotations.length > 0) needed = Math.max(needed, Math.max(...box.rotations.map((event) => event.beat)) + 1 / 64);
  }
  return needed;
}

/** The block's events: light clips for its colour boxes, ring events for its rotation boxes. */
export function generateGls(data: GlsData, start: number, end: number, context: GlsContext): { clips: LightClip[]; raw: Omit<RawEvent, 'id'>[] } {
  const clips: LightClip[] = [];
  const raw: Omit<RawEvent, 'id'>[] = [];
  // which box each element listens to: the uppermost that picks it
  const owner = new Map<number, { box: GlsBox; k: number; m: number }>();
  for (const box of data.boxes) {
    if (box.kind !== 'color') continue;
    const units = filterUnits(box.filter, context.items);
    units.forEach((unit, k) => {
      for (const item of unit) if (!owner.has(item)) owner.set(item, { box, k, m: units.length });
    });
  }
  for (const [item, { box, k, m }] of owner) {
    const offset = spreadOf(box.beatSpread, box.beatValue, k, m, null, false);
    const extra = spreadOf(box.valueSpread, box.value, k, m, box.easing, true);
    const events = [...box.events].sort((a, b) => a.beat - b.beat);
    const frames: Frame[] = events.map((event, index) => ({
      beat: start + offset + event.beat,
      transition: event.transition,
      color: event.color,
      brightness: Math.max(0, event.brightness + (index === 0 && !box.affectFirst ? 0 : extra)),
      strobe: event.strobe,
    }));
    clips.push(...framesToClips(frames, end, context.scheme, (from, to) => context.makeClip(item, from, to)));
  }
  for (const box of data.boxes) {
    if (box.kind !== 'rotation') continue;
    const rings = Math.max(1, context.ringCount(box.rings));
    const events = [...box.rotations].sort((a, b) => a.beat - b.beat);
    events.forEach((event, index) => {
      const at = start + event.beat;
      if (at >= end - 1e-6) return;
      const spread = box.valueSpread === 'wave' ? box.value / Math.max(1, rings - 1) : box.value;
      const step = index === 0 && !box.affectFirst ? 0 : spread;
      // the wave: how fast the turn passes from ring to ring (rings per 20 ms)
      const waveBeats = box.beatSpread === 'wave' ? box.beatValue : box.beatValue * rings;
      const waveSeconds = waveBeats * context.secondsPerBeat;
      const prop = waveSeconds <= 0.02 ? 50 : Math.min(50, Math.max(0.05, rings / (waveSeconds / 0.02)));
      // the easing: how fast each ring gets there (until the next turn, or 2 beats)
      const nextBeat = events[index + 1]?.beat;
      const span = Math.max(0.25, (nextBeat === undefined ? 2 : nextBeat - event.beat) * context.secondsPerBeat);
      const speed = event.easing === 'none' ? 50 : Math.min(50, Math.max(0.3, (event.easing === 'linear' ? 2.2 : event.easing === 'inQuad' ? 1.6 : 3.5) / span));
      const customData: Record<string, unknown> = {
        rotation: event.angle + event.loops * 360,
        step,
        prop: Math.round(prop * 1000) / 1000,
        speed: Math.round(speed * 1000) / 1000,
        direction: event.direction === 'cw' ? 0 : 1,
      };
      if (box.rings !== '') customData.nameFilter = box.rings;
      raw.push({ beat: Math.round(at * 10000) / 10000, type: 8, value: 0, floatValue: 1, customData });
    });
  }
  return { clips, raw };
}
