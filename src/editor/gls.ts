import type { SchemeColors } from './bake';
import { resolveRgb } from './bake';
import { newId, type ClipColor, type EndMode, type LightClip, type RawEvent, type Rgb, type StartMode } from './model';
import { ringPropFor } from '../engine/core/lighting/ring-motion';

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

/**
 * A box's event as the timeline's clips are (since 0.19): lit from `start` to `end` (beats from the
 * block's start) — its colour and brightness, a gradient to `endColor`, how it comes on (on, a flash,
 * the game's fade, up from the dark over `fadeIn`) and goes (off, fading out, staying lit), and a
 * strobe over it (flashes per beat).
 */
export interface GlsBlock {
  id: string;
  start: number;
  end: number;
  color: ClipColor;
  endColor: ClipColor | null;
  startMode: StartMode;
  fadeIn: number;
  endMode: EndMode;
  fadeOut?: number;
  hsv?: boolean;
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
  /** division / step: as the game's; custom: the elements picked by hand (`elements`). */
  type: 'division' | 'step' | 'custom';
  /** custom: the elements (their numbers, from 0). */
  elements?: number[];
  /** The order the events go over the picked ones: as they are (or reversed, `reverse`), from the
   *  middle out, or from the edges in — the two of a pair at once. */
  order?: 'line' | 'outward' | 'inward';
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
  /** The box's events as points (before 0.19; made into `blocks` when the block is opened). */
  events: GlsColorEvent[];
  /** Its events as clips (colour boxes; when there, `events` aren't used). */
  blocks?: GlsBlock[];
  /** Boxes with one link share their events (blocks): a change to one is made to all. */
  link?: string;
  rotations: GlsRotationEvent[];
  /** rotation boxes: which ring system (Chroma nameFilter; empty: all). */
  rings: string;
}

export interface GlsData {
  /** The boxes on the block's own group. */
  boxes: GlsBox[];
  /** More groups the block runs over, each with its own boxes (the timing shared). */
  lanes?: GlsLane[];
}

/** One more group a GLS block runs over: what it is (as an effect's target) and its boxes. */
export interface GlsLane {
  id: string;
  target?: string;
  /** In a preset: the target group's name (to find it in another map). */
  targetName?: string;
  type: number;
  ids: number[] | null;
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
    events: [],
    blocks: [{ id: newId('v'), start: 0, end: 1, color: { ...color, brightness: 1 }, endColor: null, startMode: 'on', fadeIn: 0.25, endMode: 'fade', strobe: 0 }],
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
  if (filter.type === 'custom') {
    const wanted = new Set(filter.elements ?? []);
    picked = units.filter((unit) => unit.some((item) => wanted.has(item))).map((unit) => unit.filter((item) => wanted.has(item)));
  } else if (filter.type === 'division') {
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
  if (filter.order === 'outward' || filter.order === 'inward') picked = fromMiddle(picked, filter.order === 'inward');
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

/** Units ordered from the middle out (or the edges in): the two at one distance from it together. */
function fromMiddle(units: number[][], inward: boolean): number[][] {
  const n = units.length;
  const out: number[][] = [];
  if (n % 2 === 1) out.push(units[(n - 1) / 2]!);
  for (let i = n % 2 === 1 ? 1 : 0; ; i++) {
    const left = n % 2 === 1 ? (n - 1) / 2 - i : n / 2 - 1 - i;
    const right = n % 2 === 1 ? (n - 1) / 2 + i : n / 2 + i;
    if (left < 0) break;
    out.push([...units[left]!, ...units[right]!]);
  }
  return inward ? out.reverse() : out;
}

/**
 * The simplest filter that picks just these elements (of `count`, no chunks): all, a section, every
 * n-th from one, one alone — or, when none does, those by hand. Its order and the rest kept.
 */
export function filterFor(elements: number[], count: number, base: GlsFilter): GlsFilter {
  const picked = [...new Set(elements)].filter((item) => item >= 0 && item < count).sort((a, b) => a - b);
  const keep: GlsFilter = { ...base, chunks: 0, limit: 1, random: base.random === 'pick' ? 'none' : base.random, elements: undefined };
  const same = (filter: GlsFilter) => {
    const got = filterUnits({ ...filter, reverse: false, order: 'line', random: 'none', limit: 1 }, count).flat().sort((a, b) => a - b);
    return got.length === picked.length && got.every((item, index) => item === picked[index]);
  };
  if (picked.length === 0) return { ...keep, type: 'custom', elements: [] };
  if (picked.length === 1 && count > 1) return { ...keep, type: 'step', step: 0, offset: picked[0]! };
  for (let sections = 1; sections <= Math.min(8, count); sections++) {
    for (let section = 0; section < sections; section++) {
      const filter: GlsFilter = { ...keep, type: 'division', sections, section };
      if (same(filter)) return filter;
    }
  }
  for (let step = 0; step <= Math.min(8, count); step++) {
    for (let offset = 0; offset < Math.min(count, step === 0 ? count : step); offset++) {
      const filter: GlsFilter = { ...keep, type: 'step', step, offset };
      if (same(filter)) return filter;
    }
  }
  return { ...keep, type: 'custom', elements: picked };
}

/** Time and value spread for the k-th of m units. */
export function spreadOf(mode: GlsSpread, value: number, k: number, m: number, easing: GlsEasing | null, last: boolean) {
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
function framesToClips(frames: Frame[], end: number, scheme: SchemeColors, make: (start: number, stop: number) => LightClip, strobes?: Map<LightClip, number>): LightClip[] {
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
    if (frame.strobe > 0 && strobes === undefined) {
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
    if (frame.strobe > 0) strobes?.set(clip, frame.strobe);
    out.push(clip);
  }
  return out;
}

/**
 * A box's point events (before 0.19) as blocks: the light they make, clip by clip (within the block's
 * `length`), each clip a block — the same light.
 */
export function pointsToBlocks(events: GlsColorEvent[], length: number, scheme: SchemeColors): GlsBlock[] {
  const frames: Frame[] = [...events]
    .sort((a, b) => a.beat - b.beat)
    .map((event) => ({ beat: event.beat, transition: event.transition, color: event.color, brightness: event.brightness, strobe: event.strobe }));
  const strobes = new Map<LightClip, number>();
  const clips = framesToClips(frames, Math.max(length, ...events.map((event) => event.beat)), scheme, (start, stop) => ({ id: '', type: 0, ids: null, start, end: stop, startMode: 'on', fadeIn: 0.25, endMode: 'off', color: { ref: 'left', brightness: 1 }, endColor: null, layer: 0 }), strobes);
  return clips.map((clip) => ({
    id: newId('v'),
    start: Math.round(clip.start * 1e6) / 1e6,
    end: Math.round(clip.end * 1e6) / 1e6,
    color: clip.color,
    endColor: clip.endColor,
    startMode: clip.startMode,
    fadeIn: clip.fadeIn,
    endMode: clip.endMode,
    strobe: strobes.get(clip) ?? 0,
  }));
}

/** A box's blocks (its points made into blocks when it has none yet). */
export function boxBlocks(box: GlsBox, length: number, scheme: SchemeColors): GlsBlock[] {
  return box.blocks ?? pointsToBlocks(box.events, length, scheme);
}

/** A colour a little brighter (or dimmer): the brightness spread. */
const brighter = (color: ClipColor, extra: number): ClipColor => ({ ...color, ...(color.rgb === undefined ? {} : { rgb: [...color.rgb] as Rgb }), brightness: Math.max(0, color.brightness + extra) });

/** One element's clips from a box's blocks: moved on by `offset`, brighter by `extra`, cut at `end`. */
function blocksToClips(blocks: GlsBlock[], affectFirst: boolean, offset: number, extra: number, start: number, end: number, scheme: SchemeColors, make: (from: number, to: number) => LightClip): LightClip[] {
  const out: LightClip[] = [];
  [...blocks]
    .sort((a, b) => a.start - b.start)
    .forEach((block, index) => {
      const from = start + offset + block.start;
      const to = Math.min(end, start + offset + block.end);
      if (to - from < 1e-6) return;
      const add = index === 0 && !affectFirst ? 0 : extra;
      const color = brighter(block.color, add);
      const endColor = block.endColor === null ? null : brighter(block.endColor, add);
      const cut = to < start + offset + block.end - 1e-6;
      if (block.strobe > 0) {
        // a strobe: on and off at its rate (through the gradient, if it has one)
        const period = 1 / block.strobe;
        for (let t = from; t < to - 1e-6; t += period) {
          const share = (t - from) / Math.max(1e-6, block.end - block.start);
          const fading = block.endMode === 'fade' ? 1 - share : 1;
          const clip = make(t, Math.min(to, t + period / 2));
          const c = endColor === null ? color : mix(color, endColor, share, scheme);
          clip.color = { ...c, brightness: (color.brightness + ((endColor?.brightness ?? color.brightness) - color.brightness) * share) * fading };
          if (clip.color.brightness <= 0.001) continue;
          clip.startMode = 'on';
          clip.endMode = 'off';
          out.push(clip);
        }
        return;
      }
      const clip = make(from, to);
      clip.color = color;
      clip.endColor = endColor;
      clip.startMode = block.startMode;
      clip.fadeIn = block.fadeIn;
      clip.endMode = cut ? 'off' : block.endMode;
      if (block.fadeOut !== undefined) clip.fadeOut = block.fadeOut;
      if (block.hsv === true) clip.hsv = true;
      out.push(clip);
    });
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
      const last = box.blocks !== undefined ? Math.max(0, ...box.blocks.map((block) => block.start + 1 / 64)) : Math.max(0, ...box.events.map((event) => event.beat));
      if ((box.blocks ?? box.events).length === 0) continue;
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
    if (box.blocks !== undefined) {
      clips.push(...blocksToClips(box.blocks, box.affectFirst, offset, extra, start, end, context.scheme, (from, to) => context.makeClip(item, from, to)));
      continue;
    }
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
      const prop = ringPropFor(rings, waveSeconds, 0.05);
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
