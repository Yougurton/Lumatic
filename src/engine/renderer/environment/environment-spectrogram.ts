import type { Group, Object3D } from 'three';

import { SPECTRUM_SAMPLES } from '../../core/lighting/spectrogram';
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
