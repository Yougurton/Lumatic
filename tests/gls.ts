import { defaultFilter, filterFor, filterUnits } from '../src/editor/gls';

/**
 * GLS filters: the order from the middle out / the edges in, and the filter found for elements
 * picked by hand.
 *
 * npx tsx tests/gls.ts
 */

let checks = 0;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL', name, JSON.stringify(detail));
  }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
check('outward even', same(filterUnits({ ...defaultFilter(), order: 'outward' }, 6), [[2, 3], [1, 4], [0, 5]]), filterUnits({ ...defaultFilter(), order: 'outward' }, 6));
check('outward odd', same(filterUnits({ ...defaultFilter(), order: 'outward' }, 5), [[2], [1, 3], [0, 4]]));
check('inward', same(filterUnits({ ...defaultFilter(), order: 'inward' }, 4), [[0, 3], [1, 2]]));
const all = filterFor([0, 1, 2, 3, 4, 5, 6, 7], 8, defaultFilter());
check('all → division 1', all.type === 'division' && all.sections === 1, all);
const half = filterFor([4, 5, 6, 7], 8, defaultFilter());
check('half → section 2/2', half.type === 'division' && half.sections === 2 && half.section === 1, half);
const odd = filterFor([1, 3, 5, 7], 8, defaultFilter());
check('every other → step 2 from 2nd', odd.type === 'step' && odd.step === 2 && odd.offset === 1, odd);
const one = filterFor([5], 8, defaultFilter());
check('one → step 0', one.type === 'step' && one.step === 0 && one.offset === 5, one);
const custom = filterFor([0, 2, 3, 7], 8, { ...defaultFilter(), reverse: true });
check('by hand → custom, order kept', custom.type === 'custom' && same(custom.elements, [0, 2, 3, 7]) && custom.reverse, custom);
check('custom picks them', same(filterUnits(custom, 8), [[7], [3], [2], [0]]), filterUnits(custom, 8));
console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
