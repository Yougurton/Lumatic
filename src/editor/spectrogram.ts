/**
 * The song as a picture under the timeline: a mel spectrogram (low notes at the bottom), worked out
 * once when the song loads (in a worker) and drawn into an offscreen canvas one column per frame;
 * the timeline paints the stretch of it that's on screen.
 */

export interface Spectrogram {
  /** One column per frame (frame = hop / sampleRate seconds), low notes at the bottom. */
  image: HTMLCanvasElement;
  secondsPerFrame: number;
  frames: number;
  /** The levels the picture is painted from (0…255, `bands` per column, lowest band first). */
  values: Uint8Array;
  bands: number;
  /** The frequencies the bands span (Hz). */
  lowHz: number;
  highHz: number;
}

/** How the spectrogram is shown: its height (px), the stretch of frequencies, the level below which
 *  it stays dark (0…1) and the contrast (a power on the level: above 1 darker, below 1 brighter). */
export interface SpectrogramLook {
  height: number;
  lowHz: number;
  highHz: number;
  floor: number;
  contrast: number;
}

export const DEFAULT_LOOK: SpectrogramLook = { height: 110, lowHz: 30, highHz: 16000, floor: 0, contrast: 1 };

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

/** Where a frequency sits among the bands (0: the lowest band's middle; fractional). */
export function bandOfHz(spectrogram: Spectrogram, hz: number) {
  const lo = hz2mel(spectrogram.lowHz);
  const hi = hz2mel(spectrogram.highHz);
  return ((hz2mel(Math.max(1, hz)) - lo) / (hi - lo)) * (spectrogram.bands + 1) - 1;
}

const BANDS = 96;
const FFT_SIZE = 2048;
const HOP = 512;
const LOW_HZ = 30;
const HIGH_HZ = 16000;

/** Inline worker code (no bundler worker setup needed): STFT → mel bands → dB → 0…255. */
const workerSource = `
const BANDS = ${BANDS}, FFT = ${FFT_SIZE}, HOP = ${HOP};
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
self.onmessage = (event) => {
  const { samples, sampleRate } = event.data;
  // (a column's window centred on its time — not starting there: else a hit lights the column up to a
  // window's length before it sounds)
  const frames = Math.max(1, Math.floor(samples.length / HOP) + 1);
  const hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
  const mel2hz = (m) => 700 * (Math.pow(10, m / 2595) - 1);
  const lo = hz2mel(${LOW_HZ}), hi = hz2mel(Math.min(${HIGH_HZ}, sampleRate / 2));
  const edges = [];
  for (let b = 0; b <= BANDS + 1; b++) edges.push(Math.round(mel2hz(lo + (hi - lo) * b / (BANDS + 1)) / sampleRate * FFT));
  const window = new Float32Array(FFT);
  for (let i = 0; i < FFT; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT);
  const out = new Uint8Array(frames * BANDS);
  const re = new Float32Array(FFT), im = new Float32Array(FFT);
  const db = new Float32Array(frames * BANDS);
  let max = -200;
  for (let f = 0; f < frames; f++) {
    const off = f * HOP - FFT / 2;
    for (let i = 0; i < FFT; i++) { re[i] = (samples[off + i] || 0) * window[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      const a = edges[b], c = edges[b + 1], e = Math.max(edges[b + 2], c + 1);
      let sum = 0;
      for (let k = a; k < e; k++) {
        const w = k < c ? (k - a) / Math.max(1, c - a) : (e - k) / Math.max(1, e - c);
        sum += w * (re[k] * re[k] + im[k] * im[k]);
      }
      const v = 10 * Math.log10(sum + 1e-10);
      db[f * BANDS + b] = v;
      if (v > max) max = v;
    }
    if (f % 2000 === 0) self.postMessage({ progress: f / frames });
  }
  const floor = max - 75;
  for (let i = 0; i < db.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((db[i] - floor) / 75 * 255)));
  self.postMessage({ done: true, data: out, frames, bands: BANDS }, [out.buffer]);
};`;

/** A colour ramp: dark blue → violet → orange → pale yellow. */
function ramp(value: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [8, 9, 18]],
    [0.35, [42, 26, 96]],
    [0.6, [150, 40, 120]],
    [0.82, [240, 120, 50]],
    [1, [255, 236, 170]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]!;
    const [p0, c0] = stops[i - 1]!;
    if (value <= p1) {
      const t = (value - p0) / (p1 - p0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return stops[stops.length - 1]![1];
}

export function computeSpectrogram(buffer: AudioBuffer, onProgress?: (progress: number) => void): Promise<Spectrogram> {
  const channels = buffer.numberOfChannels;
  const samples = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) samples[i]! += data[i]! / channels;
  }
  const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  const worker = new Worker(url);
  return new Promise((resolve, reject) => {
    worker.onerror = (error) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error(error.message));
    };
    worker.onmessage = (event: MessageEvent<{ progress?: number; done?: boolean; data?: Uint8Array; frames?: number; bands?: number }>) => {
      if (event.data.progress !== undefined) {
        onProgress?.(event.data.progress);
        return;
      }
      if (event.data.done !== true || event.data.data === undefined) return;
      worker.terminate();
      URL.revokeObjectURL(url);
      const frames = event.data.frames ?? 0;
      const bands = event.data.bands ?? BANDS;
      const values = event.data.data;
      // (columns brought down to what a canvas can be wide everywhere: ~16k pixels)
      const width = Math.min(frames, 16000);
      const scale = frames / width;
      const columns = new Uint8Array(width * bands);
      for (let x = 0; x < width; x++) {
        const f0 = Math.floor(x * scale);
        const f1 = Math.max(f0 + 1, Math.floor((x + 1) * scale));
        for (let b = 0; b < bands; b++) {
          let peak = 0;
          for (let f = f0; f < f1 && f < frames; f++) peak = Math.max(peak, values[f * bands + b]!);
          columns[x * bands + b] = peak;
        }
      }
      const image = document.createElement('canvas');
      image.width = width;
      image.height = bands;
      const spectrogram: Spectrogram = { image, secondsPerFrame: (HOP / buffer.sampleRate) * scale, frames: width, values: columns, bands, lowHz: LOW_HZ, highHz: Math.min(HIGH_HZ, buffer.sampleRate / 2) };
      paintSpectrogram(spectrogram, DEFAULT_LOOK);
      resolve(spectrogram);
    };
    worker.postMessage({ samples, sampleRate: buffer.sampleRate }, [samples.buffer]);
  });
}

/** Paints the picture anew for a look (its level floor and contrast). */
export function paintSpectrogram(spectrogram: Spectrogram, look: Pick<SpectrogramLook, 'floor' | 'contrast'>) {
  const { image, bands, values } = spectrogram;
  const floor = Math.min(0.95, Math.max(0, look.floor));
  const lut = Array.from({ length: 256 }, (_, i) => ramp(Math.max(0, Math.min(1, (i / 255 - floor) / (1 - floor))) ** look.contrast));
  const context = image.getContext('2d')!;
  const pixels = context.createImageData(image.width, bands);
  for (let x = 0; x < image.width; x++) {
    for (let b = 0; b < bands; b++) {
      const [r, g, bl] = lut[values[x * bands + b]!]!;
      const p = ((bands - 1 - b) * image.width + x) * 4;
      pixels.data[p] = r;
      pixels.data[p + 1] = g;
      pixels.data[p + 2] = bl;
      pixels.data[p + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
}
