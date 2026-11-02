import { bakeLights } from '../src/editor/bake';
import type { LightClip } from '../src/editor/model';

/**
 * Clips baked into the game's light events: layers covering each other.
 *
 * npx tsx tests/bake.ts
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
const scheme = { left: [1, 0, 0] as [number, number, number], right: [0, 0, 1] as [number, number, number], white: [1, 1, 1] as [number, number, number] };
const clip = (id: string, start: number, end: number, startMode: LightClip['startMode'], endMode: LightClip['endMode'], layer: number): LightClip => ({ id, type: 1, ids: [2], start, end, startMode, fadeIn: 0.25, endMode, color: { ref: 'right', brightness: 1 }, endColor: null, layer, scope: 'light' });

// a fade out finishing right where a clip on a layer above starts: its end still there (else the
// light stays fully lit until then)
for (const upper of [1, 2]) {
  const out = bakeLights([clip('a', 30, 31, 'on', 'fade', 1), clip('b', 31, 31.5, 'flash', 'fade', upper)], new Map([[1, [1, 2, 3]]]), scheme, 0.4);
  const fadeEnd = out.find((event) => event.beat === 31 && event.value === 4 && event.floatValue === 0);
  const flash = out.findIndex((event) => event.beat === 31 && event.value === 2);
  check(fadeEnd !== undefined && out.indexOf(fadeEnd) < flash, 'fade end kept, before the flash', upper, out);
}

// a clip on a layer above covers what's below while it lasts (the lower one's own start inside it goes)
{
  const out = bakeLights([clip('a', 30.5, 32, 'on', 'off', 1), clip('b', 30, 31, 'on', 'off', 2)], new Map([[1, [1, 2, 3]]]), scheme, 0.4);
  check(!out.some((event) => event.beat > 30 && event.beat < 31), 'covered', out);
}

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
