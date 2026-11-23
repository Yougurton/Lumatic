import { createLightRotationSampler } from '../src/engine/core/lighting/light-rotation';
import type { BasicEvent } from '../src/engine/core/beatmap/types';
import { DEFAULT_LASER_MOVE, laserEvents, type LaserMove } from '../src/editor/lasers';

/**
 * The lasers' moves as the viewer turns them (its sampler does what Chroma does with these events):
 * steps of a set angle end at that angle times the steps, from the row; spinning from the row goes at
 * the speed asked; a stop with lockRotation keeps the angle.
 *
 * npx tsx tests/lasers.ts
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

const bpm = 120;
const seconds = (beat: number) => (beat * 60) / bpm;
const angleAt = (move: LaserMove, type: number, beat: number) => {
  const events = laserEvents(move, 4, seconds)
    .filter((event) => event.type === type)
    .map((event): BasicEvent => ({ jsonTime: event.beat, songBpmTime: event.beat, type: event.type, value: event.value, floatValue: event.floatValue, customData: event.customData as BasicEvent['customData'] }));
  // (the random angle and direction: never 0, so a row that isn't one shows)
  return createLightRotationSampler(events, bpm, 1, () => 0.7, type === 12)(beat);
};

// steps: 4 × 45° from the row, the turn a quarter of a beat
const steps: LaserMove = { ...DEFAULT_LASER_MOVE, mode: 'steps', angle: 45, steps: 4, every: 1, turn: 0.25, fromRow: true, direction: 0 };
check(Math.abs(Math.abs(angleAt(steps, 13, 4.5)) - 45) < 0.5, 'first step', angleAt(steps, 13, 4.5));
check(Math.abs(Math.abs(angleAt(steps, 13, 10)) - 180) < 1, 'all steps', angleAt(steps, 13, 10));
// still between steps
check(Math.abs(angleAt(steps, 13, 4.6) - angleAt(steps, 13, 4.9)) < 1e-6, 'held between steps');
// left and right turn opposite ways (direction 0)
check(Math.sign(angleAt(steps, 12, 10)) === -Math.sign(angleAt(steps, 13, 10)), 'mirrored sides');
// an odd tempo and a turn as long as the step (no stops between)
const smooth: LaserMove = { ...steps, angle: 30, steps: 3, every: 0.5, turn: 0.5 };
check(Math.abs(Math.abs(angleAt(smooth, 13, 8)) - 90) < 1, 'continuous steps', angleAt(smooth, 13, 8));
// spinning from the row: speed 3 → 60° a second, half a second a beat
const spin: LaserMove = { ...DEFAULT_LASER_MOVE, mode: 'spin', speed: 3, from: 'row', length: 2, end: 'freeze', direction: 1 };
check(Math.abs(Math.abs(angleAt(spin, 13, 5)) - 30) < 0.5, 'spin speed', angleAt(spin, 13, 5));
check(Math.abs(Math.abs(angleAt(spin, 13, 9)) - 60) < 0.5, 'frozen at the end', angleAt(spin, 13, 9));
// a speed that isn't whole: Chroma's exact speed on the event
const exact = laserEvents({ ...spin, speed: 2.5 }, 0, seconds).find((event) => event.value > 0)!;
check(exact.value === 3 && exact.customData?.speed === 2.5 && exact.customData.lockRotation === true, 'exact speed', exact);
// swaying: 30° either way, there and back in 2 beats, for 4 beats — at a quarter of a sway it's 30° out,
// half way back at the start, three quarters 30° the other way, at the end where it started
const sway: LaserMove = { ...DEFAULT_LASER_MOVE, mode: 'sway', angle: 30, every: 2, length: 4, fromRow: true, end: 'freeze', direction: 0 };
check(Math.abs(Math.abs(angleAt(sway, 13, 4.5)) - 30) < 1.5, 'sway out', angleAt(sway, 13, 4.5));
check(Math.abs(angleAt(sway, 13, 5)) < 1.5, 'sway back', angleAt(sway, 13, 5));
check(Math.abs(angleAt(sway, 13, 5.5) + angleAt(sway, 13, 4.5)) < 2, 'sway the other way', angleAt(sway, 13, 5.5));
check(Math.abs(angleAt(sway, 13, 9)) < 2, 'sway ends where it began', angleAt(sway, 13, 9));

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
