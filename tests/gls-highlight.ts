import { Color, Group, ShaderMaterial } from 'three';
import { DEFAULT_COLORS } from '../src/engine/core/colors';
import type { MapRenderData } from '../src/engine/core/placement/map-render-data';
import { EnvironmentLightRuntime } from '../src/engine/renderer/map/environment-light-runtime';
import type { EnvironmentGlsColorTarget, EnvironmentLightSegment, LoadedEnvironment } from '../src/engine/renderer/environment/environment-runtime';

/**
 * GLS groups and individual elements use the same highlight path as classic light IDs.
 *
 * npx tsx tests/gls-highlight.ts
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

function target(id: number) {
  const material = new ShaderMaterial({ uniforms: { _Color: { value: new Color(0, 0, 0) }, _ColorMultiplier: { value: 0 } } });
  const segment = {
    start: [0, 0, 0],
    end: [0, 1, 0],
    color: [0, 0, 0],
    alpha: 1,
    node: new Group(),
    bindings: [],
    localStart: [0, 0, 0],
    localEnd: [0, 1, 0],
    baseLength: 1,
    center: 0.5,
    multiplyLengthByAlpha: false,
    alphaToLengthCurve: { keys: [] },
    alphaToLengthBloomFogCurve: { keys: [] },
  } as unknown as EnvironmentLightSegment;
  const materialLight = { materials: [material], bindings: [], intensityMultiplier: 1 };
  const glsTarget: EnvironmentGlsColorTarget = {
    id,
    key: `target-${String(id)}`,
    node: new Group(),
    materials: [material],
    colorProperty: '_Color',
    segments: [segment],
    materialLights: [materialLight],
    transform: () => ({ color: [0, 0, 0], alpha: 0, visible: true }),
  };
  return { material, segment, materialLight, glsTarget };
}

const first = target(0);
const second = target(1);
const environment = {
  root: new Group(),
  lightSegments: [first.segment, second.segment],
  materialLights: [first.materialLight, second.materialLight],
  backgroundGradient: null,
  rotations: [],
  ringGroups: [],
  glsColorGroups: [{ groupId: 7, count: 2, targets: [first.glsTarget, second.glsTarget] }],
  glsRotationGroups: [],
  glsTranslationGroups: [],
  glsFxGroups: [],
  spectrograms: [],
  eventSwitches: [],
  boostSwitches: [],
  playerPlatformNodes: [],
  directionalLights: [],
  data: { id: 'test', colorScheme: {} },
  applyChromaRemoval: () => undefined,
  enforceChromaRemoval: () => undefined,
  applyConstraints: () => false,
  syncInstancedMeshes: () => undefined,
  applyReflections: () => undefined,
  dispose: () => undefined,
} as unknown as LoadedEnvironment;
const map = {
  songBpm: 120,
  bpmEvents: [],
  lightColorEventBoxGroups: [],
  lightRotationEventBoxGroups: [],
  lightTranslationEventBoxGroups: [],
  fxEventBoxGroups: [],
  lightEvents: [],
  environmentRemoval: [],
} as unknown as MapRenderData;

first.glsTarget.node!.visible = false;
second.glsTarget.node!.visible = false;
const runtime = new EnvironmentLightRuntime();
runtime.setEnvironment(environment);
runtime.setMap(map, DEFAULT_COLORS);
runtime.setHighlight([{ type: 7, id: 1 }], [1, 0, 0], 0.75);
runtime.update(0);
const secondColor = second.material.uniforms._Color!.value as Color;
check('only the picked GLS element flashes', first.material.uniforms._ColorMultiplier.value === 0 && second.material.uniforms._ColorMultiplier.value === 0.75);
check('the flash reaches the material color', secondColor.r === 0.75 && secondColor.g === 0 && secondColor.b === 0);
check('the flash reaches light segments', runtime.lightSegments[1]?.color[0] === 0.75 && runtime.lightSegments[1]?.alpha === 0.75);
check('unpicked segments stay dark', runtime.lightSegments[0]?.alpha === 0);
check('the picked element becomes visible even when initially hidden', first.glsTarget.node!.visible === false && second.glsTarget.node!.visible === true);

runtime.setHighlight([{ type: 7, id: 0 }, { type: 7, id: 1 }], [0, 1, 0], 0.5);
runtime.update(0);
check('the whole GLS group flashes', first.material.uniforms._ColorMultiplier.value === 0.5 && second.material.uniforms._ColorMultiplier.value === 0.5);
runtime.setHighlight(null);
runtime.update(0);
check('clearing the highlight restores the show', first.material.uniforms._ColorMultiplier.value === 0 && second.material.uniforms._ColorMultiplier.value === 0);
check('clearing also restores initial visibility', first.glsTarget.node!.visible === false && second.glsTarget.node!.visible === false);

first.material.dispose();
second.material.dispose();
console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
