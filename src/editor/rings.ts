import { easingFromName } from '../engine/core/easing';
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
}

export interface RingBlock {
  id: string;
  /** Turning the rings (the default) or spacing them out. */
  kind?: 'rotation' | 'zoom';
  name: string;
  /** The ring system (its name — Chroma's nameFilter); '' for 'event': every ring system. */
  system: string;
  mode: 'event' | 'tracks';
  start: number;
  end: number;
  poses: RingPose[];
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

/**
 * The ring events of 'event' blocks. `others`: the show's other events of the rings' event type
 * (sorted); `toSong`: map beats → song BPM beats; `secondsPerBeat` of the song.
 */
export function poseRingEvents(blocks: readonly RingBlock[], others: readonly OutEvent[], systems: readonly RingSystemInfo[], eventType: number, toSong: (beat: number) => number, secondsPerBeat: number): (OutEvent & { group: string })[] {
  const out: (OutEvent & { group: string })[] = [];
  const known = others.map((event) => ({ songBeat: toSong(event.beat), customData: event.customData }));
  for (const { block, pose, beat } of timedPoses(blocks.filter((item) => !isZoom(item) && item.mode === 'event'))) {
    const system = systems.find((item) => item.name === block.system) ?? systems[0];
    if (system === undefined) continue;
    const songBeat = toSong(beat);
    const base = ringBase(known, system, songBeat);
    const rotation = turn(base, pose.angle, pose.way, pose.loops);
    const step = pose.shape === 'spiral' ? pose.step : 0;
    const count = system.rings;
    // the wave: rings per 0.02 s tick (the game's fixed step); the turn's time: how fast each ring
    // closes in on its angle (99 % of the way by the end)
    const waveSeconds = Math.max(0, pose.delay) * secondsPerBeat;
    const prop = waveSeconds <= 0.02 ? 50 : Math.min(50, Math.max(0.01, count / (waveSeconds / 0.02)));
    const turnSeconds = Math.max(0, pose.duration) * secondsPerBeat;
    const speed = turnSeconds <= 0.02 ? 50 : Math.min(50, Math.max(0.05, (1 - 0.01 ** (0.02 / turnSeconds)) / 0.02));
    const customData: Record<string, unknown> = {
      rotation: round(Math.abs(rotation)),
      step: round(step),
      prop: round(prop),
      speed: round(speed),
      direction: rotation >= 0 ? 0 : 1,
      ...(block.system !== '' && systems.length > 1 ? { nameFilter: block.system } : {}),
    };
    const event = { beat, type: eventType, value: 0, floatValue: 1, customData, group: block.id };
    out.push(event);
    // (later poses count this one — before the show's events at its moment, as it's played)
    const at = known.findIndex((item) => item.songBeat >= songBeat - 1e-9);
    known.splice(at < 0 ? known.length : at, 0, { songBeat, customData });
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
  return [...new Set(blocks.filter((block) => !isZoom(block) && block.mode === 'tracks').map((block) => block.system))].sort();
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
  const steps: { track: string; beat: number; pose: RingPose; target: number }[] = [];
  for (const { block, pose, beat } of timedPoses(blocks.filter((item) => !isZoom(item) && item.mode === 'tracks'))) {
    const system = systems.find((item) => item.name === block.system);
    if (system === undefined) continue;
    const angles = poseAngles(pose, system.rings, 'tracks');
    angles.forEach((target, i) => steps.push({ track: ringTrack(system.name, i), beat: beat + ringDelay(pose, i, system.rings), pose, target }));
  }
  steps.sort((a, b) => a.beat - b.beat);
  for (const step of steps) {
    const lane = lanes.get(step.track) ?? [];
    lanes.set(step.track, lane);
    const from = laneValue(lane, step.beat);
    const to = from + turn(from, step.target, step.pose.way, step.pose.loops);
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
