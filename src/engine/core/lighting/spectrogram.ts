/**
 * The game's spectrum of the song, as its environments' spectrograms get it (BasicSpectrogramData):
 * 64 values of the left channel's spectrum (Unity's GetSpectrumData with a Blackman-Harris window),
 * each made louder the higher its band — log(1 + value) * (band + 1) — and smoothed in time: a value
 * jumps up at once when it rises by more than a threshold, else follows up fast (8 a second) and
 * comes down slower (4 a second).
 *
 * The game does it frame by frame as the song plays; here the same is worked out for any moment of
 * the song (stepping at 60 a second from a little before it), so that it is the same when the song is
 * played, paused or jumped in.
 *
 * Unity's own scale of the spectrum's values is not documented: a pure tone at full volume is taken
 * as 1 in its band here.
 */

export const SPECTRUM_SAMPLES = 64;
const WINDOW = SPECTRUM_SAMPLES * 2;
const STEP = 1 / 60;
/** How far before a moment the smoothing starts from nothing (seconds): long enough to settle. */
const LEAD = 1.5;
const INSTANT_CHANGE_THRESHOLD = 0.1;

const window = new Float32Array(WINDOW);
let windowSum = 0;
for (let n = 0; n < WINDOW; n++) {
  const x = (2 * Math.PI * n) / (WINDOW - 1);
  window[n] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
  windowSum += window[n]!;
}
const cosTable = new Float32Array(SPECTRUM_SAMPLES * WINDOW);
const sinTable = new Float32Array(SPECTRUM_SAMPLES * WINDOW);
for (let k = 0; k < SPECTRUM_SAMPLES; k++) {
  for (let n = 0; n < WINDOW; n++) {
    const angle = (2 * Math.PI * k * n) / WINDOW;
    cosTable[k * WINDOW + n] = Math.cos(angle);
    sinTable[k * WINDOW + n] = Math.sin(angle);
  }
}

/** One step of the game's smoothing (its ProcessSamples), in place. */
export function processSpectrum(source: Float32Array, processed: Float32Array, deltaTime: number) {
  for (let i = 0; i < processed.length; i++) {
    const target = Math.log((source[i] ?? 0) + 1) * (i + 1);
    const current = processed[i]!;
    if (current < target) processed[i] = target - current > INSTANT_CHANGE_THRESHOLD ? target : current + (target - current) * Math.min(1, deltaTime * 8);
    else processed[i] = current + (target - current) * Math.min(1, deltaTime * 4);
  }
}

export class SongSpectrum {
  private readonly raw = new Float32Array(SPECTRUM_SAMPLES);
  private readonly processed = new Float32Array(SPECTRUM_SAMPLES);
  private readonly frame = new Float32Array(WINDOW);
  private time = Number.NaN;

  /** `samples`: the song's left channel. */
  constructor(
    private readonly samples: Float32Array,
    private readonly sampleRate: number,
  ) {}

  private spectrumAt(seconds: number) {
    const start = Math.round(seconds * this.sampleRate) - WINDOW;
    for (let n = 0; n < WINDOW; n++) this.frame[n] = (this.samples[start + n] ?? 0) * window[n]!;
    for (let k = 0; k < SPECTRUM_SAMPLES; k++) {
      let re = 0;
      let im = 0;
      const row = k * WINDOW;
      for (let n = 0; n < WINDOW; n++) {
        const value = this.frame[n]!;
        re += value * cosTable[row + n]!;
        im -= value * sinTable[row + n]!;
      }
      this.raw[k] = (2 * Math.hypot(re, im)) / windowSum;
    }
  }

  /** The processed samples at a moment of the song (the same array every time: read, don't keep). */
  at(seconds: number): Float32Array {
    if (!(seconds >= this.time && seconds - this.time < 0.5)) {
      this.processed.fill(0);
      this.time = seconds - LEAD;
    }
    while (this.time + STEP <= seconds) {
      this.time += STEP;
      this.spectrumAt(this.time);
      processSpectrum(this.raw, this.processed, STEP);
    }
    return this.processed;
  }
}
