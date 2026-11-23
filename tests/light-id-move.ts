import { canMoveByLightId, clampLightIdShift } from '../src/editor/light-id-move';
import type { LightClip } from '../src/editor/model';

/** npx tsx tests/light-id-move.ts */
let checks = 0;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL', name, detail ?? '');
  }
};

const clip = (id: string, type: number, ids: number[] | null): LightClip => ({
  id,
  type,
  ids,
  start: 2,
  end: 4,
  startMode: 'on',
  fadeIn: 0.5,
  endMode: 'off',
  color: { ref: 'left', brightness: 1 },
  endColor: null,
  layer: 1,
});
const lights = new Map([[5, Array.from({ length: 20 }, (_, index) => index + 1)]]);
const selected = [clip('a', 5, [10]), clip('b', 5, [11, 12])];

check('one type with explicit IDs can move vertically', canMoveByLightId(selected, 2, lights));
check('a mixed selection stays a time drag', !canMoveByLightId(selected, 3, lights));
check('different event types stay a time drag', !canMoveByLightId([selected[0]!, clip('c', 6, [10])], 2, lights));
check('all-lights clips stay a time drag', !canMoveByLightId([clip('a', 5, null)], 1, lights));
check('custom-group clips stay a time drag', !canMoveByLightId([{ ...selected[0]!, target: 'group' }], 1, lights));
check('effect children stay a time drag', !canMoveByLightId([{ ...selected[0]!, group: 'effect' }], 1, lights));
check('IDs absent from the environment are not accepted', !canMoveByLightId([clip('a', 5, [99])], 1, lights));
check('IDs 10–12 move to 8–10', clampLightIdShift(selected, lights.get(5)!, -2) === -2);
check('the upper range clamps the whole selection', clampLightIdShift(selected, lights.get(5)!, 99) === 8);
check('the lower range clamps the whole selection', clampLightIdShift(selected, lights.get(5)!, -99) === -9);
check('a requested hole does not move the selection', clampLightIdShift([clip('a', 5, [3]), clip('b', 5, [5])], [1, 3, 5, 7], -1) === 0);
check('a whole shift across holes works downward', clampLightIdShift([clip('a', 5, [3]), clip('b', 5, [5])], [1, 3, 5, 7], -2) === -2);
check('a requested hole upward does not move either', clampLightIdShift([clip('a', 5, [3]), clip('b', 5, [5])], [1, 3, 5, 7], 1) === 0);
check('a whole shift across holes works upward', clampLightIdShift([clip('a', 5, [3]), clip('b', 5, [5])], [1, 3, 5, 7], 2) === 2);
check('no opposite-direction fallback at a boundary', clampLightIdShift([clip('a', 5, [1])], [1, 3, 5], -2) === 0);

console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
