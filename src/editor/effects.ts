import { lerpHsv, resolveRgb, shiftHue, type SchemeColors } from './bake';
import { generateGls, type GlsData } from './gls';
import { newId, type ClipColor, type EndMode, type LightClip, type LightGroup, type RawEvent, type Rgb, type StartMode } from './model';

/**
 * Effects: one event on the timeline that lights a group's lights (or subgroups) one after another
 * — a wave, a fill, a strobe, a gradient, a twinkle. The effect keeps its settings and makes its
 * events from them (the "children": ordinary light clips that carry `group` = the effect's id), so
 * changing a setting, stretching or moving it, or putting it on another group makes them anew. Its
 * events can be gone into and changed by hand; from then on it keeps them (`custom`), moving and
 * stretching them with it.
 *
 * The things it goes through are the group's own items in their order (its subgroups — rings,
 * lines — or its lights); on an event type's row, that type's lights by ID.
 */

export type EffectKind = 'wave' | 'fill' | 'strobe' | 'gradient' | 'twinkle' | 'fire' | 'gls';
/** fire: how its light goes over its time — coming up, dying down, or just burning. */
export type FireShape = 'rise' | 'fall' | 'steady';
export type Direction = 'forward' | 'backward' | 'outward' | 'inward' | 'pingpong';
export type StrobePattern = 'all' | 'alternate' | 'sequence';

export interface EffectParams {
  color: ClipColor;
  /** wave / fill / gradient: the colour the last item gets (a gradient across them); strobe: every
   *  other flash. */
  color2: ClipColor | null;
  hsv: boolean;
  startMode: StartMode;
  endMode: EndMode;
  fadeIn: number;
  /** wave: how long each item stays lit; fill: how long the filling takes (beats). */
  pulse: number;
  /** wave: beats from one item's flash to the next one's (none / 0: spread over the effect's length). */
  spacing?: number;
  /** wave: how many times it runs through. */
  repeats: number;
  direction: Direction;
  /** strobe / twinkle: beats from one flash to the next. */
  rate: number;
  /** strobe / twinkle: how much of that it stays lit (0…1). */
  duty: number;
  pattern: StrobePattern;
  /** twinkle: the share of items lit each time. */
  density: number;
  seed: number;
  /** fire: coming up, dying down or burning on (older effects: none). */
  shape?: FireShape;
  /** fire: how low it goes (its share of the brightness: where it starts coming up from, dies down
   *  to). */
  floor?: number;
  /** fire: how much it trembles (a share of the brightness it has at the time). */
  tremor?: number;
  /** fire: trembling at random like a flame, or swaying evenly like a singer's vibrato — `rate` beats
   *  a sway, down by `tremor` and back. */
  wobble?: 'flame' | 'vibrato';
  /** vibrato: how far behind each next item sways (a share of a sway: 0 — all together). */
  vibratoLag?: number;
  /** vibrato: how far the hue sways either way with it (degrees). */
  vibratoHue?: number;
  /** endMode fade: the beats each flash's fade out takes (none / 0: all of it). */
  fadeOut?: number;
  /** Its colours turned round the hue circle (degrees)… */
  hueShift?: number;
  /** …and each next one further by this much (degrees): the next item, or the next flash in time. */
  hueStep?: number;
  hueBy?: 'item' | 'time';
}

export interface Effect {
  id: string;
  name: string;
  kind: EffectKind;
  /** One of the user's groups it runs over (its items, in order)… */
  target?: string;
  /** …or lights of an event type (ids null: all of them). */
  type: number;
  ids: number[] | null;
  start: number;
  end: number;
  layer: number;
  params: EffectParams;
  /** Its events were changed by hand: they stay as they are (moved and stretched with it). */
  custom?: boolean;
  /** kind 'gls': its boxes (gls.ts). */
  gls?: GlsData;
}

/** What making an effect's events needs besides the effect. */
export interface EffectExtras {
  secondsPerBeat: number;
  /** Rings in a ring system ('': all of them together). */
  ringCount: (system: string) => number;
  /** What a GLS block's further group runs over. */
  itemsOf?: (target: Pick<Effect, 'target' | 'type' | 'ids'>) => EffectItem[];
}

/** What an effect goes through, one by one. */
export type EffectItem = { kind: 'group'; id: string } | { kind: 'light'; type: number; id: number };

export const KIND_NAMES: Record<EffectKind, string> = {
  wave: 'Волна',
  fill: 'Заполнение',
  strobe: 'Стробоскоп',
  gradient: 'Градиент',
  twinkle: 'Мерцание',
  fire: 'Огонёк',
  gls: 'GLS-группа',
};

export function defaultParams(color: ClipColor): EffectParams {
  return {
    color: { ...color },
    color2: null,
    hsv: false,
    startMode: 'flash',
    endMode: 'fade',
    fadeIn: 0.25,
    pulse: 1,
    repeats: 1,
    direction: 'forward',
    rate: 0.25,
    duty: 0.5,
    pattern: 'all',
    density: 0.3,
    seed: 1,
    shape: 'steady',
    floor: 0.15,
    tremor: 0.3,
  };
}

/** The items of an effect's target: a group's own items, or the lights of its event type. */
export function effectItems(effect: Pick<Effect, 'target' | 'type' | 'ids'>, lightsByType: ReadonlyMap<number, readonly number[]>, findGroup: (id: string) => LightGroup | null): EffectItem[] {
  if (effect.target !== undefined) {
    const group = findGroup(effect.target);
    if (group !== null) return group.items.map((item): EffectItem => (item.kind === 'group' ? { kind: 'group', id: item.id } : { kind: 'light', type: item.type, id: item.id }));
  }
  const ids = effect.ids ?? [...(lightsByType.get(effect.type) ?? [])].sort((a, b) => a - b);
  return ids.map((id): EffectItem => ({ kind: 'light', type: effect.type, id }));
}

/** Where each item comes in the order the effect goes (several can share a step). */
function stepsOf(count: number, direction: Direction): number[] {
  const middle = (count - 1) / 2;
  const fromMiddle = (i: number) => Math.floor(Math.abs(i - middle));
  const far = fromMiddle(0);
  return Array.from({ length: count }, (_, i) => {
    if (direction === 'backward') return count - 1 - i;
    if (direction === 'outward') return fromMiddle(i);
    if (direction === 'inward') return far - fromMiddle(i);
    return i;
  });
}

export function mixColor(a: ClipColor, b: ClipColor | null, t: number, hsv: boolean, scheme: SchemeColors): ClipColor {
  if (b === null || t <= 0) return { ...a };
  if (t >= 1) return { ...b };
  if (a.ref === b.ref && a.ref !== 'custom') return { ref: a.ref, brightness: a.brightness + (b.brightness - a.brightness) * t };
  const from = resolveRgb(a, scheme);
  const to = resolveRgb(b, scheme);
  const rgb: Rgb = hsv ? lerpHsv(from, to, t) : [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
  return { ref: 'custom', rgb, brightness: a.brightness + (b.brightness - a.brightness) * t };
}

/** A wave's length with a set time from item to item: `passes` passes over `steps` steps. */
export function waveLength(p: EffectParams, steps: number, passes = Math.max(1, Math.round(p.repeats))) {
  return passes * ((Math.max(1, steps) - 1) * (p.spacing ?? 0) + Math.max(1 / 64, p.pulse));
}

/** How many steps a wave goes through for `count` items (items side by side from the middle are one). */
export function waveSteps(count: number, direction: Direction) {
  return count === 0 ? 0 : Math.max(...stepsOf(count, direction === 'pingpong' ? 'forward' : direction)) + 1;
}

/** A small seeded random (the same twinkle every time it is made). */
function random(seed: number) {
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
 * The effect's events. `items`: what it goes through; `whole`: a clip for its whole target at once
 * (a strobe of everything). Each event remembers which item it is for (`slot`).
 */
export function generateEffect(effect: Effect, items: readonly EffectItem[], scheme: SchemeColors, extras?: EffectExtras): LightClip[] {
  return buildEffect(effect, items, scheme, extras).clips;
}

/** The effect's events: light clips — and, for a GLS block's rotation boxes, ring events. */
export function buildEffect(effect: Effect, items: readonly EffectItem[], scheme: SchemeColors, extras?: EffectExtras): { clips: LightClip[]; raw: Omit<RawEvent, 'id'>[] } {
  const made = buildEffectEvents(effect, items, scheme, extras);
  return { clips: finishClips(made.clips, effect.params, scheme), raw: made.raw };
}

/** What every effect's events get from its settings: the fade out's length, the colours turned round
 *  the hue circle (all of them, and each next one further). */
function finishClips(clips: LightClip[], p: EffectParams, scheme: SchemeColors): LightClip[] {
  const fadeOut = p.fadeOut ?? 0;
  const shift = p.hueShift ?? 0;
  const step = p.hueStep ?? 0;
  // (the next flash in time: the clips' starts, in order)
  const times = step !== 0 && p.hueBy === 'time' ? [...new Set(clips.map((clip) => Math.round(clip.start * 10000)))].sort((a, b) => a - b) : [];
  for (const clip of clips) {
    if (fadeOut > 0 && clip.endMode === 'fade') clip.fadeOut = fadeOut;
    const k = step === 0 ? 0 : p.hueBy === 'time' ? times.indexOf(Math.round(clip.start * 10000)) : Math.max(0, clip.slot ?? 0);
    const degrees = shift + step * k;
    if (Math.abs(degrees % 360) < 1e-6) continue;
    clip.color = turnHue(clip.color, degrees, scheme);
    if (clip.endColor !== null) clip.endColor = turnHue(clip.endColor, degrees, scheme);
  }
  return clips;
}

/** A colour turned round the hue circle by `degrees` (as a colour of its own, Chroma's). */
export function turnHue(color: ClipColor, degrees: number, scheme: SchemeColors): ClipColor {
  return { ref: 'custom', rgb: shiftHue(resolveRgb(color, scheme), degrees), brightness: color.brightness };
}

function buildEffectEvents(effect: Effect, items: readonly EffectItem[], scheme: SchemeColors, extras?: EffectExtras): { clips: LightClip[]; raw: Omit<RawEvent, 'id'>[] } {
  if (effect.kind === 'gls') {
    const made = generateGls({ boxes: effect.gls?.boxes ?? [] }, effect.start, effect.end, {
      scheme,
      items: items.length,
      makeClip: (item, start, end) => childClip(effect, items[item] ?? null, start, end, item),
      ringCount: extras?.ringCount ?? (() => 1),
      secondsPerBeat: extras?.secondsPerBeat ?? 0.5,
    });
    // its further groups: each over its own elements (their slots after the ones before)
    let slot = items.length;
    for (const lane of effect.gls?.lanes ?? []) {
      const laneItems = extras?.itemsOf?.(lane) ?? [];
      const base = slot;
      const laneEffect: Effect = { ...effect, target: lane.target, type: lane.type, ids: lane.ids };
      if (lane.target === undefined) delete laneEffect.target;
      const more = generateGls({ boxes: lane.boxes.filter((box) => box.kind === 'color') }, effect.start, effect.end, {
        scheme,
        items: laneItems.length,
        makeClip: (item, start, end) => childClip(laneEffect, laneItems[item] ?? null, start, end, base + item),
        ringCount: () => 1,
        secondsPerBeat: extras?.secondsPerBeat ?? 0.5,
      });
      made.clips.push(...more.clips);
      slot += laneItems.length;
    }
    return { clips: made.clips, raw: made.raw.map((event) => ({ ...event, group: effect.id })) };
  }
  return { clips: classicEffect(effect, items, scheme), raw: [] };
}

/** One of an effect's clips: for an item (null: the whole target), from `start` to `end`. */
function childClip(effect: Effect, item: EffectItem | null, start: number, end: number, slot: number): LightClip {
  const p = effect.params;
  const clip: LightClip = {
    id: newId(),
    type: effect.type,
    ids: effect.ids === null ? null : [...effect.ids],
    start,
    end: Math.max(start + 1 / 64, end),
    startMode: p.startMode,
    fadeIn: 0.25,
    endMode: p.endMode,
    color: { ...p.color },
    endColor: null,
    layer: effect.layer,
    group: effect.id,
    slot,
  };
  if (item === null) {
    if (effect.target !== undefined) clip.target = effect.target;
  } else if (item.kind === 'group') {
    clip.target = item.id;
    clip.ids = null;
  } else {
    clip.type = item.type;
    clip.ids = [item.id];
    clip.scope = 'light';
  }
  return clip;
}

function classicEffect(effect: Effect, items: readonly EffectItem[], scheme: SchemeColors): LightClip[] {
  const p = effect.params;
  const out: LightClip[] = [];
  const duration = Math.max(1 / 64, effect.end - effect.start);
  const count = items.length;
  const base = (start: number, end: number, color: ClipColor, slot: number): LightClip => ({
    id: newId(),
    type: effect.type,
    ids: effect.ids === null ? null : [...effect.ids],
    start,
    end: Math.max(start + 1 / 64, end),
    startMode: p.startMode,
    fadeIn: Math.max(0.01, Math.min(p.fadeIn, Math.max(0.01, (end - start) * 0.9))),
    endMode: p.endMode,
    color,
    endColor: null,
    layer: effect.layer,
    group: effect.id,
    slot,
    ...(p.hsv ? { hsv: true } : {}),
  });
  const onItem = (clip: LightClip, item: EffectItem | null): LightClip => {
    if (item === null) {
      if (effect.target !== undefined) clip.target = effect.target;
      return clip;
    }
    if (item.kind === 'group') {
      clip.target = item.id;
      clip.ids = null;
    } else {
      clip.type = item.type;
      clip.ids = [item.id];
      clip.scope = 'light';
    }
    return clip;
  };
  if (count === 0) return out;
  const steps = stepsOf(count, p.direction === 'pingpong' ? 'forward' : p.direction);
  const stepCount = Math.max(...steps) + 1;
  const colorAt = (step: number) => mixColor(p.color, p.color2, stepCount <= 1 ? 0 : step / (stepCount - 1), p.hsv, scheme);

  if (effect.kind === 'wave') {
    // (the next item after a set time: a pass as long as that makes it, as many passes as fit; else
    // the passes spread over the effect)
    const spaced = (p.spacing ?? 0) > 0;
    const pulse0 = Math.max(1 / 64, p.pulse);
    const passLength = spaced ? waveLength(p, stepCount, 1) : 0;
    const passes = spaced ? Math.max(1, Math.round(duration / passLength + 1e-6)) : Math.max(1, Math.round(p.repeats));
    const pass = spaced ? passLength : duration / passes;
    const pulse = spaced ? pulse0 : Math.min(pulse0, pass);
    const delay = spaced ? p.spacing! : stepCount > 1 ? Math.max(0, pass - pulse) / (stepCount - 1) : 0;
    for (let r = 0; r < passes; r++) {
      items.forEach((item, index) => {
        const step = p.direction === 'pingpong' && r % 2 === 1 ? stepCount - 1 - steps[index]! : steps[index]!;
        const start = effect.start + r * pass + step * delay;
        out.push(onItem(base(start, start + pulse, colorAt(steps[index]!), index), item));
      });
    }
  } else if (effect.kind === 'fill') {
    const sweep = Math.max(0, Math.min(p.pulse, duration * 0.95));
    const delay = stepCount > 1 ? sweep / (stepCount - 1) : 0;
    items.forEach((item, index) => {
      const start = effect.start + steps[index]! * delay;
      out.push(onItem(base(start, effect.end, colorAt(steps[index]!), index), item));
    });
  } else if (effect.kind === 'gradient') {
    items.forEach((item, index) => {
      out.push(onItem(base(effect.start, effect.end, colorAt(steps[index]!), index), item));
    });
  } else if (effect.kind === 'strobe') {
    const rate = Math.max(1 / 32, p.rate);
    const flashes = Math.max(1, Math.floor(duration / rate + 1e-6));
    const lit = Math.max(1 / 64, rate * Math.min(1, Math.max(0.05, p.duty)));
    for (let k = 0; k < flashes; k++) {
      const start = effect.start + k * rate;
      const color = p.color2 !== null && k % 2 === 1 ? { ...p.color2 } : { ...p.color };
      if (p.pattern === 'all') out.push(onItem(base(start, start + lit, color, -1), null));
      else {
        items.forEach((item, index) => {
          const step = steps[index]!;
          const on = p.pattern === 'alternate' ? step % 2 === k % 2 : step === k % stepCount;
          if (on) out.push(onItem(base(start, start + lit, color, index), item));
        });
      }
    }
  } else if (effect.kind === 'fire') {
    out.push(...fire(effect, items, scheme, (start, end, color, slot) => base(start, end, color, slot), onItem));
  } else {
    // twinkle
    const rate = Math.max(1 / 32, p.rate);
    const slots = Math.max(1, Math.floor(duration / rate + 1e-6));
    const lit = Math.max(1 / 64, rate * Math.min(4, Math.max(0.05, p.duty)));
    const next = random(p.seed);
    const pick = Math.max(1, Math.round(p.density * count));
    for (let k = 0; k < slots; k++) {
      const order = items.map((_, index) => ({ index, value: next() })).sort((a, b) => a.value - b.value).slice(0, pick);
      for (const { index } of order) {
        const start = effect.start + k * rate;
        const t = next();
        out.push(onItem(base(start, Math.min(effect.end, start + lit), mixColor(p.color, p.color2, t, p.hsv, scheme), index), items[index]!));
      }
    }
  }
  return out;
}

/**
 * A flame: the light comes up, dies down or burns on — slowly — and trembles on its way: every step
 * (about `rate` beats, never quite the same) it goes a little dimmer, now and then a little brighter,
 * never far from where the slow change has it. Each item burns on its own (pattern 'all': all of
 * them as one); a second colour: the flame wavers between the two.
 */
function fire(
  effect: Effect,
  items: readonly EffectItem[],
  scheme: SchemeColors,
  make: (start: number, end: number, color: ClipColor, slot: number) => LightClip,
  onItem: (clip: LightClip, item: EffectItem | null) => LightClip,
): LightClip[] {
  const p = effect.params;
  const shape = p.shape ?? 'steady';
  const floor = Math.min(1, Math.max(0, p.floor ?? 0.15));
  const tremor = Math.min(1, Math.max(0, p.tremor ?? 0.3));
  const rate = Math.max(1 / 32, p.rate);
  const duration = Math.max(1 / 64, effect.end - effect.start);
  const level = (u: number) => (shape === 'rise' ? floor + (1 - floor) * u : shape === 'fall' ? 1 - (1 - floor) * u : 1);
  const out: LightClip[] = [];
  const burn = (item: EffectItem | null, slot: number) => {
    const next = random(p.seed * 7919 + slot * 104729 + 1);
    if (p.wobble === 'vibrato') {
      // even sways: eight steps a sway, each a fade to the next (smooth, near enough a sine)
      const sway = Math.max(1 / 16, p.rate);
      const step = Math.max(1 / 64, sway / 8);
      const lag = (p.vibratoLag ?? 0) * Math.max(0, slot);
      const times: number[] = [];
      for (let t = effect.start; t < effect.end - 1e-6; t += step) times.push(Math.round(t * 1e5) / 1e5);
      times.push(effect.end);
      const points = times.map((time) => {
        const u = (time - effect.start) / duration;
        const phase = 2 * Math.PI * ((time - effect.start) / sway - lag);
        // (down from full by `tremor` and back: a dip each sway)
        const dip = 0.5 - 0.5 * Math.cos(phase);
        const brightness = Math.round(Math.max(0, p.color.brightness * level(u) * (1 - tremor * dip)) * 1000) / 1000;
        let color = mixColor(p.color, p.color2, p.color2 === null ? 0 : dip, p.hsv, scheme);
        const hue = (p.vibratoHue ?? 0) * Math.sin(phase);
        if (Math.abs(hue) > 0.01) color = { ref: 'custom', rgb: shiftHue(resolveRgb(color, scheme), hue), brightness: color.brightness };
        return { time, color: { ...color, brightness } };
      });
      for (let k = 0; k + 1 < points.length; k++) {
        const from = points[k]!;
        const to = points[k + 1]!;
        const clip = make(from.time, to.time, from.color, slot);
        clip.startMode = k === 0 ? (p.startMode === 'fade' ? 'on' : p.startMode) : 'on';
        clip.endColor = to.color;
        clip.endMode = k + 2 < points.length ? 'stay' : p.endMode;
        out.push(onItem(clip, item));
      }
      return;
    }
    // the moments it changes at: about `rate` apart
    const times = [effect.start];
    // (on a 1/64 grid: uneven, but on the map's beats)
    while (times.at(-1)! < effect.end - 1e-6) times.push(Math.min(effect.end, Math.round((times.at(-1)! + rate * (0.6 + next() * 0.8)) * 64) / 64));
    if (times.length > 2 && times.at(-1)! - times.at(-2)! < rate * 0.3) times.splice(times.length - 2, 1);
    const points = times.map((time, index) => {
      const u = (time - effect.start) / duration;
      const at = level(u);
      // (mostly a little dimmer, a flare now and then; the very ends as the slow change has them)
      const shake = index === 0 || index === times.length - 1 ? 0 : next() < 0.22 ? next() * 0.45 : -next();
      const brightness = Math.round(Math.max(0, p.color.brightness * at * (1 + tremor * shake)) * 1000) / 1000;
      const color = mixColor(p.color, p.color2, p.color2 === null ? 0 : next(), p.hsv, scheme);
      return { time, color: { ...color, brightness } };
    });
    for (let k = 0; k + 1 < points.length; k++) {
      const from = points[k]!;
      const to = points[k + 1]!;
      const clip = make(from.time, to.time, from.color, slot);
      clip.startMode = k === 0 ? (p.startMode === 'fade' ? 'on' : p.startMode) : 'on';
      clip.endColor = to.color;
      // (one step hands over to the next; the last one ends as the effect does)
      clip.endMode = k + 2 < points.length ? 'stay' : p.endMode;
      out.push(onItem(clip, item));
    }
  };
  if (p.pattern === 'all' || items.length === 0) burn(null, -1);
  else items.forEach((item, index) => burn(item, index));
  return out;
}

/** What two lists of events amount to, compared (ids aside). */
export function childrenSignature(clips: readonly LightClip[]) {
  return JSON.stringify(
    clips
      .map(({ id: _id, ...rest }) => ({ ...rest, start: Math.round(rest.start * 1e4), end: Math.round(rest.end * 1e4) }))
      .sort((a, b) => a.start - b.start || (a.slot ?? 0) - (b.slot ?? 0) || a.end - b.end || JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

/** How an item's light looks at `t` beats in (0…1+ brightness, its colour) — for the sketches:
 *  the latest event on it that has started decides. */
export function sketchLevel(clips: readonly LightClip[], slot: number, t: number, beatsPerSecond = 2): { level: number; color: ClipColor | null } {
  let current: LightClip | null = null;
  for (const clip of clips) {
    if (clip.slot !== slot && clip.slot !== -1) continue;
    if (clip.start <= t && (current === null || clip.start >= current.start)) current = clip;
  }
  if (current === null) return { level: 0, color: null };
  const clip = current;
  const length = clip.end - clip.start;
  const into = t - clip.start;
  let level = 1;
  if (clip.startMode === 'fade') level = Math.max(0, 1 - into / (1.5 * beatsPerSecond));
  else if (into > length) level = clip.endMode === 'stay' ? 1 : 0;
  else {
    if (clip.startMode === 'flash') level += Math.max(0, 0.6 - into * 1.5);
    if (clip.startMode === 'fadeIn') level *= Math.min(1, into / Math.max(0.01, clip.fadeIn));
    if (clip.endMode === 'fade') level *= 1 - into / Math.max(0.01, length);
  }
  if (clip.startMode === 'fade' && into > length && clip.endMode !== 'stay') level = 0;
  // (a gradient: its brightness on its way to the end's)
  const brightness = clip.endColor === null ? clip.color.brightness : clip.color.brightness + (clip.endColor.brightness - clip.color.brightness) * Math.min(1, Math.max(0, into / Math.max(0.01, length)));
  return { level: level * brightness, color: clip.color };
}
