import { Texture, Vector3 } from 'three';
import { createLitEnvironmentMaterial } from '../src/engine/renderer/environment/materials/lit-environment-material';
import type { EnvironmentMaterialContext } from '../src/engine/renderer/environment/materials/material-context';
import type { FogUniforms } from '../src/engine/renderer/bloomfog/pipeline';
import type { EnvironmentMaterialData } from '../src/engine/renderer/environment/types';

/**
 * Unity's texture defaults in converted materials (Monstercat 2's light panels).
 *
 * npx tsx tests/environment-materials.ts
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

const explicitTexture = new Texture();
const context: EnvironmentMaterialContext = {
  fog: {} as FogUniforms,
  reflectionTexture: { value: new Texture() },
  directionalLights: {
    directions: { value: Array.from({ length: 5 }, () => new Vector3()) },
    colors: { value: Array.from({ length: 5 }, () => new Vector3()) },
    positions: { value: Array.from({ length: 5 }, () => new Vector3()) },
    radii: { value: Array.from({ length: 5 }, () => 0) },
  },
  textures: new Map([['custom', explicitTexture]]),
};
const data: EnvironmentMaterialData = {
  name: 'LightPanelNew',
  shader: 'ChroMapper/Lit',
  family: 'lit',
  colors: {},
  floats: { _EmissionTexture: 1 },
  keywords: ['_EMISSIONTEXTURE_SIMPLE'],
};

const white = createLitEnvironmentMaterial(data, context, [1, 1, 1]);
check('an empty emission slot uses Unity’s white texture', white.uniforms._EmissionTex?.value instanceof Texture && white.defines.EMISSION_TEXTURE === 1);
check('the default uses neutral texture coordinates', white.uniforms._EmissionTexScale?.value.toArray().join(',') === '1,1' && white.uniforms._EmissionTexOffset?.value.toArray().join(',') === '0,0');
const explicit = createLitEnvironmentMaterial(
  { ...data, textures: { _EmissionTex: { asset: 'custom', scale: [2, 3], offset: [0.25, 0.5] } } },
  context,
  [1, 1, 1],
);
check('an assigned texture and its coordinates are kept', explicit.uniforms._EmissionTex?.value === explicitTexture && explicit.uniforms._EmissionTexScale?.value.toArray().join(',') === '2,3' && explicit.uniforms._EmissionTexOffset?.value.toArray().join(',') === '0.25,0.5');
const disabled = createLitEnvironmentMaterial({ ...data, floats: { _EmissionTexture: 0 } }, context, [1, 1, 1]);
check('disabled emission does not gain a fallback', disabled.defines.EMISSION_TEXTURE === undefined);
white.dispose();
explicit.dispose();
disabled.dispose();
explicitTexture.dispose();
console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
