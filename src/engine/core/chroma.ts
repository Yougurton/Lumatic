import type { BeatmapCustomData } from './beatmap/types';
import { beatSaberNumber, type BeatSaberJsonValue } from './beatmap/value-schema';

export type ChromaColor = readonly [number, number, number, number];

export function chromaColor(customData: BeatmapCustomData | undefined): ChromaColor | undefined {
  // (by hand, not through a schema: this runs for every light event of the show, again on each change)
  const raw = (customData?._color ?? customData?.color) as BeatSaberJsonValue | undefined;
  if (!Array.isArray(raw) || raw.length < 3) return undefined;
  const values = raw.map((value) => beatSaberNumber(value));
  const red = values[0];
  const green = values[1];
  const blue = values[2];
  if (red === undefined || green === undefined || blue === undefined) return undefined;
  return [red, green, blue, values[3] ?? 1];
}
