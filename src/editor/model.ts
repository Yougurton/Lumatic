import type { EnvironmentFragment, EnvironmentMods } from './environment-mods';
import type { Effect } from './effects';
import type { RingBlock } from './rings';

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
  /** Lit through one of the project's light groups (its id): the group's lights, whatever they are
   *  now; `type`/`ids` are then only where it was first drawn. */
  target?: string;
  /** Drawn on a single light's row: above the clips of the groups it is in (see `clipPriority`). */
  scope?: 'light';
  /** The effect it was made by (its id), if any. */
  group?: string;
  /** Which of the effect's items it is for (-1: all of them at once). */
  slot?: number;
}

/** One light of the environment: its group (event type) and its light ID. */
export interface LightRef {
  kind: 'light';
  type: number;
  id: number;
}

/** A user's group of lights: lights and subgroups, in the order the user put them (the order waves
 *  and other effects go through them). */
export interface LightGroup {
  kind: 'group';
  id: string;
  name: string;
  items: GroupItem[];
  /** Its lights are taken out of their environment rows (those rows then light only the rest). */
  takesLights?: boolean;
}

export type GroupItem = LightRef | LightGroup;

/** An event the editor shows but doesn't model yet (ring spins, zoom, laser speeds, boost…): kept
 *  as the map had it, movable and removable. */
export interface RawEvent {
  id: string;
  beat: number;
  type: number;
  value: number;
  floatValue: number;
  customData?: Record<string, unknown>;
  /** The effect that made it (ring events of a GLS block), if any. */
  group?: string;
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
  /** The user's light groups (older project files have none). */
  groups?: LightGroup[];
  /** Which of those are opened up on the timeline. */
  expandedGroups?: string[];
  /** Effects (their events are clips with `group` = the effect's id). */
  effects?: Effect[];
  /** Ring pose blocks. */
  ringBlocks?: RingBlock[];
  /** Bookmarks (written into the difficulty as the editors' bookmarks). */
  bookmarks?: Bookmark[];
  /** The order of the top rows of lights ("g<type>" — a light group of the environment, "u<id>" — a
   *  group of the user's); rows not in it keep their own order after these. */
  rowOrder?: string[];
  /** Light groups of the environment whose row a group of the user's with all of their lights
   *  stands in for (event type → that group's id): their row is hidden, their clips shown on it. */
  replacedTypes?: Record<string, string>;
  /** Light groups of the environment whose row the user took off the timeline (event type → the place
   *  among the top rows it had, for when it's brought back). */
  removedTypes?: Record<string, number>;
  /** Changes to the environment (written into the difficulty's custom data). */
  environmentMods?: EnvironmentMods;
  /** What they wrote last time (taken out again before they're written anew). */
  writtenEnvironment?: EnvironmentFragment;
  /** Mods put into the difficulty's requirements for them (taken out when not needed any more). */
  addedRequirements?: string[];
}

/** A named place in the song (Beat Saber editors' bookmarks: v2 `_bookmarks`, v3 `bookmarks`). */
export interface Bookmark {
  id: string;
  beat: number;
  name: string;
  /** RGB 0…1. */
  color: Rgb;
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

/** Every light of a group, subgroups included, in its order (each light once). */
export function groupLights(group: LightGroup): LightRef[] {
  const seen = new Set<string>();
  const out: LightRef[] = [];
  const walk = (items: readonly GroupItem[]) => {
    for (const item of items) {
      if (item.kind === 'group') walk(item.items);
      else {
        const key = lightKey(item.type, item.id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    }
  };
  walk(group.items);
  return out;
}

export const lightKey = (type: number, id: number) => `${String(type)}:${String(id)}`;

/** A group by its id (anywhere in the tree), with how deep it sits (1: a top group) and its path. */
export function findGroup(groups: readonly LightGroup[], id: string): { group: LightGroup; depth: number; path: LightGroup[] } | null {
  const walk = (items: readonly GroupItem[], path: LightGroup[]): { group: LightGroup; depth: number; path: LightGroup[] } | null => {
    for (const item of items) {
      if (item.kind !== 'group') continue;
      const here = [...path, item];
      if (item.id === id) return { group: item, depth: here.length, path: here };
      const found = walk(item.items, here);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(groups, []);
}

/** The group holding `item` directly (null: it is a top group). */
export function parentOf(groups: LightGroup[], item: GroupItem): { items: GroupItem[] } | null {
  const walk = (holder: { items: GroupItem[] }): { items: GroupItem[] } | null => {
    for (const child of holder.items) {
      if (child === item) return holder;
      if (child.kind === 'group') {
        const found = walk(child);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk({ items: groups });
}

/**
 * Which clip wins on a light when several on one layer overlap: the one drawn deeper in — on a
 * light's own row over a subgroup's over a group's over the light group's (the event type's).
 * Layers still come first: a clip on a higher layer covers lower ones whatever they were drawn on.
 */
export function clipPriority(clip: LightClip, groups: readonly LightGroup[]): number {
  if (clip.scope === 'light') return 9;
  if (clip.target !== undefined) return Math.min(8, findGroup(groups, clip.target)?.depth ?? 1);
  return 0;
}

/** The lights a clip lights: per event type, its light IDs (null: all of that type's). */
export function clipLights(clip: LightClip, groups: readonly LightGroup[]): Map<number, number[] | null> {
  const out = new Map<number, number[] | null>();
  if (clip.target !== undefined) {
    const found = findGroup(groups, clip.target);
    if (found !== null) {
      for (const light of groupLights(found.group)) {
        const list = out.get(light.type) ?? [];
        list.push(light.id);
        out.set(light.type, list);
      }
      return out;
    }
  }
  out.set(clip.type, clip.ids);
  return out;
}

/** Whether a clip lights light `id` of type `type` (id null: any light of that type). */
export function clipTouches(clip: LightClip, groups: readonly LightGroup[], type: number, id: number | null): boolean {
  const lights = clipLights(clip, groups);
  if (!lights.has(type)) return false;
  const ids = lights.get(type)!;
  return id === null || ids === null || ids.includes(id);
}
