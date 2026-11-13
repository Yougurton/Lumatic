import { Matrix4, Quaternion, Vector3 } from 'three';
import { chromaRotation, dataRotation, flipZ, localFromWorld, rayBox } from '../src/editor/env-scene';
import { modsFragment, objectsFragment, sceneCommand, hasMods, fragmentRequirements } from '../src/editor/environment-mods';

/**
 * The scene editor's numbers: Chroma's turns and places to the 3D view's and back, a click's ray
 * against an object's box, an edit as Chroma's command.
 *
 * npx tsx tests/scene.ts
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
const near = (a: readonly number[], b: readonly number[], eps = 1e-3) => a.length === b.length && a.every((value, k) => Math.abs(value - b[k]!) < eps);

for (const rotation of [[0, 0, 0], [30, 0, 0], [0, 45, 0], [0, 0, 60], [10, 20, 30], [-80, 170, -45]]) check(`turn ${rotation.join(',')} there and back`, near(chromaRotation(dataRotation(rotation)), rotation), chromaRotation(dataRotation(rotation)));
check('place: z the other way', near(flipZ([1, 2, 3]), [1, 2, -3]));

// a box one metre across standing 5 m ahead (the view looks along -z)
{
  const box = { min: [-0.5, -0.5, -0.5] as [number, number, number], max: [0.5, 0.5, 0.5] as [number, number, number] };
  const matrix = new Matrix4().compose(new Vector3(0, 0, -5), new Quaternion(), new Vector3(1, 1, 1));
  const hit = rayBox(new Vector3(0, 0, 0), new Vector3(0, 0, -1), box, matrix);
  check('a ray into the box: 4.5 m', hit !== null && Math.abs(hit - 4.5) < 1e-6, hit);
  check('a ray past it: a miss', rayBox(new Vector3(2, 0, 0), new Vector3(0, 0, -1), box, matrix) === null);
  const scaled = new Matrix4().compose(new Vector3(0, 0, -5), new Quaternion(), new Vector3(6, 1, 1));
  check('made wider: hit', rayBox(new Vector3(2, 0, 0), new Vector3(0, 0, -1), box, scaled) !== null);
}

// an object's own numbers from where it stands under its parent
{
  const parent = new Matrix4().compose(new Vector3(0, 1, -10), new Quaternion(), new Vector3(2, 2, 2));
  const world = new Matrix4().compose(new Vector3(4, 1, -20), new Quaternion(), new Vector3(2, 2, 2));
  const local = localFromWorld(world, parent);
  check('its own place under the parent (Chroma: z ahead)', near(local.position, [2, 0, 5]) && near(local.scale, [1, 1, 1]), local);
}

// an edit as Chroma's command
check('nothing changed: no command', sceneCommand({ id: 'a' }) === null && !hasMods({ scene: [{ id: 'a' }] }));
check('hidden', JSON.stringify(sceneCommand({ id: 'a', hidden: true })) === JSON.stringify({ id: 'a', lookupMethod: 'Exact', active: false }));
{
  const fragment = modsFragment({ scene: [{ id: 'Env.[1]Thing', position: [1, 2, 3], rotation: [0, 90, 0], scale: [2, 2, 2] }] }, null);
  check('moved, turned, sized', JSON.stringify(fragment.environment) === JSON.stringify([{ id: 'Env.[1]Thing', lookupMethod: 'Exact', localPosition: [1, 2, 3], localRotation: [0, 90, 0], scale: [2, 2, 2] }]), fragment.environment);
}

// the added objects: a copy, a shape, a lamp — and only the materials they use
{
  const mods = {
    materials: { stone: { shader: 'Standard' as const, color: [0.5, 0.5, 0.5, 1] as [number, number, number, number] }, lamp: { shader: 'OpaqueLight' as const, color: [1, 1, 1, 1] as [number, number, number, number] }, unused: { shader: 'Glowing' as const, color: [1, 0, 0, 1] as [number, number, number, number] } },
    objects: [
      { uid: 'a', name: 'copy', kind: 'copy' as const, source: 'Env.[3]Ring', position: [1, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] },
      { uid: 'b', name: 'cube', kind: 'shape' as const, shape: 'Cube' as const, material: 'stone', position: [0, 1, 5] as [number, number, number], rotation: [0, 45, 0] as [number, number, number], scale: [2, 2, 2] as [number, number, number] },
      { uid: 'c', name: 'lamp', kind: 'shape' as const, shape: 'Cylinder' as const, material: 'lamp', position: [3, 1, 5] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [0.2, 3, 0.2] as [number, number, number], light: { type: 4, id: 101 }, hidden: true },
    ],
  };
  const made = objectsFragment(mods);
  check('a copy: duplicate of the original, its own place', JSON.stringify(made.environment[0]) === JSON.stringify({ id: 'Env.[3]Ring', lookupMethod: 'Exact', duplicate: 1, localPosition: [1, 0, 0], localRotation: [0, 0, 0], scale: [1, 1, 1] }), made.environment[0]);
  check('a shape: geometry with its material by name', JSON.stringify(made.environment[1]) === JSON.stringify({ geometry: { type: 'Cube', material: 'stone' }, position: [0, 1, 5], rotation: [0, 45, 0], scale: [2, 2, 2] }), made.environment[1]);
  check('a lamp: its light ID and type, hidden', JSON.stringify(made.environment[2]) === JSON.stringify({ geometry: { type: 'Cylinder', material: 'lamp' }, position: [3, 1, 5], rotation: [0, 0, 0], scale: [0.2, 3, 0.2], components: { ILightWithId: { type: 4, lightID: 101 } }, active: false }), made.environment[2]);
  check('only the materials in use', JSON.stringify(Object.keys(made.materials)) === JSON.stringify(['stone', 'lamp']), made.materials);
  const fragment = modsFragment({ ...mods, scene: [{ id: 'Env.[1]Thing', hidden: true }] }, null);
  check('the added objects last in the fragment', fragment.environment.length === 4 && (fragment.environment[3] as { geometry?: unknown }).geometry !== undefined, fragment.environment);
  check('Chroma needed', JSON.stringify(fragmentRequirements(mods)) === JSON.stringify(['Chroma']) && hasMods(mods));
}

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
