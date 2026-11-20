import { CAPTURE_FRAG } from '../src/engine/renderer/shaders/passes';

/**
 * BloomPrePassLine capture: distance attenuation, the line mask and squared alpha.
 *
 * npx tsx tests/bloomfog.ts
 */

let checks = 0;
let failures = 0;
const check = (name: string, ok: boolean) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL', name);
  }
};

check('distance attenuation is applied', CAPTURE_FRAG.includes('float response = 1.0 / (1.0 + travel * _CaptureFalloff)'));
check('the mask and squared-alpha formula', CAPTURE_FRAG.includes('float weight = response * lineMask.a * vColor.a * vColor.a'));
check('light color comes from the line and vertex colors', CAPTURE_FRAG.includes('vec4(vColor.rgb * lineMask.rgb * weight, weight)'));

console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
