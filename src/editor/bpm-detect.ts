/**
 * Finding a song's tempo and where its beats fall.
 *
 * The song (mono, brought down to ~11 kHz) → how much the spectrum grows from one short frame to
 * the next (spectral flux: high where a drum, a note starts) → the beat period that repeats best in
 * it (autocorrelation, leaning towards 120 BPM the way people count, as librosa does) → fine-tuned
 * over the whole song: for tempos close to it, the one (and its phase) whose beat grid lands on the
 * most onsets. Whole and half BPM values win when they fit nearly as well (they usually are what the
 * song was made at).
 */

export interface BpmResult {
  bpm: number;
  /** When the first beat comes (seconds into the song, before any silence is added). */
  firstBeat: number;
  /** 0…1: how clearly the grid stands out. */
  confidence: number;
  /** Other tempos worth trying (half / double), best first. */
  alternatives: number[];
}

const TARGET_RATE = 11025;
const FRAME = 1024;
const HOP = 128;

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]!;
      re[i] = re[j]!;
      re[j] = t;
      t = im[i]!;
      im[i] = im[j]!;
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + half]! * cr - im[i + k + half]! * ci;
        const bi = re[i + k + half]! * ci + im[i + k + half]! * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + half] = ar - br;
        im[i + k + half] = ai - bi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** The onset strength, one value per hop. */
export function onsetEnvelope(channels: readonly Float32Array[], sampleRate: number): { envelope: Float32Array; fps: number; frameOffset: number } {
  const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const rate = sampleRate / factor;
  const length = Math.floor(channels[0]!.length / factor);
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let k = 0; k < factor; k++) sum += channel[i * factor + k]!;
      mono[i]! += sum / factor / channels.length;
    }
  }
  const frames = Math.max(1, Math.floor((length - FRAME) / HOP) + 1);
  const window = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const bins = FRAME / 2;
  let previous = new Float32Array(bins);
  let current = new Float32Array(bins);
  const flux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = (mono[offset + i] ?? 0) * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    for (let b = 1; b < bins; b++) {
      const magnitude = Math.log1p(100 * Math.hypot(re[b]!, im[b]!));
      current[b] = magnitude;
      if (f > 0) sum += Math.max(0, magnitude - previous[b]!);
    }
    flux[f] = sum;
    [previous, current] = [current, previous];
  }
  // minus its running average (~0.4 s): what stands out of the music around it
  const fps = rate / HOP;
  const radius = Math.max(1, Math.round(fps * 0.2));
  const envelope = new Float32Array(frames);
  let running = 0;
  for (let i = 0; i < Math.min(frames, radius); i++) running += flux[i]!;
  for (let i = 0; i < frames; i++) {
    const add = i + radius;
    const drop = i - radius - 1;
    if (add < frames) running += flux[add]!;
    if (drop >= 0) running -= flux[drop]!;
    const count = Math.min(frames - 1, i + radius) - Math.max(0, i - radius) + 1;
    envelope[i] = Math.max(0, flux[i]! - running / count);
  }
  let max = 0;
  for (const value of envelope) max = Math.max(max, value);
  if (max > 0) for (let i = 0; i < frames; i++) envelope[i]! /= max;
  // (a frame's change is centred where its window is)
  return { envelope, fps, frameOffset: FRAME / 2 / rate };
}

function smooth(values: Float32Array, sigma: number): Float32Array {
  const radius = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  for (let i = -radius; i <= radius; i++) kernel.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const total = kernel.reduce((a, b) => a + b, 0);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += (values[i + k] ?? 0) * kernel[k + radius]!;
    out[i] = sum / total;
  }
  return out;
}

const sample = (values: Float32Array, at: number) => {
  const i = Math.floor(at);
  const t = at - i;
  return (values[i] ?? 0) * (1 - t) + (values[i + 1] ?? 0) * t;
};

/** How well a grid of `period` frames lands on the onsets: the best phase and its score. */
function gridScore(envelope: Float32Array, period: number): { score: number; phase: number } {
  let best = { score: -1, phase: 0 };
  const steps = Math.max(8, Math.ceil(period * 2));
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period;
    let sum = 0;
    let count = 0;
    for (let at = phase; at < envelope.length - 1; at += period) {
      sum += sample(envelope, at);
      count++;
    }
    const score = count === 0 ? 0 : sum / count;
    if (score > best.score) best = { score, phase };
  }
  return best;
}

export function detectBpm(channels: readonly Float32Array[], sampleRate: number, range: [number, number] = [60, 220]): BpmResult {
  const { envelope, fps, frameOffset } = onsetEnvelope(channels, sampleRate);
  const n = envelope.length;
  // coarse: autocorrelation over the tempo range, weighted towards 120 BPM
  const lagOf = (bpm: number) => (60 / bpm) * fps;
  const minLag = Math.floor(lagOf(range[1]));
  const maxLag = Math.ceil(lagOf(range[0]));
  const ac = new Float32Array(maxLag * 2 + 2);
  for (let lag = minLag; lag < ac.length; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += envelope[i]! * envelope[i + lag]!;
    ac[lag] = sum / Math.max(1, n - lag);
  }
  const weighted = (lag: number) => {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    return (ac[lag]! + 0.5 * (ac[lag * 2] ?? 0)) * prior;
  };
  const candidates: { lag: number; value: number }[] = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const value = weighted(lag);
    if (value >= weighted(lag - 1) && value >= weighted(lag + 1)) candidates.push({ lag, value });
  }
  candidates.sort((a, b) => b.value - a.value);
  const top = candidates.slice(0, 3);
  if (top.length === 0) return { bpm: 120, firstBeat: 0, confidence: 0, alternatives: [] };

  // fine: around each coarse candidate, the grid that fits the whole song best
  const sharp = smooth(envelope, 1.2);
  const refine = (coarseLag: number) => {
    const coarse = (60 * fps) / coarseLag;
    let best = { bpm: coarse, score: -1, phase: 0 };
    for (let bpm = coarse * 0.975; bpm <= coarse * 1.025; bpm += 0.01) {
      const { score, phase } = gridScore(sharp, lagOf(bpm));
      if (score > best.score) best = { bpm, score, phase };
    }
    // finer still, then whole / half values if they fit about as well
    for (let bpm = best.bpm - 0.01; bpm <= best.bpm + 0.01; bpm += 0.001) {
      const { score, phase } = gridScore(sharp, lagOf(bpm));
      if (score > best.score) best = { bpm, score, phase };
    }
    for (const round of [Math.round(best.bpm), Math.round(best.bpm * 2) / 2]) {
      if (Math.abs(round - best.bpm) > 0.35) continue;
      const fit = gridScore(sharp, lagOf(round));
      if (fit.score >= best.score * 0.985) {
        best = { bpm: round, score: fit.score, phase: fit.phase };
        break;
      }
    }
    return best;
  };
  const refined = top.map((candidate) => ({ ...refine(candidate.lag), weight: candidate.value }));
  // (the autocorrelation's pick, unless another candidate fits the song much better)
  let chosen = refined[0]!;
  for (const other of refined.slice(1)) if (other.score > chosen.score * 1.12 && other.weight > chosen.weight * 0.6) chosen = other;

  let mean = 0;
  for (const value of sharp) mean += value;
  mean /= Math.max(1, sharp.length);
  const confidence = Math.max(0, Math.min(1, (chosen.score / Math.max(1e-6, mean) - 1.5) / 5));
  // (slow-counted songs are mapped at double time: under 90 BPM, the double — when its grid
  // still lands on the music)
  if (chosen.bpm < 90 && chosen.bpm * 2 <= range[1]) {
    const doubled = gridScore(sharp, lagOf(chosen.bpm * 2));
    if (doubled.score >= chosen.score * 0.7) chosen = { ...chosen, bpm: chosen.bpm * 2, phase: doubled.phase };
  }
  const period = 60 / chosen.bpm;
  // (the flux peaks a little before the window's centre reaches the onset: measured on songs with
  // known grids, ~25 ms)
  let firstBeat = chosen.phase / fps + frameOffset + 0.025;
  firstBeat -= Math.floor(firstBeat / period) * period;
  const round2 = (value: number) => Math.round(value * 100) / 100;
  const alternatives = [...new Set([chosen.bpm / 2, chosen.bpm * 2, ...refined.map((item) => item.bpm)].map(round2))]
    .filter((bpm) => bpm !== round2(chosen.bpm) && bpm >= 40 && bpm <= 400);
  return { bpm: round2(chosen.bpm), firstBeat, confidence, alternatives };
}
