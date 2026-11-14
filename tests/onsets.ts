import { BANDS, bandFlux, pickOnsets } from '../src/editor/onsets';

/**
 * Hits found by band in a made-up beat: a kick on every beat, a snare on 2 and 4, hi-hats between —
 * each band finds its own drum, at the right time.
 *
 * npx tsx tests/onsets.ts
 */

let failures = 0;
let checks = 0;
const check = (ok: boolean, ...what: unknown[]) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('fail', ...what);
  }
};

const rate = 44100;
const seconds = 16;
const song = new Float32Array(rate * seconds);
let seed = 7;
const noise = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed / 2147483647) * 2 - 1;
};
const beat = 0.5;
const start = 0.25;
const kicks: number[] = [];
const snares: number[] = [];
const hats: number[] = [];
for (let k = 0; start + k * beat < seconds - 0.5; k++) {
  const at = start + k * beat;
  kicks.push(at);
  if (k % 2 === 1) snares.push(at);
  hats.push(at + beat / 2);
}
// a pad under it all (a steady chord: no hits)
for (let i = 0; i < song.length; i++) song[i]! += 0.05 * (Math.sin((2 * Math.PI * 440 * i) / rate) + Math.sin((2 * Math.PI * 554 * i) / rate));
const add = (at: number, length: number, sample: (t: number) => number) => {
  const from = Math.round(at * rate);
  for (let i = 0; i < length * rate && from + i < song.length; i++) song[from + i]! += sample(i / rate);
};
for (const at of kicks) add(at, 0.25, (t) => 0.8 * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12));
for (const at of snares) add(at, 0.2, (t) => (0.35 * noise() + 0.3 * Math.sin(2 * Math.PI * 200 * t)) * Math.exp(-t * 20));
// (hats: noise, high-passed by differencing twice)
let a = 0;
let b = 0;
for (const at of hats)
  add(at, 0.06, (t) => {
    const n = noise();
    const out = n - 2 * a + b;
    b = a;
    a = n;
    return 0.12 * out * Math.exp(-t * 60);
  });

const band = (id: string) => BANDS.find((item) => item.id === id)!;
const result = bandFlux([song], rate, [kicks, snares, hats].map((_, index) => [band(['kick', 'snare', 'hats'][index]!).lowHz, band(['kick', 'snare', 'hats'][index]!).highHz]));
const match = (name: string, found: number[], expected: number[], tolerance = 0.03) => {
  const hits = expected.filter((time) => found.some((at) => Math.abs(at - time) < tolerance)).length;
  const extra = found.filter((at) => !expected.some((time) => Math.abs(at - time) < tolerance)).length;
  check(hits >= expected.length - 1 && extra <= 1, name, 'hits', hits, 'of', expected.length, 'extra', extra);
  const errors = found.flatMap((at) => expected.filter((time) => Math.abs(at - time) < tolerance).map((time) => at - time));
  const mean = errors.reduce((s, e) => s + e, 0) / Math.max(1, errors.length);
  check(Math.abs(mean) < 0.015, name, 'timing', mean.toFixed(4));
};
const times = (index: number, sensitivity = 0.5, gap = 0.1) => pickOnsets(result.flux[index]!, result.fps, result.offset, sensitivity, gap).map((onset) => onset.time);
match('kick', times(0, band('kick').sensitivity), kicks);
match('snare', times(1, band('snare').sensitivity), snares);
// (a snare has its highs too)
match('hats', times(2), [...hats, ...snares]);
// the sensitivity: lower finds no more than higher
check(times(2, 0.1).length <= times(2, 0.9).length, 'sensitivity');
// a stretch of the song only
const part = pickOnsets(result.flux[0]!, result.fps, result.offset, 0.5, 0.1, 4, 8);
check(part.every((onset) => onset.time >= 4 && onset.time <= 8) && part.length >= 7, 'range', part.length);

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
