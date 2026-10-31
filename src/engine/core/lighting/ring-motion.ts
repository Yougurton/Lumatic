import type { BasicEvent } from '../beatmap/types';
import {
  beatSaberBooleanSchema as booleanSchema,
  beatSaberNumberSchema as numberSchema,
  beatSaberStringSchema as stringSchema,
} from '../beatmap/value-schema';

/** Unity's fixed step: what a ring closes in on its angle by each tick (`speed` × this). */
const FIXED_DELTA = 0.02;

/**
 * How often the rings tick (seconds). The game's ring motion runs on Unity's fixed step, 50 times a
 * second — as long as the game itself keeps up: a game drawing fewer frames (a slow computer, a
 * recording) ticks the rings once a frame, still by 0.02 s each, so the waves and the turns go slower
 * by as much (measured: ~30 ticks a second in a game running at ~30 frames).
 */
let tickSeconds = FIXED_DELTA;

/** The game's frames a second the rings are worked out for (50 and more: the game's own 50 ticks). */
export function setRingTickRate(perSecond: number) {
  tickSeconds = 1 / Math.min(50, Math.max(10, perSecond));
}

export const ringTickSeconds = () => tickSeconds;

export interface RingRotationConfig {
  name: string;
  ringCount: number;
  startupRotationAngle: number;
  startupRotationStep: number;
  startupPropagationSpeed: number;
  startupFlexySpeed: number;
  rotationStep: number;
  counterSpin: boolean;
  rotation: number;
  step: number;
  stepType: number;
  propagationSpeed: number;
  flexySpeed: number;
}

export interface RingPositionConfig {
  positionOffsets: readonly number[];
  initialPositions: readonly number[];
  minPositionStep: number;
  maxPositionStep: number;
  moveSpeed: number;
  /** The ring system's name (Chroma's nameFilter picks ring systems by it). */
  name?: string;
}

export type RingRandom = (event: BasicEvent | null, index: number, channel: 'direction' | 'step') => number;

interface TargetChange {
  tick: number;
  order: number;
  target: number;
  speed: number;
}

interface SampledTargetChange {
  tick: number;
  target: number;
  speed: number;
  valueBefore: number;
}

const custom = (event: BasicEvent, v2: string, v3: string) => event.customData?.[v2] ?? event.customData?.[v3];

/** Whether a ring system answers to a Chroma nameFilter (its name, ignoring case). */
export function matchesRingName(name: string | undefined, filter: string) {
  if (name === undefined) return true;
  const a = name.toLowerCase();
  const b = filter.toLowerCase();
  return a === b || a.includes(b);
}
const tickAt = (seconds: number, tick = tickSeconds) => Math.max(1, Math.ceil(seconds / tick - 1e-9));
const lerp = (start: number, end: number, time: number) => start + (end - start) * Math.min(Math.max(time, 0), 1);

function addPropagation(
  changes: TargetChange[][],
  startTick: number,
  order: number,
  angle: number,
  step: number,
  propagationSpeed: number,
  flexySpeed: number,
) {
  if (propagationSpeed <= 0) return;
  let progressPos = 0;
  let relativeTick = 0;
  while (progressPos < changes.length) {
    let progress = Math.floor(progressPos);
    while (progress < progressPos + propagationSpeed && progress < changes.length) {
      changes[progress]?.push({
        tick: startTick + relativeTick,
        order,
        target: angle + progress * step,
        speed: flexySpeed,
      });
      progress++;
    }
    progressPos += propagationSpeed;
    relativeTick++;
  }
}

function approachTarget(value: number, target: number, speed: number, ticks: number) {
  return target + (value - target) * (1 - Math.min(Math.max(FIXED_DELTA * speed, 0), 1)) ** ticks;
}

function compileChanges(initial: number, changes: TargetChange[]) {
  const sampled: SampledTargetChange[] = [];
  let value = initial;
  let target = initial;
  let speed = 0;
  let nextTick = 1;
  let index = 0;
  while (index < changes.length) {
    const tick = changes[index]?.tick ?? Infinity;
    const count = tick - nextTick;
    if (count > 0) value = approachTarget(value, target, speed, count);
    while (changes[index]?.tick === tick) {
      target = changes[index]?.target ?? target;
      speed = changes[index]?.speed ?? speed;
      index++;
    }
    sampled.push({ tick, target, speed, valueBefore: value });
    nextTick = tick;
  }
  return sampled;
}

function valueAfterTicks(initial: number, changes: SampledTargetChange[], ticks: number) {
  if (ticks <= 0) return initial;
  let low = 0;
  let high = changes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((changes[middle]?.tick ?? Infinity) <= ticks) low = middle + 1;
    else high = middle;
  }
  const change = changes[low - 1];
  return change === undefined
    ? initial
    : approachTarget(change.valueBefore, change.target, change.speed, ticks - change.tick + 1);
}

function sampleChanges(initial: number, changes: SampledTargetChange[], seconds: number) {
  const ticks = Math.floor(seconds / tickSeconds);
  const fraction = seconds / tickSeconds - ticks;
  const previous = valueAfterTicks(initial, changes, Math.max(ticks - 1, 0));
  const current = valueAfterTicks(initial, changes, ticks);
  return lerp(previous, current, fraction);
}

function sortChanges(changes: TargetChange[][]) {
  for (const entries of changes) entries.sort((a, b) => a.tick - b.tick || b.order - a.order);
  return changes;
}

function randomStep(config: RingRotationConfig, event: BasicEvent, index: number, random: RingRandom) {
  const value = random(event, index, 'step');
  if (config.stepType === 0) return value * config.step;
  if (config.stepType === 1) return -config.step + value * config.step * 2;
  if (config.stepType === 2) return value > 0.5 ? config.step : 0;
  return 0;
}

/** How many ticks in a row a turn sets the first ring (Chroma: while its progress is under 1). */
export function firstRingTicks(propagationSpeed: number) {
  if (propagationSpeed <= 0) return 0;
  let ticks = 0;
  for (let progressPos = 0; progressPos < 1; progressPos += propagationSpeed) ticks++;
  return ticks;
}

/**
 * A ring system's turns, as the game makes them (Chroma's ChromaRingsRotationEffect): each ring event
 * starts a turn whose angle is where the FIRST RING IS HEADED at that moment plus the event's
 * rotation — and a turn keeps setting the first ring until its wave has moved past it (1/prop ticks),
 * the older turn winning a tick two set. So events closer together than that don't add up: a later one
 * counts from what an earlier one is still holding the first ring at.
 */
export class RingTurnModel {
  readonly changes: TargetChange[][];
  /** The ticks each turn sets the first ring through, and the angle it sets. */
  private readonly firsts: { start: number; end: number; order: number; angle: number }[] = [];
  private longest = 1;
  private order = 0;
  private tieIndex = 0;
  private tieBeat = Number.NaN;

  /** `tick`: the ticks' length (seconds) — the rings' preview's, unless asked for the game's own. */
  constructor(
    private readonly config: RingRotationConfig,
    private readonly songBpm: number,
    private readonly random: RingRandom,
    private readonly tick = tickSeconds,
  ) {
    this.changes = Array.from({ length: config.ringCount }, (): TargetChange[] => []);
    this.turn(1, config.startupRotationAngle, config.startupRotationStep, config.startupPropagationSpeed, config.startupFlexySpeed);
  }

  private turn(tick: number, angle: number, step: number, propagationSpeed: number, flexySpeed: number) {
    const order = this.order++;
    addPropagation(this.changes, tick, order, angle, step, propagationSpeed, flexySpeed);
    const ticks = firstRingTicks(propagationSpeed);
    if (ticks <= 0 || this.changes.length === 0) return;
    this.firsts.push({ start: tick, end: tick + ticks - 1, order, angle });
    this.longest = Math.max(this.longest, ticks);
  }

  /** Where the first ring is headed just before tick `tick` (the ticks before it done). */
  firstBefore(tick: number) {
    let bestTick = -1;
    let bestOrder = Infinity;
    let angle = this.config.startupRotationAngle;
    for (let i = this.firsts.length - 1; i >= 0; i--) {
      const first = this.firsts[i]!;
      if (first.start + this.longest - 1 < bestTick) break;
      if (first.start >= tick) continue;
      const last = Math.min(tick - 1, first.end);
      if (last > bestTick || (last === bestTick && first.order < bestOrder)) {
        bestTick = last;
        bestOrder = first.order;
        angle = first.angle;
      }
    }
    return angle;
  }

  /** Where the first ring is headed just before a moment (seconds of the song): what the next ring
   *  event then counts from. */
  firstAt(seconds: number) {
    return this.firstBefore(tickAt(seconds, this.tick));
  }

  /** The next ring event (in time order). */
  add(event: BasicEvent) {
    const config = this.config;
    const random = this.random;
    this.tieIndex = event.songBpmTime === this.tieBeat ? this.tieIndex + 1 : 0;
    this.tieBeat = event.songBpmTime;
    const tieIndex = this.tieIndex;
    const hasCustomData = event.customData !== undefined;
    const directionValue = custom(event, '_direction', 'direction');
    const clockwise = hasCustomData
      ? directionValue !== undefined && numberSchema.parse(directionValue) === 0
      : random(event, tieIndex, 'direction') < 0.5;
    const ringRotation = custom(event, '_rotation', 'rotation');
    const rotationStep = ringRotation === undefined ? config.rotationStep : numberSchema.parse(ringRotation);
    const nameFilter = custom(event, '_nameFilter', 'nameFilter');
    // (Chroma: a named event turns only the ring system of that name — the others don't move, and
    // don't count it either)
    if (nameFilter !== undefined && !matchesRingName(config.name, stringSchema.parse(nameFilter))) {
      this.order++;
      return;
    }
    let step = randomStep(config, event, tieIndex, random);
    let propagationSpeed = config.propagationSpeed;
    let flexySpeed = config.flexySpeed;
    const customStep = custom(event, '_step', 'step');
    const customProp = custom(event, '_prop', 'prop');
    const customSpeed = custom(event, '_speed', 'speed');
    if (customStep !== undefined) step = numberSchema.parse(customStep);
    if (customProp !== undefined) propagationSpeed = numberSchema.parse(customProp);
    if (customSpeed !== undefined) flexySpeed = numberSchema.parse(customSpeed);
    const stepMultiplier = custom(event, '_stepMult', 'stepMult');
    const propagationMultiplier = custom(event, '_propMult', 'propMult');
    const speedMultiplier = custom(event, '_speedMult', 'speedMult');
    if (stepMultiplier !== undefined) step *= numberSchema.parse(stepMultiplier);
    if (propagationMultiplier !== undefined) propagationSpeed *= numberSchema.parse(propagationMultiplier);
    if (speedMultiplier !== undefined) flexySpeed *= numberSchema.parse(speedMultiplier);

    let multiplier = clockwise ? 1 : -1;
    const counterSpinEvent = booleanSchema.parse(event.customData?._counterSpin);
    if (config.counterSpin && counterSpinEvent) multiplier *= -1;
    const reset = booleanSchema.parse(event.customData?._reset);
    const tick = tickAt((event.songBpmTime * 60) / this.songBpm, this.tick);
    const base = this.firstBefore(tick);
    this.turn(
      tick,
      base + (reset ? 90 * (counterSpinEvent ? 1 : -1) : rotationStep * multiplier),
      reset ? 0 : step,
      reset ? 50 : propagationSpeed,
      reset ? 50 : flexySpeed,
    );
  }
}

export function createRingRotationSampler(
  events: BasicEvent[],
  songBpm: number,
  initialRotations: readonly number[],
  config: RingRotationConfig,
  random: RingRandom,
) {
  const model = new RingTurnModel(config, songBpm, random);
  for (const event of events) model.add(event);

  const sampledChanges = sortChanges(model.changes).map((entries, index) =>
    compileChanges(initialRotations[index] ?? 0, entries),
  );
  const result = initialRotations.map(() => 0);
  return (beat: number) => {
    const seconds = (beat * 60) / songBpm;
    for (let index = 0; index < sampledChanges.length; index++) {
      result[index] = sampleChanges(initialRotations[index] ?? 0, sampledChanges[index] ?? [], seconds);
    }
    return result;
  };
}

export function createRingPositionSampler(events: BasicEvent[], songBpm: number, config: RingPositionConfig) {
  const changes = config.initialPositions.map<TargetChange[]>(() => []);
  events = events.filter((event) => {
    const nameFilter = custom(event, '_nameFilter', 'nameFilter');
    return nameFilter === undefined || matchesRingName(config.name, stringSchema.parse(nameFilter));
  });
  events.forEach((event, index) => {
    const customStep = custom(event, '_step', 'step');
    const customSpeed = custom(event, '_speed', 'speed');
    const step =
      customStep === undefined
        ? (index + 1) % 2 === 0
          ? config.maxPositionStep
          : config.minPositionStep
        : numberSchema.parse(customStep);
    const speed = customSpeed === undefined ? config.moveSpeed : numberSchema.parse(customSpeed);
    const tick = tickAt((event.songBpmTime * 60) / songBpm);
    changes.forEach((ringChanges, ringIndex) => {
      ringChanges.push({
        tick,
        order: index + 1,
        target: (config.positionOffsets[ringIndex] ?? 0) + ringIndex * step,
        speed,
      });
    });
  });
  const sampledChanges = sortChanges(changes).map((entries, index) =>
    compileChanges(config.initialPositions[index] ?? 0, entries),
  );
  const result = config.initialPositions.map(() => 0);
  return (beat: number) => {
    const seconds = (beat * 60) / songBpm;
    for (let index = 0; index < sampledChanges.length; index++) {
      result[index] = sampleChanges(config.initialPositions[index] ?? 0, sampledChanges[index] ?? [], seconds);
    }
    return result;
  };
}

export function deterministicRingRandom(seed: number): RingRandom {
  return (event, index, channel) => {
    const time = event?.songBpmTime ?? 0;
    const value = Math.sin(seed * 23.1407 + time * 91.737 + index * 17.119 + (channel === 'step' ? 1 : 0));
    return value - Math.floor(value);
  };
}

/** The game's own tick (seconds): what ring events are worked out for. */
export const GAME_RING_TICK = FIXED_DELTA;

/** The `speed` (Chroma's flexy speed) that brings a ring 99 % of the way to its angle in `seconds`, in
 *  the game's 50 ticks a second. */
export function ringSpeedFor(seconds: number) {
  if (seconds <= FIXED_DELTA) return 50;
  return Math.min(50, Math.max(0.05, (1 - 0.01 ** (FIXED_DELTA / seconds)) / FIXED_DELTA));
}

/** The `prop` (rings a tick) that takes a turn along `rings` rings in `seconds`, in the game's 50 ticks
 *  a second. */
export function ringPropFor(rings: number, seconds: number, least = 0.01) {
  if (seconds <= FIXED_DELTA) return 50;
  return Math.min(50, Math.max(least, rings / (seconds / FIXED_DELTA)));
}
