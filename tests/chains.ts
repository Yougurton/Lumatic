import { chainFromNote, directionOf, type MapNote } from '../src/editor/notes';

/**
 * Chains: made from one note (its tail along the arrow), the head's arrow turned to where the tail is.
 *
 * npx tsx tests/chains.ts
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

const note = (x: number, y: number, d: number): MapNote => ({ id: 'n', b: 4, x, y, c: 0, d, a: 0 });

// a down note on the top row: the tail two rows down, a quarter later
{
  const chain = chainFromNote(note(1, 2, 1));
  check('down: tail two rows down', chain.tx === 1 && chain.ty === 0 && chain.tb === 4.25 && chain.d === 1, chain);
}
// a down-right note at the bottom: no room down — the tail stays where it can
{
  const chain = chainFromNote(note(2, 0, 7));
  check('down-right at the bottom: the tail as far as the grid goes', chain.tx === 2 && chain.ty === 0, chain);
}
// a right note in column 2: one cell of room
{
  const chain = chainFromNote(note(2, 1, 3));
  check('right: one cell of room', chain.tx === 3 && chain.ty === 1, chain);
}
// a dot: made a down chain
check('a dot: down', chainFromNote(note(1, 2, 8)).d === 1);

// the head's arrow turned to the tail
check('tail below: down', directionOf(0, -2, 0) === 1);
check('tail right: right', directionOf(2, 0, 0) === 3);
check('tail down-left: down-left', directionOf(-1, -1, 0) === 6);
check('tail up-right: up-right', directionOf(2, 2, 0) === 5);
check('tail mostly down: down', directionOf(1, -2, 0) === 1 || directionOf(1, -2, 0) === 7, directionOf(1, -2, 0));
check('tail on the head: as it was', directionOf(0, 0, 4) === 4);

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
