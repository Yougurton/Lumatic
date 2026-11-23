import { ShaderMaterial } from 'three';
import { applySpectrumProperties, buildSpectrumProperties } from '../src/engine/renderer/environment/environment-spectrogram';
import { ENVIRONMENT_LIT_VERT } from '../src/engine/renderer/shaders/environment-surface-shaders';
import type { EnvironmentData } from '../src/engine/renderer/environment/types';

/**
 * Spectrum-driven material properties and the vertex displacement they control (Monstercat 2's teeth).
 *
 * npx tsx tests/spectrogram.ts
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

const data = {
  objects: [
    {
      components: {
        MaterialPropertyBlockController: [{ Renderers: [], enabled: true }],
        SpectrogramMpbProperty: [
          {
            MpbController: { obj: 0, component: 'MaterialPropertyBlockController', componentIndex: 0 },
            DataIndex: 1,
            PropertyName: '_DisplacementStrength',
            Multiplier: 2,
            Curve: { keys: [{ time: 0, value: 0, inSlope: 0, outSlope: 1 }, { time: 1, value: 1, inSlope: 1, outSlope: 0 }] },
            enabled: true,
          },
        ],
      },
    },
  ],
} as unknown as EnvironmentData;
const material = new ShaderMaterial({ uniforms: { _DisplacementStrength: { value: 0 } } });
buildSpectrumProperties(data, [[material]]);
const samples = new Float32Array(64);
samples[1] = 0.375;
applySpectrumProperties(samples);
check('the tooth takes its own spectrum band through its curve and multiplier', material.uniforms._DisplacementStrength?.value === 0.75, material.uniforms._DisplacementStrength?.value);
applySpectrumProperties(null);
check('no song puts the tooth at rest', material.uniforms._DisplacementStrength?.value === 0, material.uniforms._DisplacementStrength?.value);
check(
  'ordinary displacement respects every axis, including the teeth’s vertical one',
  ENVIRONMENT_LIT_VERT.includes('localNormal * displacement.r * _DisplacementAxisMultiplier * _DisplacementStrength'),
);

material.dispose();
console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
