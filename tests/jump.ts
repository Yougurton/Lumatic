import { jumpOf, jumpWarnings, offsetForReaction } from '../src/editor/jump';

/**
 * The jump: the game's half jump and jump distance, a reaction time turned back into an offset, and
 * BSMG's ranges.
 *
 * npx tsx tests/jump.ts
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
// 120 BPM, NJS 16: 16 × 0.5 × 4 = 32 > 18 → half 2 beats; JD = 16 × 0.5 × 2 × 2 = 32 m; RT 1000 ms
const a = jumpOf(120, 16, 0);
check('half jump', a.half === 2 && Math.abs(a.distance - 32) < 1e-9 && Math.abs(a.reaction - 1000) < 1e-9, a);
// an offset of −1 beat: half 1, RT 500 ms
check('offset', Math.abs(jumpOf(120, 16, -1).reaction - 500) < 1e-9);
// a reaction time back to its offset
const offset = offsetForReaction(120, 16, 600);
check('reaction → offset', Math.abs(jumpOf(120, 16, offset).reaction - 600) < 1, offset);
// the half jump never under a quarter beat
check('least half', jumpOf(120, 16, -5).half === 0.25);
// warnings: a short reaction time; an NJS out of Easy's range
check('short reaction', jumpWarnings('Expert', 16, 20, 300).some((item) => item.level === 'bad'));
check('easy NJS', jumpWarnings('Easy', 18, 27, 800).some((item) => item.text.includes('NJS')));
check('fine', jumpWarnings('ExpertPlus', 18, 22, 600, 6).length === 0, jumpWarnings('ExpertPlus', 18, 22, 600, 6));
console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
