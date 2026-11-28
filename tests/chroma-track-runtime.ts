import { Group } from 'three';
import { ChromaTrackRuntime } from '../src/engine/renderer/map/chroma-track-runtime';
import type { ChromaTrackAnimation } from '../src/engine/core/chroma-environment';
import type { LoadedEnvironment } from '../src/engine/renderer/environment/environment-runtime';

let checks = 0;
let failures = 0;
const check = (ok: boolean, name: string, actual: number) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL', name, actual);
  }
};

const target = new Group();
const root = new Group();
root.add(target);
const animation: ChromaTrackAnimation = {
  jsonTime: 0,
  songBpmTime: 0,
  duration: 1,
  durationSongBpmTime: 1,
  repeat: 0,
  track: ['x'],
  position: [
    { value: [0, 0, 0], time: 0, spline: false },
    { value: [10, 0, 0], time: 1, spline: false },
  ],
};
const second: ChromaTrackAnimation = {
  jsonTime: 3,
  songBpmTime: 3,
  duration: 0,
  durationSongBpmTime: 0,
  repeat: 0,
  track: ['x'],
  position: [{ value: [20, 0, 0], time: 0, spline: false }],
};
const laterBeat: ChromaTrackAnimation = {
  jsonTime: 3,
  songBpmTime: 3,
  duration: 0,
  durationSongBpmTime: 0,
  repeat: 0,
  track: ['y'],
  position: [{ value: [30, 0, 0], time: 0, spline: false }],
};
const earlierBeat: ChromaTrackAnimation = {
  jsonTime: 1,
  songBpmTime: 1,
  duration: 0,
  durationSongBpmTime: 0,
  repeat: 0,
  track: ['y'],
  position: [{ value: [5, 0, 0], time: 0, spline: false }],
};
const secondTarget = new Group();
root.add(secondTarget);
const environment = {
  root,
  data: { fogParams: {} },
  chromaEnvironment: {
    version: 3,
    enhancements: [],
    materials: {},
    animations: [animation, second, laterBeat, earlierBeat],
    componentAnimations: [],
    fogTrackEvents: [],
  },
  chromaTracks: new Map([['x', [target]], ['y', [secondTarget]]]),
} as unknown as LoadedEnvironment;
const runtime = new ChromaTrackRuntime();
runtime.rebuild(environment);
const at = (beat: number, expected: number, name: string) => {
  runtime.update(beat);
  check(Math.abs(target.position.x - expected) < 1e-6, name, target.position.x);
};

at(0.5, 5, 'active animation');
at(1.5, 10, 'completed animation stays at its final value');
at(2.5, 10, 'static target is not reset before the next event');
at(3, 20, 'next event is applied on its beat');
at(0.5, 5, 'backward seek recomputes the active event');

for (const [beat, expected] of [[1, 5], [2, 5], [3, 30], [1.5, 5]]) {
  runtime.update(beat);
  check(secondTarget.position.x === expected, `unsorted track at ${beat}`, secondTarget.position.x);
}

// Noodle AssignTrackParent: a child's own position event that is NEWER than the parent's latest
// position event acts in world space (Heck re-asserts transform.position), so a parent parked far
// below must not displace it — while children without newer positions keep riding the parent.
// (Pictured as Perfect: digit cubes re-positioned after their parent parked stay visible in game;
// its transition tunnel, last positioned before the park, disappears with the parent.)
import { Vector3 } from 'three';
import type { NoodleBeatmapData } from '../src/engine/core/noodle-data';
const childTarget = new Group();
const riderTarget = new Group();
const lateChildTarget = new Group();
const parentRoot = new Group();
parentRoot.add(childTarget);
parentRoot.add(riderTarget);
parentRoot.add(lateChildTarget);
const parentedEnvironment = {
  root: parentRoot,
  data: { fogParams: {} },
  chromaEnvironment: {
    version: 3,
    enhancements: [],
    materials: {},
    animations: [
      // the parent track parks far below at beat 0, like the map's "box" tracks
      {
        jsonTime: 0,
        songBpmTime: 0,
        duration: 0,
        durationSongBpmTime: 0,
        repeat: 0,
        track: ['parkedParent'],
        position: [{ value: [0, -69420, 0], time: 0, spline: false }],
      },
      // the child track sets its own world positions after the park
      {
        jsonTime: 1,
        songBpmTime: 1,
        duration: 0,
        durationSongBpmTime: 0,
        repeat: 0,
        track: ['worldChild'],
        position: [{ value: [4.4, 3.8, 20], time: 1, spline: false }],
      },
      {
        jsonTime: 1.5,
        songBpmTime: 1.5,
        duration: 0,
        durationSongBpmTime: 0,
        repeat: 0,
        track: ['lateChild'],
        position: [{ value: [0, 2, 30], time: 0, spline: false }],
      },
    ],
    componentAnimations: [],
    fogTrackEvents: [],
  },
  chromaTracks: new Map([
    ['worldChild', [childTarget]],
    ['rider', [riderTarget]],
    ['lateChild', [lateChildTarget]],
  ]),
} as unknown as LoadedEnvironment;
const noodle: NoodleBeatmapData = {
  version: 3,
  pointDefinitions: {},
  trackEvents: [
    {
      jsonTime: 0,
      songBpmTime: 0,
      type: 'AnimateTrack',
      tracks: ['parkedParent'],
      duration: 0,
      durationSongBpmTime: 0,
      repeat: 0,
      animation: { position: [{ value: [0, -69420, 0], time: 0 }] },
    },
  ],
  parentEvents: [
    {
      jsonTime: 0.5,
      songBpmTime: 0.5,
      parentTrack: 'parkedParent',
      childrenTracks: ['worldChild', 'rider', 'lateChild'],
      worldPositionStays: true,
      transform: {},
    },
  ],
  playerEvents: [],
  localSpaceSaberTrail: false,
};
const parentedRuntime = new ChromaTrackRuntime();
parentedRuntime.rebuild(parentedEnvironment);
parentedRuntime.update(2, noodle);
const worldOf = (target: Group) => {
  parentRoot.updateWorldMatrix(true, true);
  return target.getWorldPosition(new Vector3());
};
const childWorld = worldOf(childTarget);
check(
  Math.abs(childWorld.x - 4.4) < 1e-6 && Math.abs(childWorld.y - 3.8) < 1e-6 && Math.abs(childWorld.z - -20) < 1e-6,
  'own position event newer than the parent event wins (world)',
  childWorld.y,
);
const lateWorld = worldOf(lateChildTarget);
check(
  Math.abs(lateWorld.x) < 1e-6 && Math.abs(lateWorld.y - 2) < 1e-6 && Math.abs(lateWorld.z - -30) < 1e-6,
  'later child position also wins over the parked parent',
  lateWorld.y,
);
// a child without any position event rides the parked parent (upstream behavior)
const riderWorld = worldOf(riderTarget);
check(Math.abs(riderWorld.y - -69420) < 1e-6, 'property-less child rides the parked parent', riderWorld.y);

// Depth-fighting stabilization: nearly coplanar stacked tracks get a minimum z gap (order kept).
const stackAnimation = (track: string, value: [number, number, number]): ChromaTrackAnimation => ({
  jsonTime: 0,
  songBpmTime: 0,
  duration: 0,
  durationSongBpmTime: 0,
  repeat: 0,
  track: [track],
  position: [{ value, time: 0, spline: false }],
});
const buildStackEnvironment = (animations: ChromaTrackAnimation[], tracks: Map<string, Group[]>) =>
  ({
    root: stackRoot,
    data: { fogParams: {} },
    chromaEnvironment: {
      version: 3,
      enhancements: [],
      materials: {},
      animations,
      componentAnimations: [],
      fogTrackEvents: [],
    },
    chromaTracks: tracks,
  }) as unknown as LoadedEnvironment;
const stackRoot = new Group();
const stackFar = new Group();
const stackNear = new Group();
stackRoot.add(stackFar, stackNear);
const stackRuntime = new ChromaTrackRuntime();
const stackAnimations = [stackAnimation('stackFar', [1, 1, 10]), stackAnimation('stackNear', [1, 1, 10.001])];
stackRuntime.rebuild(
  buildStackEnvironment(stackAnimations, new Map([
    ['stackFar', [stackFar]],
    ['stackNear', [stackNear]],
  ])),
);
stackRuntime.update(0);
const stackGap = Math.abs(stackFar.position.z - stackNear.position.z);
check(stackGap >= 0.04, 'stacked tracks are separated to the depth gap', stackGap);
check(Math.abs(stackFar.position.z) < 10.2 && Math.abs(stackNear.position.z) < 10.2, 'stack separation stays near the original depth', Math.abs(stackNear.position.z));
const gapAfterRepeat = (() => {
  stackRuntime.update(0);
  return Math.abs(stackFar.position.z - stackNear.position.z);
})();
check(gapAfterRepeat >= 0.04, 'stack separation is stable across updates', gapAfterRepeat);

// parked stack values are left untouched
const parkedA = new Group();
const parkedB = new Group();
stackRoot.add(parkedA, parkedB);
const parkedStackRuntime = new ChromaTrackRuntime();
parkedStackRuntime.rebuild(
  buildStackEnvironment(
    [stackAnimation('parkA', [0, -69420, 0]), stackAnimation('parkB', [0, -69420, 0.001])],
    new Map([
      ['parkA', [parkedA]],
      ['parkB', [parkedB]],
    ]),
  ),
);
parkedStackRuntime.update(0);
check(
  parkedA.position.y < -60000 && parkedB.position.y < -60000 && Math.abs(parkedB.position.z) < 0.06,
  'parked stack members stay parked',
  parkedB.position.y,
);

// tracks already separated by more than the gap are untouched
const wideA = new Group();
const wideB = new Group();
stackRoot.add(wideA, wideB);
const wideRuntime = new ChromaTrackRuntime();
wideRuntime.rebuild(
  buildStackEnvironment(
    [stackAnimation('wideA', [2, 2, 10]), stackAnimation('wideB', [2, 2, 10.5])],
    new Map([
      ['wideA', [wideA]],
      ['wideB', [wideB]],
    ]),
  ),
);
wideRuntime.update(0);
check(Math.abs(wideA.position.z - wideB.position.z) > 0.4, 'widely separated tracks are not adjusted', Math.abs(wideA.position.z - wideB.position.z));

// a second rebuild keeps the stabilization working
stackRuntime.rebuild(
  buildStackEnvironment(stackAnimations, new Map([
    ['stackFar', [stackFar]],
    ['stackNear', [stackNear]],
  ])),
);
stackRuntime.update(0);
check(Math.abs(stackFar.position.z - stackNear.position.z) >= 0.04, 'stack separation survives a rebuild', Math.abs(stackFar.position.z - stackNear.position.z));

console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
