import type { EnvironmentData } from '../engine/renderer/environment/types';
import { boxGroupRows, lightGroupsOf, readBoxGroups, type BoxGroupBlock, type BoxGroupRow, type LightGroupInfo } from './box-groups';
import type { BoxGroupSource } from './box-group-lanes';
import { describeLightGroups } from './gls-environment';
import type { Preview } from './preview';

/**
 * What the timeline shows of the map's own light groups: the 3D view's parsed event box groups on
 * the environment's groups' rows. Made again only when the view's groups or environment change.
 */

/** The part of the environment's data the groups are read from (an imported one names its groups). */
type GroupEnvironment = Pick<EnvironmentData, 'objects'> & { id?: string; lightGroups?: { id: number; name: string; count: number }[] };

export class PreviewBoxGroups implements BoxGroupSource {
  private cache: { version: number; blocks: BoxGroupBlock[]; rows: BoxGroupRow[]; groups: LightGroupInfo[] } | null = null;
  private pickedId: string | null = null;
  /** Set by the timeline: a block picked (or let go) — the properties panel follows it. */
  onPick: ((id: string | null) => void) | null = null;

  constructor(
    private readonly preview: Preview,
    private readonly seek: (beat: number) => void,
  ) {}

  private made() {
    const version = this.preview.boxGroupsVersion;
    if (this.cache?.version === version) return this.cache;
    // (the environment's data is not there until it has loaded: the groups are then only the map's)
    const environment = this.preview.environmentData() as unknown as GroupEnvironment | null | undefined;
    const fromTable = environment?.id === undefined ? [] : lightGroupsOf(environment.id);
    // (an environment imported from the game names its groups in its own data)
    const names = fromTable.length > 0 ? fromTable : (environment?.lightGroups ?? []);
    const groups: LightGroupInfo[] = environment === null || environment === undefined ? [] : describeLightGroups(environment, names);
    const set = this.preview.boxGroupsSet();
    const blocks = set === null ? [] : readBoxGroups(set, groups);
    this.cache = { version, blocks, rows: boxGroupRows(blocks, groups), groups };
    return this.cache;
  }

  /** The blocks, in time (for the properties and the checks). */
  blocks() {
    return this.made().blocks;
  }

  rows() {
    return this.made().rows;
  }

  version() {
    return this.preview.boxGroupsVersion;
  }

  picked() {
    return this.pickedId;
  }

  pick(id: string | null, beat: number | null) {
    this.pickedId = id;
    if (beat !== null) this.seek(beat);
    this.onPick?.(id);
  }
}
