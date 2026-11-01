import type { Editor } from './editor';
import type { MapIssue } from './checks';
import { DIR_ANGLE, MIRROR_DIR, objectSpan, strobeWalls, WALL_NAMES, WALL_SHAPES, wallKindOf, type MapArc, type MapBomb, type MapChain, type MapNote, type MapObjects, type MapWall, type ObjectKind } from './notes';
import { newId } from './model';
import { drawGameNote } from './note-draw';
import { objectRightClick } from './object-menu';

/**
 * The notes side's timeline (as in ChroViewer): the grid's four columns as four lanes, time going right.
 * A note is a mark in its colour with its arrow (or dot), and three pips on its side — the lit one its
 * row (bottom, middle, top); a bomb a dark ball; a wall a band across its columns for its length; an arc
 * a curve from its head to its tail, a chain a line with its links. The timeline around it (the ruler,
 * the spectrogram, bookmarks, the song cursor, zoom) is the lights' one.
 *
 * A click on an empty lane puts in what the tool is (a wall: drawn along); a drag there picks
 * everything in its box. Objects: click — pick (Shift/Ctrl: add), drag — move in time and across
 * lanes (Alt: a copy), right click — delete, middle click — the other colour, Alt+wheel — turn.
 */

export interface LaneHost {
  readonly editor: Editor;
  beatToX(beat: number): number;
  xToBeat(x: number): number;
  readonly lanesTop: number;
  readonly lanesBottom: number;
  readonly left: number;
  readonly width: number;
  readonly pxPerBeat: number;
  redraw(): void;
}

type AnyObject = MapNote | MapBomb | MapWall | MapArc | MapChain;
type Found = { kind: ObjectKind; item: AnyObject };

type Drag =
  | { kind: 'move'; grabBeat: number; grabLane: number; anchor: number; origin: Map<string, { b: number; tb?: number; x: number; tx?: number }>; moved: boolean }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: 'wall'; from: number; to: number; lane: number; lane2: number }
  | { kind: 'place'; x0: number; y0: number; beat: number; lane: number; additive: boolean }
  | { kind: 'resize'; id: string; edge: 'start' | 'end'; b: number; d: number; moved: boolean };

const ROW_NAMES = ['низ', 'середина', 'верх'];
const DIR_NAMES: Record<number, string> = { 0: '↑', 1: '↓', 2: '←', 3: '→', 4: '↖', 5: '↗', 6: '↙', 7: '↘', 8: '•' };

export class NotesLanes {
  private drag: Drag | null = null;
  hover: { x: number; y: number } | null = null;

  constructor(private readonly host: LaneHost) {}

  private get editor() {
    return this.host.editor;
  }

  laneHeight() {
    return Math.max(18, (this.host.lanesBottom - this.host.lanesTop) / 4);
  }

  laneTop(lane: number) {
    return this.host.lanesTop + lane * this.laneHeight();
  }

  laneAt(y: number): number | null {
    if (y < this.host.lanesTop || y >= this.host.lanesBottom) return null;
    return Math.max(0, Math.min(3, Math.floor((y - this.host.lanesTop) / this.laneHeight())));
  }

  // ----- what's where ------------------------------------------------------------------------------------

  /** The ticks drawn for the notes and bombs in view (as ChroViewer's): a thin stroke in its colour,
   *  in its lane's third that is its row (the top third: the top row). `w`, `h`: its box. */
  private marks(): { found: Found; x: number; y: number; w: number; h: number }[] {
    const host = this.host;
    const from = host.xToBeat(host.left - 8);
    const to = host.xToBeat(host.width + 8);
    const third = this.laneHeight() / 3;
    const out: { found: Found; x: number; y: number; w: number; h: number }[] = [];
    const put = (kind: ObjectKind, item: MapNote | MapBomb) => {
      if (item.b < from || item.b > to) return;
      const lane = Math.max(0, Math.min(3, Math.round(item.x)));
      const row = Math.max(0, Math.min(2, Math.round(item.y)));
      out.push({ found: { kind, item }, x: host.beatToX(item.b), y: this.laneTop(lane) + (2 - row + 0.5) * third, w: 4, h: Math.max(4, third - 3) });
    };
    for (const item of this.editor.objects.bombs) put('bombs', item);
    for (const item of this.editor.objects.notes) put('notes', item);
    return out;
  }

  /** How big the arcs' and chains' ends are drawn. */
  private markSize() {
    return Math.max(6, Math.min(14, this.laneHeight() * 0.3));
  }

  private wallRect(wall: MapWall) {
    const x0 = this.host.beatToX(wall.b);
    const x1 = this.host.beatToX(wall.b + Math.max(0, wall.d));
    const first = Math.max(0, Math.min(3, Math.round(wall.x)));
    const last = Math.max(first, Math.min(3, Math.round(wall.x + wall.w - 1)));
    const top = this.laneTop(first) + 3;
    const bottom = this.laneTop(last) + this.laneHeight() - 3;
    return { x: x0, y: top, w: Math.max(3, x1 - x0), h: bottom - top };
  }

  private laneCenter(x: number) {
    const lane = Math.max(0, Math.min(3, Math.round(x)));
    return this.laneTop(lane) + this.laneHeight() / 2;
  }

  /** The object under the mouse (marks before walls, arcs and chains). */
  hit(x: number, y: number): Found | null {
    const marks = this.marks();
    for (let i = marks.length - 1; i >= 0; i--) {
      const mark = marks[i]!;
      if (Math.abs(x - mark.x) <= mark.w / 2 + 3 && Math.abs(y - mark.y) <= mark.h / 2 + 1) return mark.found;
    }
    // (an arc or a chain: by its head or its tail)
    for (const kind of ['chains', 'arcs'] as const) {
      for (const item of this.editor.objects[kind]) {
        const hx = this.host.beatToX(item.b);
        const tx = this.host.beatToX(item.tb);
        const reach = kind === 'chains' ? this.markSize() / 2 + 2 : 7;
        if (Math.hypot(x - hx, y - this.laneCenter(item.x)) <= reach || Math.hypot(x - tx, y - this.laneCenter(item.tx)) <= 7) return { kind, item };
      }
    }
    for (const wall of this.editor.objects.walls) {
      const r = this.wallRect(wall);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { kind: 'walls', item: wall };
    }
    return null;
  }

  // ----- drawing ------------------------------------------------------------------------------------------

  private rgb(color: readonly number[], alpha = 1) {
    return `rgba(${color
      .slice(0, 3)
      .map((value) => Math.round(Math.max(0, Math.min(1, value)) * 255))
      .join(',')},${String(alpha)})`;
  }

  draw(ctx: CanvasRenderingContext2D) {
    const host = this.host;
    const editor = this.editor;
    const colors = editor.preview.colors;
    const noteColor = (c: number) => (c === 0 ? colors.leftNote : colors.rightNote);
    const h = this.laneHeight();
    // lanes
    for (let lane = 0; lane < 4; lane++) {
      const top = this.laneTop(lane);
      ctx.fillStyle = lane % 2 === 0 ? '#17181e' : '#191a20';
      ctx.fillRect(0, top, host.width, h);
      ctx.fillStyle = '#25272f';
      ctx.fillRect(0, top + h - 1, host.width, 1);
    }
    // (the middle: between the left hand's columns and the right hand's)
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, this.laneTop(2) - 1, host.width, 1);
  }

  /** The objects over the lanes (and the grid drawn between). */
  drawObjects(ctx: CanvasRenderingContext2D) {
    const host = this.host;
    const editor = this.editor;
    const colors = editor.preview.colors;
    const noteColor = (c: number) => (c === 0 ? colors.leftNote : colors.rightNote);
    const h = this.laneHeight();
    const from = host.xToBeat(host.left - 40);
    const to = host.xToBeat(host.width + 40);
    // walls
    for (const wall of editor.objects.walls) {
      if (wall.b + wall.d < from || wall.b > to) continue;
      const r = this.wallRect(wall);
      const picked = editor.noteSelection.has(wall.id);
      const crouch = wall.y >= 1;
      ctx.fillStyle = this.rgb(colors.obstacle, picked ? 0.45 : 0.28);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      if (crouch) {
        // (a crouch wall: hatched, the player ducks under it)
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();
        ctx.strokeStyle = this.rgb(colors.obstacle, 0.55);
        ctx.lineWidth = 1;
        for (let x = r.x - r.h; x < r.x + r.w; x += 7) {
          ctx.beginPath();
          ctx.moveTo(x, r.y + r.h);
          ctx.lineTo(x + r.h, r.y);
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.strokeStyle = picked ? '#ffe27a' : this.rgb(colors.obstacle, 0.9);
      ctx.lineWidth = picked ? 2 : 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      if (r.w > 40 && r.h > 14) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(WALL_NAMES[wallKindOf(wall)], r.x + 4, r.y + 11);
      }
    }
    // arcs and chains
    for (const arc of editor.objects.arcs) {
      if (arc.tb < from || arc.b > to) continue;
      const x0 = host.beatToX(arc.b);
      const x1 = host.beatToX(arc.tb);
      const y0 = this.laneCenter(arc.x);
      const y1 = this.laneCenter(arc.tx);
      const picked = editor.noteSelection.has(arc.id);
      ctx.strokeStyle = picked ? '#ffe27a' : this.rgb(noteColor(arc.c), 0.8);
      ctx.lineWidth = picked ? 3 : 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      const bend = arc.m === 1 ? -h * 0.5 : arc.m === 2 ? h * 0.5 : 0;
      ctx.bezierCurveTo(x0 + (x1 - x0) * 0.35, y0 + bend, x0 + (x1 - x0) * 0.65, y1 + bend, x1, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [x, y] of [
        [x0, y0],
        [x1, y1],
      ] as const) {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = this.rgb(noteColor(arc.c), 1);
        ctx.fill();
      }
    }
    for (const chain of editor.objects.chains) {
      if (chain.tb < from || chain.b > to) continue;
      const x0 = host.beatToX(chain.b);
      const x1 = host.beatToX(chain.tb);
      const y0 = this.laneCenter(chain.x);
      const y1 = this.laneCenter(chain.tx);
      const picked = editor.noteSelection.has(chain.id);
      ctx.strokeStyle = picked ? '#ffe27a' : this.rgb(noteColor(chain.c), 0.9);
      ctx.lineWidth = picked ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      const links = Math.max(1, Math.round(chain.sc) - 1);
      ctx.fillStyle = this.rgb(noteColor(chain.c), 1);
      for (let k = 1; k <= links; k++) {
        const t = (k / links) * Math.max(0, Math.min(1, chain.s));
        ctx.fillRect(x0 + (x1 - x0) * t - 2, y0 + (y1 - y0) * t - 4, 4, 8);
      }
      // (its head: a note of its own, half a block — drawn as a note with a notch)
      const size = this.markSize() * 0.9;
      this.drawNote(ctx, { id: chain.id, b: chain.b, x: chain.x, y: chain.y, c: chain.c, d: chain.d, a: 0 }, x0, y0, size, this.rgb(noteColor(chain.c)), picked);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(x0 - size / 2, y0 + size * 0.12, size, 2);
    }
    // notes and bombs
    for (const { found, x, y, w, h: tall } of this.marks()) {
      const picked = editor.noteSelection.has(found.item.id);
      if (picked) {
        ctx.fillStyle = '#ffe27a';
        ctx.fillRect(x - w / 2 - 2, y - tall / 2 - 2, w + 4, tall + 4);
      }
      ctx.fillStyle = found.kind === 'bombs' ? '#9a9eaa' : this.rgb(noteColor((found.item as MapNote).c));
      ctx.fillRect(x - w / 2, y - tall / 2, w, tall);
    }
    // the map checker's finds: what's at fault ringed (red: an error, yellow: a warning), a mark over
    // the lanes where it is (the mouse over it tells what's wrong)
    const shown = editor.activeIssues().filter((issue) => issue.level !== 'info' && issue.beat >= from - 8 && issue.beat <= to);
    const faults = this.faults(shown);
    for (const [id, level] of faults) {
      const found = editor.objectById(id);
      if (found === null) continue;
      const colour = level === 'error' ? '#ff4d4d' : '#ffc94a';
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      if (found.kind === 'walls') {
        const r = this.wallRect(found.item as MapWall);
        ctx.strokeRect(r.x - 2.5, r.y - 2.5, r.w + 5, r.h + 5);
      } else {
        const x = host.beatToX(found.item.b);
        if (x < -20 || x > host.width + 20) continue;
        const y = this.laneCenter(found.item.x);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(9, h * 0.42), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.setLineDash([]);
    let lastMark = -Infinity;
    for (const issue of shown) {
      if (issue.beat < from) continue;
      const x = host.beatToX(issue.beat);
      if (x - lastMark < 4) continue;
      lastMark = x;
      ctx.fillStyle = issue.level === 'error' ? 'rgba(255,77,77,0.22)' : 'rgba(255,201,74,0.16)';
      ctx.fillRect(x - 1, host.lanesTop, 3, host.lanesBottom - host.lanesTop);
      ctx.fillStyle = issue.level === 'error' ? '#ff4d4d' : '#ffc94a';
      ctx.beginPath();
      ctx.moveTo(x - 7, host.lanesTop);
      ctx.lineTo(x + 7, host.lanesTop);
      ctx.lineTo(x, host.lanesTop + 10);
      ctx.fill();
    }
    // what's being drawn or boxed
    const drag = this.drag;
    if (drag?.kind === 'wall') {
      const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
      const lane = Math.min(drag.lane, drag.lane2);
      const wall: MapWall = { id: '', b: a, d: Math.max(b - a, editor.snap || 0.25), x: lane, y: 0, w: Math.abs(drag.lane2 - drag.lane) + 1, h: 5 };
      const strobe = editor.wallStrobe;
      const pieces = strobe.on ? strobeWalls(wall, a, a + Math.max(wall.d, strobe.step), strobe.step, strobe.fill).map((item) => ({ ...item, id: '' })) : [wall];
      for (const piece of pieces) {
        const r = this.wallRect(piece);
        ctx.fillStyle = this.rgb(colors.obstacle, 0.3);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = '#ffe27a';
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      }
    }
    if (drag?.kind === 'box') {
      const { x0, y0, x1, y1 } = drag;
      ctx.fillStyle = 'rgba(120,170,255,0.12)';
      ctx.strokeStyle = 'rgba(140,180,255,0.8)';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    this.drawTip(ctx);
  }

  private drawNote(ctx: CanvasRenderingContext2D, note: MapNote, x: number, y: number, size: number, color: string, picked: boolean) {
    drawGameNote(ctx, note, x, y, size, color, picked);
  }

  private drawBomb(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, picked: boolean) {
    const r = size * 0.42;
    ctx.fillStyle = '#2b2d33';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = picked ? '#ffe27a' : '#c9ccd6';
    ctx.lineWidth = picked ? 2.5 : 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - r * 0.6, y + r * 0.6);
    ctx.lineTo(x + r * 0.6, y - r * 0.6);
    ctx.stroke();
  }

  /** Three pips beside a mark, bottom to top: the lit one is the note's row. */
  private drawPips(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, row: number) {
    const gap = Math.max(3, size * 0.26);
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = k === Math.round(row) ? '#ffffff' : 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.arc(x, y + (1 - k) * gap, Math.max(1.3, size * 0.07), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** A note on what's under the mouse (what it is, when, where). */
  /** The objects at fault in these finds, each with its worst level. */
  private faults(issues: MapIssue[]) {
    const out = new Map<string, 'error' | 'warn'>();
    for (const issue of issues) {
      if (issue.level === 'info') continue;
      for (const id of issue.ids) if (out.get(id) !== 'error') out.set(id, issue.level);
    }
    return out;
  }

  /** The finds whose mark is under the mouse (the marks hang over the lanes' top). */
  private issuesAtMark(x: number, y: number) {
    const host = this.host;
    if (y < host.lanesTop - 2 || y > host.lanesTop + 14) return [];
    return this.editor.activeIssues().filter((issue) => issue.level !== 'info' && Math.abs(host.beatToX(issue.beat) - x) <= 8);
  }

  /** A box of lines by the mouse (long lines wrapped). */
  private tipBox(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, lines: { text: string; colour: string; bold?: boolean }[], gridBeat?: number) {
    const most = Math.max(220, Math.min(420, this.host.width * 0.45));
    const wrapped: typeof lines = [];
    for (const line of lines) {
      ctx.font = line.bold === true ? '600 12px system-ui, sans-serif' : '12px system-ui, sans-serif';
      let current = '';
      for (const word of line.text.split(' ')) {
        const next = current === '' ? word : `${current} ${word}`;
        if (ctx.measureText(next).width > most && current !== '') {
          wrapped.push({ ...line, text: current });
          current = word;
        } else current = next;
      }
      wrapped.push({ ...line, text: current });
    }
    ctx.font = '600 12px system-ui, sans-serif';
    // (with a little wall: the grid as it is on this beat, beside the text)
    const cell = 17;
    const gridW = gridBeat === undefined ? 0 : cell * 4 + 12;
    const textW = Math.max(...wrapped.map((line) => ctx.measureText(line.text).width)) + 18;
    const w = textW + gridW;
    const hgt = Math.max(16 * wrapped.length + 10, gridBeat === undefined ? 0 : cell * 3 + 16);
    let x = at.x + 14;
    let y = at.y - hgt - 8;
    if (x + w > this.host.width) x = Math.max(2, at.x - w - 14);
    // (kept on the lanes: above the mouse, or below it when there's no room)
    if (y < this.host.lanesTop + 2) y = Math.min(at.y + 16, this.host.lanesBottom - hgt - 2);
    y = Math.max(this.host.lanesTop + 2, y);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(20,22,28,0.97)';
    roundRect(ctx, x, y, w, hgt, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
    wrapped.forEach((line, index) => {
      ctx.font = line.bold === true ? '600 12px system-ui, sans-serif' : '12px system-ui, sans-serif';
      ctx.fillStyle = line.colour;
      ctx.fillText(line.text, x + 9 + gridW, y + 18 + index * 16);
    });
    if (gridBeat !== undefined) this.miniWall(ctx, x + 8, y + 8, cell, gridBeat);
  }

  /** The 4×3 wall as it is on a beat: its notes, bombs and walls (what's at the mouse among them). */
  private miniWall(ctx: CanvasRenderingContext2D, left: number, top: number, cell: number, beat: number) {
    const editor = this.editor;
    const colors = editor.preview.colors;
    const at = (row: number) => top + (2 - row) * cell;
    ctx.fillStyle = '#0e0f13';
    ctx.fillRect(left, top, cell * 4, cell * 3);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) ctx.strokeRect(left + k * cell + 0.5, top + 0.5, 0, cell * 3);
    for (let k = 0; k <= 3; k++) ctx.strokeRect(left + 0.5, top + k * cell + 0.5, cell * 4, 0);
    for (const wall of editor.objects.walls) {
      if (wall.b > beat + 1e-3 || wall.b + wall.d < beat - 1e-3) continue;
      ctx.fillStyle = this.rgb(colors.obstacle, 0.35);
      for (let row = 0; row < 3; row++) {
        if (row < wall.y || row >= wall.y + wall.h) continue;
        const x0 = Math.max(0, wall.x);
        const x1 = Math.min(4, wall.x + wall.w);
        if (x1 > x0) ctx.fillRect(left + x0 * cell, at(row), (x1 - x0) * cell, cell);
      }
    }
    for (const bomb of editor.objects.bombs) {
      if (Math.abs(bomb.b - beat) > 1e-3) continue;
      ctx.fillStyle = '#9a9eaa';
      ctx.beginPath();
      ctx.arc(left + (bomb.x + 0.5) * cell, at(bomb.y) + cell / 2, cell * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const note of editor.objects.notes) {
      if (Math.abs(note.b - beat) > 1e-3 || note.x < 0 || note.x > 3 || note.y < 0 || note.y > 2) continue;
      drawGameNote(ctx, note, left + (note.x + 0.5) * cell, at(note.y) + cell / 2, cell * 0.82, this.rgb(note.c === 0 ? colors.leftNote : colors.rightNote), editor.noteSelection.has(note.id));
    }
  }

  private issueLines(issues: MapIssue[]) {
    return issues.map((issue) => ({ text: `${issue.level === 'error' ? '⛔' : '⚠'} ${issue.text}`, colour: issue.level === 'error' ? '#ff9a9a' : '#ffd77a' }));
  }

  private drawTip(ctx: CanvasRenderingContext2D) {
    const hover = this.hover;
    if (hover === null || this.drag !== null) return;
    const atMark = this.issuesAtMark(hover.x, hover.y);
    if (atMark.length > 0) {
      const beat = atMark[0]!.beat;
      this.tipBox(ctx, hover, [{ text: `Доля ${(Math.round(beat * 1000) / 1000).toString()}`, colour: '#fff', bold: true }, ...this.issueLines(atMark.slice(0, 8))]);
      return;
    }
    const found = this.hit(hover.x, hover.y);
    if (found === null) return;
    const editor = this.editor;
    const item = found.item;
    const seconds = editor.beatToSeconds(item.b);
    const time = `${String(Math.floor(seconds / 60))}:${(seconds % 60).toFixed(2).padStart(5, '0')} · доля ${item.b.toFixed(3)}`;
    let title: string;
    let where = `колонка ${String(item.x + 1)}, ряд ${ROW_NAMES[Math.round((item as MapNote).y)] ?? String((item as MapNote).y)}`;
    if (found.kind === 'notes') {
      const note = item as MapNote;
      title = `${note.c === 0 ? 'Красная' : 'Синяя'} нота ${DIR_NAMES[note.d] ?? ''}`;
    } else if (found.kind === 'bombs') title = 'Бомба';
    else if (found.kind === 'walls') {
      const wall = item as MapWall;
      title = WALL_NAMES[wallKindOf(wall)];
      where = `колонки ${String(wall.x + 1)}–${String(wall.x + wall.w)}, длина ${wall.d.toFixed(2)} доли`;
    } else {
      const span = objectSpan(found.kind, item);
      title = found.kind === 'arcs' ? 'Дуга' : `Цепь (${String((item as MapChain).sc)} звеньев)`;
      where = `${where} → доля ${span[1].toFixed(3)}`;
    }
    const issues = editor.activeIssues().filter((issue) => issue.level !== 'info' && issue.ids.includes(item.id));
    this.tipBox(ctx, hover, [{ text: title, colour: '#fff', bold: true }, { text: time, colour: '#9aa0ad' }, { text: where, colour: '#9aa0ad' }, ...this.issueLines(issues.slice(0, 6))], found.kind === 'walls' ? Math.max(item.b, Math.min(item.b + (item as MapWall).d, this.host.xToBeat(hover.x))) : item.b);
  }

  // ----- the mouse -------------------------------------------------------------------------------------

  /** A wall's end under the mouse (its start or end, to stretch it as a light's clip is). */
  private wallEdge(x: number, y: number): { wall: MapWall; edge: 'start' | 'end' } | null {
    for (const wall of this.editor.objects.walls) {
      const r = this.wallRect(wall);
      if (y < r.y || y > r.y + r.h) continue;
      if (Math.abs(x - (r.x + r.w)) <= 6) return { wall, edge: 'end' };
      if (Math.abs(x - r.x) <= 6 && r.w > 12) return { wall, edge: 'start' };
    }
    return null;
  }

  cursor(x: number, y: number) {
    if (this.drag !== null) return this.drag.kind === 'move' ? 'grabbing' : this.drag.kind === 'resize' ? 'ew-resize' : 'default';
    if (this.wallEdge(x, y) !== null) return 'ew-resize';
    return this.hit(x, y) !== null ? 'grab' : this.laneAt(y) !== null ? 'crosshair' : 'default';
  }

  /** A mouse button down on the lanes. */
  mouseDown(event: MouseEvent, x: number, y: number) {
    const editor = this.editor;
    const lane = this.laneAt(y);
    if (lane === null) return;
    const beat = this.host.xToBeat(x);
    const found = this.hit(x, y);
    if (event.button === 1) {
      // middle click: the other colour (as in ChroMapper)
      event.preventDefault();
      if (found !== null && 'c' in found.item) editor.updateObjects([found.item.id], (_kind, item) => ((item as MapNote).c = 1 - (item as MapNote).c));
      return;
    }
    if (event.button === 2) {
      if (found !== null) objectRightClick(editor, event.clientX, event.clientY, found);
      return;
    }
    if (event.button !== 0) return;
    const edge = (found === null || found.kind === 'walls') && !(event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) ? this.wallEdge(x, y) : null;
    if (edge !== null) {
      // a wall's end: stretched or shrunk, as a light's clip is (one undo step)
      editor.selectNotes([edge.wall.id]);
      editor.noteCheckpoint();
      this.drag = { kind: 'resize', id: edge.wall.id, edge: edge.edge, b: edge.wall.b, d: edge.wall.d, moved: false };
      return;
    }
    if (found === null) {
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, additive: true };
        return;
      }
      if (editor.noteTool.kind === 'wall') {
        const from = editor.snapBeat(Math.max(0, beat));
        this.drag = { kind: 'wall', from, to: from, lane, lane2: lane };
        return;
      }
      // (a click puts in a note — a drag boxes)
      this.drag = { kind: 'place', x0: x, y0: y, beat: editor.snapBeat(Math.max(0, beat)), lane, additive: false };
      return;
    }
    const id = found.item.id;
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      editor.selectNotes([id], 'toggle');
      return;
    }
    if (!editor.noteSelection.has(id)) editor.selectNotes([id]);
    editor.noteCheckpoint();
    if (event.altKey) {
      // Alt: drag a copy
      const copies = editor.selectedObjects().map(({ kind, item }) => ({ kind, item: { ...structuredClone(item), id: newId('n') } as AnyObject }));
      for (const { kind, item } of copies) (editor.objects[kind] as AnyObject[]).push(item);
      editor.noteSelection = new Set(copies.map(({ item }) => item.id));
    }
    const origin = new Map<string, { b: number; tb?: number; x: number; tx?: number }>();
    for (const { item } of editor.selectedObjects()) origin.set(item.id, { b: item.b, x: item.x, ...('tb' in item ? { tb: item.tb, tx: item.tx } : {}) });
    this.drag = { kind: 'move', grabBeat: beat, grabLane: lane, anchor: found.item.b, origin, moved: event.altKey };
  }

  /** The mouse moved (a drag going on: true). */
  mouseMove(x: number, y: number): boolean {
    this.hover = { x, y };
    const drag = this.drag;
    if (drag === null) return false;
    const editor = this.editor;
    const beat = this.host.xToBeat(x);
    if (drag.kind === 'place') {
      if (Math.hypot(x - drag.x0, y - drag.y0) > 5) this.drag = { kind: 'box', x0: drag.x0, y0: drag.y0, x1: x, y1: y, additive: drag.additive };
      this.host.redraw();
      return true;
    }
    if (drag.kind === 'resize') {
      const wall = editor.objects.walls.find((item) => item.id === drag.id);
      if (wall === undefined) return true;
      const at = editor.snapBeat(Math.max(0, beat));
      const least = Math.max(1 / 64, editor.snap || 1 / 16);
      const end = drag.b + drag.d;
      if (drag.edge === 'end') {
        wall.b = drag.b;
        wall.d = round(Math.max(least, at - drag.b));
      } else {
        wall.b = round(Math.min(at, end - least));
        wall.d = round(end - wall.b);
      }
      drag.moved = wall.b !== drag.b || wall.d !== drag.d;
      editor.noteVersion++;
      editor.rebuildPreview();
    } else if (drag.kind === 'box') {
      drag.x1 = x;
      drag.y1 = y;
    } else if (drag.kind === 'wall') {
      drag.to = editor.snapBeat(Math.max(0, beat));
      drag.lane2 = this.laneAt(Math.max(this.host.lanesTop, Math.min(this.host.lanesBottom - 1, y))) ?? drag.lane2;
    } else {
      const target = editor.snapBeat(drag.anchor + (beat - drag.grabBeat));
      const shift = Math.max(-Math.min(...[...drag.origin.values()].map((o) => o.b)), target - drag.anchor);
      const lane = this.laneAt(Math.max(this.host.lanesTop, Math.min(this.host.lanesBottom - 1, y))) ?? drag.grabLane;
      let laneShift = lane - drag.grabLane;
      // (nothing goes off the grid)
      for (const found of editor.selectedObjects()) {
        const o = drag.origin.get(found.item.id);
        if (o === undefined) continue;
        const width = found.kind === 'walls' ? (found.item as MapWall).w : 1;
        const lows = [o.x, o.tx ?? o.x];
        const highs = [o.x + width - 1, o.tx ?? o.x];
        laneShift = Math.max(laneShift, -Math.min(...lows));
        laneShift = Math.min(laneShift, 3 - Math.max(...highs));
      }
      if (shift !== 0 || laneShift !== 0) drag.moved = true;
      for (const found of editor.selectedObjects()) {
        const o = drag.origin.get(found.item.id);
        if (o === undefined) continue;
        const item = found.item;
        item.b = round(o.b + shift);
        item.x = o.x + laneShift;
        if ('tb' in item && o.tb !== undefined && o.tx !== undefined) {
          item.tb = round(o.tb + shift);
          item.tx = o.tx + laneShift;
        }
      }
      editor.noteVersion++;
      editor.rebuildPreview();
    }
    this.host.redraw();
    return true;
  }

  mouseUp(event: MouseEvent) {
    const drag = this.drag;
    this.drag = null;
    if (drag === null) return;
    const editor = this.editor;
    if (drag.kind === 'resize') {
      if (drag.moved) editor.notesChanged(true);
      else editor.noteUndoDiscard();
    } else if (drag.kind === 'place') {
      this.place(drag.beat, drag.lane);
    } else if (drag.kind === 'box') {
      const [x0, x1] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)];
      const [y0, y1] = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
      const inside = new Set<string>();
      for (const mark of this.marks()) if (mark.x >= x0 && mark.x <= x1 && mark.y >= y0 && mark.y <= y1) inside.add(mark.found.item.id);
      for (const wall of editor.objects.walls) {
        const r = this.wallRect(wall);
        if (r.x <= x1 && r.x + r.w >= x0 && r.y <= y1 && r.y + r.h >= y0) inside.add(wall.id);
      }
      for (const kind of ['arcs', 'chains'] as const) {
        for (const item of editor.objects[kind]) {
          const hx = this.host.beatToX(item.b);
          const hy = this.laneCenter(item.x);
          if (hx >= x0 && hx <= x1 && hy >= y0 && hy <= y1) inside.add(item.id);
        }
      }
      editor.selectNotes(inside, drag.additive || event.shiftKey ? 'add' : 'replace');
    } else if (drag.kind === 'wall') {
      const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
      const lane = Math.min(drag.lane, drag.lane2);
      const wide = Math.abs(drag.lane2 - drag.lane) + 1;
      const length = Math.max(b - a, editor.snap || 0.25);
      const strobe = editor.wallStrobe;
      if (strobe.on) {
        // (a strobe: short walls one every step over the stretch drawn)
        const made = strobeWalls({ x: lane, ...WALL_SHAPES[editor.wallKind], w: wide }, a, a + Math.max(length, strobe.step), strobe.step, strobe.fill);
        editor.addObjects(made.map((item) => ({ kind: 'walls' as const, item: { ...item, id: newId('n') } })), false);
      } else editor.addObjects([{ kind: 'walls', item: { id: newId('n'), b: a, x: lane, ...WALL_SHAPES[editor.wallKind], d: round(length), w: wide } }], false);
    } else if (!drag.moved) {
      editor.noteUndoDiscard();
    } else {
      editor.notesChanged(true);
    }
    this.host.redraw();
  }

  /** What the tool puts in at a beat in a lane (its row: the one picked on the grid). */
  place(beat: number, lane: number, row = this.editor.noteRow) {
    const editor = this.editor;
    const tool = editor.noteTool;
    const same = (item: { b: number; x: number; y: number }) => Math.abs(item.b - beat) < 1e-4 && item.x === lane && item.y === row;
    const there = [...editor.objects.notes, ...editor.objects.bombs].find(same);
    if (there !== undefined) {
      editor.selectNotes([there.id]);
      return;
    }
    if (tool.kind === 'bomb') editor.addObjects([{ kind: 'bombs', item: { id: newId('n'), b: beat, x: lane, y: row } }], false);
    else if (tool.kind === 'wall') editor.addObjects([{ kind: 'walls', item: { id: newId('n'), b: beat, x: lane, ...WALL_SHAPES[editor.wallKind], d: 1, w: 1 } }], false);
    else editor.addObjects([{ kind: 'notes', item: { id: newId('n'), b: beat, x: lane, y: row, c: tool.kind === 'red' ? 0 : 1, d: tool.direction, a: 0 } }], false);
  }

  /** Alt+wheel over a note: its arrow turned an eighth (true: done). */
  wheel(event: WheelEvent, x: number, y: number) {
    if (!event.altKey) return false;
    const found = this.hit(x, y);
    if (found !== null && found.kind === 'chains') {
      // (a chain: its links one more or less)
      this.editor.updateObjects([found.item.id], (_kind, item) => ((item as MapChain).sc = Math.max(2, Math.min(32, (item as MapChain).sc + (event.deltaY < 0 ? 1 : -1)))), `links:${found.item.id}`);
      return true;
    }
    if (found === null || found.kind !== 'notes') return false;
    const order = [0, 5, 3, 7, 1, 6, 2, 4];
    this.editor.updateObjects(
      this.editor.noteSelection.has(found.item.id) ? this.editor.noteSelection : [found.item.id],
      (kind, item) => {
        if (kind !== 'notes') return;
        const note = item as MapNote;
        if (note.d === 8) return;
        const at = order.indexOf(note.d);
        note.d = order[(at + (event.deltaY > 0 ? 1 : -1) + 8) % 8]!;
      },
      `turn:${found.item.id}`,
    );
    return true;
  }

  leave() {
    this.hover = null;
    this.host.redraw();
  }
}

/** The selected objects mirrored left ↔ right: columns, directions, colours (as in ChroMapper). */
export function mirrorObjects(editor: Editor) {
  const ids = [...editor.noteSelection];
  if (ids.length === 0) return;
  editor.updateObjects(ids, (kind, item) => {
    if (kind === 'walls') {
      const wall = item as MapWall;
      wall.x = 4 - wall.x - wall.w;
      return;
    }
    item.x = 3 - item.x;
    if ('c' in item) item.c = 1 - item.c;
    if ('d' in item) item.d = MIRROR_DIR[item.d] ?? item.d;
    if ('a' in item) item.a = -item.a;
    if ('tx' in item) item.tx = 3 - item.tx;
    if ('tc' in item) item.tc = MIRROR_DIR[item.tc] ?? item.tc;
    if ('m' in item && item.m !== 0) item.m = 3 - item.m;
  });
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export type { MapObjects };
