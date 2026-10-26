import { readFileSync } from 'node:fs';
import type { EnvironmentData } from '../src/engine/renderer/environment/types';
import { environmentParts, modsFragment, replaceFragment, ringSystemParts, type EnvironmentFragment } from '../src/editor/environment-mods';

/**
 * The environment's changes: what they write finds what it should in the environment (its Chroma ids),
 * and writing them again takes the ones written before out, the map's own entries left as they are.
 *
 * npx tsx tests/environment.ts
 */

let failures = 0;
let checks = 0;
const check = (ok: boolean, ...what: unknown[]) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('fail', ...what);
  }
};

const load = (id: string) => JSON.parse(readFileSync(new URL(`../public/environments/${id}.json`, import.meta.url), 'utf8')) as EnvironmentData;
const ids = (data: EnvironmentData) => data.objects.map((object) => (object.components?.ChromaIDMarker ?? []).map((marker) => marker.ChromaID));
const found = (data: EnvironmentData, id: string) => {
  const expression = new RegExp(id);
  return data.objects.flatMap((object, index) => (ids(data)[index]!.some((value) => expression.test(value)) ? [object] : []));
};

for (const environment of ['DefaultEnvironment', 'BigMirrorEnvironment', 'TimbalandEnvironment', 'PanicEnvironment']) {
  const data = load(environment);
  const parts = environmentParts(data);
  check(parts.length > 3, environment, 'parts', parts.length);
  const part = parts[0]!;
  const systems = ringSystemParts(data);
  const ring = systems[0]!;
  const fragment = modsFragment({ hidden: [part.name], rings: { [ring.ring]: { size: 1.5, thickness: 2 } } }, data);
  // the part: every object of its name right under the environment's root, nothing else
  const hide = found(data, fragment.environment[0]!.id as string);
  check(hide.length === part.count && hide.every((object) => object.name.replace(/ \(\d+\)$/u, '') === part.name), environment, 'hidden', part.name, hide.length, part.count);
  // the rings: all of them, whatever place the game gives them
  const rings = found(data, fragment.environment[1]!.id as string);
  check(rings.length === ring.count && rings.every((object) => object.name === ring.ring), environment, 'rings', rings.length, ring.count);
  check(JSON.stringify(fragment.environment[1]!.scale) === JSON.stringify(ring.scale.map((value) => value * 1.5)), environment, 'ring scale');
  // the light tubes in them
  for (const entry of fragment.environment.slice(2)) {
    const tubes = found(data, entry.id as string);
    check(tubes.length >= ring.count && tubes.every((object) => object.components?.ParametricBloomFogLightController !== undefined), environment, 'tubes', entry.id, tubes.length);
  }
}

// written again: the ones before out, the map's own kept; v2 keys for a v2 file
const before: EnvironmentFragment = { environment: [{ id: 'A', lookupMethod: 'Contains', active: false }], materials: { m: { shader: 'Standard' } }, customEvents: [{ b: 1, t: 'AnimateTrack', d: { track: 'x' } }], pointDefinitions: {} };
const next: EnvironmentFragment = { environment: [{ id: 'B', lookupMethod: 'Contains', active: false }], materials: {}, customEvents: [{ b: 0, t: 'AnimateTrack', d: { track: 'y' } }], pointDefinitions: {} };
const custom = { environment: [{ id: 'Mine', lookupMethod: 'Exact', active: false }, ...before.environment], materials: { ...before.materials, own: { shader: 'OpaqueLight' } }, customEvents: [...before.customEvents, { b: 2, t: 'AnimateTrack', d: { track: 'mine' } }], bookmarks: [1] };
const out = replaceFragment(custom, before, next, false);
check(JSON.stringify((out.environment as { id: string }[]).map((entry) => entry.id)) === '["Mine","B"]', 'environment', out.environment);
check(JSON.stringify(Object.keys(out.materials as object)) === '["own"]', 'materials', out.materials);
check(JSON.stringify((out.customEvents as { d: { track: string } }[]).map((event) => event.d.track)) === '["y","mine"]', 'events', out.customEvents);
check(JSON.stringify(out.bookmarks) === '[1]', 'other data kept');
const v2 = replaceFragment({ _environment: [{ _id: 'Mine', _lookupMethod: 'Exact', _active: false }, { _id: 'A', _lookupMethod: 'Contains', _active: false }] }, before, next, true);
check(JSON.stringify(v2._environment) === '[{"_id":"Mine","_lookupMethod":"Exact","_active":false},{"_id":"B","_lookupMethod":"Contains","_active":false}]', 'v2', v2._environment);
const emptied = replaceFragment({ environment: before.environment, materials: before.materials, customEvents: before.customEvents }, before, { environment: [], materials: {}, customEvents: [], pointDefinitions: {} }, false);
check(Object.keys(emptied).length === 0, 'emptied', emptied);

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
