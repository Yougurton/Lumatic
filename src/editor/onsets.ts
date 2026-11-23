import { fft } from './bpm-detect';

/**
 * Where the drums hit: the song's spectrum frame by frame (2048 samples, a hop of 256), and in a band
 * of it (the kick drum's lows, the snare, the hi-hats) how much it grows from one frame to the next
 * (spectral flux) — high where something in that band starts. Then the peaks that stand out of
 * what is around them, as many as the sensitivity lets through, not closer together than a gap.
 */

export interface Band {
  id: string;
  name: string;
  lowHz: number;
  highHz: number;
  /** Where the sensitivity starts for it (a band other drums are heard in starts lower). */
  sensitivity: number;
}

export const BANDS: Band[] = [
  { id: 'kick', name: 'Бочка', lowHz: 35, highHz: 120, sensitivity: 0.5 },
  { id: 'snare', name: 'Малый барабан', lowHz: 180, highHz: 3500, sensitivity: 0.35 },
  { id: 'hats', name: 'Хэты, тарелки', lowHz: 7000, highHz: 16000, sensitivity: 0.5 },
  { id: 'bass', name: 'Бас', lowHz: 40, highHz: 300, sensitivity: 0.5 },
  { id: 'mid', name: 'Середина (голос, синты)', lowHz: 300, highHz: 4000, sensitivity: 0.4 },
  { id: 'all', name: 'Всё вместе', lowHz: 30, highHz: 16000, sensitivity: 0.5 },
];

const FRAME = 2048;
const HOP = 256;

export interface BandFlux {
  /** One value per hop, per band asked for. */
  flux: Float32Array[];
  /** Frames per second. */
  fps: number;
  /** Seconds from a frame's start to where its hit is (a hit shows most as it comes into the window:
   *  near its end — measured on drums). */
  offset: number;
}

/** The flux of each band (`[lowHz, highHz]`) over the whole song. */
export function bandFlux(channels: readonly Float32Array[], sampleRate: number, bands: readonly [number, number][]): BandFlux {
  const length = channels[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) mono[i]! += channel[i]! / channels.length;
  const frames = Math.max(1, Math.floor((length - FRAME) / HOP) + 1);
  const window = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const ranges = bands.map(([low, high]) => {
    const from = Math.max(1, Math.floor((low / sampleRate) * FRAME));
    return [from, Math.max(from + 1, Math.min(FRAME / 2, Math.ceil((high / sampleRate) * FRAME)))] as const;
  });
  const top = Math.max(...ranges.map(([, to]) => to));
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  let previous = new Float32Array(top);
  let current = new Float32Array(top);
  const flux = bands.map(() => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = (mono[offset + i] ?? 0) * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 1; b < top; b++) current[b] = Math.log1p(100 * Math.hypot(re[b]!, im[b]!));
    if (f > 0) {
      ranges.forEach(([from, to], index) => {
        let sum = 0;
        for (let b = from; b < to; b++) sum += Math.max(0, current[b]! - previous[b]!);
        flux[index]![f] = sum / (to - from);
      });
    }
    [previous, current] = [current, previous];
  }
  return { flux, fps: sampleRate / HOP, offset: (FRAME * 0.87) / sampleRate };
}

export interface Onset {
  /** Seconds into the song. */
  time: number;
  /** 0…1: how hard, against the strongest found. */
  strength: number;
}

/**
 * The hits in a band's flux: peaks over what is around them (±0.25 s) and not much weaker than the
 * strongest within ±2 s (other drums heard a little in the band), the more of them the higher the
 * sensitivity (0…1); two closer than `gap` seconds — the stronger one; only between `from` and `to`
 * seconds.
 */
export function pickOnsets(flux: Float32Array, fps: number, offset: number, sensitivity: number, gap: number, from = 0, to = Infinity): Onset[] {
  const frames = flux.length;
  const radius = Math.max(2, Math.round(fps * 0.25));
  // (the running mean and spread around each frame)
  const sums = new Float64Array(frames + 1);
  const squares = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) {
    sums[i + 1] = sums[i]! + flux[i]!;
    squares[i + 1] = squares[i]! + flux[i]! * flux[i]!;
  }
  let max = 0;
  for (const value of flux) max = Math.max(max, value);
  if (max <= 0) return [];
  const sensitive = Math.min(1, Math.max(0, sensitivity));
  const spread = 0.3 + 2.7 * (1 - sensitive);
  const floor = max * (0.02 + 0.25 * (1 - sensitive) ** 2);
  const peak = Math.max(1, Math.round(fps * 0.02));
  const found: { time: number; level: number }[] = [];
  const first = Math.max(1, Math.floor((from - offset) * fps));
  const last = Math.min(frames - 1, Math.ceil((to - offset) * fps));
  for (let i = first; i <= last; i++) {
    const value = flux[i]!;
    if (value < floor) continue;
    let highest = true;
    for (let k = Math.max(0, i - peak); k <= Math.min(frames - 1, i + peak) && highest; k++) if (flux[k]! > value || (flux[k] === value && k < i)) highest = false;
    if (!highest) continue;
    const a = Math.max(0, i - radius);
    const b = Math.min(frames, i + radius + 1);
    const mean = (sums[b]! - sums[a]!) / (b - a);
    const deviation = Math.sqrt(Math.max(0, (squares[b]! - squares[a]!) / (b - a) - mean * mean));
    const over = value - (mean + spread * deviation);
    if (over <= 0) continue;
    const time = i / fps + offset;
    if (time < from || time > to) continue;
    const previous = found[found.length - 1];
    if (previous !== undefined && time - previous.time < gap) {
      if (value > previous.level) found[found.length - 1] = { time, level: value };
      continue;
    }
    found.push({ time, level: value });
  }
  // (not much weaker than the strongest around)
  const ratio = 0.9 * (1 - sensitive) ** 0.7;
  const kept = found.filter((item) => {
    let strongest = 0;
    for (const other of found) if (Math.abs(other.time - item.time) <= 2) strongest = Math.max(strongest, other.level);
    return item.level >= strongest * ratio;
  });
  const strongest = Math.max(0, ...kept.map((item) => item.level));
  return kept.map((item) => ({ time: item.time, strength: strongest > 0 ? item.level / strongest : 1 }));
}
