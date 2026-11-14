import { matchObjects } from '../src/editor/note-filter';
import { emptyObjects, placeOf, readObjects, setPlace, usesNoodlePlaces, writeObjects, type MapObjects } from '../src/editor/notes';

/**
 * The notes side's "select by…" and the free grid's places (Noodle Extensions' coordinates).
 *
 * npx tsx tests/select.ts
 */

let checks = 0;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL', name, detail ?? '');
  }
};

const objects: MapObjects = {
  ...emptyObjects(),
  notes: [
    { id: 'r-up', b: 1, x: 0, y: 0, c: 0, d: 0, a: 0 },
    { id: 'b-down', b: 2, x: 3, y: 2, c: 1, d: 1, a: 0 },
    { id: 'b-dot', b: 3, x: 2, y: 1, c: 1, d: 8, a: 0 },
    { id: 'free', b: 4, x: 3, y: 0, c: 0, d: 1, a: 0, customData: { coordinates: [3.5, 0.25] } },
  ],
  bombs: [{ id: 'bomb', b: 2, x: 1, y: 0 }],
  walls: [{ id: 'wall', b: 0, x: 1, y: 0, d: 8, w: 2, h: 5 }],
};
const all = { from: 0, to: 10, kinds: ['notes', 'bombs', 'walls', 'arcs', 'chains'] as const, colors: [0, 1], directions: [0, 1, 2, 3, 4, 5, 6, 7, 8], columns: [0, 1, 2, 3], rows: [0, 1, 2] };
const ids = (criteria: Partial<typeof all>) => matchObjects(objects, { ...all, ...criteria, kinds: [...(criteria.kinds ?? all.kinds)] }).sort();

check('everything', ids({}).length === 6, ids({}));
check('blue notes', JSON.stringify(ids({ kinds: ['notes'], colors: [1] })) === JSON.stringify(['b-dot', 'b-down']), ids({ kinds: ['notes'], colors: [1] }));
check('dots only', JSON.stringify(ids({ kinds: ['notes'], directions: [8] })) === JSON.stringify(['b-dot']), ids({ kinds: ['notes'], directions: [8] }));
check('top row', JSON.stringify(ids({ kinds: ['notes', 'bombs'], rows: [2] })) === JSON.stringify(['b-down']), ids({ kinds: ['notes', 'bombs'], rows: [2] }));
check('within beats 1.5–2.5', JSON.stringify(ids({ from: 1.5, to: 2.5 })) === JSON.stringify(['b-down', 'bomb', 'wall']), ids({ from: 1.5, to: 2.5 }));
check('a wall by any column it covers', ids({ kinds: ['walls'], columns: [2] }).includes('wall') && !ids({ kinds: ['walls'], columns: [0] }).includes('wall'));
check('a free note by its nearest column', ids({ kinds: ['notes'], columns: [3], colors: [0] }).includes('free'));

// the free grid's places
{
  const note = { id: 'n', b: 0, x: 0, y: 0, c: 0, d: 1, a: 0 } as { id: string; b: number; x: number; y: number; c: number; d: number; a: number; customData?: Record<string, unknown> };
  setPlace(note, 1.25, 0.75);
  check('off the cells: coordinates', JSON.stringify(note.customData?.coordinates) === JSON.stringify([-0.75, 0.75]) && note.x === 1 && note.y === 1, note);
  const place = placeOf(note);
  check('read back', place.free && place.x === 1.25 && place.y === 0.75, place);
  setPlace(note, 2, 1);
  check('on a cell: plain again', note.customData === undefined && note.x === 2 && note.y === 1, note);
  setPlace(note, -2, 4);
  check('beyond the grid', JSON.stringify(note.customData?.coordinates) === JSON.stringify([-4, 4]) && note.x === 0 && note.y === 2, note);
  const kept = { id: 'k', b: 0, x: 0, y: 0, customData: { color: [1, 0, 0], coordinates: [0, 0] } } as { id: string; b: number; x: number; y: number; customData?: Record<string, unknown> };
  setPlace(kept, 1, 0);
  check('its other data kept', JSON.stringify(kept.customData) === JSON.stringify({ color: [1, 0, 0] }), kept);
}

// written: v3 as coordinates, v2 as _position / _scale; Noodle needed
{
  const free: MapObjects = { ...emptyObjects(), notes: [{ id: 'n', b: 1, x: 3, y: 0, c: 1, d: 1, a: 0, customData: { coordinates: [1.25, 0] } }], walls: [{ id: 'w', b: 2, x: 0, y: 0, d: 1, w: 1, h: 5, customData: { coordinates: [-2.5, 0.5], size: [0.75, 1.5] } }] };
  check('Noodle needed', usesNoodlePlaces(free) && !usesNoodlePlaces(objects.notes.length > 0 ? { ...objects, notes: objects.notes.filter((n) => n.id !== 'free') } : objects));
  const v3: Record<string, unknown> = { version: '3.3.0' };
  writeObjects(v3, free, '3');
  const back3 = readObjects(JSON.stringify(v3));
  check('v3 keeps coordinates', JSON.stringify(back3.notes[0]?.customData) === JSON.stringify({ coordinates: [1.25, 0] }), back3.notes[0]);
  const v2: Record<string, unknown> = { _version: '2.6.0' };
  writeObjects(v2, free, '2');
  const notes = v2._notes as { _customData?: Record<string, unknown> }[];
  const walls = v2._obstacles as { _customData?: Record<string, unknown> }[];
  check('v2 note: _position', JSON.stringify(notes[0]?._customData) === JSON.stringify({ _position: [1.25, 0] }), notes[0]);
  check('v2 wall: _position and _scale', JSON.stringify(walls[0]?._customData) === JSON.stringify({ _position: [-2.5, 0.5], _scale: [0.75, 1.5] }), walls[0]);
  const back2 = readObjects(JSON.stringify(v2));
  check('v2 read back: the same place', placeOf(back2.notes[0]!).x === 3.25, back2.notes[0]);
}

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
