import { Group, ShaderMaterial, Texture } from 'three';
import { buildSwitches } from '../src/engine/renderer/environment/environment-scene-builder';
import type { EnvironmentMaterialContext } from '../src/engine/renderer/environment/materials/material-context';
import type { EnvironmentData } from '../src/engine/renderer/environment/types';

/**
 * Texture selection by a basic beatmap event (Britney's TubeDisplay).
 *
 * npx tsx tests/environment-switches.ts
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

const first = new Texture();
const second = new Texture();
const material = new ShaderMaterial({ uniforms: { _MainTex: { value: first } } });
const data = {
  objects: [
    {
      name: 'Display',
      components: {
        MaterialPropertyBlockController: [{ Renderers: [], enabled: true }],
      },
    },
    {
      name: 'TextureSwitch',
      components: {
        TextureIntSwitch: [
          {
            MpbController: { obj: 0, component: 'MaterialPropertyBlockController', componentIndex: 0 },
            Property: '_MainTex',
            EventType: 12,
            DefaultValue: 0,
            Textures: [
              { Value: 0, Asset: 'first' },
              { Value: 1, Asset: 'second' },
            ],
            enabled: true,
          },
        ],
      },
    },
  ],
} as unknown as EnvironmentData;
const context = { textures: new Map([
  ['first', first],
  ['second', second],
]) } as EnvironmentMaterialContext;

const switches = buildSwitches(data, [new Group(), new Group()], [[material], []], context).eventSwitches;
check('one texture switch is built', switches.length === 1);
check('the default texture is applied on load', material.uniforms._MainTex?.value === first);
switches[0]?.apply(1);
check('an event value selects its texture', material.uniforms._MainTex?.value === second);
switches[0]?.apply(99);
check('an unknown value restores the default texture', material.uniforms._MainTex?.value === first);
check('the switch listens to the game event type', switches[0]?.eventType === 12 && switches[0]?.defaultValue === 0);

material.dispose();
first.dispose();
second.dispose();
console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
