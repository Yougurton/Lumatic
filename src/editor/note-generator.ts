import type { MapBomb, MapNote } from './notes';

/**
 * Notes for one beat made up to fit what comes before them: so many red and blue notes, each hand
 * swinging the other way from its last note (parity), on its own side, not in each other's way. Every
 * pattern that keeps to the rules, best first — "another one" goes down the list.
 *
 * The rules (hard): a hand's notes at one beat are one swing — the same direction, lined up along it
 * (a stack, a tower, a window); no two notes in a cell; red never right of blue; no notes in the
 * middle two cells of the middle row (they block the view); no two notes swung into each other.
 * The rest is scored: each hand near where its last note was, on its own side, the usual rows.
 */

/** Cut directions: 0 up, 1 down, 2 left, 3 right, 4 up-left, 5 up-right, 6 down-left, 7 down-right, 8 any. */
const UP = [0, 4, 5];
const DOWN = [1, 6, 7];
/** Along a swing: the step from one note of a stack to the next (the way the saber goes). */
const AXIS: Record<number, [number, number]> = { 0: [0, 1], 1: [0, -1], 2: [-1, 0], 3: [1, 0], 4: [-1, 1], 5: [1, 1], 6: [-1, -1], 7: [1, -1] };

export interface GeneratedNote {
  x: number;
  y: number;
  c: 0 | 1;
  d: number;
}

export interface GeneratorInput {
  /** The beat the notes go at. */
  beat: number;
  red: number;
  blue: number;
  /** The map's notes and bombs (the ones at `beat` of a colour being made are put aside). */
  notes: readonly MapNote[];
  bombs: readonly MapBomb[];
}

/** The directions a hand can swing next: the other way from its last note (any way, without one, or
 *  after a long rest: down first then). */
function nextDirections(last: MapNote | undefined, beat: number): number[] {
  if (last === undefined || beat - last.b >= 4) return [1, 6, 7, 0, 4, 5];
  if (UP.includes(last.d)) return DOWN;
  if (DOWN.includes(last.d)) return UP;
  if (last.d === 2) return [3, 5, 7];
  if (last.d === 3) return [2, 4, 6];
  return [1, 6, 7, 0, 4, 5];
}

/** A hand's notes for a direction: `count` cells in a line along it, from each start that fits. */
function lines(direction: number, count: number): { x: number; y: number }[][] {
  const [dx, dy] = AXIS[direction] ?? [0, 0];
  const out: { x: number; y: number }[][] = [];
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 3; y++) {
      const cells = Array.from({ length: count }, (_, k) => ({ x: x + dx * k, y: y + dy * k }));
      if (cells.every((cell) => cell.x >= 0 && cell.x < 4 && cell.y >= 0 && cell.y < 3)) out.push(cells);
    }
  }
  return out;
}

const blocksView = (cell: { x: number; y: number }) => cell.y === 1 && (cell.x === 1 || cell.x === 2);

/** How well a hand's notes sit (higher: better). */
function handScore(cells: readonly { x: number; y: number }[], direction: number, color: 0 | 1, last: MapNote | undefined) {
  let score = 0;
  for (const cell of cells) {
    // (its own side: red on the left two columns, blue on the right two)
    const outward = color === 0 ? 1 - cell.x : cell.x - 2;
    score += outward >= 0 ? 1 : outward === -1 ? -1.5 : -4;
    // (the usual rows: the bottom one most, the top one for swings up)
    score += cell.y === 0 ? 0.8 : cell.y === 2 ? (UP.includes(direction) ? 0.3 : -0.6) : 0;
  }
  // (near where the hand was: a big jump across the grid is awkward)
  if (last !== undefined) {
    const first = cells[0]!;
    score -= 0.6 * (Math.abs(first.x - last.x) + Math.abs(first.y - last.y));
  }
  // (straight swings a little more than slanted ones, outward slants more than inward)
  if (direction === 0 || direction === 1) score += 0.4;
  else if ((color === 0 && (direction === 4 || direction === 6)) || (color === 1 && (direction === 5 || direction === 7))) score += 0.2;
  return score;
}

/** Every pattern for the beat that keeps to the rules, best first. */
export function generatePatterns(input: GeneratorInput): GeneratedNote[][] {
  const at = (item: { b: number }) => Math.abs(item.b - input.beat) < 1e-6;
  const making = new Set<number>([...(input.red > 0 ? [0] : []), ...(input.blue > 0 ? [1] : [])]);
  // (what stays at the beat: bombs, and notes of a colour not being made)
  const taken = new Set<string>([...input.bombs.filter(at), ...input.notes.filter((note) => at(note) && !making.has(note.c))].map((item) => `${String(item.x)},${String(item.y)}`));
  const kept = input.notes.filter((note) => at(note) && !making.has(note.c));
  const lastOf = (color: 0 | 1) => [...input.notes].filter((note) => note.c === color && note.b < input.beat - 1e-6).sort((a, b) => b.b - a.b)[0];
  const options = (color: 0 | 1, count: number) => {
    if (count <= 0) return [{ notes: [] as GeneratedNote[], score: 0 }];
    const last = lastOf(color);
    const out: { notes: GeneratedNote[]; score: number }[] = [];
    for (const direction of nextDirections(last, input.beat)) {
      for (const cells of lines(direction, count)) {
        if (cells.some((cell) => blocksView(cell) || taken.has(`${String(cell.x)},${String(cell.y)}`))) continue;
        out.push({ notes: cells.map((cell) => ({ ...cell, c: color, d: direction })), score: handScore(cells, direction, color, last) });
      }
    }
    return out;
  };
  const reds = options(0, input.red);
  const blues = options(1, input.blue);
  const all: { notes: GeneratedNote[]; score: number }[] = [];
  for (const red of reds) {
    for (const blue of blues) {
      const notes = [...red.notes, ...blue.notes];
      if (notes.length === 0) continue;
      // no two in a cell
      if (new Set(notes.map((note) => `${String(note.x)},${String(note.y)}`)).size < notes.length) continue;
      // red never right of blue (the kept notes counted too)
      const redX = [...red.notes, ...kept.filter((note) => note.c === 0)].map((note) => note.x);
      const blueX = [...blue.notes, ...kept.filter((note) => note.c === 1)].map((note) => note.x);
      if (redX.length > 0 && blueX.length > 0 && Math.max(...redX) > Math.min(...blueX)) continue;
      // no swings into each other: red cutting right into a blue note beside it (and blue left into red)
      const into = red.notes.some((r) => (r.d === 3 || r.d === 5 || r.d === 7) && blue.notes.some((b) => b.y === r.y && b.x === r.x + 1)) || blue.notes.some((b) => (b.d === 2 || b.d === 4 || b.d === 6) && red.notes.some((r) => r.y === b.y && r.x === b.x - 1));
      if (into) continue;
      // (both hands the same way up or down: easier to read than one up, one down)
      const together = red.notes.length > 0 && blue.notes.length > 0 && (UP.includes(red.notes[0]!.d) === UP.includes(blue.notes[0]!.d)) ? 0.5 : 0;
      all.push({ notes, score: red.score + blue.score + together });
    }
  }
  return all.sort((a, b) => b.score - a.score).map((entry) => entry.notes);
}
