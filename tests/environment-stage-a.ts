import { checkScene } from '../src/editor/env-checks';

Object.assign(globalThis, {
  window: globalThis,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  localStorage: { getItem: () => null, setItem: () => undefined },
});
const { Editor } = await import('../src/editor/editor');
import { objectCommand, sceneCommand } from '../src/editor/environment-mods';
import type { EnvironmentData } from '../src/engine/renderer/environment/types';

/** npx tsx tests/environment-stage-a.ts */
let checks = 0;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL', name, detail ?? '');
  }
};
const near = (a: readonly number[], b: readonly number[]) => a.every((value, index) => Math.abs(value - b[index]!) < 1e-4);

const editor = new Editor({} as never);
editor.project = {
  format: 'lumatic', version: 1, difficulty: 'test.dat', environment: 'TestEnvironment', clips: [], raw: [], expanded: [],
  scene: [], objects: [], anims: [], materials: {},
};
editor.envSceneData = {
  objects: [
    { name: 'Parent', parent: -1, position: [0, 0, -10], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: 'Child', parent: 0, position: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { ChromaIDMarker: [{ ChromaID: 'Child', enabled: true }] } },
  ],
  meshes: {},
} as unknown as EnvironmentData;
(editor as unknown as { sceneStep: () => void }).sceneStep = () => undefined;
(editor as unknown as { putAnims: (anims: unknown, tidy: boolean) => void }).putAnims = (anims) => {
  (editor.project!.environmentMods ??= {}).anims = anims as Editor['sceneAnims'] extends () => infer R ? R : never;
};
(editor as unknown as { putScene: (scene: unknown, objects: unknown, materials?: unknown) => void }).putScene = (scene, objects, materials) => {
  const mods = (editor.project!.environmentMods ??= {});
  mods.scene = scene as Editor['sceneEdits'] extends () => infer R ? R : never;
  mods.objects = objects as Editor['sceneObjects'] extends () => infer R ? R : never;
  if (materials !== undefined) mods.materials = materials as Editor['sceneMaterials'] extends () => infer R ? R : never;
};
(editor as unknown as { sceneChanged: () => void }).sceneChanged = () => undefined;

(editor.project.environmentMods ??= {}).anims = [{ target: 'g:1', keys: { position: [{ id: 'key', beat: 0, value: [3, 0, 0] }] } }];
editor.setSceneSpace(['g:1'], 'world');
const worldEdit = editor.sceneEdits()[0];
check('local to world applies the game parent', worldEdit !== undefined && near(worldEdit.position, [2, 0, 10]) && worldEdit.space === 'world', worldEdit);
check('the animation key is converted too', near(editor.sceneAnims()[0]!.keys.position![0]!.value, [3, 0, 10]), editor.sceneAnims()[0]!.keys.position);
check('world command uses position, not localPosition', JSON.stringify(sceneCommand({ ...worldEdit!, id: 'Child' })) === JSON.stringify({ id: 'Child', lookupMethod: 'Exact', position: [2, 0, 10], rotation: [0, 0, 0] }), sceneCommand({ ...worldEdit!, id: 'Child' }));

editor.setSceneSpace(['g:1'], 'local');
const localEdit = editor.sceneEdits()[0];
check('world to local returns the original values', localEdit !== undefined && near(localEdit.position, [2, 0, 0]) && localEdit.space === 'local', localEdit);
check('the animation key returns too', near(editor.sceneAnims()[0]!.keys.position![0]!.value, [3, 0, 0]), editor.sceneAnims()[0]!.keys.position);

(editor.project.environmentMods ??= {}).objects = [
  { uid: 'a', name: 'A', kind: 'shape', shape: 'Cube', material: 'stone', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], collision: true },
  { uid: 'b', name: 'B', kind: 'shape', shape: 'Cube', material: 'stone', position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
];
(editor.project.environmentMods ??= {}).materials = { stone: { shader: 'Standard', color: [0.5, 0.5, 0.5, 1] } };
const shapeCommand = objectCommand(editor.sceneObjects()[0]!, editor.sceneMaterials());
check('collision is written into geometry', JSON.stringify(shapeCommand?.geometry) === JSON.stringify({ type: 'Cube', material: 'stone', collision: true }), shapeCommand);

const own = editor.makeMaterialOwn(['a']);
check('make own creates a separate material', own !== null && own !== 'stone' && editor.sceneObjects()[0]!.material === own, own);
check('the other object keeps the shared material', editor.sceneObjects()[1]!.material === 'stone');
check('the shared material is not changed', own !== null && editor.sceneMaterials()[own] !== editor.sceneMaterials().stone);

editor.applyScene(['g:1'], () => ({ locked: true }));
check('lock is available to the picker', editor.sceneValues('g:1')?.locked === true);
check('lock is not written into Chroma JSON', sceneCommand(editor.sceneEdits().find((edit) => edit.id === 'Child')!)?.locked === undefined);

const { issues } = checkScene({
  mods: {}, knownIds: new Set(), gameLights: new Map(), events: 0,
  environmentEntries: [
    { id: 'Both', position: [0, 0, 0], localPosition: [1, 2, 3] },
    { id: 'Turn', rotation: [0, 0, 0], localRotation: [0, 90, 0] },
    { id: 'Clean', localPosition: [1, 2, 3] },
  ],
});
check('position/localPosition conflict is reported', issues.some((issue) => issue.targets.includes('Both') && issue.text.includes('положение в мире')));
check('rotation/localRotation conflict is reported', issues.some((issue) => issue.targets.includes('Turn') && issue.text.includes('поворот в мире')));
check('single-space entries are accepted', !issues.some((issue) => issue.targets.includes('Clean')));

console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
