import { Matrix4, Quaternion, Vector3 } from 'three';
import { chromaRotation, dataRotation, flipZ, localFromWorld, rayBox } from '../src/editor/env-scene';
import { expandObjects, FOG_ID, modsFragment, objectsFragment, sceneCommand, hasMods, fragmentRequirements } from '../src/editor/environment-mods';
import { arrayCount, arrayPlacings, mirrored } from '../src/editor/env-array';
import { animEvents, animTrack, animValue, linkDelta, linkTrack, offsetAnim } from '../src/editor/env-anim';

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
  const loop = { target: 'o:b', keys: { position: [{ id: 'a', beat: 4, value: [0, 0, 0] as [number, number, number] }, { id: 'b', beat: 8, value: [4, 0, 0] as [number, number, number] }], rotation: [{ id: 'c', beat: 0, value: [0, 0, 0] as [number, number, number] }, { id: 'd', beat: 4, value: [0, 360, 0] as [number, number, number] }] }, repeat: { position: 2 } };
  check('played three times: the beat taken back into the first run, then it stays', JSON.stringify(animValue(loop, 'position', 13)) === JSON.stringify([1, 0, 0]) && JSON.stringify(animValue(loop, 'position', 16.5)) === JSON.stringify([4, 0, 0]), animValue(loop, 'position', 13));
  check('a whole round: gone axis by axis', JSON.stringify(animValue(loop, 'rotation', 1)) === JSON.stringify([0, 90, 0]), animValue(loop, 'rotation', 1));
  const looped = animEvents(loop, true);
  check('written: repeat, a whole round as quarter rounds', (looped[0]!.d as { repeat?: number }).repeat === 2 && JSON.stringify((looped[1]!.d as { rotation: unknown }).rotation) === JSON.stringify([[0, 0, 0, 0], [0, 90, 0, 0.25], [0, 180, 0, 0.5], [0, 270, 0, 0.75], [0, 360, 0, 1]]), looped);
  const shape = { uid: 'b', name: 'cube', kind: 'shape' as const, shape: 'Cube' as const, material: 'm', position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
  const mods = { materials: { m: { shader: 'Standard' as const, color: [1, 1, 1, 1] as [number, number, number, number] } }, objects: [shape], anims: [anim, { target: 'Env.[1]Thing', keys: { scale: [{ id: 's', beat: 1, value: [2, 2, 2] as [number, number, number] }] } }, { target: 'o:gone', keys: {} }] };
  const fragment = modsFragment(mods, null);
  check('in the fragment: tracks on both, three events, the game\'s thing by its own (local) names', fragment.customEvents.length === 3 && (fragment.environment.find((entry) => entry.id === 'Env.[1]Thing') as { track?: string }).track === animTrack('Env.[1]Thing') && (fragment.environment.at(-1) as { track?: string }).track === 'lumaticAnim_b', fragment);
  check('an animation alone needs Chroma', JSON.stringify(fragmentRequirements({ anims: [anim] })) === JSON.stringify(['Chroma']) && hasMods({ anims: [anim] }) && !hasMods({ anims: [{ target: 'x', keys: {} }] }));
}

// stage 4–5: materials, the fog, lamps, the player, links, arrays, smooth curves
{
  const v3 = (x: number, y: number, z: number) => [x, y, z];
  const shape = { uid: 'p', name: 'cube', kind: 'shape' as const, shape: 'Cube' as const, material: 'm', position: [5, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
  const child = { uid: 'c', name: 'child', kind: 'shape' as const, shape: 'Cube' as const, material: 'm', position: [6, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
  const row = { ...child, uid: 'r', array: { kind: 'row' as const, count: 2, step: [0, 0, 3] as [number, number, number], turn: [0, 0, 0] as [number, number, number], grow: 1 } };
  const mods = {
    materials: { m: { shader: 'Standard' as const, color: [1, 1, 1, 1] as [number, number, number, number] } },
    objects: [shape, child, row],
    anims: [
      { target: 'o:p', keys: { position: [{ id: 'a', beat: 0, value: v3(5, 0, 0) }, { id: 'b', beat: 4, value: v3(7, 0, 0) }] } },
      { target: 'o:r', keys: { position: [{ id: 'c', beat: 0, value: v3(6, 0, 0) }, { id: 'd', beat: 2, value: v3(6, 1, 0) }] }, spline: { position: true } },
      { target: 'm:m', keys: { color: [{ id: 'e', beat: 1, value: [1, 0, 0, 1] }, { id: 'f', beat: 3, value: [0, 0, 1, 1] }] } },
      { target: 'fog', keys: { attenuation: [{ id: 'g', beat: 0, value: [0.01] }, { id: 'h', beat: 8, value: [0.05] }] }, repeat: { attenuation: 1 } },
      { target: 'player', keys: { position: [{ id: 'i', beat: 2, value: v3(0, 0, 0) }, { id: 'j', beat: 6, value: v3(0, 3, 0) }] } },
      { target: 'Env.[2]Lamp', keys: { alpha: [{ id: 'k', beat: 0, value: [1] }, { id: 'l', beat: 2, value: [3] }] } },
    ],
    links: [{ child: 'o:c', parent: 'o:p' }],
    fog: { attenuation: 0.02 },
    scene: [{ id: 'Env.[2]Lamp', tube: { bloom: 2 } }],
  };
  const fragment = modsFragment(mods, null);
  const events = fragment.customEvents as { b: number; t: string; d: Record<string, unknown> }[];
  const material = fragment.materials.m as { track?: string };
  check('a material\'s colour: on its track', material.track === animTrack('m:m') && events.some((event) => event.t === 'AnimateTrack' && event.d.track === material.track && JSON.stringify(event.d.color) === JSON.stringify([[1, 0, 0, 1, 0], [0, 0, 1, 1, 1]])), events);
  const fog = fragment.environment.find((entry) => entry.id === FOG_ID) as { lookupMethod?: string; components?: unknown; track?: string } | undefined;
  check('the fog: the root found by a pattern, its density, its track', fog?.lookupMethod === 'Regex' && JSON.stringify(fog.components) === JSON.stringify({ BloomFogEnvironment: { attenuation: 0.02 } }) && fog.track === 'lumaticFog' && new RegExp(FOG_ID).test('TimbalandEnvironment.[0]Environment') && !new RegExp(FOG_ID).test('TimbalandEnvironment.[0]Environment.[3]Ring'), fog);
  const fogEvent = events.find((event) => event.t === 'AnimateComponent' && event.d.track === 'lumaticFog');
  check('the fog animated: AnimateComponent, played twice in one event', fogEvent !== undefined && fogEvent.d.duration === 16 && JSON.stringify((fogEvent.d.BloomFogEnvironment as { attenuation: unknown }).attenuation) === JSON.stringify([[0.01, 0], [0.05, 0.5], [0.01, 0.5], [0.05, 1]]), fogEvent);
  const lamp = fragment.environment.find((entry) => entry.id === 'Env.[2]Lamp') as { components?: unknown; track?: string } | undefined;
  check('a lamp of the game: its settings, its track, its brightness animated', JSON.stringify(lamp?.components) === JSON.stringify({ TubeBloomPrePassLight: { bloomFogIntensityMultiplier: 2 } }) && lamp?.track === animTrack('Env.[2]Lamp') && events.some((event) => event.t === 'AnimateComponent' && JSON.stringify(event.d.TubeBloomPrePassLight) === JSON.stringify({ colorAlphaMultiplier: [[1, 0], [3, 1]] })), lamp);
  check('the player: put on its track, moved', events.some((event) => event.t === 'AssignPlayerToTrack' && event.d.track === 'lumaticPlayer' && event.d.target === 'Root') && events.some((event) => event.t === 'AnimateTrack' && event.d.track === 'lumaticPlayer' && event.b === 2 && JSON.stringify(event.d.position) === JSON.stringify([[0, 0, 0, 0], [0, 3, 0, 1]])));
  const parent = events.find((event) => event.t === 'AssignTrackParent');
  check('a link: the child on its own track, hung on its parent\'s link track, staying where it is', JSON.stringify(parent?.d) === JSON.stringify({ childrenTracks: [animTrack('o:c')], parentTrack: linkTrack('o:p'), worldPositionStays: true }) && (fragment.environment.find((entry) => (entry.geometry as { type?: string } | undefined) !== undefined && entry.position !== undefined && (entry.position as number[])[0] === 6 && entry.track !== undefined) as { track?: string } | undefined)?.track === animTrack('o:c'), parent);
  const carried = events.find((event) => event.t === 'AnimateTrack' && event.d.track === linkTrack('o:p'));
  const moves = carried?.d.position as number[][] | undefined;
  check('the link track: how far the parent has gone (none at first, 2 m on at the end)', moves !== undefined && JSON.stringify(moves[0]) === JSON.stringify([0, 0, 0, 0]) && JSON.stringify(moves.at(-1)) === JSON.stringify([2, 0, 0, 1]), moves);
  const others = events.filter((event) => event.t === 'AnimateTrack' && String(event.d.track).startsWith(animTrack('o:r')));
  check('an array: the object and its other, each on its track, as far aside; a smooth curve flagged', others.length === 2 && JSON.stringify((others[1]!.d.position as unknown[])[1]) === JSON.stringify([6, 1, 3, 1, 'splineCatmullRom']), others);
  check('links and the player need Noodle', JSON.stringify(fragmentRequirements(mods)) === JSON.stringify(['Chroma', 'Noodle Extensions']));
  // a parent turned: its children go round it
  const turn = { target: 'o:p', keys: { rotation: [{ id: 'a', beat: 0, value: v3(0, 0, 0) }, { id: 'b', beat: 4, value: v3(0, 90, 0) }] } };
  const delta = linkDelta(turn, shape, 4)!;
  const point = new Vector3(6, 0, 0).applyMatrix4(delta);
  check('a turned parent carries its child round itself', Math.abs(point.distanceTo(new Vector3(5, 0, 0)) - 1) < 1e-6 && Math.abs(point.x - 5) < 1e-6, point);
  check('before the parent moves: nothing', linkDelta(turn, shape, -1) === null);
  // a smooth curve goes through its keys
  const smooth = { target: 'x', keys: { position: [{ id: 'a', beat: 0, value: v3(0, 0, 0) }, { id: 'b', beat: 1, value: v3(1, 2, 0) }, { id: 'c', beat: 2, value: v3(2, 0, 0) }] }, spline: { position: true } };
  check('a smooth curve: through its keys, rounder between them', JSON.stringify(animValue(smooth, 'position', 1)) === JSON.stringify([1, 2, 0]) && animValue(smooth, 'position', 0.5)![1]! > 1, animValue(smooth, 'position', 0.5));
  check('an offset animation: as far aside, as many times bigger', JSON.stringify(offsetAnim({ target: 'o:a', keys: { position: [{ id: 'a', beat: 0, value: v3(1, 0, 0) }], scale: [{ id: 'b', beat: 0, value: v3(2, 2, 2) }] } }, { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, { position: [0, 0, 5], rotation: [0, 0, 0], scale: [2, 2, 2] }, 'o:b').keys) === JSON.stringify({ position: [{ id: 'a', beat: 0, value: [1, 0, 5] }], scale: [{ id: 'b', beat: 0, value: [4, 4, 4] }] }));
}

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
