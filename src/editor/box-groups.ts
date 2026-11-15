import type { Difficulty, EventBox, EventBoxGroup, FloatFxEvent, LightColorEvent, LightRotationEvent, LightTransformEventBox, LightTranslationEvent } from '../engine/core/beatmap/types';
import { expandGlsEvents } from '../engine/core/lighting/gls-events';
import groupNames from './gls-groups.json';

/**
 * The game's own Group Lighting System in a map — its "event box groups" — as the editor reads them:
 * blocks on the light groups of a GLS environment (Weave and the ones after it).
 *
 * A block is at a beat on one group and of one kind: colour, rotation, translation or an effect value
 * (FX). It holds boxes; a box picks some of the group's elements with a filter, spreads its events over
 * them in time and in value, and has its own events. v3 files keep the blocks in four lists, v4 ones in
 * one list with the boxes and events in shared tables: the engine's parser reads both into the same
 * shape, and this is that shape put on the editor's rows.
 *
 * Reading only: nothing here writes a map. A block remembers where it came from in the file (`source`),
 * so that an untouched block can go back as it was.
 *
 * (Not src/editor/gls.ts: that one is the editor's own blocks for the classic environments, made into
 * plain light events with Chroma light IDs.)
 */

export type BoxGroupKind = 'color' | 'rotation' | 'translation' | 'fx';

export const BOX_GROUP_KINDS: readonly BoxGroupKind[] = ['color', 'rotation', 'translation', 'fx'];

type AnyEvent = LightColorEvent | LightRotationEvent | LightTranslationEvent | FloatFxEvent;
type AnyBox = EventBox<AnyEvent> & { axis?: number; flip?: number };

export interface BoxGroupBlock {
  /** Unique among the difficulty's blocks: its kind and its place in the file's list. */
  id: string;
  kind: BoxGroupKind;
  /** The environment's light group (its number). */
  group: number;
  beat: number;
  /** Beats from its start to its last event on any element (0: all at once). Not in the file: worked
   *  out from the boxes, and exact only when the group's number of elements is known. */
  length: number;
  /** The axes its boxes turn or move on (0 x, 1 y, 2 z): rotation and translation blocks only. */
  axes: number[];
  boxes: AnyBox[];
  /** How many events its boxes have. */
  events: number;
  /** Where it is in the file: the list of its kind (v3) or of all (v4), and its place in the order
   *  the parser gives. */
  source: { kind: BoxGroupKind; index: number };
  customData?: Record<string, unknown>;
}

/** One of an environment's light groups, as the game names it. */
export interface LightGroupInfo {
  id: number;
  name: string;
  /** How many elements it has. */
  count: number;
}

const NAMES = groupNames as Record<string, LightGroupInfo[]>;

/** The light groups of a built-in GLS environment, by number ([]: not one the editor knows). */
export function lightGroupsOf(environment: string): LightGroupInfo[] {
  return NAMES[environment] ?? [];
}

function lengthOf(kind: BoxGroupKind, group: EventBoxGroup<AnyBox>, count: number): number {
  let last = 0;
  // (what each element gets, by the engine's own spreading — the same the 3D view plays)
  if (count > 0) {
    const expanded = expandGlsEvents<AnyEvent, AnyBox>([group], count, kind === 'rotation' || kind === 'translation' ? (box) => box.axis ?? 0 : undefined);
    for (const item of expanded) last = Math.max(last, item.jsonTime - group.jsonTime);
    if (expanded.length > 0) return last;
  }
  // (the group's size not known: the boxes' own events, and a wave's whole time)
  for (const box of group.boxes) {
    const end = box.events.reduce((max, event) => Math.max(max, event.relativeJsonTime), 0);
    last = Math.max(last, box.beatDistributionType === 1 ? Math.max(end, box.beatDistribution) : end);
  }
  return last;
}

function blocksOf(kind: BoxGroupKind, groups: readonly EventBoxGroup<AnyBox>[], counts: ReadonlyMap<number, number>): BoxGroupBlock[] {
  return groups.map((group, index) => {
    const axes = kind === 'rotation' || kind === 'translation' ? [...new Set(group.boxes.map((box) => box.axis ?? 0))].sort((a, b) => a - b) : [];
    const block: BoxGroupBlock = {
      id: `${kind}:${String(index)}`,
      kind,
      group: group.id,
      beat: group.jsonTime,
      length: lengthOf(kind, group, counts.get(group.id) ?? 0),
      axes,
      boxes: group.boxes,
      events: group.boxes.reduce((sum, box) => sum + box.events.length, 0),
      source: { kind, index },
    };
    if (group.customData !== undefined && Object.keys(group.customData).length > 0) block.customData = group.customData as Record<string, unknown>;
    return block;
  });
}

/**
 * A parsed difficulty's blocks, in time (those at one beat: colour, rotation, translation, FX — and
 * in the file's order within a kind). `groups`: the environment's light groups, for the blocks' lengths.
 */
export function readBoxGroups(difficulty: Difficulty, groups: readonly LightGroupInfo[] = []): BoxGroupBlock[] {
  const counts = new Map(groups.map((group) => [group.id, group.count]));
  const blocks = [
    ...blocksOf('color', difficulty.lightColorEventBoxGroups as EventBoxGroup<AnyBox>[], counts),
    ...blocksOf('rotation', difficulty.lightRotationEventBoxGroups as EventBoxGroup<LightTransformEventBox<LightRotationEvent>>[] as EventBoxGroup<AnyBox>[], counts),
    ...blocksOf('translation', difficulty.lightTranslationEventBoxGroups as EventBoxGroup<LightTransformEventBox<LightTranslationEvent>>[] as EventBoxGroup<AnyBox>[], counts),
    ...blocksOf('fx', difficulty.fxEventBoxGroups as EventBoxGroup<AnyBox>[], counts),
  ];
  const order = new Map(BOX_GROUP_KINDS.map((kind, index) => [kind, index]));
  return blocks.sort((a, b) => a.beat - b.beat || order.get(a.kind)! - order.get(b.kind)! || a.source.index - b.source.index);
}

/** A row of the timeline: one group's blocks of one kind — and, for rotation and translation, on one axis. */
export interface BoxGroupLane {
  kind: BoxGroupKind;
  /** 0 x, 1 y, 2 z (rotation and translation). */
  axis?: number;
  blocks: BoxGroupBlock[];
}

export interface BoxGroupRow {
  group: number;
  /** The game's name of the group ('' when the environment has no such group, or isn't known). */
  name: string;
  /** Its number of elements (0: not known). */
  count: number;
  /** The environment has no group of this number: the map's blocks on it play nothing. */
  missing: boolean;
  lanes: BoxGroupLane[];
}

/**
 * The blocks on rows: a row per group — the environment's in their order (also those the map has
 * nothing on), then the map's groups the environment hasn't got — each with a lane per kind and axis
 * the map uses on it. A block of several axes is on each of their lanes.
 */
export function boxGroupRows(blocks: readonly BoxGroupBlock[], groups: readonly LightGroupInfo[]): BoxGroupRow[] {
  const rows = new Map<number, BoxGroupRow>();
  for (const group of groups) rows.set(group.id, { group: group.id, name: group.name, count: group.count, missing: false, lanes: [] });
  const known = groups.length > 0;
  for (const block of blocks) {
    let row = rows.get(block.group);
    if (row === undefined) {
      row = { group: block.group, name: '', count: 0, missing: known, lanes: [] };
      rows.set(block.group, row);
    }
    for (const axis of block.axes.length > 0 ? block.axes : [undefined]) {
      let lane = row.lanes.find((item) => item.kind === block.kind && item.axis === axis);
      if (lane === undefined) {
        lane = axis === undefined ? { kind: block.kind, blocks: [] } : { kind: block.kind, axis, blocks: [] };
        row.lanes.push(lane);
      }
      lane.blocks.push(block);
    }
  }
  const order = new Map(BOX_GROUP_KINDS.map((kind, index) => [kind, index]));
  for (const row of rows.values()) row.lanes.sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || (a.axis ?? 0) - (b.axis ?? 0));
  const listed = groups.map((group) => rows.get(group.id)!);
  const extra = [...rows.values()].filter((row) => !groups.some((group) => group.id === row.group)).sort((a, b) => a.group - b.group);
  return [...listed, ...extra];
}

/** The tab a lane is shown on: the colour ones with the lights, the moving ones with the scene. */
export function laneTab(kind: BoxGroupKind): 'light' | 'scene' {
  return kind === 'color' ? 'light' : 'scene';
}

/** What a difficulty has of the group lighting system, in numbers (for the tests and the checks). */
export function boxGroupStats(blocks: readonly BoxGroupBlock[]) {
  const stats = { blocks: { color: 0, rotation: 0, translation: 0, fx: 0 }, boxes: 0, events: 0, groups: 0 };
  const groups = new Set<number>();
  for (const block of blocks) {
    stats.blocks[block.kind]++;
    stats.boxes += block.boxes.length;
    stats.events += block.events;
    groups.add(block.group);
  }
  stats.groups = groups.size;
  return stats;
}
