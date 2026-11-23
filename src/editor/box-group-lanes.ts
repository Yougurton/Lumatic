import { laneTab, type BoxGroupBlock, type BoxGroupKind, type BoxGroupLane, type BoxGroupRow } from './box-groups';
import { tr } from './i18n';
import type { LaneHost } from './notes-timeline';

/**
 * The game's own light groups (GLS) on the timeline, to look at: for each group of the environment
 * that has blocks in the map a title and a line per kind (and axis) of block, each block a bar from
 * its beat to its last event. Nothing here changes the map: a click picks a block (the properties
 * show it), the rest only scrolls.
 *
 * It is drawn the way `AnimLanes` is (in place of the lights' rows) and is asked for the same things
 * by the timeline — draw, drawObjects, cursor, the mouse, the wheel — so it takes the place of one
 * in the timeline's `alt`. Which blocks it shows is the tab's: colour with the lights, turning,
 * moving and FX with the scene.
 */

/** What the lanes are shown from (the editor gives it; see `boxGroupRows`). */
export interface BoxGroupSource {
  /** The rows of the map's difficulty (all kinds; the lanes show their tab's). */
  rows(): BoxGroupRow[];
  /** Changes whenever the rows do (the layout is made again then, not on each frame). */
  version(): number;
  /** The block picked now (its id; null: none). */
  picked(): string | null;
  /** A block picked (null: nothing). */
  pick(id: string | null, beat: number | null): void;
}

export const KIND_NAMES: Record<BoxGroupKind, string> = { color: 'цвет', rotation: 'вращение', translation: 'перемещение', fx: 'эффект' };
const KIND_COLOURS: Record<BoxGroupKind, string> = { color: '#e58cff', rotation: '#ffb45a', translation: '#6aa6ff', fx: '#7fdc9a' };
export const AXIS_NAMES = ['X', 'Y', 'Z'];

const TITLE_H = 20;
const LANE_H = 22;
const GAP = 6;
/** A block shorter than this many pixels is drawn this wide (a single event is a point in the song). */
const MIN_W = 4;

interface Line {
  kind: 'title' | 'lane';
  row: BoxGroupRow;
  lane?: BoxGroupLane;
  top: number;
  height: number;
}

export class BoxGroupLanes {
  private scrollY = 0;
  private laidOut: { key: string; lines: Line[] } | null = null;
  /** Shift held while dragging (set by the timeline; there is no dragging here). */
  shift = false;

  /** `tab`: which blocks it shows — the lights' (colour) or the scene's (turning, moving, FX). */
  constructor(
    private readonly host: LaneHost,
    private readonly source: BoxGroupSource,
    private readonly tab: 'light' | 'scene',
  ) {}

  private lines(): Line[] {
    const key = `${String(this.source.version())}|${this.tab}|${String(this.host.lanesTop)}|${String(this.scrollY)}`;
    if (this.laidOut?.key === key) return this.laidOut.lines;
    const lines: Line[] = [];
    let top = this.host.lanesTop - this.scrollY + 2;
    for (const row of this.source.rows()) {
      const lanes = row.lanes.filter((lane) => laneTab(lane.kind) === this.tab && lane.blocks.length > 0);
      if (lanes.length === 0) continue;
      lines.push({ kind: 'title', row, top, height: TITLE_H });
      top += TITLE_H;
      for (const lane of lanes) {
        lines.push({ kind: 'lane', row, lane, top, height: LANE_H });
        top += LANE_H;
      }
      top += GAP;
    }
    this.laidOut = { key, lines };
    return lines;
  }

  private total() {
    const lines = this.lines();
    const last = lines[lines.length - 1];
    return last === undefined ? 0 : last.top + last.height + this.scrollY - this.host.lanesTop + 8;
  }

  /** A block's bar on its line: from its beat for its length. */
  private rect(block: BoxGroupBlock, line: Line) {
    const x = this.host.beatToX(block.beat);
    const w = Math.max(MIN_W, (block.length * this.host.pxPerBeat));
    return { x, y: line.top + 3, w, h: line.height - 7 };
  }

  draw(ctx: CanvasRenderingContext2D) {
    const host = this.host;
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.total() - (host.lanesBottom - host.lanesTop)));
    ctx.fillStyle = '#15161b';
    ctx.fillRect(0, host.lanesTop, host.width, host.lanesBottom - host.lanesTop);
    for (const line of this.lines()) {
      if (line.top + line.height < host.lanesTop || line.top > host.lanesBottom) continue;
      ctx.fillStyle = line.kind === 'title' ? (line.row.missing ? '#33262a' : '#22242c') : '#1b1c22';
      ctx.fillRect(host.left, line.top, host.width - host.left, line.height - 1);
    }
  }

  drawObjects(ctx: CanvasRenderingContext2D) {
    const host = this.host;
    const lines = this.lines();
    ctx.save();
    ctx.textBaseline = 'middle';
    if (lines.length === 0) {
      ctx.fillStyle = '#8a8d98';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(tr(this.tab === 'light' ? 'В карте нет блоков цвета групп света (GLS)' : 'В карте нет блоков вращения, перемещения и эффектов групп света (GLS)'), host.left + 14, host.lanesTop + 26);
      ctx.restore();
      return;
    }
    const picked = this.source.picked();
    const from = host.xToBeat(host.left - 8);
    const to = host.xToBeat(host.width + 8);
    for (const line of lines) {
      if (line.top + line.height < host.lanesTop || line.top > host.lanesBottom) continue;
      if (line.kind === 'lane') {
        const lane = line.lane!;
        const colour = KIND_COLOURS[lane.kind];
        for (const block of lane.blocks) {
          if (block.beat > to || block.beat + block.length < from) continue;
          const { x, y, w, h } = this.rect(block, line);
          const chosen = block.id === picked;
          ctx.globalAlpha = chosen ? 0.95 : 0.6;
          ctx.fillStyle = colour;
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = chosen ? '#ffffff' : 'rgba(0,0,0,0.55)';
          ctx.lineWidth = chosen ? 2 : 1;
          ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1);
          // (more than one box: the number, where there is room)
          if (w > 26 && block.boxes.length > 1) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip();
            ctx.fillStyle = '#0d0e12';
            ctx.font = '600 10px system-ui, sans-serif';
            ctx.fillText(`×${String(block.boxes.length)}`, x + 4, y + h / 2);
            ctx.restore();
          }
        }
      }
      // the name: stays at the left whatever the song's place
      const middle = line.top + line.height / 2;
      const text =
        line.kind === 'title'
          ? `${line.row.name !== '' ? line.row.name : tr('Группа {0}', line.row.group)}${line.row.missing ? ` (${tr('нет в окружении')})` : ''}${line.row.count > 0 ? ` · ${String(line.row.count)}` : ''}`
          : `${tr(KIND_NAMES[line.lane!.kind])}${line.lane!.axis === undefined ? '' : ` ${AXIS_NAMES[line.lane!.axis] ?? String(line.lane!.axis)}`}`;
      ctx.font = line.kind === 'title' ? '600 12px system-ui, sans-serif' : '11px system-ui, sans-serif';
      const width = ctx.measureText(text).width + 14;
      const indent = line.kind === 'title' ? 6 : 16;
      ctx.fillStyle = line.kind === 'title' ? 'rgba(34,36,44,0.92)' : 'rgba(27,28,34,0.88)';
      ctx.fillRect(host.left, middle - 9, width + indent - 4, 18);
      ctx.fillStyle = line.kind === 'title' ? (line.row.missing ? '#ff9a9a' : '#e8eaf2') : KIND_COLOURS[line.lane!.kind];
      ctx.fillText(text, host.left + indent, middle);
    }
    ctx.restore();
  }

  /** The block under a point (the later of those over each other: it is drawn on top). */
  private blockAt(x: number, y: number): BoxGroupBlock | null {
    for (const line of this.lines()) {
      if (line.kind !== 'lane' || y < line.top || y >= line.top + line.height) continue;
      for (const block of [...line.lane!.blocks].reverse()) {
        const rect = this.rect(block, line);
        if (x >= rect.x - 2 && x <= rect.x + rect.w + 2) return block;
      }
    }
    return null;
  }

  cursor(x: number, y: number) {
    return this.blockAt(x, y) !== null ? 'pointer' : 'default';
  }

  mouseDown(event: MouseEvent, x: number, y: number) {
    if (event.button !== 0) return;
    const block = this.blockAt(x, y);
    this.source.pick(block?.id ?? null, block?.beat ?? null);
    this.host.redraw();
  }

  mouseMove(_x: number, _y: number): boolean {
    return false;
  }

  mouseUp(_event: MouseEvent) {}

  contextMenu(_x: number, _y: number, _clientX: number, _clientY: number) {}

  /** The wheel turned so far towards the next line (the lines scroll a line a wheel step). */
  private wheelLeft = 0;

  wheel(event: WheelEvent, _x: number, _y: number): boolean {
    // (Shift + wheel: the lines up and down, when there are more than fit — a line a notch: the next
    //  line's edge brought to the top, not the raw pixels of the wheel; a notch is one wheel event)
    if (!event.shiftKey) return false;
    this.wheelLeft += event.deltaY !== 0 ? event.deltaY : event.deltaX;
    if (Math.abs(this.wheelLeft) < 12) return true;
    this.wheelLeft = 0;
    const down = event.deltaY !== 0 ? event.deltaY > 0 : event.deltaX > 0;
    const lines = this.lines();
    if (down) {
      const next = lines.find((line) => line.top > this.host.lanesTop + 0.5);
      if (next !== undefined) this.scrollY = next.top + this.scrollY - this.host.lanesTop;
    } else {
      let previous: number | null = null;
      for (const line of lines) {
        if (line.top >= this.host.lanesTop - 0.5) break;
        previous = line.top;
      }
      if (previous !== null) this.scrollY = previous + this.scrollY - this.host.lanesTop;
    }
    this.host.redraw();
    return true;
  }

  leave() {}
}
