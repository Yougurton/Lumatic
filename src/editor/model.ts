/**
 * The editor's own picture of a lightshow (what the project file keeps): light clips on the
 * timeline, each a rectangle from its start to its end — two (or more) events in the map, the light
 * coming on (on / flash / fading in) and going out (off / fading out / staying). Clips sit on
 * layers: a higher one covers what's under it while it lasts, and when it ends the light goes back
 * to what the layer under it is doing (bake.ts works that out into plain events for the game).
 *
 * Times are beats of the map (its jsonTime), colours linear 0…1 like Chroma's.
 */

export type Rgb = [number, number, number];

/** A light's colour: one of the map's own (left / right / white, as the colour scheme has them) or
 *  its own RGB; `brightness` is the event's float value (1 normal, above 1 brighter). */
export interface ClipColor {
  ref: 'left' | 'right' | 'white' | 'custom';
  rgb?: Rgb;
  brightness: number;
}

/** on; flash (bright, settling to its colour); fade (the game's own: a flash dying out over 1.5 s);
 *  fadeIn (coming up from nothing over `fadeIn` beats). */
export type StartMode = 'on' | 'flash' | 'fade' | 'fadeIn';
export type EndMode = 'off' | 'fade' | 'stay';

export interface LightClip {
  id: string;
  /** The light group (the event type). */
  type: number;
  /** Which of its lights; null: all of them. */
  ids: number[] | null;
  start: number;
  end: number;
  startMode: StartMode;
  /** fadeIn: how many beats it takes to come up. */
  fadeIn: number;
  endMode: EndMode;
  color: ClipColor;
  /** A gradient across the clip: the colour it has arrived at by its end (null: none). */
  endColor: ClipColor | null;
  /** Its transitions (the gradient, the fade in) blend through hue (HSV) rather than straight
   *  through RGB. */
  hsv?: boolean;
  /** Higher covers lower. Imported lights are layer 0, new ones 1 by default. */
  layer: number;
  /** The group (or effect) it belongs to, if any. */
  group?: string;
}

/** An event the editor shows but doesn't model yet (ring spins, zoom, laser speeds, boost…): kept
 *  as the map had it, movable and removable. */
export interface RawEvent {
  id: string;
  beat: number;
  type: number;
  value: number;
  floatValue: number;
  customData?: Record<string, unknown>;
}

export interface Project {
  format: 'chroeditor';
  version: 1;
  /** The difficulty file it belongs to. */
  difficulty: string;
  environment: string;
  clips: LightClip[];
  raw: RawEvent[];
  /** Which light groups are opened up into their lights on the timeline. */
  expanded: number[];
}

let counter = 0;
export function newId(prefix = 'c'): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function cloneClip(clip: LightClip, patch: Partial<LightClip> = {}): LightClip {
  return {
    ...clip,
    ids: clip.ids === null ? null : [...clip.ids],
    color: { ...clip.color, ...(clip.color.rgb === undefined ? {} : { rgb: [...clip.color.rgb] as Rgb }) },
    endColor: clip.endColor === null ? null : { ...clip.endColor, ...(clip.endColor.rgb === undefined ? {} : { rgb: [...clip.endColor.rgb] as Rgb }) },
    ...patch,
    id: patch.id ?? newId(),
  };
}

/** Whether a clip lights light `id` of its group. */
export function clipHas(clip: LightClip, id: number): boolean {
  return clip.ids === null || clip.ids.includes(id);
}

/** Event types that are lights (the rest — rings, zoom, laser speeds, boost — are other events). */
export const NON_LIGHT_TYPES = new Set([5, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19, 40, 41, 42, 43, 100]);
export function isLightType(type: number) {
  return !NON_LIGHT_TYPES.has(type) && type >= 0;
}
