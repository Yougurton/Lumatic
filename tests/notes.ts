import { noteRolls, readFakeWalls, readObjects, wallFootprint, writeObjects, type MapObjects } from '../src/editor/notes';
import { writeDifficulty } from '../src/editor/map-io';

/**
 * The notes side's objects in and out: a v3 and a v2 difficulty read, written back and read again —
 * the same objects (their custom data too), and the rest of the file untouched.
 *
 * npx tsx tests/notes.ts
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
const strip = (objects: MapObjects) => JSON.stringify(Object.fromEntries(Object.entries(objects).map(([kind, items]) => [kind, (items as { id: string; b: number }[]).map(({ id: _id, ...rest }) => rest).sort((a, b) => a.b - b.b)])));

const v3 = {
  version: '3.3.0',
  bpmEvents: [],
  colorNotes: [
    { b: 4, x: 1, y: 0, c: 0, d: 1, a: 0 },
    { b: 4, x: 2, y: 0, c: 1, d: 1, a: 15, customData: { color: [1, 0, 0] } },
  ],
  bombNotes: [{ b: 6, x: 0, y: 2 }],
  obstacles: [
    { b: 8, x: 0, y: 0, d: 2, w: 1, h: 5 },
    { b: 10, x: 0, y: 2, d: 1, w: 4, h: 3 },
  ],
  sliders: [{ c: 0, b: 12, x: 1, y: 0, d: 1, mu: 1, tb: 13, tx: 1, ty: 2, tc: 0, tmu: 1, m: 0 }],
  burstSliders: [{ c: 1, b: 14, x: 2, y: 2, d: 1, tb: 14.5, tx: 2, ty: 0, sc: 5, s: 1 }],
  basicBeatmapEvents: [{ b: 1, et: 1, i: 1, f: 1 }],
  colorBoostBeatmapEvents: [],
  customData: { fakeColorNotes: [{ b: 3, x: 0, y: 0, c: 0, d: 8 }] },
};
const read3 = readObjects(JSON.stringify(v3));
check('v3 counts', read3.notes.length === 2 && read3.bombs.length === 1 && read3.walls.length === 2 && read3.arcs.length === 1 && read3.chains.length === 1, read3);
check('v3 custom data kept', JSON.stringify(read3.notes[1]?.customData) === JSON.stringify({ color: [1, 0, 0] }));
const root3 = structuredClone(v3) as Record<string, unknown>;
writeObjects(root3, read3, '3');
check('v3 round trip', strip(readObjects(JSON.stringify(root3))) === strip(read3));
check('v3 rest kept', JSON.stringify(root3.customData) === JSON.stringify(v3.customData));
// a note added, a wall taken out
read3.notes.push({ id: 'x', b: 20, x: 3, y: 1, c: 1, d: 5, a: 0 });
read3.walls.shift();
const written = writeDifficulty(JSON.stringify(v3), [], undefined, undefined, undefined, read3);
const again = readObjects(written);
check('v3 edits written', again.notes.length === 3 && again.walls.length === 1 && again.notes.some((note) => note.b === 20 && note.d === 5));

const v2 = {
  _version: '2.6.0',
  _notes: [
    { _time: 2, _lineIndex: 0, _lineLayer: 0, _type: 0, _cutDirection: 1 },
    { _time: 2, _lineIndex: 3, _lineLayer: 0, _type: 1, _cutDirection: 1, _customData: { _color: [0, 1, 0] } },
    { _time: 3, _lineIndex: 1, _lineLayer: 2, _type: 3, _cutDirection: 0 },
  ],
  _obstacles: [
    { _time: 4, _lineIndex: 0, _type: 0, _duration: 1, _width: 1 },
    { _time: 5, _lineIndex: 0, _type: 1, _duration: 2, _width: 4 },
  ],
  _sliders: [],
  _events: [{ _time: 1, _type: 1, _value: 1, _floatValue: 1 }],
};
const read2 = readObjects(JSON.stringify(v2));
check('v2 counts', read2.notes.length === 2 && read2.bombs.length === 1 && read2.walls.length === 2, read2);
check('v2 crouch wall', read2.walls[1]?.y === 2 && read2.walls[1].h === 3);
const root2 = structuredClone(v2) as Record<string, unknown>;
writeObjects(root2, read2, '2');
check('v2 round trip', strip(readObjects(JSON.stringify(root2))) === strip(read2));
check('v2 wall types', JSON.stringify((root2._obstacles as { _type: number }[]).map((wall) => wall._type)) === '[0,1]');
check('v2 custom data kept', JSON.stringify((root2._notes as { _customData?: unknown }[])[1]?._customData) === JSON.stringify({ _color: [0, 1, 0] }));

const v4 = {
  version: '4.0.0',
  colorNotes: [{ b: 2, r: 0, i: 0 }],
  colorNotesData: [{ x: 1, y: 1, c: 1, d: 3, a: 0 }],
  bombNotes: [{ b: 3, r: 0, i: 0 }],
  bombNotesData: [{ x: 2, y: 0 }],
  obstacles: [{ b: 4, r: 0, i: 0 }],
  obstaclesData: [{ d: 1, x: 0, y: 0, w: 2, h: 5 }],
  arcs: [],
  arcsData: [],
  chains: [{ hb: 5, tb: 5.5, hr: 0, tr: 0, i: 0, ci: 0 }],
  chainsData: [{ tx: 1, ty: 0, c: 4, s: 1 }],
};
const read4 = readObjects(JSON.stringify(v4));
check('v4 read', read4.notes[0]?.d === 3 && read4.bombs[0]?.x === 2 && read4.walls[0]?.w === 2 && read4.chains[0]?.sc === 4, read4);

// the game's window turn: a dot beside a down-right arrow, both turned to the line between them
const rolls = noteRolls([{ id: 'w1', b: 10, x: 2, y: 2, c: 1, d: 8, a: 0 }, { id: 'w2', b: 10, x: 3, y: 0, c: 1, d: 7, a: 0 }]);
check('window turn', Math.abs((rolls.get('w1') ?? 0) - 26.565) < 0.01 && Math.abs((rolls.get('w2') ?? 0) - 26.565) < 0.01, [...rolls]);
const stack = noteRolls([{ id: 'a', b: 1, x: 1, y: 0, c: 0, d: 1, a: 0 }, { id: 'b', b: 1, x: 1, y: 1, c: 0, d: 1, a: 0 }]);
check('stack stays', stack.get('a') === 0 && stack.get('b') === 0);
// Noodle walls: coordinates and size, a negative width
const noodle = wallFootprint({ id: 'n', b: 0, x: 0, y: 0, d: 1, w: 1, h: 5, customData: { coordinates: [-1, 1], size: [-2, 0.5, 3], localRotation: [0, 0, 45], color: [1, 0, 0] } });
check('noodle wall', noodle.x === -1 && noodle.w === 2 && noodle.y === 1 && noodle.h === 0.5 && noodle.length === 3 && noodle.local?.[2] === 45 && noodle.color?.[0] === 1, noodle);
check('fake walls', readFakeWalls(JSON.stringify({ version: '3.3.0', customData: { fakeObstacles: [{ b: 2, x: 1, y: 0, d: 1, w: 1, h: 5 }] } })).length === 1);
console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
