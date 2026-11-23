import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lightGroupsOf } from '../src/editor/box-groups';
import { describeLightGroups, groupCan } from '../src/editor/gls-environment';
import type { EnvironmentData } from '../src/engine/renderer/environment/types';

/**
 * The light groups an environment's data describes (src/editor/gls-environment.ts), against the
 * game's list the editor carries (src/editor/gls-groups.json): the same groups, the same numbers
 * of elements — for the built-in GLS environments, the ones given (default: Weave and Lattice).
 *
 *   esbuild tests/gls-environment.ts --bundle --platform=node --format=cjs --outfile=/tmp/gls-environment.cjs
 *   node /tmp/gls-environment.cjs [Environment name …]
 */

let failed = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

const names = process.argv.length > 2 ? process.argv.slice(2) : ['WeaveEnvironment', 'LatticeEnvironment'];
for (const name of names) {
  const data = JSON.parse(readFileSync(join('public', 'environments', `${name}.json`), 'utf8').replace(/^﻿/u, '')) as EnvironmentData;
  const known = lightGroupsOf(name);
  const described = describeLightGroups(data, known);
  console.log(`\n${name}: ${String(described.length)} groups described, ${String(known.length)} in the game's list`);

  check(known.length > 0, 'the game\'s list has the environment');
  check(
    JSON.stringify(described.map((group) => group.id)) === JSON.stringify(known.map((group) => group.id)),
    'the same group numbers',
  );
  const sizes = described.filter((group) => group.count !== known.find((item) => item.id === group.id)?.count);
  check(sizes.length === 0, `the same numbers of elements${sizes.length > 0 ? ` (differ: ${sizes.map((group) => `${String(group.id)}: ${String(group.count)}`).join(', ')})` : ''}`);
  const idle = described.filter((group) => !groupCan(group, 'color') && !groupCan(group, 'rotation') && !groupCan(group, 'translation') && !groupCan(group, 'fx'));
  check(idle.length === 0, `every group does something${idle.length > 0 ? ` (nothing: ${idle.map((group) => String(group.id)).join(', ')})` : ''}`);

  const count = (pick: (group: (typeof described)[number]) => boolean) => described.filter(pick).length;
  console.log(
    `  info colour ${String(count((group) => group.color))}, turning ${String(count((group) => group.rotationAxes.length > 0))}, moving ${String(count((group) => group.translationAxes.length > 0))}, FX ${String(count((group) => group.fx))}`,
  );
}

console.log(failed === 0 ? '\nAll passed' : `\n${String(failed)} failed`);
process.exit(failed === 0 ? 0 : 1);
