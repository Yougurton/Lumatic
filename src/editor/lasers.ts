/**
 * The rotating lasers moved with what Chroma gives their speed events (types 12 and 13): a speed that
 * needn't be whole (`speed`), the way they turn (`direction` — 0: the left ones one way and the right
 * ones the other, 1: the opposite), and `lockRotation` — not put back to where they started with a
 * random angle added: a stop leaves them where they are, a speed goes on from there.
 *
 * So the lasers can go in a row: a stop without lockRotation puts each back where the environment has
 * it; a speed with lockRotation turns them all from there, the same, together. And turned by a set
 * angle: the speed that turns that far in the turn's time, then a stop with lockRotation — again and
 * again, in steps.
 */

export interface LaserMove {
  sides: 'left' | 'right' | 'both';
  /** spin: round and round; steps: turned by an angle at a time; sway: back and forth, evenly — a
   *  vibrato (`angle` either way, `every` beats a sway there and back, for `length` beats). */
  mode: 'spin' | 'steps' | 'sway';
  /** Spinning: the speed (the game's, 1 = 20° a second). */
  speed: number;
  direction: 0 | 1 | 'random';
  /** Spinning: from the environment's row, from where they are, from a random angle (the game's). */
  from: 'row' | 'place' | 'random';
  /** Spinning: how long (beats); then what. */
  length: number;
  end: 'keep' | 'freeze' | 'reset';
  /** Steps: the angle each step turns (degrees), how many, how often (beats), each turn's time. */
  angle: number;
  steps: number;
  every: number;
  turn: number;
  /** Steps: from the environment's row first. */
  fromRow: boolean;
}

export const DEFAULT_LASER_MOVE: LaserMove = { sides: 'both', mode: 'steps', speed: 3, direction: 0, from: 'row', length: 4, end: 'freeze', angle: 45, steps: 4, every: 1, turn: 0.25, fromRow: true };

export interface LaserEvent {
  beat: number;
  type: number;
  value: number;
  floatValue: number;
  customData?: Record<string, unknown>;
}

/** (a second event at the same moment comes just after: the game takes them in that order) */
const AFTER = 0.001;
const round = (value: number) => Math.round(value * 10000) / 10000;

/** A speed event: its whole value, and the exact speed when it isn't whole. */
function speedEvent(beat: number, type: number, speed: number, data: Record<string, unknown>): LaserEvent {
  const value = Math.max(1, Math.round(speed));
  const exact = Math.abs(value - speed) > 1e-4 ? { speed: round(speed) } : {};
  return { beat: round(beat), type, value, floatValue: 1, customData: { ...data, ...exact } };
}

/** Sixteen speeds a sway: the angle follows a sine, there and back (each piece at the speed that turns
 *  it that far in its time, its direction changing as the sway turns back). */
const SWAY_STEPS = 16;

function swayEvents(move: LaserMove, type: number, start: number, seconds: (beat: number) => number, direction: Record<string, unknown>): LaserEvent[] {
  const out: LaserEvent[] = [];
  const period = Math.max(1 / 16, move.every);
  const length = Math.max(period / 4, move.length);
  const amplitude = Math.abs(move.angle);
  // (one way: the direction asked for; back: the other)
  const forward = move.direction === 'random' ? 0 : move.direction;
  const stop = (beat: number, freeze: boolean): LaserEvent => ({ beat: round(beat), type, value: 0, floatValue: 1, ...(freeze ? { customData: { lockRotation: true } } : {}) });
  if (move.fromRow) out.push(stop(start, false));
  const piece = period / SWAY_STEPS;
  const angleAt = (t: number) => amplitude * Math.sin((2 * Math.PI * t) / period);
  for (let k = 0; k * piece < length - 1e-6; k++) {
    const t0 = k * piece;
    const t1 = Math.min(length, t0 + piece);
    const delta = angleAt(t1) - angleAt(t0);
    const at = start + t0 + (k === 0 && move.fromRow ? AFTER : 0);
    const time = seconds(start + t1) - seconds(start + t0);
    const speed = Math.max(0.01, Math.abs(delta) / (20 * Math.max(0.001, time)));
    out.push(speedEvent(at, type, speed, { lockRotation: true, ...direction, direction: delta >= 0 ? forward : 1 - forward }));
  }
  out.push(stop(start + length, move.end !== 'reset'));
  return out;
}

/** The events of a move from `start` (`seconds`: a beat's time in the song, for the speeds). */
export function laserEvents(move: LaserMove, start: number, seconds: (beat: number) => number): LaserEvent[] {
  const types = move.sides === 'both' ? [12, 13] : [move.sides === 'left' ? 12 : 13];
  const direction = move.direction === 'random' ? {} : { direction: move.direction };
  const out: LaserEvent[] = [];
  const stop = (beat: number, type: number, freeze: boolean): LaserEvent => ({ beat: round(beat), type, value: 0, floatValue: 1, ...(freeze ? { customData: { lockRotation: true } } : {}) });
  for (const type of types) {
    if (move.mode === 'spin') {
      const speed = Math.max(0.05, move.speed);
      if (move.from === 'row') {
        out.push(stop(start, type, false));
        out.push(speedEvent(start + AFTER, type, speed, { lockRotation: true, ...direction }));
      } else out.push(speedEvent(start, type, speed, { ...(move.from === 'place' ? { lockRotation: true } : {}), ...direction }));
      if (move.end !== 'keep') out.push(stop(start + Math.max(0.0625, move.length), type, move.end === 'freeze'));
      continue;
    }
    if (move.mode === 'sway') {
      out.push(...swayEvents(move, type, start, seconds, direction));
      continue;
    }
    const steps = Math.max(1, Math.min(64, Math.round(move.steps)));
    const every = Math.max(1 / 64, move.every);
    const turn = Math.max(1 / 64, Math.min(move.turn, every));
    // (a turn as long as the step: no stop between, the lasers just change speed)
    const continuous = turn >= every - 1e-6;
    if (move.fromRow) out.push(stop(start, type, false));
    for (let k = 0; k < steps; k++) {
      const at = start + k * every + (k === 0 && move.fromRow ? AFTER : 0);
      const time = seconds(at + turn) - seconds(at);
      const speed = Math.abs(move.angle) / (20 * Math.max(0.001, time));
      out.push(speedEvent(at, type, speed, { lockRotation: true, ...direction }));
      if (!continuous || k === steps - 1) out.push(stop(at + turn, type, true));
    }
    if (move.end === 'reset') out.push(stop(start + steps * every, type, false));
  }
  return out.sort((a, b) => a.beat - b.beat);
}
