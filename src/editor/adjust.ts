import { resolveRgb, type SchemeColors } from './bake';
import { easingFromName } from '../engine/core/easing';
import { newId, type ClipColor, type LightClip, type Rgb } from './model';

/**
 * Changing the selected events' light all at once (as Enlighten does for ChroMapper): brighter or
 * dimmer, another hue, more or less saturated — the same everywhere or going from one setting at the
 * selection's start to another at its end (on each row by itself if asked); swelling in a few pulses;
 * a flutter (each event split in two, the second half a little off).
 */

export interface Adjustment {
  /** Brightness × (start, end). */
  brightness: [number, number];
  /** Hue shift in degrees (start, end). */
  hue: [number, number];
  /** Saturation + (start, end; -1…1). */
  saturation: [number, number];
  /** From the start setting to the end one over the selection (else: the start one everywhere). */
  gradient: boolean;
  easing: string;
  /** The gradient on each row by itself (from its own first event to its last). */
  perRow: boolean;
  /** Swells: how many over the selection, how deep (0…1). */
  pulse: { cycles: number; depth: number } | null;
  /** Each event split in two: the second half × this, give or take `turbulence`. */
  flutter: { multiplier: number; turbulence: number; seed: number } | null;
}

export const NO_ADJUSTMENT: Adjustment = { brightness: [1, 1], hue: [0, 0], saturation: [0, 0], gradient: false, easing: 'easeLinear', perRow: false, pulse: null, flutter: null };

function rgbToHsv([r, g, b]: Rgb): Rgb {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return [hue, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb([h, s, v]: Rgb): Rgb {
  const section = Math.floor(h * 6);
  const f = h * 6 - section;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((section % 6) + 6) % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;

/** A colour with the adjustment's settings at that point: brightness ×, hue and saturation moved. */
function adjustColor(color: ClipColor, scheme: SchemeColors, brightness: number, hue: number, saturation: number): ClipColor {
  const out: ClipColor = { ...color, brightness: round4(Math.max(0, color.brightness * brightness)) };
  if (Math.abs(hue) < 1e-6 && Math.abs(saturation) < 1e-6) return out;
  const [h, s, v] = rgbToHsv(resolveRgb(color, scheme));
  const rgb = hsvToRgb([(((h + hue / 360) % 1) + 1) % 1, Math.min(1, Math.max(0, s + saturation)), v]);
  return { ref: 'custom', rgb: [round4(rgb[0]), round4(rgb[1]), round4(rgb[2])], brightness: out.brightness };
}

/** A small seeded random (the same flutter for the same seed). */
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
 * The clips adjusted (changed in place) — and the halves a flutter split off (new clips). `rowOf`:
 * which row a clip is on (a gradient per row).
 */
export function adjustClips(clips: LightClip[], adjustment: Adjustment, scheme: SchemeColors, rowOf: (clip: LightClip) => string = () => ''): LightClip[] {
  if (clips.length === 0) return [];
  const ease = easingFromName(adjustment.easing);
  const span = (list: readonly LightClip[]) => {
    const from = Math.min(...list.map((clip) => clip.start));
    const to = Math.max(...list.map((clip) => clip.end));
    return { from, to: to > from ? to : from + 1 };
  };
  const whole = span(clips);
  const rows = new Map<string, { from: number; to: number }>();
  if (adjustment.perRow) {
    const byRow = new Map<string, LightClip[]>();
    for (const clip of clips) byRow.set(rowOf(clip), [...(byRow.get(rowOf(clip)) ?? []), clip]);
    for (const [row, list] of byRow) rows.set(row, span(list));
  }
  /** The settings at a moment of a clip's. */
  const at = (clip: LightClip, beat: number) => {
    const range = adjustment.perRow ? (rows.get(rowOf(clip)) ?? whole) : whole;
    const t = adjustment.gradient ? ease(Math.min(1, Math.max(0, (beat - range.from) / (range.to - range.from)))) : 0;
    const mix = ([a, b]: [number, number]) => a + (b - a) * t;
    let brightness = mix(adjustment.brightness);
    if (adjustment.pulse !== null) {
      const u = (beat - whole.from) / (whole.to - whole.from);
      brightness *= 1 - Math.min(1, Math.max(0, adjustment.pulse.depth)) * (0.5 - 0.5 * Math.cos(2 * Math.PI * Math.max(1, adjustment.pulse.cycles) * u));
    }
    return { brightness, hue: mix(adjustment.hue), saturation: mix(adjustment.saturation) };
  };
  const recolor = (clip: LightClip) => {
    const a = at(clip, clip.start);
    const b = at(clip, clip.end);
    const original = clip.color;
    clip.color = adjustColor(original, scheme, a.brightness, a.hue, a.saturation);
    // (a gradient across the selection or pulses make the clip itself a gradient)
    const changesOnIt = Math.abs(a.brightness - b.brightness) > 1e-4 || Math.abs(a.hue - b.hue) > 1e-4 || Math.abs(a.saturation - b.saturation) > 1e-4;
    if (clip.endColor !== null) clip.endColor = adjustColor(clip.endColor, scheme, b.brightness, b.hue, b.saturation);
    else if (changesOnIt && clip.startMode !== 'fade' && clip.end - clip.start > 0.25) clip.endColor = adjustColor(original, scheme, b.brightness, b.hue, b.saturation);
  };
  const added: LightClip[] = [];
  if (adjustment.flutter !== null) {
    const next = random(adjustment.flutter.seed);
    for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
      if (clip.end - clip.start < 1 / 16 || clip.startMode === 'fade') continue;
      const middle = Math.round(((clip.start + clip.end) / 2) * 64) / 64;
      const factor = Math.max(0, adjustment.flutter.multiplier * (1 + adjustment.flutter.turbulence * (next() * 2 - 1)));
      // (the colour it has at the middle: a gradient half way)
      const midColor: ClipColor =
        clip.endColor === null
          ? { ...clip.color }
          : { ...clip.endColor, brightness: clip.color.brightness + (clip.endColor.brightness - clip.color.brightness) * 0.5 };
      const second: LightClip = { ...clip, id: newId(), start: middle, startMode: 'on', color: { ...midColor, brightness: round4(midColor.brightness * factor) }, endColor: clip.endColor === null ? null : { ...clip.endColor, brightness: round4(clip.endColor.brightness * factor) } };
      clip.end = middle;
      clip.endMode = 'stay';
      clip.endColor = clip.endColor === null ? null : midColor;
      added.push(second);
    }
  }
  for (const clip of [...clips, ...added]) recolor(clip);
  return added;
}
