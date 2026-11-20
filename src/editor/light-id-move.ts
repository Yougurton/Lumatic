import type { LightClip } from './model';

/** Whether the selection can move as one light-ID shift instead of a time drag. */
export function canMoveByLightId(clips: readonly LightClip[], selectionSize: number, lightsByType: ReadonlyMap<number, readonly number[]>): boolean {
  if (clips.length === 0 || clips.length !== selectionSize) return false;
  const type = clips[0]!.type;
  const available = lightsByType.get(type);
  if (available === undefined || available.length === 0) return false;
  const ids = new Set(available);
  return clips.every((clip) => clip.type === type && clip.target === undefined && clip.group === undefined && clip.ids !== null && clip.ids.length > 0 && clip.ids.every((id) => ids.has(id)));
}

/** The nearest requested whole shift for which every resulting ID exists in the environment. */
export function clampLightIdShift(clips: readonly LightClip[], availableIds: readonly number[], requested: number): number {
  if (clips.length === 0 || availableIds.length === 0 || requested === 0) return 0;
  const available = new Set(availableIds);
  const selected = clips.flatMap((clip) => clip.ids ?? []);
  if (selected.length === 0) return 0;
  const lowest = Math.min(...selected);
  const highest = Math.max(...selected);
  const minimum = Math.min(...availableIds) - lowest;
  const maximum = Math.max(...availableIds) - highest;
  const wanted = Math.max(minimum, Math.min(maximum, Math.trunc(requested)));
  const step = wanted < 0 ? -1 : 1;
  for (let shift = wanted; shift !== 0; shift -= step) {
    if (selected.every((id) => available.has(id + shift))) return shift;
  }
  return 0;
}
