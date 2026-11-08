import { generatePatterns } from '../src/editor/note-generator';
import type { MapNote } from '../src/editor/notes';

let checks = 0;
let failures = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('fail', what, detail);
  }
};
const note = (b: number, x: number, y: number, c: number, d: number): MapNote => ({ id: `n${String(b)}${String(x)}${String(y)}`, b, x, y, c, d, a: 0 });
const UP = [0, 4, 5];
const DOWN = [1, 6, 7];

// after a red down and a blue down at beat 4: at beat 6 both swing up
{
  const notes = [note(4, 1, 0, 0, 1), note(4, 2, 0, 1, 1)];
  const patterns = generatePatterns({ beat: 6, red: 1, blue: 1, notes, bombs: [] });
  check(patterns.length > 3, 'a few patterns for one red and one blue', patterns.length);
  const best = patterns[0]!;
  check(best.every((n) => UP.includes(n.d)), 'both swing up after swinging down', best);
  check(best.find((n) => n.c === 0)!.x <= best.find((n) => n.c === 1)!.x, 'red left of blue', best);
  for (const pattern of patterns) {
    check(!pattern.some((n) => n.y === 1 && (n.x === 1 || n.x === 2)), 'nothing in the middle of the middle row', pattern);
    const red = pattern.filter((n) => n.c === 0);
    const blue = pattern.filter((n) => n.c === 1);
    check(Math.max(...red.map((n) => n.x)) <= Math.min(...blue.map((n) => n.x)), 'never crossed', pattern);
  }
}

// two blue notes at once: one swing — the same direction, lined up along it
{
  const notes = [note(4, 3, 0, 1, 0)];
  const patterns = generatePatterns({ beat: 5, red: 0, blue: 2, notes, bombs: [] });
  check(patterns.length > 0, 'two blue notes: some pattern', patterns.length);
  for (const pattern of patterns.slice(0, 20)) {
    const [a, b] = pattern;
    check(pattern.length === 2 && a!.d === b!.d && DOWN.includes(a!.d), 'a stack: the same swing, down after up', pattern);
    const dx = b!.x - a!.x;
    const dy = b!.y - a!.y;
    check(Math.max(Math.abs(dx), Math.abs(dy)) === 1, 'a stack: notes side by side', pattern);
  }
}

// notes already at the beat of a colour not made stay, and are kept clear of
{
  const notes = [note(8, 2, 0, 1, 1)];
  const patterns = generatePatterns({ beat: 8, red: 1, blue: 0, notes, bombs: [] });
  check(patterns.every((pattern) => pattern.every((n) => n.x <= 2 && !(n.x === 2 && n.y === 0))), 'red: left of the blue note there, not on it', patterns.slice(0, 5));
}

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
