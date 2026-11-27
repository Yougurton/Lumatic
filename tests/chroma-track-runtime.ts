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

console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
