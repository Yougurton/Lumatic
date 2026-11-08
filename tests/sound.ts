import { soundLevels, splitHz, type SoundSettings, type SoundSource } from '../src/editor/sound-effect';
import { buildEffect, type Effect } from '../src/editor/effects';

let checks = 0;
let failures = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('fail', what, detail);
  }
};

// a made-up song: a kick on every beat (low bands) for its first half, a hat between the beats (high
// bands) for its second; 120 BPM, 50 frames a second
const bands = 40;
const frames = 50 * 8;
const values = new Uint8Array(frames * bands);
for (let f = 0; f < frames; f++) {
  const t = f / 50;
  const kick = t < 4 ? Math.exp(-((t % 0.5) / 0.06)) : 0;
  const hat = t >= 4 ? Math.exp(-(((t + 0.25) % 0.5) / 0.04)) : 0;
  for (let b = 0; b < bands; b++) {
    const u = b / (bands - 1);
    values[f * bands + b] = Math.round(Math.min(1, 0.05 + kick * Math.max(0, 1 - u * 4) + hat * Math.max(0, u * 2 - 1)) * 255);
  }
}
const source: SoundSource = { secondsPerFrame: 0.02, frames, bands, values, lowHz: 30, highHz: 16000 };
const base: SoundSettings = { mode: 'eq', gain: 1, lowHz: 40, highHz: 12000, step: 1 / 16, release: 0.25, delay: 0, peakFall: 0 };
const times = Array.from({ length: 16 * 8 }, (_, k) => k / 8);
const toSeconds = (beat: number) => beat * 0.5;

// the equaliser: the lowest item follows the kick (first half), the highest the hat (second half)
{
  const { levels } = soundLevels(source, base, 4, times, toSeconds, 0.5);
  const mean = (list: number[], from: number, to: number) => list.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);
  check(mean(levels[0]!, 0, 64) > mean(levels[0]!, 64, 128) + 0.2, 'eq: the low item lit by the kick', [mean(levels[0]!, 0, 64), mean(levels[0]!, 64, 128)]);
  check(mean(levels[3]!, 64, 128) > mean(levels[3]!, 0, 64) + 0.2, 'eq: the high item lit by the hat', [mean(levels[3]!, 0, 64), mean(levels[3]!, 64, 128)]);
  check(levels[0]![0]! > 0.7 && levels[0]![4]! < levels[0]![0]!, 'eq: bright on the kick, dimmer between kicks', levels[0]!.slice(0, 8));
  const split = splitHz(40, 12000, 4);
  check(split.length === 4 && Math.abs(split[0]![0] - 40) < 1e-6 && Math.abs(split[3]![1] - 12000) < 1e-3, 'the frequencies split end to end', split);
}

// the meter: more items lit on the kick than between; its top falling back slowly
{
  const { levels, peak } = soundLevels(source, { ...base, mode: 'meter', lowHz: 40, highHz: 300, peakFall: 2 }, 8, times, toSeconds, 0.5);
  const lit = (k: number) => levels.filter((item) => item[k]! > 0.5).length;
  check(lit(0) > lit(4), 'meter: more lit on the kick', [lit(0), lit(4)]);
  check(peak.some((value) => value >= 0), 'meter: a falling top shows', peak.slice(0, 16));
}

// one light by loudness, later on each next item: the second item's peak a delay after the first's
{
  const { levels } = soundLevels(source, { ...base, mode: 'level', lowHz: 40, highHz: 300, delay: 0.25 }, 2, times, toSeconds, 0.5);
  // (the kick on beat 1: the eighth no. 8)
  const first = levels[0]!.slice(5, 13).indexOf(Math.max(...levels[0]!.slice(5, 13)));
  const second = levels[1]!.slice(5, 13).indexOf(Math.max(...levels[1]!.slice(5, 13)));
  check(second - first === 2, 'level: the next item two eighths later', [first, second]);
}

// as an effect: clips on each item, fading from point to point
{
  const effect: Effect = {
    id: 's',
    name: 'eq',
    kind: 'sound',
    type: 0,
    ids: null,
    start: 0,
    end: 8,
    layer: 1,
    params: { color: { ref: 'right', brightness: 1 }, color2: null, hsv: false, startMode: 'on', endMode: 'off', fadeIn: 0.25, pulse: 1, repeats: 1, direction: 'forward', rate: 0.25, duty: 0.5, pattern: 'all', density: 0.3, seed: 1, soundMode: 'eq', soundStep: 1 / 8 },
  };
  const items = Array.from({ length: 4 }, (_, id) => ({ kind: 'light' as const, type: 0, id }));
  const scheme = { left: [1, 0, 0], right: [0, 0, 1], white: [1, 1, 1] } as never;
  const without = buildEffect(effect, items, scheme, { secondsPerBeat: 0.5, ringCount: () => 1 });
  check(without.clips.length === 0, 'no song yet: nothing made', without.clips.length);
  const made = buildEffect(effect, items, scheme, { secondsPerBeat: 0.5, ringCount: () => 1, sound: source });
  check(made.clips.length > 20 && new Set(made.clips.map((clip) => clip.slot)).size === 4, 'clips on all four items', made.clips.length);
  check(made.clips.every((clip) => clip.endColor !== null), 'each a fade to the next point', made.clips.find((clip) => clip.endColor === null));
}

// the direction: backward — the first item takes the highest band; outward — the middle ones the lowest,
// side by side sharing it
{
  const effect: Effect = {
    id: 's2',
    name: 'eq',
    kind: 'sound',
    type: 0,
    ids: null,
    start: 0,
    end: 8,
    layer: 1,
    params: { color: { ref: 'right', brightness: 1 }, color2: null, hsv: false, startMode: 'on', endMode: 'off', fadeIn: 0.25, pulse: 1, repeats: 1, direction: 'forward', rate: 0.25, duty: 0.5, pattern: 'all', density: 0.3, seed: 1, soundMode: 'eq', soundStep: 1 / 8 },
  };
  const items = Array.from({ length: 4 }, (_, id) => ({ kind: 'light' as const, type: 0, id }));
  const scheme = { left: [1, 0, 0], right: [0, 0, 1], white: [1, 1, 1] } as never;
  const extras = { secondsPerBeat: 0.5, ringCount: () => 1, sound: source };
  const bright = (clips: { slot: number; start: number; color: { brightness: number } }[], slot: number, from: number, to: number) => {
    const own = clips.filter((clip) => clip.slot === slot && clip.start >= from && clip.start < to);
    return own.reduce((sum, clip) => sum + clip.color.brightness, 0) / Math.max(1, own.length);
  };
  const forward = buildEffect(effect, items, scheme, extras).clips;
  const backward = buildEffect({ ...effect, params: { ...effect.params, direction: 'backward' } }, items, scheme, extras).clips;
  // (the kick — low bands — in the first half)
  check(bright(forward, 0, 0, 4) > bright(forward, 3, 0, 4), 'forward: the first item low', [bright(forward, 0, 0, 4), bright(forward, 3, 0, 4)]);
  check(bright(backward, 3, 0, 4) > bright(backward, 0, 0, 4), 'backward: the last item low', [bright(backward, 3, 0, 4), bright(backward, 0, 0, 4)]);
  const outward = buildEffect({ ...effect, params: { ...effect.params, direction: 'outward' } }, items, scheme, extras).clips;
  const same = (a: number, b: number) => JSON.stringify(outward.filter((clip) => clip.slot === a).map((clip) => [clip.start, clip.color])) === JSON.stringify(outward.filter((clip) => clip.slot === b).map((clip) => [clip.start, clip.color]));
  check(same(1, 2) && same(0, 3), 'outward: mirrored about the middle');
  check(bright(outward, 1, 0, 4) > bright(outward, 0, 0, 4), 'outward: the middle low', [bright(outward, 1, 0, 4), bright(outward, 0, 0, 4)]);
}

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
