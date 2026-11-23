import type { EnvironmentData, EnvironmentObjectData, GroupEffectManagerData, ObjectReference } from '../engine/renderer/environment/types';
import { lightGroupsOf, type LightGroupInfo } from './box-groups';

/**
 * What an environment says of its light groups (the game's Group Lighting System): which groups it
 * has, how many elements each has, and what each can do — colour, turning and moving on which axes,
 * an FX value. The map doesn't say any of it, so a map can't be shown (or edited) right without it.
 *
 * It is read from the environment's own data: the group effect managers list their groups, each
 * group's effect holds its number of elements and, for turning and moving, the axes of its entries.
 * The game's names of the groups are not in that data; they are looked up by `lightGroupsOf`.
 */

export interface LightGroupDescription extends LightGroupInfo {
  /** It can be given a colour (a colour block on it plays). */
  color: boolean;
  /** The axes it turns on (0 x, 1 y, 2 z), in order: none, it doesn't turn. */
  rotationAxes: number[];
  /** The axes it moves on. */
  translationAxes: number[];
  /** It takes an FX value. */
  fx: boolean;
}

type ManagerKey = 'LightColorGroupEffectManager' | 'LightRotationGroupEffectManager' | 'LightTranslationGroupEffectManager' | 'FloatFxGroupEffectManager';
type EffectKey = 'LightColorGroupEffect' | 'LightRotationGroupEffect' | 'LightTranslationGroupEffect' | 'FloatFxGroupEffect';

type Components = NonNullable<EnvironmentObjectData['components']>;

/** The effect a manager's entry points to (undefined: it points to nothing the environment has). */
function effectOf<K extends EffectKey>(objects: readonly EnvironmentObjectData[], reference: ObjectReference, key: K): NonNullable<Components[K]>[number] | undefined {
  const list = objects[reference.obj]?.components?.[key] as Components[K];
  return list?.[reference.componentIndex ?? 0] as NonNullable<Components[K]>[number] | undefined;
}

/** Every (group number, effect reference) the environment's managers of one kind list. */
function entriesOf(objects: readonly EnvironmentObjectData[], key: ManagerKey): { group: number; effect: ObjectReference }[] {
  const entries: { group: number; effect: ObjectReference }[] = [];
  for (const object of objects) {
    for (const manager of (object.components?.[key] ?? []) as GroupEffectManagerData[]) {
      if (manager.enabled === false) continue;
      for (const entry of manager.effectEntries) entries.push({ group: entry.Group, effect: entry.Effect });
    }
  }
  return entries;
}

/**
 * The light groups of a loaded environment, by number. `names`: the game's names and the sizes it
 * is known by (`lightGroupsOf` of the environment), for the groups' names; the number of elements
 * is the effect's own when it has one.
 */
export function describeLightGroups(data: Pick<EnvironmentData, 'objects'>, names: readonly LightGroupInfo[] = []): LightGroupDescription[] {
  const known = new Map(names.map((group) => [group.id, group]));
  const groups = new Map<number, LightGroupDescription>();
  const get = (id: number): LightGroupDescription => {
    let group = groups.get(id);
    if (group === undefined) {
      group = { id, name: known.get(id)?.name ?? String(id), count: known.get(id)?.count ?? 0, color: false, rotationAxes: [], translationAxes: [], fx: false };
      groups.set(id, group);
    }
    return group;
  };
  const axesOf = (entries: readonly { Axis: number }[]) => [...new Set(entries.map((entry) => entry.Axis))].sort((a, b) => a - b);
  const merge = (into: number[], axes: number[]) => {
    for (const axis of axes) if (!into.includes(axis)) into.push(axis);
    into.sort((a, b) => a - b);
  };

  for (const { group, effect } of entriesOf(data.objects, 'LightColorGroupEffectManager')) {
    const item = effectOf(data.objects, effect, 'LightColorGroupEffect');
    if (item === undefined || item.enabled === false) continue;
    const description = get(group);
    description.color = true;
    if (item.Count > 0) description.count = Math.max(description.count, item.Count);
  }
  for (const { group, effect } of entriesOf(data.objects, 'LightRotationGroupEffectManager')) {
    const item = effectOf(data.objects, effect, 'LightRotationGroupEffect');
    if (item === undefined || item.enabled === false) continue;
    const description = get(group);
    merge(description.rotationAxes, axesOf(item.transformEntries));
    if (item.Count > 0) description.count = Math.max(description.count, item.Count);
  }
  for (const { group, effect } of entriesOf(data.objects, 'LightTranslationGroupEffectManager')) {
    const item = effectOf(data.objects, effect, 'LightTranslationGroupEffect');
    if (item === undefined || item.enabled === false) continue;
    const description = get(group);
    merge(description.translationAxes, axesOf(item.transformEntries));
    if (item.Count > 0) description.count = Math.max(description.count, item.Count);
  }
  for (const { group, effect } of entriesOf(data.objects, 'FloatFxGroupEffectManager')) {
    const item = effectOf(data.objects, effect, 'FloatFxGroupEffect');
    if (item === undefined || item.enabled === false) continue;
    const description = get(group);
    description.fx = true;
    if (item.Count > 0) description.count = Math.max(description.count, item.Count);
  }
  return [...groups.values()].sort((a, b) => a.id - b.id);
}

/** The groups of a built-in environment with what the engine's data of it says (see `describeLightGroups`). */
export function describeEnvironmentGroups(environment: string, data: Pick<EnvironmentData, 'objects'>): LightGroupDescription[] {
  return describeLightGroups(data, lightGroupsOf(environment));
}

/** Whether a block of a kind (and, for turning and moving, an axis) on this group plays anything. */
export function groupCan(group: LightGroupDescription, kind: 'color' | 'rotation' | 'translation' | 'fx', axis?: number): boolean {
  switch (kind) {
    case 'color':
      return group.color;
    case 'fx':
      return group.fx;
    case 'rotation':
      return axis === undefined ? group.rotationAxes.length > 0 : group.rotationAxes.includes(axis);
    case 'translation':
      return axis === undefined ? group.translationAxes.length > 0 : group.translationAxes.includes(axis);
  }
}
