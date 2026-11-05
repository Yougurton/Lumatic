import { readFileSync } from 'node:fs';
import type { BasicEvent } from '../src/engine/core/beatmap/types';
import { createRingPositionSampler, createRingRotationSampler, deterministicRingRandom, MEASURED_RING_TICKS, ringTickSeconds, setRingTickRate, type RingRotationConfig } from '../src/engine/core/lighting/ring-motion';
import { dataFirstRing, firstRingFromLog, fitRingBlock, newPose, newRingBlock, newSpinBlock, stepPoses, newZoomBlock, poseRingEvents, poseZoomEvents, ringAnimations, ringEnhancements, ringObjectNames, zoomPositions, type RingBlock, type RingSystemInfo, type ZoomSystemInfo } from '../src/editor/rings';
import type { OutEvent } from '../src/editor/bake';

/**
 * Ring poses land where they're asked to: random ring events (vanilla ones without custom data, and
 * Chroma ones turning either way, some for the other ring system) before each pose, then the pose's
 * event — ChroPaper's ring motion must put the first ring at the pose's angle and the others a step
 * apart. And the ring tracks' turns start from where each ring is.
 *
 * npx tsx tests/rings.ts
 */

const environment = JSON.parse(readFileSync(new URL('../public/environments/DefaultEnvironment.json', import.meta.url), 'utf8')) as {
  objects: { name: string; components?: Record<string, Record<string, unknown>[]> }[];
};
const systems: RingSystemInfo[] = [];
const markers = new Map<number, string[]>();
environment.objects.forEach((object, index) => {
  for (const marker of (object.components?.ChromaIDMarker ?? []) as { ChromaID: string }[]) markers.set(index, [...(markers.get(index) ?? []), marker.ChromaID]);
});
environment.objects.forEach((object, index) => {
  for (const rotation of object.components?.TrackLaneRingsRotation ?? []) {
    const manager = environment.objects[(rotation.Manager as { obj: number }).obj]!;
    const effect = environment.objects.flatMap((candidate) => candidate.components?.TrackLaneRingsRotationEffect ?? []).find((item) => (item.Effect as { obj: number }).obj === index)!;
    const rings = (manager.components!.TrackLaneRingsManager![0]!.Rings as unknown[]).length;
    const config: RingRotationConfig = {
      name: manager.name,
      ringCount: rings,
      startupRotationAngle: rotation.StartupRotationAngle as number,
      startupRotationStep: rotation.StartupRotationStep as number,
      startupPropagationSpeed: rotation.StartupRotationPropagationSpeed as number,
      startupFlexySpeed: rotation.StartupRotationFlexySpeed as number,
      rotationStep: rotation.RotationStep as number,
      counterSpin: rotation.CounterSpin !== 0,
      rotation: effect.Rotation as number,
      step: effect.Step as number,
      stepType: effect.StepType as number,
      propagationSpeed: effect.PropagationSpeed as number,
      flexySpeed: effect.FlexySpeed as number,
    };
    systems.push({ name: manager.name, rings, rotation: config, seed: (rotation.Manager as { obj: number }).obj, ringIds: (manager.components!.TrackLaneRingsManager![0]!.Rings as { obj: number }[]).map((ring) => markers.get(ring.obj) ?? []) });
  }
});

let seed = 7;
const random = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const bpm = 120;
let failures = 0;
let checks = 0;
for (let round = 0; round < 40; round++) {
  // the show's own ring events: some vanilla, some Chroma ones, some named for one system
  const others: OutEvent[] = [];
  // (none in the 2 beats before a pose: the game's own ring events spread their turn slowly along
  // the rings, and a pose right after one — or at its very moment — can't stop it reaching the far
  // rings later; a Chroma one at the moment of a pose is fine: the pose's goes first and wins)
  const poseBeats = [11, 26, 44];
  for (let beat = 0.5; beat < 60; beat += 0.5 + Math.floor(random() * 6)) {
    const kind = random();
    if (poseBeats.some((at) => beat > at - 2 && (beat < at || (beat === at && kind < 0.3)))) continue;
    const customData =
      kind < 0.3
        ? undefined
        : { rotation: Math.round(random() * 180), step: Math.round(random() * 20), prop: 50, speed: 50, direction: random() < 0.5 ? 0 : 1, ...(kind > 0.8 ? { nameFilter: systems[Math.floor(random() * systems.length)]!.name } : {}) };
    others.push({ beat, type: 8, value: 0, floatValue: 1, ...(customData === undefined ? {} : { customData }) });
  }
  if (round % 3 === 0) others.push({ beat: 26, type: 8, value: 0, floatValue: 1, customData: { rotation: 30, step: 5, prop: 50, speed: 50, direction: 0 } });
  others.sort((a, b) => a.beat - b.beat);
  const system = systems[round % systems.length]!;
  const block: RingBlock = {
    id: 'k',
    name: 'test',
    system: system.name,
    mode: 'event',
    start: 3,
    end: 70,
    poses: [8, 23, 41].map((beat, index) => newPose(beat, { shape: index === 1 ? 'same' : 'spiral', angle: Math.round(random() * 720 - 360), step: Math.round(random() * 40 - 20), duration: 0, way: (['short', 'cw', 'ccw'] as const)[index]!, loops: index === 2 ? 1 : 0 })),
  };
  const made = poseRingEvents([block], others, systems, 8, (beat) => beat, 60 / bpm);
  const all: BasicEvent[] = [...made, ...others]
    .sort((a, b) => a.beat - b.beat)
    .map((event) => ({ jsonTime: event.beat, songBpmTime: event.beat, type: event.type, value: event.value, floatValue: event.floatValue, ...(event.customData === undefined ? {} : { customData: event.customData as BasicEvent['customData'] }) }));
  const sampler = createRingRotationSampler(all, bpm, Array(system.rings).fill(0) as number[], system.rotation, deterministicRingRandom(system.seed));
  for (const pose of block.poses) {
    const at = block.start + pose.beat;
    // (just before the next ring event, the pose has settled)
    const next = Math.min(...all.filter((event) => event.songBpmTime > at + 1e-6).map((event) => event.songBpmTime), at + 4);
    const angles = sampler(next - 0.01);
    const step = pose.shape === 'spiral' ? pose.step : 0;
    for (let i = 0; i < system.rings; i += 7) {
      const want = pose.angle + i * step;
      const got = angles[i]!;
      const off = Math.abs((((got - want) % 360) + 540) % 360 - 180);
      checks++;
      if (off > 0.5) {
        failures++;
        if (failures < 6) console.log('off', round, system.name, 'pose', pose.beat, 'ring', i, 'want', want, 'got', got.toFixed(2));
      }
    }
  }
}

// a turn in steps: each step's form reached (ring events, no other ring events in between)
{
  const system = systems[0]!;
  const block: RingBlock = { id: 's', name: 'steps', system: system.name, mode: 'event', start: 2, end: 20, poses: stepPoses({ fromAngle: 0, toAngle: 90, fromStep: 0, toStep: 20, steps: 4, every: 2, turn: 0.5 }) };
  const made = poseRingEvents([block], [], systems, 8, (beat) => beat, 60 / bpm);
  const all: BasicEvent[] = made.map((event) => ({ jsonTime: event.beat, songBpmTime: event.beat, type: event.type, value: event.value, floatValue: event.floatValue, customData: event.customData as BasicEvent['customData'] }));
  const sampler = createRingRotationSampler(all, bpm, Array(system.rings).fill(0) as number[], system.rotation, deterministicRingRandom(system.seed));
  block.poses.forEach((pose, k) => {
    const angles = sampler(block.start + pose.beat + 1.9);
    for (const i of [0, 5]) {
      const want = 22.5 * k + i * 5 * k;
      const off = Math.abs((((angles[i]! - want) % 360) + 540) % 360 - 180);
      checks++;
      if (off > 0.5) {
        failures++;
        console.log('steps off', k, i, want, angles[i]);
      }
    }
  });
}

// ring tracks: each turn starts where the ring is, also when a turn cuts the one before it short
const tracks: RingBlock = {
  id: 't',
  name: 'tracks',
  system: systems[1]!.name,
  mode: 'tracks',
  start: 0,
  end: 16,
  poses: [newPose(0, { shape: 'same', angle: 90, duration: 4, easing: 'easeLinear' }), newPose(2, { shape: 'same', angle: 0, duration: 2, easing: 'easeLinear' })],
};
const animations = ringAnimations([tracks], systems).filter((animation) => animation.track.endsWith(':0'));
const second = animations[1]!.localRotation;
checks++;
if (Math.abs(second[0]![2] - 45) > 1e-6 || Math.abs(second.at(-1)![2]) > 1e-6) {
  failures++;
  console.log('track turn', JSON.stringify(animations));
}
const loop: RingBlock = { ...tracks, poses: [newPose(0, { shape: 'same', angle: 0, duration: 2, loops: 1, way: 'ccw', easing: 'easeLinear' })] };
const points = ringAnimations([loop], systems)[0]!.localRotation;
checks++;
if (points.length !== 5 || points.at(-1)![2] !== 360) {
  failures++;
  console.log('loop points', JSON.stringify(points));
}

// relative poses: 90°, then +15 → 105°, then −45 → 60° (ring events, with a show's ring event between
// them that the turn adds to; ring tracks)
{
  const system = systems[0]!;
  const block: RingBlock = {
    id: 'r',
    name: 'relative',
    system: system.name,
    mode: 'event',
    start: 2,
    end: 22,
    poses: [newPose(0, { shape: 'same', angle: 90, duration: 0 }), newPose(4, { shape: 'same', angle: 15, duration: 0, relative: true }), newPose(10, { shape: 'spiral', angle: -45, step: 10, duration: 0, relative: true })],
  };
  const others = [{ beat: 9, type: 8, value: 0, floatValue: 1, customData: { rotation: 20, step: 0, prop: 50, speed: 50, direction: 0 } }];
  const made = poseRingEvents([block], others, systems, 8, (beat) => beat, 60 / bpm);
  const all: BasicEvent[] = [...made, ...others]
    .sort((a, b) => a.beat - b.beat)
    .map((event) => ({ jsonTime: event.beat, songBpmTime: event.beat, type: event.type, value: event.value, floatValue: event.floatValue, customData: event.customData as BasicEvent['customData'] }));
  const sampler = createRingRotationSampler(all, bpm, Array(system.rings).fill(0) as number[], system.rotation, deterministicRingRandom(system.seed));
  const first = (beat: number) => sampler(beat)[0]!;
  const want: [number, number][] = [[5.9, 90], [8.9, 105], [11.9, 125], [16, 80]];
  for (const [beat, angle] of want) {
    checks++;
    const off = Math.abs((((first(beat) - angle) % 360) + 540) % 360 - 180);
    if (off > 0.5) {
      failures++;
      console.log('relative off', beat, angle, first(beat));
    }
  }
  checks++;
  if (Math.abs(sampler(16)[3]! - (80 + 30)) > 0.5) {
    failures++;
    console.log('relative spiral', sampler(16)[3]);
  }
  const lanes = ringAnimations([{ ...block, id: 'rt', mode: 'tracks', system: systems[1]!.name }], systems).filter((animation) => animation.track.endsWith(':0'));
  const ends = lanes.map((animation) => animation.localRotation.at(-1)![2]);
  checks++;
  if (JSON.stringify(ends) !== JSON.stringify([90, 105, 60])) {
    failures++;
    console.log('relative tracks', JSON.stringify(ends));
  }
}

// relative steps: a spiral of 10° per ring, then +5 → 15°, then −20 → −5° (ring events and tracks)
{
  const system = systems[0]!;
  const block: RingBlock = {
    id: 'rs',
    name: 'relative steps',
    system: system.name,
    mode: 'event',
    start: 2,
    end: 22,
    poses: [newPose(0, { shape: 'spiral', angle: 0, step: 10, duration: 0 }), newPose(4, { shape: 'spiral', angle: 0, step: 5, duration: 0, relativeStep: true }), newPose(10, { shape: 'spiral', angle: 15, step: -20, duration: 0, relative: true, relativeStep: true })],
  };
  const made = poseRingEvents([block], [], systems, 8, (beat) => beat, 60 / bpm);
  const steps = made.map((event) => (event.customData as { step: number }).step);
  checks++;
  if (JSON.stringify(steps) !== JSON.stringify([10, 15, -5])) {
    failures++;
    console.log('relative steps (events)', JSON.stringify(steps));
  }
  const all: BasicEvent[] = made.map((event) => ({ jsonTime: event.beat, songBpmTime: event.beat, type: event.type, value: event.value, floatValue: event.floatValue, customData: event.customData as BasicEvent['customData'] }));
  const sampler = createRingRotationSampler(all, bpm, Array(system.rings).fill(0) as number[], system.rotation, deterministicRingRandom(system.seed));
  for (const [beat, first, step] of [[5.9, 0, 10], [11.9, 0, 15], [16, 15, -5]] as const) {
    const angles = sampler(beat);
    checks++;
    const off = (want: number, got: number) => Math.abs((((got - want) % 360) + 540) % 360 - 180);
    if (off(first, angles[0]!) > 0.5 || off(first + 4 * step, angles[4]!) > 0.5) {
      failures++;
      console.log('relative steps sampled', beat, angles[0], angles[4]);
    }
  }
  const tracked = ringAnimations([{ ...block, id: 'rst', mode: 'tracks', system: systems[1]!.name }], systems).filter((animation) => animation.track.endsWith(':4'));
  const ends = tracked.map((animation) => animation.localRotation.at(-1)![2]);
  checks++;
  if (JSON.stringify(ends) !== JSON.stringify([40, 60, -5])) {
    failures++;
    console.log('relative steps (tracks)', JSON.stringify(ends));
  }
}

// ring events along an easing: an overshoot passes the angle and comes back; a bounce ends on it
{
  const system = systems[0]!;
  const posed = (easing: string): RingBlock => ({
    id: 'e' + easing,
    name: 'eased',
    system: system.name,
    mode: 'event',
    start: 2,
    end: 12,
    poses: [newPose(0, { shape: 'same', angle: 0, duration: 0 }), newPose(1, { shape: 'same', angle: 90, duration: 2, eventEasing: easing })],
  });
  const sample = (block: RingBlock) => {
    const made = poseRingEvents([block], [], systems, 8, (beat) => beat, 60 / bpm);
    const all: BasicEvent[] = made.map((event) => ({ jsonTime: event.beat, songBpmTime: event.beat, type: event.type, value: event.value, floatValue: event.floatValue, customData: event.customData as BasicEvent['customData'] }));
    return { count: made.length, at: createRingRotationSampler(all, bpm, Array(system.rings).fill(0) as number[], system.rotation, deterministicRingRandom(system.seed)) };
  };
  const off = (want: number, got: number) => Math.abs((((got - want) % 360) + 540) % 360 - 180);
  const back = sample(posed('easeOutBack'));
  const peak = Math.max(...Array.from({ length: 40 }, (_, k) => back.at(3 + (k * 2) / 40)[0]!));
  checks++;
  if (!(peak > 92) || off(90, back.at(6)[0]!) > 0.5 || back.count < 10) {
    failures++;
    console.log('eased overshoot', peak, back.at(6)[0], back.count);
  }
  // the turn glides along the easing: close to it all the way, not stepping on and standing
  const eased = sample(posed('easeInOutQuad'));
  const curve = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  let worst = 0;
  let still = 0;
  const samples = 400;
  for (let k = 1; k < samples; k++) {
    const beat = 3 + (k * 2) / samples;
    worst = Math.max(worst, off(90 * curve((beat - 3) / 2), eased.at(beat)[0]!));
    if (k > 20 && k < samples - 20 && Math.abs(eased.at(beat)[0]! - eased.at(beat - 2 / samples)[0]!) < 0.02) still++;
  }
  checks++;
  if (worst > 6 || still > samples * 0.05) {
    failures++;
    console.log('eased glide', worst, still, eased.count);
  }
  const bounce = sample(posed('easeOutBounce'));
  checks++;
  if (off(90, bounce.at(6)[0]!) > 0.5) {
    failures++;
    console.log('eased bounce end', bounce.at(6)[0]);
  }
}

// the game's rule for the base: an event coming while an earlier, slow turn still holds the first ring
// counts from that turn's angle — three 45° turns two ticks apart (prop 0.05) end at 90°, not 135°
{
  const system = systems[0]!;
  const tickBeats = (ringTickSeconds() * bpm) / 60;
  const three: BasicEvent[] = [0, 2, 4].map((k) => ({ jsonTime: 4 + k * tickBeats, songBpmTime: 4 + k * tickBeats, type: 8, value: 0, floatValue: 1, customData: { rotation: 45, step: 0, prop: 0.05, speed: 50, direction: 0 } as BasicEvent['customData'] }));
  const before = createRingRotationSampler([], bpm, Array(system.rings).fill(0) as number[], system.rotation, deterministicRingRandom(system.seed))(3.9)[0]!;
  const after = createRingRotationSampler(three, bpm, Array(system.rings).fill(0) as number[], system.rotation, deterministicRingRandom(system.seed))(60);
  checks++;
  if (Math.abs(after[0]! - before - 90) > 0.5 || Math.abs(after[system.rings - 1]! - before - 90) > 0.5) {
    failures++;
    console.log('held first ring', before, after[0], after.at(-1));
  }
}

// a spring along a slow wave (each turn holding the first ring for many ticks) still lands where it's
// asked — the events counted from where the game has the first ring — at the game's ticks and at Unity's usual 50
for (const rate of [MEASURED_RING_TICKS, 50]) {
  setRingTickRate(rate);
  const system = systems[0]!;
  const block: RingBlock = {
    id: 'slow' + String(rate),
    name: 'slow',
    system: system.name,
    mode: 'event',
    start: 2,
    end: 20,
    poses: [newPose(0, { shape: 'same', angle: 0, duration: 0 }), newPose(1, { shape: 'spiral', angle: 120, step: 10, duration: 3, delay: 4, eventEasing: 'easeOutBack' })],
  };
  const made = poseRingEvents([block], [], systems, 8, (beat) => beat, 60 / bpm);
  const all: BasicEvent[] = made.map((event) => ({ jsonTime: event.beat, songBpmTime: event.beat, type: event.type, value: event.value, floatValue: event.floatValue, customData: event.customData as BasicEvent['customData'] }));
  const at = createRingRotationSampler(all, bpm, Array(system.rings).fill(0) as number[], system.rotation, deterministicRingRandom(system.seed))(16);
  const off = (want: number, got: number) => Math.abs((((got - want) % 360) + 540) % 360 - 180);
  checks++;
  if (off(120, at[0]!) > 0.5 || off(120 + 10 * (system.rings - 1), at[system.rings - 1]!) > 0.5 || made.length < 10) {
    failures++;
    console.log('slow spring', rate, made.length, at[0], at.at(-1));
  }
}
setRingTickRate(MEASURED_RING_TICKS);

const check1 = (ok: boolean, ...what: unknown[]) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('fail', ...what);
  }
};

// a ring block as long as its poses take: longer when they run past it, shorter when they're over before it
{
  const block = newRingBlock('X', 'event', 4, 8);
  check1(block.poses.length === 1 && block.poses[0]!.duration === 4, 'a new turn block: one pose over its length', block.poses);
  block.poses[0]!.duration = 1;
  fitRingBlock(block);
  check1(Math.abs(block.end - 5) < 1e-9, 'shortened to its pose', block.end);
  block.poses.push(newPose(2, { duration: 1.5, delay: 2 }));
  fitRingBlock(block);
  check1(Math.abs(block.end - 9.5) < 1e-9, 'made long enough for a turn and its wave', block.end);
}

// zoom poses: the rings stand their pose's spacing apart once its time is over
const zoomSystem: ZoomSystemInfo = {
  name: 'SmallTrackLaneRings',
  rings: 30,
  position: { positionOffsets: Array(30).fill(14) as number[], initialPositions: Array.from({ length: 30 }, (_, i) => 14 + i * 3.5), minPositionStep: 1, maxPositionStep: 3.5, moveSpeed: 1, name: 'SmallTrackLaneRings' },
  initialStep: 3.5,
};
const zoom = newZoomBlock(zoomSystem, 2, 12);
check1(zoom.poses.length === 1 && zoom.poses[0]!.duration === 10, 'a new zoom block: one pose over its length', zoom.poses);
zoom.poses = [newPose(0, { step: 3.5, duration: 1 }), newPose(5, { step: 0.6, duration: 1 })];
const zoomEvents = poseZoomEvents([zoom], [zoomSystem], 9, 60 / bpm).map((event) => ({ jsonTime: event.beat, songBpmTime: event.beat, type: 9, value: 0, floatValue: 1, customData: event.customData as BasicEvent['customData'] }));
const positions = createRingPositionSampler(zoomEvents, bpm, zoomSystem.position);
for (const pose of zoom.poses) {
  const at = zoom.start + pose.beat + pose.duration + 0.4;
  const want = zoomPositions(zoomSystem, pose.step);
  const got = positions(at);
  for (let i = 0; i < 30; i += 7) {
    checks++;
    if (Math.abs(got[i]! - want[i]!) > 0.05 * Math.max(1, want[i]!)) {
      failures++;
      console.log('zoom off', pose.step, i, want[i], got[i]);
    }
  }
}

// the rings found where the game puts them: every GameCore place moved by the same amount
const first = dataFirstRing(systems)!;
const moved = ringEnhancements([{ ...tracks, system: systems[0]!.name }], systems, first + 7);
const placeOf = (id: string) => [...id.matchAll(/GameCore\\\.\\\[(\d+)\\\]/gu)].map((match) => Number(match[1]));
const original = ringEnhancements([{ ...tracks, system: systems[0]!.name }], systems);
checks++;
if (moved.length === 0 || moved.some((item, i) => placeOf(item.id).join() !== placeOf(original[i]!.id).map((place) => place + 7).join() || placeOf(item.id).length === 0)) {
  failures++;
  console.log('moved ids', moved[0]?.id, original[0]?.id);
}
// …and the place read from a Chroma debug listing in a game log (the last one in it)
const names = ringObjectNames(systems);
const log = [
  `[DEBUG @ 10:00:00 | Chroma] GameCore.[300]${names[0]!}`,
  ...Array.from({ length: 300 }, () => 'noise'),
  `[DEBUG @ 10:05:00 | Chroma] DefaultEnvironment.[0]Environment`,
  `[DEBUG @ 10:05:00 | Chroma] GameCore.[612]${names[0]!}`,
  `[DEBUG @ 10:05:00 | Chroma] GameCore.[612]${names[0]!}.[0]Ring`,
  `[DEBUG @ 10:05:00 | Chroma] GameCore.[611]${names[0]!}`,
  `[DEBUG @ 10:05:00 | Chroma] GameCore.[640]Something(Clone)`,
].join('\n');
checks++;
if (firstRingFromLog(log, names) !== 611 || firstRingFromLog('nothing', names) !== undefined) {
  failures++;
  console.log('log place', firstRingFromLog(log, names));
}

// spins: the rings turn at an even speed between the ramps, and end turned speed × the beats at full speed
{
  const system = systems[0]!;
  const spin = newSpinBlock(system.name, 'rotation', 4, 12);
  spin.spin!.speed = 60;
  spin.spin!.twist = 2;
  const made = poseRingEvents([spin], [], systems, 8, (beat) => beat, 60 / bpm);
  const all: BasicEvent[] = made.map((event) => ({ jsonTime: event.beat, songBpmTime: event.beat, type: event.type, value: event.value, floatValue: event.floatValue, customData: event.customData as BasicEvent['customData'] }));
  const at = createRingRotationSampler(all, bpm, Array(system.rings).fill(0) as number[], system.rotation, deterministicRingRandom(system.seed));
  const rates = [6, 7, 8, 9].map((beat) => (at(beat + 0.5)[0]! - at(beat)[0]!) / 0.5);
  const turned = at(13)[0]! - at(3.9)[0]!;
  const twisted = at(13)[1]! - at(13)[0]! - (at(3.9)[1]! - at(3.9)[0]!);
  check1(rates.every((rate) => Math.abs(rate - 60) < 8) && Math.abs(turned - 60 * 7) < 2 && Math.abs(twisted - 14) < 0.5, 'a spin: even speed, turned and twisted as set', { rates, turned, twisted, events: made.length });
  const zoomSpin = newSpinBlock('', 'zoom', 4, 12);
  zoomSpin.spin!.zoom = 'drift';
  zoomSpin.spin!.rate = 0.25;
  const zoomMade = poseZoomEvents([zoomSpin], [zoomSystem], 9, 60 / bpm).map((event) => ({ jsonTime: event.beat, songBpmTime: event.beat, type: 9, value: 0, floatValue: 1, customData: event.customData as BasicEvent['customData'] }));
  const zoomAt = createRingPositionSampler(zoomMade, bpm, zoomSystem.position);
  const spacing = (beat: number) => zoomAt(beat)[1]! - zoomAt(beat)[0]!;
  check1(Math.abs(spacing(13) - (3.5 + 0.25 * 7)) < 0.05, 'a zoom spin one way: the spacing grown by rate × beats at full speed', spacing(13));
}

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
