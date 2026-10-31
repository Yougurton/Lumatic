import { easingFromName } from '../engine/core/easing';
import type { LaserMove } from './lasers';
import { deterministicRingRandom, matchesRingName, type RingPositionConfig, type RingRotationConfig } from '../engine/core/lighting/ring-motion';
import type { OutEvent } from './bake';
import { newId } from './model';

/**
 * Ring poses: where the rings of a ring system stand, set exactly — a block on the timeline's "ring
 * poses" row holding poses one after another, each turning the rings to it over its own time.
 *
 * A pose is an angle per ring: all the same, a spiral (a step from ring to ring), a wave, every
 * other one, at random, or set ring by ring by hand. Two ways to play it in the game:
 *
 * - 'event' — one Chroma ring event per pose. The rings of a system can only ever stand in a spiral
 *   that way (the first ring's angle and a step), so only those two shapes; the event's turn is
 *   worked out from everything the rings were told before (ring events add up), so the pose lands
 *   exactly where it is asked to whatever came before it. The time a turn takes and the wave along
 *   the rings become the event's speed and propagation.
 * - 'tracks' — every ring on a Chroma track of its own (environment enhancements) and turned by
 *   AnimateTrack: any shape, any easing, ring by ring. Chroma adds the ring events' turn on top of
 *   what the track sets (its TrackLaneRingOffset), so both kinds can be used together.
 *
 * Angles are degrees: Chroma's, a larger one turning a ring counterclockwise as the player sees it
 * (ring events' direction 0 adds to the angle).
 *
 * Zoom blocks ('zoom') do the same for how far apart the rings stand: each pose a spacing (Chroma's
 * zoom event step — the distance from ring to ring), reached over its time (the event's speed).
 * Zoom events set the spacing outright, so they land exactly anyway.
 */

export type PoseShape = 'same' | 'spiral' | 'wave' | 'alternate' | 'random' | 'manual';
export type TurnWay = 'short' | 'cw' | 'ccw';

export interface RingPose {
  id: string;
  /** Beats from the block's start. */
  beat: number;
  /** How long the turn to it takes (beats; 0: at once). */
  duration: number;
  /** Chroma's easing name ('tracks' only). */
  easing: string;
  /** Which way the rings turn to it: the shorter way, or always one way ('ccw': the angle grows). */
  way: TurnWay;
  /** Whole turns on top. */
  loops: number;
  shape: PoseShape;
  /** The first ring's angle (the middle one for a wave). */
  angle: number;
  /** spiral: from ring to ring; wave / alternate / random: how far from `angle` they go. */
  step: number;
  /** wave: how many waves along the rings; its phase (degrees). */
  periods: number;
  phase: number;
  seed: number;
  /** manual: each ring's angle. */
  manual: number[];
  /** The turn runs along the rings: from the first ring to the last over this many beats. */
  delay: number;
  /** …from the last ring to the first. */
  reverse: boolean;
  /** `angle` is a turn from where the first ring was headed before it (+15: 15° further
   *  counterclockwise), not where it ends up. */
  relative?: boolean;
  /** A spiral's `step` is added to the step the rings had before it (+5 after 10: 15). */
  relativeStep?: boolean;
  /** Ring events: how the turn goes — none: the game's own (closing in, slowing down); an easing: the
   *  turn made of short ring events along it (a spring, a bounce, an overshoot…). */
  eventEasing?: string;
}

export interface RingBlock {
  id: string;
  /** Turning the rings (the default), spacing them out, or turning the rotating lasers. */
  kind?: 'rotation' | 'zoom' | 'lasers';
  name: string;
  /** The ring system (its name — Chroma's nameFilter); '' for 'event': every ring system. */
  system: string;
  mode: 'event' | 'tracks';
  start: number;
  end: number;
  poses: RingPose[];
  /** Made by "Rings in steps" from these settings (gone once its poses are changed by hand). */
  steps?: StepTransition;
  /** Made by "Ring glitch" from these settings (the same). */
  glitch?: RingGlitch;
  /** A lasers block: what they do (its length decides how long they spin / how many steps). */
  lasers?: LaserMove;
}

/** What making ring poses needs to know about the environment's ring systems. */
export interface RingSystemInfo {
  name: string;
  rings: number;
  rotation: RingRotationConfig;
  seed: number;
  /** Per ring, the ids Chroma's environment lookups find it by. */
  ringIds: string[][];
}

export const SHAPES: [PoseShape, string][] = [
  ['same', 'Ровно'],
  ['spiral', 'Спираль'],
  ['wave', 'Волна'],
  ['alternate', 'Через одно'],
  ['random', 'Случайно'],
  ['manual', 'Вручную'],
];

/** What making zoom poses needs to know about a ring system that zooms. */
export interface ZoomSystemInfo {
  name: string;
  rings: number;
  position: RingPositionConfig;
  /** The spacing the rings start with. */
  initialStep: number;
}

export const isZoom = (block: RingBlock) => block.kind === 'zoom';
export const isLasers = (block: RingBlock) => block.kind === 'lasers';
/** A block turning the rings (not a zoom, not lasers). */
export const isTurn = (block: RingBlock) => block.kind !== 'zoom' && block.kind !== 'lasers';

/** The shapes ring events can make. */
export const EVENT_SHAPES = new Set<PoseShape>(['same', 'spiral']);

export const EASINGS: [string, string][] = [
  ['easeLinear', 'Линейно'],
  ['easeInQuad', 'Разгон'],
  ['easeOutQuad', 'Торможение'],
  ['easeInOutQuad', 'Разгон и торможение'],
  ['easeInOutSine', 'Мягко (синус)'],
  ['easeOutCubic', 'Сильное торможение'],
  ['easeInOutCubic', 'Сильный разгон и торможение'],
  ['easeOutBack', 'С перелётом'],
  ['easeOutElastic', 'Пружина'],
  ['easeOutBounce', 'Отскок'],
  ['easeStep', 'Рывком в конце'],
];

export function newPose(beat: number, patch: Partial<RingPose> = {}): RingPose {
  return { id: newId('p'), beat, duration: 1, easing: 'easeInOutQuad', way: 'short', loops: 0, shape: 'spiral', angle: 0, step: 15, periods: 1, phase: 0, seed: 1, manual: [], delay: 0, reverse: false, ...patch };
}

export function newRingBlock(system: string, mode: RingBlock['mode'], start: number, end: number): RingBlock {
  const length = Math.max(1, end - start);
  return {
    id: newId('k'),
    name: 'Позы колец',
    system,
    mode,
    start,
    end: start + length,
    poses: [newPose(0, { shape: 'same', angle: 0, step: 0, duration: Math.min(1, length / 2) }), newPose(Math.min(length, Math.max(1, length / 2)), { shape: 'spiral', angle: 45, step: 15, duration: Math.min(1, length / 2) })],
  };
}

/** A turn from one form to another in even steps: the rings stand still between them. */
export interface StepTransition {
  /** The first ring's angle at the start and at the end. */
  fromAngle: number;
  toAngle: number;
  /** The spiral (degrees from ring to ring) at the start and at the end. */
  fromStep: number;
  toStep: number;
  /** How many steps from the first form to the last. */
  steps: number;
  /** Beats from one step to the next. */
  every: number;
  /** Beats each step's turn takes (the speed). */
  turn: number;
}

export const DEFAULT_STEPS: StepTransition = { fromAngle: 0, toAngle: 90, fromStep: 0, toStep: 15, steps: 4, every: 1, turn: 0.5 };

/** The poses of a step transition (the first: its start form). */
export function stepPoses(transition: StepTransition): RingPose[] {
  const steps = Math.max(1, Math.round(transition.steps));
  const every = Math.max(1 / 64, transition.every);
  // (0: at once — the rings jump there)
  const turn = Math.max(0, Math.min(transition.turn, every));
  return Array.from({ length: steps + 1 }, (_, k) => {
    const t = k / steps;
    const step = transition.fromStep + (transition.toStep - transition.fromStep) * t;
    return newPose(Math.round(k * every * 100000) / 100000, {
      shape: Math.abs(step) < 1e-6 ? 'same' : 'spiral',
      angle: round(transition.fromAngle + (transition.toAngle - transition.fromAngle) * t),
      step: round(step),
      duration: turn,
      easing: 'easeInOutQuad',
    });
  });
}

/** A block of a step transition (as long as its steps). */
export function newStepsBlock(system: string, mode: RingBlock['mode'], start: number, transition: StepTransition = DEFAULT_STEPS): RingBlock {
  const poses = stepPoses(transition);
  const length = Math.max(1, poses.at(-1)!.beat + poses.at(-1)!.duration);
  return { id: newId('k'), name: 'Кольца по шагам', system, mode, start, end: start + length, poses, steps: { ...transition } };
}

/** Rings jerking about at random (scratches, glitches in the song). */
export interface RingGlitch {
  /** Beats the block lasts. */
  length: number;
  /** A jerk every this many beats (some left out), or at the song's hits (`hits`, beats from the
   *  block's start). */
  every: number;
  hits?: number[];
  /** How far the rings jerk (degrees, either way). */
  strength: number;
  /** How far apart the rings go (degrees from ring to ring, either way; 0: all as one). */
  chaos: number;
  /** Each jerk's share of the time to the next (small: snaps). */
  snap: number;
  seed: number;
  /** Back to where they were at the end. */
  back: boolean;
  /** The band of the song the hits were found in (the dialog's choice). */
  band?: string;
}

export const DEFAULT_GLITCH: RingGlitch = { length: 4, every: 0.125, strength: 35, chaos: 12, snap: 0.3, seed: 1, back: true };

/** The poses of a glitch (`mode`: per ring, the rings can each go their own way). */
export function glitchPoses(glitch: RingGlitch, mode: RingBlock['mode']): RingPose[] {
  let state = (glitch.seed * 9301 + 49297) % 233280 || 1;
  const random = () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
  const length = Math.max(0.25, glitch.length);
  const every = Math.max(1 / 64, glitch.every);
  const times = (glitch.hits ?? Array.from({ length: Math.floor(length / every) }, (_, k) => k * every).filter((time, k) => k === 0 || random() < 0.8))
    .filter((time) => time >= 0 && time < length - 1e-6)
    .sort((a, b) => a - b);
  const poses = times.map((time, index) => {
    const next = times[index + 1] ?? length;
    const angle = round((random() * 2 - 1) * glitch.strength);
    const step = round((random() * 2 - 1) * glitch.chaos);
    const shape: PoseShape = Math.abs(step) < 0.5 ? 'same' : mode === 'tracks' && random() < 0.35 ? 'random' : 'spiral';
    return newPose(round(time), { shape, angle, step: shape === 'random' ? Math.abs(step) : step, seed: Math.floor(random() * 1000), duration: glitch.snap <= 0 ? 0 : round(Math.max(1 / 64, (next - time) * Math.min(1, Math.max(0.02, glitch.snap)))), easing: 'easeOutCubic' });
  });
  if (glitch.back) poses.push(newPose(round(length), { shape: 'same', angle: 0, step: 0, duration: round(Math.min(0.5, length / 4)), easing: 'easeInOutQuad' }));
  return poses;
}

/** A block of a glitch. */
export function newGlitchBlock(system: string, mode: RingBlock['mode'], start: number, glitch: RingGlitch = DEFAULT_GLITCH): RingBlock {
  const poses = glitchPoses(glitch, mode);
  const last = poses.at(-1);
  const end = start + Math.max(glitch.length, last === undefined ? 1 : last.beat + last.duration);
  return { id: newId('k'), name: 'Глитч колец', system, mode, start, end, poses, glitch: { ...glitch } };
}

/** A lasers block at `start` (as long as the move: its spin, or its steps). */
export function newLaserBlock(start: number, move: LaserMove): RingBlock {
  const length = move.mode === 'steps' ? Math.max(1, Math.round(move.steps)) * Math.max(1 / 64, move.every) : Math.max(0.25, move.length);
  const name = move.mode === 'spin' ? 'Лазеры крутятся' : move.mode === 'sway' ? 'Лазеры качаются' : 'Лазеры по шагам';
  return { id: newId('k'), kind: 'lasers', name, system: '', mode: 'event', start, end: start + length, poses: [], lasers: { ...move } };
}

/** A lasers block's move as long as the block is now (dragged longer: a longer spin, more steps). */
export function laserBlockMove(block: RingBlock): LaserMove {
  const move = block.lasers!;
  const length = block.end - block.start;
  return move.mode === 'steps' ? { ...move, steps: Math.max(1, Math.round(length / Math.max(1 / 64, move.every))) } : { ...move, length };
}

export function newZoomBlock(system: ZoomSystemInfo | undefined, start: number, end: number, name = ''): RingBlock {
  const length = Math.max(1, end - start);
  const initial = round(system?.initialStep ?? 2);
  const tight = round(system?.position.minPositionStep ?? initial / 2);
  return {
    id: newId('k'),
    kind: 'zoom',
    name: 'Зум колец',
    system: name,
    mode: 'event',
    start,
    end: start + length,
    poses: [newPose(0, { step: initial, duration: Math.min(1, length / 2) }), newPose(Math.min(length, Math.max(1, length / 2)), { step: tight, duration: Math.min(1, length / 2) })],
  };
}

/** Where each ring of a zooming system stands (its distance ahead) at a spacing. */
export function zoomPositions(system: ZoomSystemInfo, step: number): number[] {
  return Array.from({ length: system.rings }, (_, i) => (system.position.positionOffsets[i] ?? 0) + i * step);
}

/** The zoom events of zoom blocks (each pose: the spacing, the speed that gets there in its time). */
export function poseZoomEvents(blocks: readonly RingBlock[], systems: readonly ZoomSystemInfo[], eventType: number, secondsPerBeat: number): (OutEvent & { group: string })[] {
  return timedPoses(blocks.filter(isZoom)).map(({ block, pose, beat }) => {
    const turnSeconds = Math.max(0, pose.duration) * secondsPerBeat;
    const speed = turnSeconds <= 0.02 ? 50 : Math.min(50, Math.max(0.05, (1 - 0.01 ** (0.02 / turnSeconds)) / 0.02));
    const customData: Record<string, unknown> = { step: round(pose.step), speed: round(speed), ...(block.system !== '' && systems.length > 1 ? { nameFilter: block.system } : {}) };
    return { beat, type: eventType, value: 0, floatValue: 1, customData, group: block.id };
  });
}

const rand = (seed: number, index: number) => {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return value - Math.floor(value);
};

/** Each ring's angle in a pose (`count` rings, nearest first). */
export function poseAngles(pose: RingPose, count: number, mode: RingBlock['mode']): number[] {
  const shape = mode === 'event' && !EVENT_SHAPES.has(pose.shape) ? 'spiral' : pose.shape;
  return Array.from({ length: count }, (_, i) => {
    switch (shape) {
      case 'same':
        return pose.angle;
      case 'spiral':
        return pose.angle + i * pose.step;
      case 'wave':
        return pose.angle + pose.step * Math.sin((2 * Math.PI * pose.periods * i) / Math.max(1, count) + (pose.phase * Math.PI) / 180);
      case 'alternate':
        return pose.angle + (i % 2 === 1 ? pose.step : 0);
      case 'random':
        return pose.angle + Math.round((rand(pose.seed, i) * 2 - 1) * pose.step);
      case 'manual':
        return pose.manual[i] ?? pose.angle;
    }
  });
}

/** When the turn reaches ring `i` (beats after the pose's own time). */
export function ringDelay(pose: RingPose, i: number, count: number) {
  if (pose.delay <= 0 || count <= 1) return 0;
  return (pose.delay * (pose.reverse ? count - 1 - i : i)) / (count - 1);
}

/** The turn from `from` to `to` as the pose asks for it (the shorter way, or one way), with its whole
 *  turns on top. */
export function turn(from: number, to: number, way: TurnWay, loops: number) {
  let delta = to - from;
  if (way === 'short') delta = ((((delta + 180) % 360) + 360) % 360) - 180;
  else if (way === 'ccw') delta = ((delta % 360) + 360) % 360;
  else delta = -((((-delta) % 360) + 360) % 360);
  const sign = delta < 0 || (way === 'cw' && delta === 0) ? -1 : 1;
  return delta + sign * 360 * Math.max(0, Math.round(loops));
}

/** A relative pose's turn as asked: by its angle, its whole turns on top the same way. */
function relativeTurn(pose: RingPose) {
  const sign = pose.angle < 0 || (pose.angle === 0 && pose.way === 'cw') ? -1 : 1;
  return pose.angle + sign * 360 * Math.max(0, Math.round(pose.loops));
}

/**
 * Where the first ring is headed before `pose` (of `block`), by the poses of the same rings before it
 * (0 at the start) — for showing where a relative pose puts the rings. (The show's own ring events are
 * left out; the map's events count them.)
 */
export function poseBase(blocks: readonly RingBlock[], block: RingBlock, pose: RingPose) {
  return poseBefore(blocks, block, pose).angle;
}

/** How the rings stand before `pose`, by the poses of the same rings before it: the first ring's angle
 *  and the step from ring to ring (0 and 0 at the start). */
export function poseBefore(blocks: readonly RingBlock[], block: RingBlock, pose: RingPose): { angle: number; step: number } {
  let angle = 0;
  let step = 0;
  for (const item of timedPoses(blocks.filter((other) => isTurn(other) && other.system === block.system && other.mode === block.mode))) {
    if (item.pose.id === pose.id) break;
    angle = item.pose.relative === true ? angle + item.pose.angle : item.pose.angle;
    step = stepAfter(item.pose, step);
  }
  return { angle, step };
}

/** The step from ring to ring a pose leaves (`before`: the one before it): a spiral its own (or the one
 *  before plus its own), the rings in line none, other shapes their own spread. */
function stepAfter(pose: RingPose, before: number) {
  if (pose.shape === 'same' || pose.shape === 'manual') return 0;
  return pose.shape === 'spiral' && pose.relativeStep === true ? before + pose.step : pose.step;
}

/** The pose with its first ring's angle and its step as they end up (`before`: how the rings stood). */
export function absolutePose(pose: RingPose, before: number | { angle: number; step: number }): RingPose {
  const base = typeof before === 'number' ? { angle: before, step: 0 } : before;
  if (pose.relative !== true && pose.relativeStep !== true) return pose;
  const out: RingPose = { ...pose, angle: pose.relative === true ? base.angle + pose.angle : pose.angle, step: pose.relativeStep === true && pose.shape === 'spiral' ? base.step + pose.step : pose.step };
  delete out.relative;
  delete out.relativeStep;
  return out;
}

/** The poses of blocks in time order (each with its block), only those inside its block. */
function timedPoses(blocks: readonly RingBlock[]) {
  return blocks
    .flatMap((block) => block.poses.filter((pose) => pose.beat <= block.end - block.start + 1e-6).map((pose) => ({ block, pose, beat: block.start + pose.beat })))
    .sort((a, b) => a.beat - b.beat);
}

// ----- 'event': Chroma ring events ----------------------------------------------------------------------

/**
 * Where a ring system's turns have got to just before `beat`: the angle its first ring is headed for,
 * the base Chroma's next ring event adds to — every earlier ring event (in `events`, sorted, beats in
 * song BPM time) counted the way the game's ring motion does (ChroPaper's ring-motion.ts). A pose's
 * event goes before the show's ring events at its very moment (of two at once the first one wins),
 * so those don't count.
 */
export function ringBase(events: readonly { songBeat: number; customData?: Record<string, unknown> }[], system: RingSystemInfo, songBeat: number) {
  const config = system.rotation;
  const random = deterministicRingRandom(system.seed);
  let base = config.startupRotationAngle;
  let tieIndex = 0;
  let tieBeat = Number.NaN;
  for (const event of events) {
    if (event.songBeat >= songBeat - 1e-9) break;
    tieIndex = event.songBeat === tieBeat ? tieIndex + 1 : 0;
    tieBeat = event.songBeat;
    const custom = event.customData;
    const get = (key: string) => custom?.[`_${key}`] ?? custom?.[key];
    const direction = get('direction');
    const clockwise = custom !== undefined ? direction !== undefined && Number(direction) === 0 : random({ songBpmTime: event.songBeat } as never, tieIndex, 'direction') < 0.5;
    const ringRotation = get('rotation');
    const rotation = ringRotation === undefined ? config.rotation : Number(ringRotation);
    const nameFilter = get('nameFilter');
    if (nameFilter !== undefined && !matchesRingName(config.name, String(nameFilter))) continue;
    base += clockwise ? rotation : -rotation;
  }
  return base;
}

/** The step from ring to ring the last ring event before `songBeat` set for a system (its custom step,
 *  with its multiplier); 0 when that event had none, or there was none. */
export function ringStepBase(events: readonly { songBeat: number; customData?: Record<string, unknown> }[], system: RingSystemInfo, songBeat: number) {
  let step = 0;
  for (const event of events) {
    if (event.songBeat >= songBeat - 1e-9) break;
    const custom = event.customData;
    const get = (key: string) => custom?.[`_${key}`] ?? custom?.[key];
    const nameFilter = get('nameFilter');
    if (nameFilter !== undefined && !matchesRingName(system.rotation.name, String(nameFilter))) continue;
    const own = get('step');
    const mult = get('stepMult');
    step = own === undefined ? 0 : Number(own) * (mult === undefined ? 1 : Number(mult));
  }
  return step;
}

/**
 * The ring events of 'event' blocks. `others`: the show's other events of the rings' event type
 * (sorted); `toSong`: map beats → song BPM beats; `secondsPerBeat` of the song.
 */
export function poseRingEvents(blocks: readonly RingBlock[], others: readonly OutEvent[], systems: readonly RingSystemInfo[], eventType: number, toSong: (beat: number) => number, secondsPerBeat: number): (OutEvent & { group: string })[] {
  const out: (OutEvent & { group: string })[] = [];
  const known = others.map((event) => ({ songBeat: toSong(event.beat), customData: event.customData }));
  for (const { block, pose, beat } of timedPoses(blocks.filter((item) => isTurn(item) && item.mode === 'event'))) {
    const system = systems.find((item) => item.name === block.system) ?? systems[0];
    if (system === undefined) continue;
    const songBeat = toSong(beat);
    const base = ringBase(known, system, songBeat);
    const rotation = pose.relative === true ? relativeTurn(pose) : turn(base, pose.angle, pose.way, pose.loops);
    const step = pose.shape !== 'spiral' ? 0 : pose.relativeStep === true ? ringStepBase(known, system, songBeat) + pose.step : pose.step;
    const count = system.rings;
    // the wave: rings per 0.02 s tick (the game's fixed step); the turn's time: how fast each ring
    // closes in on its angle (99 % of the way by the end)
    const waveSeconds = Math.max(0, pose.delay) * secondsPerBeat;
    const prop = waveSeconds <= 0.02 ? 50 : Math.min(50, Math.max(0.01, count / (waveSeconds / 0.02)));
    const turnSeconds = Math.max(0, pose.duration) * secondsPerBeat;
    const speed = turnSeconds <= 0.02 ? 50 : Math.min(50, Math.max(0.05, (1 - 0.01 ** (0.02 / turnSeconds)) / 0.02));
    const filter = block.system !== '' && systems.length > 1 ? { nameFilter: block.system } : {};
    const add = (at: number, turned: number, spiral: number, closing: number) => {
      const customData: Record<string, unknown> = {
        rotation: round(Math.abs(turned)),
        step: round(spiral),
        prop: round(prop),
        speed: round(closing),
        direction: turned >= 0 ? 0 : 1,
        ...filter,
      };
      out.push({ beat: at, type: eventType, value: 0, floatValue: 1, customData, group: block.id });
      // (later poses count this one — before the show's events at its moment, as it's played)
      const songAt = toSong(at);
      const index = known.findIndex((item) => item.songBeat >= songAt - 1e-9);
      known.splice(index < 0 ? known.length : index, 0, { songBeat: songAt, customData });
    };
    const easing = pose.eventEasing;
    if (easing === undefined || easing === '' || turnSeconds <= 0.04) {
      add(beat, rotation, step, speed);
      continue;
    }
    // the turn along an easing: a ring event every ~1/25 s, each turning on to where the easing has
    // got (back, for an overshoot or a bounce), the spiral going along too; the rings close in on each
    // nearly at once
    const ease = easingFromName(easing);
    const pieces = Math.max(2, Math.min(96, Math.round(turnSeconds / 0.04)));
    const fromStep = ringStepBase(known, system, songBeat);
    let done = 0;
    for (let k = 1; k <= pieces; k++) {
      const reached = ease(k / pieces);
      const at = beat + (pose.duration * (k - 1)) / pieces;
      add(Math.round(at * 100000) / 100000, rotation * (reached - done), fromStep + (step - fromStep) * reached, k === pieces ? 50 : 35);
      done = reached;
    }
  }
  return out;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

// ----- 'tracks': every ring on a Chroma track -----------------------------------------------------------

export const TRACK_PREFIX = 'chroeditorRing';

export function ringTrack(system: string, index: number) {
  return `${TRACK_PREFIX}:${system}:${String(index)}`;
}

/** Chroma environment enhancements putting every ring of a system on its own track. */
export interface RingEnhancement {
  id: string;
  lookupMethod: 'Regex';
  track: string;
}

/** One AnimateTrack: a ring's track turned from one angle to another (points every ≤ 90°: Heck
 *  turns between two points the shorter way round). */
export interface RingAnimation {
  beat: number;
  duration: number;
  track: string;
  easing?: string;
  localRotation: [number, number, number, number][];
}

/** The systems 'tracks' blocks turn. */
export function trackedSystems(blocks: readonly RingBlock[]) {
  return [...new Set(blocks.filter((block) => isTurn(block) && block.mode === 'tracks').map((block) => block.system))].sort();
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * `geometry`: the systems drawn from Chroma geometry (their rings on their tracks already). `firstRing`:
 * where the game puts the rings for this player — the game spawns them at the root of
 * its GameCore scene and Chroma finds them by their place there ("GameCore.[509]SmallTrackLaneRing
 * (Clone)"), which hangs on the game's version and mods; the environment data's places are moved so
 * its first ring is there (undefined: as the data has them).
 */
export function ringEnhancements(blocks: readonly RingBlock[], systems: readonly RingSystemInfo[], firstRing?: number, geometry: ReadonlySet<string> = new Set()): RingEnhancement[] {
  const out: RingEnhancement[] = [];
  const shift = firstRing === undefined ? 0 : firstRing - (dataFirstRing(systems) ?? firstRing);
  for (const name of trackedSystems(blocks)) {
    const system = systems.find((item) => item.name === name);
    // (rings drawn from geometry are on their tracks already)
    if (system === undefined || geometry.has(name)) continue;
    system.ringIds.forEach((ids, index) => {
      if (ids.length === 0) return;
      const moved = ids.map((id) => id.replace(GAME_CORE_RING, (_, place: string) => `GameCore.[${String(Number(place) + shift)}]`));
      out.push({ id: `^(?:${moved.map(escapeRegex).join('|')})$`, lookupMethod: 'Regex', track: ringTrack(name, index) });
    });
  }
  return out;
}

const GAME_CORE_RING = /^GameCore\.\[(\d+)\]/u;

/** The place of the environment data's first ring in the game's GameCore scene (undefined: its
 *  rings aren't there). */
export function dataFirstRing(systems: readonly RingSystemInfo[]): number | undefined {
  const places = systems.flatMap((system) => system.ringIds.flat()).flatMap((id) => {
    const match = GAME_CORE_RING.exec(id);
    return match === null ? [] : [Number(match[1])];
  });
  return places.length === 0 ? undefined : Math.min(...places);
}

/** The rings' object names in the environment data ("SmallTrackLaneRing(Clone)"…). */
export function ringObjectNames(systems: readonly RingSystemInfo[]): string[] {
  return [...new Set(systems.flatMap((system) => system.ringIds.flat()).flatMap((id) => {
    const match = /^GameCore\.\[\d+\]([^.]+)$/u.exec(id);
    return match === null ? [] : [match[1]!];
  }))];
}

/**
 * The game's place of its first ring, read from a Beat Saber log with Chroma's "print environment
 * enhancement debug" on (it lists every environment object's id): the lowest place of these ring
 * names in the last listing in it (undefined: none there).
 */
export function firstRingFromLog(log: string, names: readonly string[]): number | undefined {
  const wanted = new Set(names);
  const found: { line: number; place: number }[] = [];
  log.split(/\r?\n/u).forEach((text, line) => {
    for (const match of text.matchAll(/GameCore\.\[(\d+)\]([^\s.\]"]+\(Clone\))(?=$|[\s"])/gu)) {
      if (wanted.has(match[2]!)) found.push({ line, place: Number(match[1]) });
    }
  });
  if (found.length === 0) return undefined;
  // (the last listing: the matches after the last gap of many lines)
  let from = found.length - 1;
  while (from > 0 && found[from]!.line - found[from - 1]!.line < 200) from--;
  return Math.min(...found.slice(from).map((item) => item.place));
}

export function ringAnimations(blocks: readonly RingBlock[], systems: readonly RingSystemInfo[]): RingAnimation[] {
  const out: RingAnimation[] = [];
  // per ring: its turns in time order, each from where the ring is when it starts
  const lanes = new Map<string, { beat: number; duration: number; from: number; to: number; easing: string }[]>();
  // (a relative pose's angles: from where the first ring was headed at the pose's time — worked out
  // when its first ring's turn comes up, before any of its own turns count)
  const steps: { track: string; beat: number; pose: RingPose; at: number; first: string; target: number }[] = [];
  for (const { block, pose, beat } of timedPoses(blocks.filter((item) => isTurn(item) && item.mode === 'tracks'))) {
    const system = systems.find((item) => item.name === block.system);
    if (system === undefined) continue;
    // (a spiral's step added to the one before: worked out from the poses before it)
    const spread = pose.shape === 'spiral' && pose.relativeStep === true ? { ...pose, step: poseBefore(blocks, block, pose).step + pose.step } : pose;
    const angles = poseAngles(spread, system.rings, 'tracks');
    angles.forEach((target, i) => steps.push({ track: ringTrack(system.name, i), beat: beat + ringDelay(pose, i, system.rings), pose, at: beat, first: ringTrack(system.name, 0), target }));
  }
  steps.sort((a, b) => a.beat - b.beat);
  const bases = new Map<RingPose, number>();
  for (const step of steps) {
    const lane = lanes.get(step.track) ?? [];
    lanes.set(step.track, lane);
    const from = laneValue(lane, step.beat);
    let to: number;
    if (step.pose.relative === true) {
      let base = bases.get(step.pose);
      if (base === undefined) {
        base = laneTarget(lanes.get(step.first) ?? [], step.at - 1e-6);
        bases.set(step.pose, base);
      }
      // (turned by the pose's angle, its whole turns on top — no shorter way round)
      const target = base + step.target;
      const loops = 360 * Math.max(0, Math.round(step.pose.loops));
      to = target + (step.pose.angle < 0 || (step.pose.angle === 0 && step.pose.way === 'cw') ? -loops : loops);
    } else to = from + turn(from, step.target, step.pose.way, step.pose.loops);
    const duration = Math.max(0, step.pose.duration);
    lane.push({ beat: step.beat, duration, from, to, easing: step.pose.easing });
    if (duration <= 1e-6) {
      out.push({ beat: step.beat, duration: 0, track: step.track, localRotation: [[0, 0, round(to), 0]] });
      continue;
    }
    const segments = Math.max(1, Math.ceil(Math.abs(to - from) / 90));
    const points: [number, number, number, number][] = [];
    for (let k = 0; k <= segments; k++) points.push([0, 0, round(from + ((to - from) * k) / segments), round(k / segments)]);
    out.push({ beat: step.beat, duration, track: step.track, easing: step.pose.easing, localRotation: points });
  }
  return out.sort((a, b) => a.beat - b.beat);
}

/** Where a ring is headed at `beat`: the end of its latest turn by then. */
function laneTarget(lane: readonly { beat: number; to: number }[], beat: number) {
  let current = 0;
  for (const item of lane) if (item.beat <= beat + 1e-9) current = item.to;
  return current;
}

/** Where a ring is at `beat` after the turns before it (its track's latest AnimateTrack wins). */
function laneValue(lane: readonly { beat: number; duration: number; from: number; to: number; easing: string }[], beat: number) {
  let current: (typeof lane)[number] | undefined;
  for (const item of lane) if (item.beat <= beat + 1e-9) current = item;
  if (current === undefined) return 0;
  if (current.duration <= 1e-6 || beat >= current.beat + current.duration) return current.to;
  const t = easingFromName(current.easing)((beat - current.beat) / current.duration);
  return current.from + (current.to - current.from) * t;
}

/** A block's copy (new ids). */
export function cloneRingBlock(block: RingBlock, patch: Partial<RingBlock> = {}): RingBlock {
  return { ...structuredClone(block), poses: block.poses.map((pose) => ({ ...structuredClone(pose), id: newId('p') })), ...patch, id: newId('k') };
}

/** The ring tracks and their turns as a difficulty's custom data (v2 keys or v3 ones). */
export function chromaCustomData(enhancements: readonly RingEnhancement[], animations: readonly RingAnimation[], v2: boolean): Record<string, unknown[]> {
  if (v2) {
    return {
      _environment: enhancements.map((item) => ({ _id: item.id, _lookupMethod: item.lookupMethod, _track: item.track })),
      _customEvents: animations.map((item) => ({ _time: item.beat, _type: 'AnimateTrack', _data: { _track: item.track, _duration: item.duration, ...(item.easing === undefined ? {} : { _easing: item.easing }), _localRotation: item.localRotation } })),
    };
  }
  return {
    environment: enhancements.map((item) => ({ id: item.id, lookupMethod: item.lookupMethod, track: item.track })),
    customEvents: animations.map((item) => ({ b: item.beat, t: 'AnimateTrack', d: { track: item.track, duration: item.duration, ...(item.easing === undefined ? {} : { easing: item.easing }), localRotation: item.localRotation } })),
  };
}
