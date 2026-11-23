/**
 * The light following the song: how loud it is (in a stretch of frequencies) at each moment of an
 * effect, from the song's spectrogram — the effects "by sound": an equaliser (each item a stretch of
 * the frequencies, low to high), a level meter (more items lit the louder it is, its top falling back
 * slowly) and one light by loudness (on the other items later and later: a wave to the sound).
 */

/** The spectrogram's numbers (spectrogram.ts): `bands` levels 0…255 a frame, lowest band first, the
 *  bands even on the mel scale from lowHz to highHz. */
export interface SoundSource {
  secondsPerFrame: number;
  frames: number;
  bands: number;
  values: Uint8Array;
  lowHz: number;
  highHz: number;
}

export type SoundMode = 'eq' | 'meter' | 'level';

export interface SoundSettings {
  mode: SoundMode;
  /** How much brighter than the song's own swing (1: its loud parts full, its quiet ones dark). */
  gain: number;
  /** The frequencies listened to (Hz). */
  lowHz: number;
  highHz: number;
  /** Beats from one point to the next. */
  step: number;
  /** Beats to die down from full to dark (rising is at once). */
  release: number;
  /** level: beats each next item is later (0: all at once). */
  delay: number;
  /** meter: the top item kept lit and falling back to the level this many beats from the top (0: none). */
  peakFall: number;
}

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

/** Where a frequency sits among the bands (fractional; as spectrogram.ts's bandOfHz). */
function bandOf(source: SoundSource, hz: number) {
  const lo = hz2mel(source.lowHz);
  const hi = hz2mel(source.highHz);
  return ((hz2mel(Math.max(1, hz)) - lo) / (hi - lo)) * (source.bands + 1) - 1;
}

/** `count` stretches of frequencies between two, even on the mel scale (the equaliser's items). */
export function splitHz(lowHz: number, highHz: number, count: number): [number, number][] {
  const lo = hz2mel(Math.max(1, lowHz));
  const hi = hz2mel(Math.max(lowHz + 1, highHz));
  return Array.from({ length: count }, (_, k) => [mel2hz(lo + ((hi - lo) * k) / count), mel2hz(lo + ((hi - lo) * (k + 1)) / count)]);
}

/**
 * How loud a stretch of frequencies is at each of `times` (seconds): the bands in it averaged over
 * each step's frames, scaled to 0…1 by the stretch's own quiet and loud (its 10th and 97th
 * percentiles over these times) times `gain`, dying down no faster than `release` allows.
 */
export function loudness(source: SoundSource, times: readonly number[], lowHz: number, highHz: number, settings: Pick<SoundSettings, 'gain' | 'release' | 'step'>, secondsPerBeat: number): number[] {
  if (times.length === 0 || source.frames === 0) return times.map(() => 0);
  const from = Math.max(0, Math.min(source.bands - 1, Math.floor(bandOf(source, lowHz))));
  const to = Math.max(from, Math.min(source.bands - 1, Math.ceil(bandOf(source, highHz))));
  const half = Math.max(1, Math.round((settings.step * secondsPerBeat) / source.secondsPerFrame / 2));
  const raw = times.map((seconds) => {
    const middle = Math.round(seconds / source.secondsPerFrame);
    let sum = 0;
    let n = 0;
    for (let frame = Math.max(0, middle - half); frame <= Math.min(source.frames - 1, middle + half); frame++) {
      for (let band = from; band <= to; band++) {
        sum += source.values[frame * source.bands + band]!;
        n++;
      }
    }
    return n === 0 ? 0 : sum / n;
  });
  const sorted = [...raw].sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const loud = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.97))] ?? 255;
  const span = Math.max(4, loud - quiet);
  const fall = settings.release > 0 ? settings.step / settings.release : 1;
  let was = 0;
  return raw.map((value) => {
    const level = Math.max(0, Math.min(1, ((value - quiet) / span) * settings.gain));
    was = level >= was ? level : Math.max(level, was - fall);
    return Math.round(was * 1000) / 1000;
  });
}

/**
 * Each item's brightness (0…1) at each time, and the meter's falling top (which item, -1: none).
 * `times`: beats; `toSeconds`: their place in the song.
 */
export function soundLevels(source: SoundSource, settings: SoundSettings, count: number, times: readonly number[], toSeconds: (beat: number) => number, secondsPerBeat: number): { levels: number[][]; peak: number[] } {
  const seconds = times.map(toSeconds);
  if (settings.mode === 'eq') {
    const levels = splitHz(settings.lowHz, settings.highHz, count).map(([low, high]) => loudness(source, seconds, low, high, settings, secondsPerBeat));
    return { levels, peak: times.map(() => -1) };
  }
  if (settings.mode === 'level') {
    // (each next item later by `delay`: the loudness the song had that much earlier)
    const levels = Array.from({ length: count }, (_, k) => loudness(source, times.map((beat) => Math.max(0, toSeconds(beat - settings.delay * k))), settings.lowHz, settings.highHz, settings, secondsPerBeat));
    return { levels, peak: times.map(() => -1) };
  }
  // the meter: lit up to the level, the top one partly; its top falling back slowly
  const level = loudness(source, seconds, settings.lowHz, settings.highHz, settings, secondsPerBeat);
  const fall = settings.peakFall > 0 ? (count * settings.step) / settings.peakFall : Infinity;
  let top = 0;
  const peak = level.map((value) => {
    const reach = value * count;
    top = reach >= top ? reach : Math.max(reach, top - fall);
    return settings.peakFall > 0 && top > reach + 0.5 ? Math.min(count - 1, Math.floor(top)) : -1;
  });
  const levels = Array.from({ length: count }, (_, k) => level.map((value) => Math.round(Math.max(0, Math.min(1, value * count - k)) * 1000) / 1000));
  return { levels, peak };
}
