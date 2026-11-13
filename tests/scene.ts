import { Matrix4, Quaternion, Vector3 } from 'three';
import { chromaRotation, dataRotation, flipZ, localFromWorld, rayBox } from '../src/editor/env-scene';
import { expandObjects, modsFragment, objectsFragment, sceneCommand, hasMods, fragmentRequirements } from '../src/editor/environment-mods';
import { arrayCount, arrayPlacings, mirrored } from '../src/editor/env-array';
import { animEvents, animTrack, animValue } from '../src/editor/env-anim';

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

// many of one object
{
  const base = { position: [1, 0, 5] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
  const near = (a: readonly number[], b: readonly number[]) => a.every((value, k) => Math.abs(value - b[k]!) < 1e-3);
  const row = arrayPlacings(base, { kind: 'row', count: 4, step: [2, 0, 0], turn: [0, 10, 0], grow: 2 });
  check('a row: the others, each a step on', row.length === 3 && near(row[2]!.position, [7, 0, 5]) && near(row[2]!.rotation, [0, 30, 0]) && near(row[1]!.scale, [4, 4, 4]), row);
  const circle = arrayPlacings(base, { kind: 'circle', count: 4, axis: 1, centre: [0, 0, 5], angle: 360, face: true });
  check('a round: a quarter each, as far from the centre', circle.length === 3 && circle.every((item) => Math.abs(Math.hypot(item.position[0], item.position[2] - 5) - 1) < 1e-3) && near(circle[1]!.position, [-1, 0, 5]) && Math.abs(Math.abs(circle[0]!.rotation[1]) - 90) < 1e-3, circle);
  check('a round: turned as Chroma turns about y', near(circle[0]!.position, [0, 0, 5 - Math.sign(circle[0]!.rotation[1])]), circle[0]);
  const half = arrayPlacings(base, { kind: 'circle', count: 3, axis: 1, centre: [0, 0, 5], angle: 180, face: false });
  check('a part of a round: the last at its end', near(half[1]!.position, [-1, 0, 5]) && near(half[1]!.rotation, [0, 0, 0]), half);
  const grid = arrayPlacings(base, { kind: 'grid', counts: [2, 2, 2], steps: [1, 2, 3] });
  check('a grid', grid.length === 7 && near(grid[6]!.position, [2, 2, 8]), grid);
  const line = arrayPlacings(base, { kind: 'line', count: 3, end: [0, 0, 10], bend: [0, 2, 0] });
  check('a bent line: ends at its end, its middle pulled aside', near(line[1]!.position, [1, 0, 15]) && near(line[0]!.position, [1, 2, 10]), line);
  const scatter = { kind: 'scatter' as const, count: 20, size: [4, 2, 6] as [number, number, number], turn: 0, sizeFrom: 1, sizeTo: 1, seed: 7 };
  const once = arrayPlacings(base, scatter);
  check('a scatter: in its box, the same again', once.length === 19 && once.every((item) => Math.abs(item.position[0] - 1) <= 2 && Math.abs(item.position[1]) <= 1 && Math.abs(item.position[2] - 5) <= 3) && JSON.stringify(once) === JSON.stringify(arrayPlacings(base, scatter)) && JSON.stringify(once) !== JSON.stringify(arrayPlacings(base, { ...scatter, seed: 8 })));
  check('counted', arrayCount({ kind: 'grid', counts: [3, 1, 3], steps: [1, 1, 1] }) === 9 && arrayCount({ kind: 'row', count: 100000, step: [1, 0, 0], turn: [0, 0, 0], grow: 1 }) === 500);
  check('mirrored', JSON.stringify(mirrored({ position: [2, 1, 3], rotation: [10, 20, 30], scale: [1, 2, 3] })) === JSON.stringify({ position: [-2, 1, 3], rotation: [10, -20, -30], scale: [1, 2, 3] }));
  const lamp = { uid: 'l', name: 'lamp', kind: 'shape' as const, shape: 'Cube' as const, material: 'lamp', ...base, light: { type: 0, id: 101 }, array: { kind: 'row' as const, count: 3, step: [1, 0, 0] as [number, number, number], turn: [0, 0, 0] as [number, number, number], grow: 1 }, arrayLights: [102, 103] };
  const ghost = { uid: 'g', name: 'ring', kind: 'copy' as const, source: 'Env.[3]Ring', ...base, ghost: true, array: { kind: 'row' as const, count: 3, step: [0, 0, 2] as [number, number, number], turn: [0, 0, 0] as [number, number, number], grow: 1 } };
  const all = expandObjects([lamp, ghost]);
  check('an array written out: the object, its others; a ghost: only the others', all.length === 5 && all[2]!.light?.id === 103 && all[2]!.of === 'l' && all[3]!.of === 'g' && all[4]!.position[2] === 9, all);
  const made = objectsFragment({ materials: { lamp: { shader: 'OpaqueLight', color: [1, 1, 1, 1], track: 't', keywords: ['A'] } }, objects: [lamp, ghost] });
  check('in the fragment: five commands, a material with its track and keywords', made.environment.length === 5 && JSON.stringify(made.materials.lamp) === JSON.stringify({ shader: 'OpaqueLight', color: [1, 1, 1, 1], track: 't', shaderKeywords: ['A'] }), made);
}

// animation: keys on beats
{
  const anim = { target: 'o:b', keys: { position: [{ id: 'k2', beat: 8, value: [4, 0, 0] as [number, number, number], easing: 'easeInQuad' }, { id: 'k1', beat: 4, value: [0, 0, 0] as [number, number, number] }], rotation: [{ id: 'r1', beat: 2, value: [0, 90, 0] as [number, number, number] }] } };
  check('before the first key: the thing\'s own value', animValue(anim, 'position', 3) === null && animValue(anim, 'scale', 5) === null);
  check('between keys: eased', JSON.stringify(animValue(anim, 'position', 6)) === JSON.stringify([1, 0, 0]), animValue(anim, 'position', 6));
  check('after the last key: it stays', JSON.stringify(animValue(anim, 'position', 20)) === JSON.stringify([4, 0, 0]));
  const turn = animValue({ target: 'x', keys: { rotation: [{ id: 'a', beat: 0, value: [0, 0, 0] }, { id: 'b', beat: 2, value: [0, 90, 0] }] } }, 'rotation', 1)!;
  check('a turn half way', Math.abs(turn[1] - 45) < 1e-3 && Math.abs(turn[0]) < 1e-3, turn);
  const events = animEvents(anim, true);
  check('written: an event a part, beats as shares of its length', JSON.stringify(events) === JSON.stringify([{ b: 4, t: 'AnimateTrack', d: { track: 'lumaticAnim_b', duration: 4, position: [[0, 0, 0, 0], [4, 0, 0, 1, 'easeInQuad']] } }, { b: 2, t: 'AnimateTrack', d: { track: 'lumaticAnim_b', duration: 0, rotation: [[0, 90, 0, 0]] } }]), events);
  const shape = { uid: 'b', name: 'cube', kind: 'shape' as const, shape: 'Cube' as const, material: 'm', position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
  const mods = { materials: { m: { shader: 'Standard' as const, color: [1, 1, 1, 1] as [number, number, number, number] } }, objects: [shape], anims: [anim, { target: 'Env.[1]Thing', keys: { scale: [{ id: 's', beat: 1, value: [2, 2, 2] as [number, number, number] }] } }, { target: 'o:gone', keys: {} }] };
  const fragment = modsFragment(mods, null);
  check('in the fragment: tracks on both, three events, the game\'s thing by its own (local) names', fragment.customEvents.length === 3 && (fragment.environment.find((entry) => entry.id === 'Env.[1]Thing') as { track?: string }).track === animTrack('Env.[1]Thing') && (fragment.environment.at(-1) as { track?: string }).track === 'lumaticAnim_b', fragment);
  check('an animation alone needs Chroma', JSON.stringify(fragmentRequirements({ anims: [anim] })) === JSON.stringify(['Chroma']) && hasMods({ anims: [anim] }) && !hasMods({ anims: [{ target: 'x', keys: {} }] }));
}

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
