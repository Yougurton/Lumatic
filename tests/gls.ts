import { defaultFilter, filterFor, filterUnits, generateGls, newColorBox, pointsToBlocks } from '../src/editor/gls';
import type { LightClip } from '../src/editor/model';

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
// points (before 0.19) → blocks: on at 0, fading to dark by 1 — one block fading out
const scheme = { left: [1, 0, 0] as [number, number, number], right: [0, 0, 1] as [number, number, number], white: [1, 1, 1] as [number, number, number] };
const blocks = pointsToBlocks(
  [
    { id: 'a', beat: 0, transition: 'instant', color: { ref: 'left', brightness: 1 }, brightness: 1, strobe: 0 },
    { id: 'b', beat: 1, transition: 'fade', color: { ref: 'left', brightness: 1 }, brightness: 0, strobe: 0 },
    { id: 'c', beat: 2, transition: 'instant', color: { ref: 'right', brightness: 1 }, brightness: 0.5, strobe: 4 },
    { id: 'd', beat: 3, transition: 'instant', color: { ref: 'right', brightness: 1 }, brightness: 0, strobe: 0 },
  ],
  4,
  scheme,
);
check('points → blocks', blocks.length === 2 && blocks[0]!.start === 0 && blocks[0]!.end === 1 && blocks[0]!.endMode === 'fade' && blocks[1]!.strobe === 4 && blocks[1]!.color.brightness === 0.5, blocks);
// blocks over elements: a wave of 1 beat over 4 elements, +0.4 brightness at the last
const box = { ...newColorBox({ ref: 'left', brightness: 1 }), beatValue: 1, value: 0.4, affectFirst: true };
const made = generateGls({ boxes: [box] }, 10, 12, {
  scheme,
  items: 4,
  makeClip: (item, start, end): LightClip => ({ id: '', type: 0, ids: null, start, end, startMode: 'on', fadeIn: 0.25, endMode: 'off', color: { ref: 'left', brightness: 1 }, endColor: null, layer: 1, slot: item }),
  ringCount: () => 1,
  secondsPerBeat: 0.5,
});
const starts = made.clips.map((clip) => [clip.slot, clip.start, Math.round(clip.color.brightness * 100) / 100]);
check('blocks spread', JSON.stringify(starts) === JSON.stringify([[0, 10, 1], [1, 10.25, 1.13], [2, 10.5, 1.27], [3, 10.75, 1.4]]), starts);
console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
