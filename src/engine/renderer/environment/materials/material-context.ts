import { DataTexture, SRGBColorSpace, type CubeTexture, type Texture } from 'three';

import type { Rgb } from '../../../core/colors';
import type { FogUniforms } from '../../bloomfog/pipeline';
import type { DirectionalLightUniforms, MaterialFogSettings } from '../../materials/shared';
import type { EnvironmentBakedReflectionProbe } from '../environment-runtime';
import type { EnvironmentMaterialData } from '../types';

export interface EnvironmentMaterialContext {
  fog: FogUniforms;
  reflectionTexture: { value: Texture };
  directionalLights: DirectionalLightUniforms;
  reflectionProbe?: CubeTexture;
  bakedReflectionProbe?: EnvironmentBakedReflectionProbe;
  songTime?: { value: number };
  textures?: ReadonlyMap<string, Texture>;
}

export function materialColor(data: EnvironmentMaterialData): Rgb {
  const color = data.colors._Color ?? [1, 1, 1, 1];
  return [color[0], color[1], color[2]];
}

export function vectorColor(value: [number, number, number, number] | undefined, fallback: Rgb): Rgb {
  return value === undefined ? fallback : [value[0], value[1], value[2]];
}

export function materialFog(data: EnvironmentMaterialData, alwaysEnabled = false): MaterialFogSettings {
  return {
    enabled: alwaysEnabled || data.floats._EnableFog !== 0,
    startOffset: data.floats._FogStartOffset ?? 0,
    scale: data.floats._FogScale ?? 1,
    heightEnabled: (data.floats._EnableHeightFog ?? 0) !== 0,
    heightOffset: data.floats._FogHeightOffset ?? 0,
    heightScale: data.floats._FogHeightScale ?? 1,
  };
}

export function materialTimeMode(keywords: readonly string[]) {
  if (keywords.includes('_CUSTOM_TIME_FREEZE')) return 'freeze';
  if (keywords.includes('_CUSTOM_TIME_SONG_TIME')) return 'song';
  return 'continuous';
}

export function materialTexture(data: EnvironmentMaterialData, context: EnvironmentMaterialContext, property: string) {
  const texture = data.textures?.[property];
  if (texture === undefined) return undefined;
  const loaded = context.textures?.get(texture.asset);
  return loaded === undefined ? undefined : { texture: loaded, scale: texture.scale, offset: texture.offset };
}

let whiteTexture: Texture | undefined;

/** Unity's default when a material leaves a texture slot empty. */
export function whiteMaterialTexture() {
  if (whiteTexture === undefined) {
    whiteTexture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteTexture.colorSpace = SRGBColorSpace;
    whiteTexture.needsUpdate = true;
  }
  return { texture: whiteTexture, scale: [1, 1] as [number, number], offset: [0, 0] as [number, number] };
}
