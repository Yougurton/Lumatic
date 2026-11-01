import { checkMap, CHECK_RULES } from '../src/editor/checks';
import type { MapObjects } from '../src/editor/notes';

/**
 * The map checker: each rule caught on a small made-up pattern, and left quiet on a clean one.
 *
 * npx tsx tests/checks.ts
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
let id = 0;
const n = (b: number, x: number, y: number, c: number, d: number, a = 0) => ({ id: `n${String(id++)}`, b, x, y, c, d, a });
const bomb = (b: number, x: number, y: number) => ({ id: `b${String(id++)}`, b, x, y });
const wall = (b: number, x: number, y: number, d: number, w: number, h: number) => ({ id: `w${String(id++)}`, b, x, y, d, w, h });
const map = (part: Partial<MapObjects>): MapObjects => ({ notes: [], bombs: [], walls: [], arcs: [], chains: [], ...part });
// 120 BPM: a beat is half a second
const run = (part: Partial<MapObjects>, songSeconds = 130) => checkMap({ objects: map(part), seconds: (beat) => beat / 2, songSeconds, difficulty: 'Expert' });
const rules = (part: Partial<MapObjects>, songSeconds?: number) => new Set(run(part, songSeconds).map((issue) => issue.rule));
/** Notes enough to fill the map (from beat 8 to 200, down/up alternating) — no issue of their own;
 *  the patterns tried go after them (from beat 210). */
const filler = () => {
  const out = [];
  for (let b = 8; b <= 200; b += 2) out.push(n(b, 1, 0, 0, b % 4 === 0 ? 1 : 0), n(b, 2, 0, 1, b % 4 === 0 ? 1 : 0));
  return out;
};

check('rules have names', CHECK_RULES.every((rule) => rule.name.length > 0));
const clean = rules({ notes: filler() }, 110);
check('clean map', clean.size === 0, [...clean]);
check('stacked', rules({ notes: [...filler(), n(210.5, 0, 0, 0, 1), n(210.5, 0, 0, 1, 1)] }).has('stacked'));
check('handclap', rules({ notes: [...filler(), n(211, 1, 1, 0, 3), n(211, 2, 1, 1, 2)] }).has('handclap'));
check('parallel', rules({ notes: [...filler(), n(211, 0, 2, 0, 1), n(211, 1, 2, 0, 1)] }).has('parallel'));
check('stack ok', !rules({ notes: [...filler(), n(211, 0, 2, 0, 1), n(211, 0, 1, 0, 1)] }).has('parallel'));
check('same swing angle', rules({ notes: [...filler(), n(211, 0, 2, 0, 1), n(211, 0, 1, 0, 0)] }).has('sameSwingAngle'));
check('pre swing', rules({ notes: [...filler(), n(211, 1, 1, 0, 1), n(211, 1, 2, 1, 8)] }).has('preSwing'));
check('double directional', rules({ notes: [...filler(), n(211, 0, 0, 0, 1), n(211.5, 0, 0, 0, 1)] }).has('doubleDirectional'));
check('bomb reset', !rules({ notes: [...filler(), n(211, 0, 0, 0, 1), n(212.5, 0, 0, 0, 1)], bombs: [bomb(211.75, 0, 2)] }).has('doubleDirectional'));
check('vision block', rules({ notes: [...filler(), n(211, 1, 1, 0, 1), n(211.25, 2, 0, 1, 1)] }).has('visionBlock'));
check('angle offset', rules({ notes: [...filler(), n(211, 0, 0, 0, 1, 15)] }).has('angleOffset'));
check('hammer hit', rules({ notes: [...filler(), n(211, 0, 1, 0, 1)], bombs: [bomb(211, 0, 0)] }).has('hammerHit'));
check('bomb spacing', rules({ notes: filler(), bombs: [bomb(211, 0, 2), bomb(211.02, 0, 2)] }).has('bombSpacing'));
check('in wall', rules({ notes: [...filler(), n(221, 3, 0, 1, 1)], walls: [wall(220, 3, 0, 4, 1, 5)] }).has('inWall'));
check('wall short', rules({ notes: filler(), walls: [wall(220, 0, 0, 0.01, 1, 5)] }).has('wallShape'));
check('danger dash', rules({ notes: filler(), walls: [wall(220, 1, 0, 2, 2, 5)] }).has('dangerDash'));
check('crouch fine', !rules({ notes: filler(), walls: [wall(220, 0, 2, 2, 4, 3)] }).has('dangerDash'));
check('rapid dodge', rules({ notes: filler(), walls: [wall(220, 1, 0, 0.3, 1, 5), wall(220.5, 2, 0, 0.3, 1, 5), wall(221, 1, 0, 0.3, 1, 5), wall(221.5, 2, 0, 0.3, 1, 5)] }).has('rapidDodge'));
check('hot start', rules({ notes: [n(1, 0, 0, 0, 1), ...filler()] }).has('hotStart'));
check('cold end', rules({ notes: filler() }, 101).has('coldEnd'));
check('short map', rules({ notes: [n(8, 1, 0, 0, 1), n(20, 1, 0, 0, 0)] }).has('mapLength'));
// a fast stream: one hand every 0.08 s for 4 s (375 BPM)
const fast = [];
for (let t = 105; t < 109; t += 0.08) fast.push(n(t * 2, 0, 0, 0, Math.round(t / 0.08) % 2));
check('fast stream', rules({ notes: [...filler(), ...fast] }).has('fastStream'));
check('switched off', !checkMap({ objects: map({ notes: [n(1, 0, 0, 0, 1), ...filler()] }), seconds: (beat) => beat / 2, songSeconds: 120, disabled: ['hotStart'] }).some((issue) => issue.rule === 'hotStart'));

console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
