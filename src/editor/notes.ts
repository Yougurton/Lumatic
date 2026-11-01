import type { Arc, Chain, Difficulty, Note, Obstacle } from '../engine/core/beatmap/types';
import { newId } from './model';

/**
 * The notes side of a difficulty: colour notes, bombs, walls, arcs and chains, kept the way a v3 file
 * has them (beats of the map's own BPM, the 4×3 grid's column x 0–3 from the left and row y 0–2 from
 * the bottom) with an id each. Read from a v2, v3 or v4 file; written back into v2 and v3 ones in
 * place of what they had — the objects' own custom data (Noodle, Chroma colours…) kept.
 */

export type Json = Record<string, unknown>;

/** Cut directions as the game numbers them. */
export const DIR = { up: 0, down: 1, left: 2, right: 3, upLeft: 4, upRight: 5, downLeft: 6, downRight: 7, any: 8 } as const;

/** Each direction as a step on the grid (x to the right, y up); the dot: none. */
export const DIR_VECTOR: Record<number, [number, number]> = {
  0: [0, 1],
  1: [0, -1],
  2: [-1, 0],
  3: [1, 0],
  4: [-1, 1],
  5: [1, 1],
  6: [-1, -1],
  7: [1, -1],
  8: [0, 0],
};

/** Each direction's angle (degrees, counter-clockwise from "right"); the dot: none. */
export const DIR_ANGLE: Record<number, number> = { 0: 90, 1: 270, 2: 180, 3: 0, 4: 135, 5: 45, 6: 225, 7: 315 };

/** The direction mirrored left ↔ right. */
export const MIRROR_DIR: Record<number, number> = { 0: 0, 1: 1, 2: 3, 3: 2, 4: 5, 5: 4, 6: 7, 7: 6, 8: 8 };

export interface MapNote {
  id: string;
  b: number;
  x: number;
  y: number;
  /** 0: red (left), 1: blue (right). */
  c: number;
  d: number;
  /** The arrow's turn off its direction (degrees). */
  a: number;
  customData?: Json;
}

export interface MapBomb {
  id: string;
  b: number;
  x: number;
  y: number;
  customData?: Json;
}

export interface MapWall {
  id: string;
  b: number;
  x: number;
  y: number;
  /** How long (beats). */
  d: number;
  w: number;
  h: number;
  customData?: Json;
}

export interface MapArc {
  id: string;
  c: number;
  b: number;
  x: number;
  y: number;
  d: number;
  /** How far the curve leaves the head (its control point's length). */
  mu: number;
  tb: number;
  tx: number;
  ty: number;
  /** The tail's direction. */
  tc: number;
  tmu: number;
  /** The curve's middle: 0 straight, 1 clockwise, 2 counter-clockwise. */
  m: number;
  customData?: Json;
}

export interface MapChain {
  id: string;
  c: number;
  b: number;
  x: number;
  y: number;
  d: number;
  tb: number;
  tx: number;
  ty: number;
  /** Its pieces, the head among them. */
  sc: number;
  /** How far along the way to the tail they reach (1: all the way). */
  s: number;
  customData?: Json;
}

/** The walls (as ChroMapper has them): a full wall (dodged) — from the grid's bottom and middle rows —
 *  and the game's crouch wall — from its top row. ('deep': a wall from the middle row up, as some maps
 *  have; read, not made.) */
export type WallKind = 'full' | 'deep' | 'crouch';
export const WALL_SHAPES: Record<WallKind, { y: number; h: number }> = { full: { y: 0, h: 5 }, deep: { y: 1, h: 4 }, crouch: { y: 2, h: 3 } };
export const ROW_WALL: WallKind[] = ['full', 'crouch', 'crouch'];
export const WALL_NAMES: Record<WallKind, string> = { full: 'Полная стена', deep: 'Низкая стена', crouch: 'Присед' };

/** What a wall is (from its row and height). */
export function wallKindOf(wall: { y: number; h: number }): WallKind {
  return wall.y >= 2 ? 'crouch' : wall.y >= 1 ? 'deep' : 'full';
}

export interface MapObjects {
  notes: MapNote[];
  bombs: MapBomb[];
  walls: MapWall[];
  arcs: MapArc[];
  chains: MapChain[];
}

export type ObjectKind = keyof MapObjects;

export const emptyObjects = (): MapObjects => ({ notes: [], bombs: [], walls: [], arcs: [], chains: [] });

const num = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]).filter((item) => typeof item === 'object' && item !== null) : []);
const custom = (item: Json, key: string) => {
  const data = item[key];
  return typeof data === 'object' && data !== null && Object.keys(data).length > 0 ? { customData: structuredClone(data as Json) } : {};
};

/** The notes, bombs, walls, arcs and chains of a difficulty file's text. */
export function readObjects(text: string): MapObjects {
  const root = JSON.parse(text) as Json;
  const version = String(root.version ?? root._version ?? '2');
  if (version.startsWith('4')) return readV4(root);
  if (version.startsWith('3')) return readV3(root);
  return readV2(root);
}

function readV3(root: Json): MapObjects {
  return {
    notes: list(root.colorNotes).map((n) => ({ id: newId('n'), b: num(n.b), x: num(n.x), y: num(n.y), c: num(n.c), d: num(n.d), a: num(n.a), ...custom(n, 'customData') })),
    bombs: list(root.bombNotes).map((n) => ({ id: newId('n'), b: num(n.b), x: num(n.x), y: num(n.y), ...custom(n, 'customData') })),
    walls: list(root.obstacles).map((w) => ({ id: newId('n'), b: num(w.b), x: num(w.x), y: num(w.y), d: num(w.d), w: num(w.w, 1), h: num(w.h, 5), ...custom(w, 'customData') })),
    arcs: list(root.sliders).map((s) => ({ id: newId('n'), c: num(s.c), b: num(s.b), x: num(s.x), y: num(s.y), d: num(s.d), mu: num(s.mu, 1), tb: num(s.tb), tx: num(s.tx), ty: num(s.ty), tc: num(s.tc), tmu: num(s.tmu, 1), m: num(s.m), ...custom(s, 'customData') })),
    chains: list(root.burstSliders).map((s) => ({ id: newId('n'), c: num(s.c), b: num(s.b), x: num(s.x), y: num(s.y), d: num(s.d), tb: num(s.tb), tx: num(s.tx), ty: num(s.ty), sc: num(s.sc, 3), s: num(s.s, 1), ...custom(s, 'customData') })),
  };
}

function readV2(root: Json): MapObjects {
  const out = emptyObjects();
  for (const n of list(root._notes)) {
    const type = num(n._type);
    const base = { id: newId('n'), b: num(n._time), x: num(n._lineIndex), y: num(n._lineLayer), ...custom(n, '_customData') };
    if (type === 3) out.bombs.push(base);
    else if (type === 0 || type === 1) out.notes.push({ ...base, c: type, d: num(n._cutDirection), a: 0 });
  }
  for (const w of list(root._obstacles)) {
    const type = num(w._type);
    // (0: full height, 1: crouch; v2.6's 2: its own row and height)
    const [y, h] = type === 1 ? [2, 3] : type === 2 ? [num(w._lineLayer), num(w._height, 5)] : [0, 5];
    out.walls.push({ id: newId('n'), b: num(w._time), x: num(w._lineIndex), y, d: num(w._duration), w: num(w._width, 1), h, ...custom(w, '_customData') });
  }
  for (const s of list(root._sliders)) {
    out.arcs.push({
      id: newId('n'),
      c: num(s._colorType),
      b: num(s._headTime),
      x: num(s._headLineIndex),
      y: num(s._headLineLayer),
      d: num(s._headCutDirection),
      mu: num(s._headControlPointLengthMultiplier, 1),
      tb: num(s._tailTime),
      tx: num(s._tailLineIndex),
      ty: num(s._tailLineLayer),
      tc: num(s._tailCutDirection),
      tmu: num(s._tailControlPointLengthMultiplier, 1),
      m: num(s._sliderMidAnchorMode),
      ...custom(s, '_customData'),
    });
  }
  return out;
}

function readV4(root: Json): MapObjects {
  const notes = list(root.colorNotesData);
  const bombs = list(root.bombNotesData);
  const walls = list(root.obstaclesData);
  const arcs = list(root.arcsData);
  const chains = list(root.chainsData);
  const out = emptyObjects();
  for (const n of list(root.colorNotes)) {
    const item = notes[num(n.i)];
    if (item !== undefined) out.notes.push({ id: newId('n'), b: num(n.b), x: num(item.x), y: num(item.y), c: num(item.c), d: num(item.d), a: num(item.a), ...custom(n, 'customData') });
  }
  for (const n of list(root.bombNotes)) {
    const item = bombs[num(n.i)];
    if (item !== undefined) out.bombs.push({ id: newId('n'), b: num(n.b), x: num(item.x), y: num(item.y), ...custom(n, 'customData') });
  }
  for (const w of list(root.obstacles)) {
    const item = walls[num(w.i)];
    if (item !== undefined) out.walls.push({ id: newId('n'), b: num(w.b), x: num(item.x), y: num(item.y), d: num(item.d), w: num(item.w, 1), h: num(item.h, 5), ...custom(w, 'customData') });
  }
  for (const s of list(root.arcs)) {
    const head = notes[num(s.hi)];
    const tail = notes[num(s.ti)];
    const item = arcs[num(s.ai)];
    if (head === undefined || tail === undefined || item === undefined) continue;
    out.arcs.push({ id: newId('n'), c: num(head.c), b: num(s.hb), x: num(head.x), y: num(head.y), d: num(head.d), mu: num(item.m, 1), tb: num(s.tb), tx: num(tail.x), ty: num(tail.y), tc: num(tail.d), tmu: num(item.tm, 1), m: num(item.a), ...custom(s, 'customData') });
  }
  for (const s of list(root.chains)) {
    const head = notes[num(s.i)];
    const item = chains[num(s.ci)];
    if (head === undefined || item === undefined) continue;
    out.chains.push({ id: newId('n'), c: num(head.c), b: num(s.hb), x: num(head.x), y: num(head.y), d: num(head.d), tb: num(s.tb), tx: num(item.tx), ty: num(item.ty), sc: num(item.c, 3), s: num(item.s, 1), ...custom(s, 'customData') });
  }
  return out;
}

const byBeat = <T extends { b: number }>(items: readonly T[]) => [...items].sort((a, b) => a.b - b.b);
const withData = (node: Json, item: { customData?: Json }, key: string) => {
  if (item.customData !== undefined && Object.keys(item.customData).length > 0) node[key] = item.customData;
  return node;
};

/** What can't be kept in a file of this version (a v2 file has no chains). */
export function unsupported(objects: MapObjects, version: '2' | '3' | '4'): string[] {
  if (version === '2' && objects.chains.length > 0) return [`цепи (${String(objects.chains.length)}): в формате v2 их нет`];
  return [];
}

/** A difficulty file's root with its notes, bombs, walls, arcs and chains replaced by these. */
export function writeObjects(root: Json, objects: MapObjects, version: '2' | '3') {
  if (version === '3') {
    root.colorNotes = byBeat(objects.notes).map((n) => withData({ b: n.b, x: n.x, y: n.y, a: n.a, c: n.c, d: n.d }, n, 'customData'));
    root.bombNotes = byBeat(objects.bombs).map((n) => withData({ b: n.b, x: n.x, y: n.y }, n, 'customData'));
    root.obstacles = byBeat(objects.walls).map((w) => withData({ b: w.b, x: w.x, y: w.y, d: w.d, w: w.w, h: w.h }, w, 'customData'));
    root.sliders = byBeat(objects.arcs).map((s) => withData({ c: s.c, b: s.b, x: s.x, y: s.y, d: s.d, mu: s.mu, tb: s.tb, tx: s.tx, ty: s.ty, tc: s.tc, tmu: s.tmu, m: s.m }, s, 'customData'));
    root.burstSliders = byBeat(objects.chains).map((s) => withData({ c: s.c, b: s.b, x: s.x, y: s.y, d: s.d, tb: s.tb, tx: s.tx, ty: s.ty, sc: s.sc, s: s.s }, s, 'customData'));
    return;
  }
  const notes = [
    ...objects.notes.map((n) => withData({ _time: n.b, _lineIndex: n.x, _lineLayer: n.y, _type: n.c, _cutDirection: n.d }, n, '_customData')),
    ...objects.bombs.map((n) => withData({ _time: n.b, _lineIndex: n.x, _lineLayer: n.y, _type: 3, _cutDirection: 0 }, n, '_customData')),
  ];
  root._notes = notes.sort((a, b) => (a._time as number) - (b._time as number));
  root._obstacles = byBeat(objects.walls).map((w) => {
    const node: Json = { _time: w.b, _lineIndex: w.x, _type: 0, _duration: w.d, _width: w.w };
    if (w.y === 2 && w.h === 3) node._type = 1;
    else if (!(w.y === 0 && w.h === 5)) Object.assign(node, { _type: 2, _lineLayer: w.y, _height: w.h });
    return withData(node, w, '_customData');
  });
  if (objects.arcs.length > 0 || Array.isArray(root._sliders)) {
    root._sliders = byBeat(objects.arcs).map((s) =>
      withData(
        {
          _colorType: s.c,
          _headTime: s.b,
          _headLineIndex: s.x,
          _headLineLayer: s.y,
          _headControlPointLengthMultiplier: s.mu,
          _headCutDirection: s.d,
          _tailTime: s.tb,
          _tailLineIndex: s.tx,
          _tailLineLayer: s.ty,
          _tailControlPointLengthMultiplier: s.tmu,
          _tailCutDirection: s.tc,
          _sliderMidAnchorMode: s.m,
        },
        s,
        '_customData',
      ),
    );
  }
}

/** The objects as the 3D view takes them (`toSong`: map beats → song BPM beats). */
export function engineObjects(objects: MapObjects, toSong: (beat: number) => number): Pick<Difficulty, 'notes' | 'obstacles' | 'arcs' | 'chains'> {
  const notes: Note[] = [
    ...objects.notes.map((n) => ({ jsonTime: n.b, songBpmTime: toSong(n.b), posX: n.x, posY: n.y, type: n.c, cutDirection: n.d, angleOffset: n.a, rotation: 0, customFake: false, ...(n.customData === undefined ? {} : { customData: n.customData as Note['customData'] }) })),
    ...objects.bombs.map((n) => ({ jsonTime: n.b, songBpmTime: toSong(n.b), posX: n.x, posY: n.y, type: 3, cutDirection: 0, angleOffset: 0, rotation: 0, customFake: false, ...(n.customData === undefined ? {} : { customData: n.customData as Note['customData'] }) })),
  ].sort((a, b) => a.songBpmTime - b.songBpmTime);
  const obstacles: Obstacle[] = objects.walls
    .map((w) => ({ jsonTime: w.b, songBpmTime: toSong(w.b), rotation: 0, posX: w.x, posY: w.y, type: 0, duration: w.d, durationSongBpmTime: toSong(w.b + w.d) - toSong(w.b), width: w.w, height: w.h, customFake: false, ...(w.customData === undefined ? {} : { customData: w.customData as Obstacle['customData'] }) }))
    .sort((a, b) => a.songBpmTime - b.songBpmTime);
  const arcs: Arc[] = objects.arcs
    .map((s) => ({
      jsonTime: s.b,
      songBpmTime: toSong(s.b),
      color: s.c,
      posX: s.x,
      posY: s.y,
      cutDirection: s.d,
      angleOffset: 0,
      rotation: 0,
      headControlPointLengthMultiplier: s.mu,
      tailJsonTime: s.tb,
      tailSongBpmTime: toSong(s.tb),
      tailPosX: s.tx,
      tailPosY: s.ty,
      tailCutDirection: s.tc,
      tailControlPointLengthMultiplier: s.tmu,
      tailRotation: 0,
      midAnchorMode: s.m,
      ...(s.customData === undefined ? {} : { customData: s.customData as Arc['customData'] }),
    }))
    .sort((a, b) => a.songBpmTime - b.songBpmTime);
  const chains: Chain[] = objects.chains
    .map((s) => ({
      jsonTime: s.b,
      songBpmTime: toSong(s.b),
      color: s.c,
      posX: s.x,
      posY: s.y,
      cutDirection: s.d,
      angleOffset: 0,
      rotation: 0,
      tailJsonTime: s.tb,
      tailSongBpmTime: toSong(s.tb),
      tailPosX: s.tx,
      tailPosY: s.ty,
      tailRotation: 0,
      sliceCount: s.sc,
      squish: s.s,
      customFake: false,
      ...(s.customData === undefined ? {} : { customData: s.customData as Chain['customData'] }),
    }))
    .sort((a, b) => a.songBpmTime - b.songBpmTime);
  return { notes, obstacles, arcs, chains };
}

/** Every object of every kind with its kind (in no particular order). */
export function allObjects(objects: MapObjects): { kind: ObjectKind; item: MapNote | MapBomb | MapWall | MapArc | MapChain }[] {
  return (Object.keys(objects) as ObjectKind[]).flatMap((kind) => objects[kind].map((item) => ({ kind, item })));
}

/** An object's time span (beats): a wall's length, an arc's or chain's tail. */
export function objectSpan(kind: ObjectKind, item: MapNote | MapBomb | MapWall | MapArc | MapChain): [number, number] {
  if (kind === 'walls') return [item.b, item.b + (item as MapWall).d];
  if (kind === 'arcs' || kind === 'chains') return [item.b, (item as MapArc).tb];
  return [item.b, item.b];
}

/**
 * A wall strobe: short walls of one shape one after another from `from` up to `to` — one every `step`
 * beats, each `fill` of the step long (as the lights' strobe).
 */
export function strobeWalls(shape: { x: number; y: number; w: number; h: number }, from: number, to: number, step: number, fill: number): Omit<MapWall, 'id'>[] {
  const out: Omit<MapWall, 'id'>[] = [];
  if (!(step > 0)) return out;
  const length = Math.max(1 / 64, step * Math.min(1, Math.max(0.05, fill)));
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  for (let k = 0; from + k * step < to - 1e-6 && k < 4096; k++) out.push({ b: round(from + k * step), d: round(length), ...shape });
  return out;
}

/** A v3 difficulty's fake walls (Noodle's `customData.fakeObstacles`): shown, not edited. */
export function readFakeWalls(text: string): MapWall[] {
  if (text === '') return [];
  const root = JSON.parse(text) as Json;
  const custom = root.customData;
  if (typeof custom !== 'object' || custom === null) return [];
  return list((custom as Json).fakeObstacles).map((w) => ({ id: newId('f'), b: num(w.b), x: num(w.x), y: num(w.y), d: num(w.d), w: num(w.w, 1), h: num(w.h, 5), ...(typeof w.customData === 'object' && w.customData !== null ? { customData: w.customData as Json } : {}) }));
}

const numbers = (value: unknown): (number | undefined)[] | undefined => (Array.isArray(value) ? value.map((item) => (typeof item === 'number' && Number.isFinite(item) ? item : undefined)) : undefined);

/**
 * Where a wall stands, Noodle Extensions' data taken in (`coordinates` / `_position`, `size` /
 * `_scale`): its left edge in lanes from the grid's left (0–4 the grid), its bottom in rows, its width
 * and height in lanes, its length in lanes (undefined: as long as it lasts), its own turn and its turn
 * about the player (degrees x, y, z) and its own colour.
 */
export function wallFootprint(wall: MapWall) {
  const data = wall.customData ?? {};
  const position = numbers(data.coordinates ?? data._position);
  const size = numbers(data.size ?? data._scale);
  let x = position?.[0] !== undefined ? position[0] + 2 : wall.x;
  let y = position?.[1] ?? wall.y;
  let w = size?.[0] ?? wall.w;
  let h = size?.[1] ?? (position !== undefined || size !== undefined ? wall.h : Math.min(wall.h, 5 - Math.max(0, wall.y)));
  // (a negative size grows the other way)
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  const turn = (value: unknown): [number, number, number] | undefined => {
    if (typeof value === 'number') return [0, value, 0];
    const parts = numbers(value);
    return parts === undefined ? undefined : [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const colour = numbers(data.color ?? data._color);
  return {
    x,
    y,
    w,
    h,
    length: size?.[2],
    local: turn(data.localRotation ?? data._localRotation),
    world: turn(data.worldRotation ?? data._rotation),
    color: colour === undefined ? undefined : ([colour[0] ?? 1, colour[1] ?? 1, colour[2] ?? 1, colour[3] ?? 1] as [number, number, number, number]),
    noodle: position !== undefined || size !== undefined,
  };
}

/** The game's turn of a note's arrow (degrees; 0 points down). */
export const NOTE_ROLL: Record<number, number> = { 0: 180, 1: 0, 2: -90, 3: 90, 4: -135, 5: 135, 6: -45, 7: 45, 8: 0 };

/**
 * How the game turns each note (degrees, 0 = down): its arrow and angle offset — and, for two notes of
 * one colour at one time (a window, a stack), both turned to line up with each other as the game does
 * (a dot after the arrow beside it; two dots along the line between them).
 */
export function noteRolls(notes: readonly MapNote[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const note of notes) out.set(note.id, (NOTE_ROLL[note.d] ?? 0) + (note.d === 8 ? 0 : note.a));
  for (const colour of [0, 1]) {
    const own = notes.filter((note) => note.c === colour).sort((a, b) => a.b - b.b);
    for (let i = 0; i < own.length; ) {
      let j = i + 1;
      while (j < own.length && own[j]!.b <= own[i]!.b + 0.001) j++;
      if (j - i === 2) {
        const first = own[i]!;
        const second = own[i + 1]!;
        if (first.d === second.d || first.d === 8 || second.d === 8) {
          const [guide, companion] = first.d === 8 ? [second, first] : [first, second];
          const lineAngle = (Math.atan2(guide.y - companion.y, guide.x - companion.x) * 180) / Math.PI;
          const cutAxis = guide.d === 8 ? 90 : (NOTE_ROLL[guide.d] ?? 0) - 90;
          const windowAngle = ((((lineAngle - cutAxis + 90) % 180) + 180) % 180) - 90;
          if (guide.d === 8 && companion.d === 8) {
            out.set(guide.id, windowAngle);
            out.set(companion.id, windowAngle);
          } else if (Math.abs(windowAngle) <= 40) {
            out.set(guide.id, (NOTE_ROLL[guide.d] ?? 0) + windowAngle);
            const diagonalDot = companion.d === 8 && (guide.d < 0 || guide.d > 3);
            out.set(companion.id, (NOTE_ROLL[companion.d] ?? 0) + windowAngle + (diagonalDot ? 45 : 0));
          }
        }
      }
      i = j;
    }
  }
  return out;
}
