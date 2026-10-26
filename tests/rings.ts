import { readFileSync } from 'node:fs';
import type { BasicEvent } from '../src/engine/core/beatmap/types';
import { createRingPositionSampler, createRingRotationSampler, deterministicRingRandom, type RingRotationConfig } from '../src/engine/core/lighting/ring-motion';
import { dataFirstRing, firstRingFromLog, newPose, newZoomBlock, poseRingEvents, poseZoomEvents, ringAnimations, ringEnhancements, ringObjectNames, zoomPositions, type RingBlock, type RingSystemInfo, type ZoomSystemInfo } from '../src/editor/rings';
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

// zoom poses: the rings stand their pose's spacing apart once its time is over
const zoomSystem: ZoomSystemInfo = {
  name: 'SmallTrackLaneRings',
  rings: 30,
  position: { positionOffsets: Array(30).fill(14) as number[], initialPositions: Array.from({ length: 30 }, (_, i) => 14 + i * 3.5), minPositionStep: 1, maxPositionStep: 3.5, moveSpeed: 1, name: 'SmallTrackLaneRings' },
  initialStep: 3.5,
};
const zoom = newZoomBlock(zoomSystem, 2, 12);
zoom.poses[1]!.step = 0.6;
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

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
