import type { Group, IUniform, Object3D, ShaderMaterial } from 'three';

import { SPECTRUM_SAMPLES } from '../../core/lighting/spectrogram';
import { evaluateAnimationCurve, type AnimationCurveData } from './animation-curve';
import { referenceKey, shaderMaterialsForMpbController } from './environment-component-utils';
import type { EnvironmentData } from './types';

/**
 * An environment's things that move with the song's spectrum (the game's TransformSpectrogram): each
 * of its transforms is put, along one axis of its own, between a lowest and a highest place by one of
 * the spectrum's 64 processed values — the transforms spread over all the values, or taking them one
 * after another.
 */

export interface EnvironmentSpectrogram {
  targets: Object3D[];
  /** 0 x, 1 y, 2 z (the game's; its z is the engine's -z). */
  axis: number;
  min: number;
  max: number;
  scaleSamples: boolean;
  scale: number;
}

export function buildEnvironmentSpectrograms(data: EnvironmentData, nodes: Group[]): EnvironmentSpectrogram[] {
  const spectrograms: EnvironmentSpectrogram[] = [];
  for (const object of data.objects) {
    for (const item of object.components?.TransformSpectrogram ?? []) {
      if (!item.enabled) continue;
      const targets = item.Transforms.flatMap((reference) => nodes[reference.obj] ?? []);
      if (targets.length === 0) continue;
      spectrograms.push({ targets, axis: item.Axis, min: item.MinPosition, max: item.MaxPosition, scaleSamples: item.ScaleSamples !== 0, scale: item.Scale });
    }
  }
  return spectrograms;
}

/** Puts the spectrograms' transforms where the song's spectrum has them (null: no song — at the lowest). */
export function applyEnvironmentSpectrograms(spectrograms: readonly EnvironmentSpectrogram[], samples: Float32Array | null) {
  for (const spectrogram of spectrograms) {
    const count = spectrogram.targets.length;
    for (let i = 0; i < count; i++) {
      const index = spectrogram.scaleSamples ? Math.round((count > 1 ? i / (count - 1) : 0) * (SPECTRUM_SAMPLES - 1) * spectrogram.scale) : i;
      const sample = samples === null ? 0 : (samples[((index % SPECTRUM_SAMPLES) + SPECTRUM_SAMPLES) % SPECTRUM_SAMPLES] ?? 0);
      const value = spectrogram.min + (spectrogram.max - spectrogram.min) * Math.min(1, Math.max(0, sample));
      const target = spectrogram.targets[i]!;
      const next = spectrogram.axis === 2 ? -value : value;
      const position = target.position;
      if (spectrogram.axis === 0) {
        if (position.x === next) continue;
        position.x = next;
      } else if (spectrogram.axis === 1) {
        if (position.y === next) continue;
        position.y = next;
      } else {
        if (position.z === next) continue;
        position.z = next;
      }
      target.updateMatrix();
    }
  }
}

/**
 * Material properties that follow the spectrum (the game's SpectrogramRowPropertyAnimator): each takes
 * one of the processed values through a curve and a multiplier, which an FX group may set. One
 * environment is shown at a time, so they are kept here.
 */
interface SpectrumProperty {
  uniforms: IUniform<number>[];
  dataIndex: number;
  curve: AnimationCurveData;
  multiplier: number;
  initialMultiplier: number;
}

let spectrumProperties: SpectrumProperty[] = [];
const spectrumPropertyByKey = new Map<string, SpectrumProperty>();

export function buildSpectrumProperties(data: EnvironmentData, objectMaterials: readonly ShaderMaterial[][]) {
  spectrumProperties = [];
  spectrumPropertyByKey.clear();
  data.objects.forEach((object, obj) => {
    (object.components?.SpectrogramMpbProperty ?? []).forEach((item, componentIndex) => {
      if (!item.enabled) return;
      const uniforms = shaderMaterialsForMpbController(data, objectMaterials, item.MpbController).flatMap((material) => {
        const uniform: IUniform<number> | undefined = material.uniforms[item.PropertyName];
        return uniform !== undefined && typeof uniform.value === 'number' ? [uniform] : [];
      });
      const property = { uniforms, dataIndex: item.DataIndex, curve: item.Curve, multiplier: item.Multiplier, initialMultiplier: item.Multiplier };
      spectrumProperties.push(property);
      spectrumPropertyByKey.set(referenceKey({ obj, component: 'SpectrogramMpbProperty', componentIndex }), property);
    });
  });
}

/** (no value: back to the environment's own) */
export function setSpectrumPropertyMultiplier(key: string, multiplier?: number) {
  const property = spectrumPropertyByKey.get(key);
  if (property !== undefined) property.multiplier = multiplier ?? property.initialMultiplier;
}

export const hasSpectrumProperties = () => spectrumProperties.length > 0;

export function applySpectrumProperties(samples: Float32Array | null) {
  for (const property of spectrumProperties) {
    const sample = samples === null ? 0 : (samples[property.dataIndex % SPECTRUM_SAMPLES] ?? 0);
    const value = property.multiplier * evaluateAnimationCurve(property.curve, sample);
    for (const uniform of property.uniforms) uniform.value = value;
  }
}
