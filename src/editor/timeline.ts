import { adjustDialog, selectByDialog } from './adjust-dialog';
import { soundDialog } from './sound-dialog';
import { ringStepsDialog } from './ring-steps-dialog';
import { ringGlitchDialog } from './ring-glitch-dialog';
import { resolveRgb } from './bake';
import { isLightRow, RING_EVENT_TYPE, ZOOM_EVENT_TYPE, type Editor, type Row, type ShownClip, type SortKey } from './editor';
import type { Effect } from './effects';
import { ask, showMenu, showPanel, type MenuItem } from './menu';
import { cloneClip, findGroup, groupLights, lightKey, newId, type ClipColor, type LightClip, type RawEvent } from './model';
import { groupHue, lightGroupName } from './names';
import { isZoom, newRingBlock, newZoomBlock, ringDelay, type RingBlock } from './rings';
import { bandOfHz, DEFAULT_LOOK, paintSpectrogram, type Spectrogram, type SpectrogramLook } from './spectrogram';

/**
 * The timeline: a ruler, the rows (each light group, opened up into its lights on request, and the
 * other events), the song's spectrogram at the bottom. Light clips are rectangles from their start
 * to their end — the colour they light, a ramp where they fade in or out, a bright edge for a
 * flash; a clip on a higher layer is drawn over the ones under it but lower, so they still show
 * above it. A clip for only some lights of a group shows striped on the group's row.
 *
 * Mouse: drag on an empty spot of a row to draw a clip; drag a clip to move it, its edges to
 * resize; Shift/Ctrl+drag on an empty spot selects a box; Alt+drag copies; right click deletes (on
 * something picked: a menu — mirror, copy…).
 * Wheel: through time; Alt/Shift+wheel (or the wheel over the row names): through the rows;
 * Ctrl+wheel: zoom.
 *
 * Row names: ▸ opens a group up; a click picks lights (Ctrl adds, Shift a range) — for grouping
 * them (Ctrl+G) — right click: what can be done with it; the lights and subgroups of a group of the
 * user's can be dragged into another order.
 */

const RULER_H = 30;
/** The row scrollbar, left of the rows. */
const GUTTER = 14;
/** The song overview under the spectrogram. */
const NAV_H = 26;
/** How tall the spectrogram's name area must be for the grid and speed to stand in it. */
const PLAY_ROOM = 74;
/** The grids offered (beats; 0: none) — down to 1/64, triplets too. */
export const GRIDS: [number, string][] = [
  [1, '1'],
  [0.5, '1/2'],
  [1 / 3, '1/3'],
  [0.25, '1/4'],
  [1 / 6, '1/6'],
  [0.125, '1/8'],
  [1 / 12, '1/12'],
  [0.0625, '1/16'],
  [1 / 24, '1/24'],
  [0.03125, '1/32'],
  [1 / 48, '1/48'],
  [0.015625, '1/64'],
  [0, 'без сетки'],
];
/** The playback speed's range. */
export const MIN_RATE = 0.1;
export const MAX_RATE = 2;
/** Grips at the ends of a scrollbar's thumb (dragged: zoom). */
const GRIP = 7;
const GROUP_H = 28;
const LIGHT_H = 20;
const RAW_H = 22;
const EDGE_PX = 6;

const baseRowHeight = (row: Row) => (row.kind === 'group' || row.kind === 'custom' || row.kind === 'poses' ? GROUP_H : row.kind === 'light' ? LIGHT_H : RAW_H);

/** A colour per user group (from its name). */
export function customHue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 3600;
  return (hash * 7) % 360;
}

const SORTS: [SortKey, string][] = [
  ['id', 'по light ID'],
  ['x', 'слева направо'],
  ['y', 'снизу вверх'],
  ['z', 'от ближних к дальним'],
  ['angle', 'по кругу (от верха по часовой)'],
  ['reverse', 'обратный порядок'],
];
const LAYER_FACTOR = [1, 0.8, 0.64, 0.52, 0.44];

/** Where a dragged effect and its events were. */
interface EffectOrigin {
  start: number;
  end: number;
  children: Map<string, { start: number; end: number }>;
  target: Pick<Effect, 'target' | 'type' | 'ids'>;
}

type Drag =
  /** Drawing a new event: it is made only when the mouse has moved (a click alone makes nothing). */
  | { kind: 'create'; row: Row; from: number; to: number; x0: number; moved: boolean }
  | { kind: 'move'; origin: Map<string, LightClip>; rawOrigin: Map<string, number>; effectOrigin: Map<string, EffectOrigin>; blockOrigin: Map<string, { start: number; end: number }>; grabBeat: number; anchor: number; moved: boolean; rowKey: string }
  | { kind: 'resize'; edge: 'start' | 'end'; origin: Map<string, { start: number; end: number }>; effectOrigin: Map<string, EffectOrigin>; blockOrigin: Map<string, { start: number; end: number; poses: Map<string, number> }>; anchor: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: 'seek' }
  | { kind: 'scroll'; grabY: number; scrollY: number }
  | { kind: 'rowZoom'; edge: 'top' | 'bottom'; grabY: number; thumb: number; scale: number; scrollY: number }
  | { kind: 'nav'; part: 'body' | 'left' | 'right'; grabX: number; viewStart: number; pxPerBeat: number }
  | { kind: 'spectro'; grabY: number; height: number }
  | { kind: 'range'; from: number }
  | { kind: 'bookmark'; id: string; grab: number; origin: number; moved: boolean };

/** The edge between the rows and the spectrogram is grabbed within this many pixels of it. */
const SPECTRO_GRIP = 4;
const LOOK_KEY = 'chroeditor.spectrogram';

function loadLook(): SpectrogramLook {
  try {
    const saved = JSON.parse(localStorage.getItem(LOOK_KEY) ?? 'null') as Partial<SpectrogramLook> | null;
    return { ...DEFAULT_LOOK, ...(saved ?? {}) };
  } catch {
    return { ...DEFAULT_LOOK };
  }
}

/** Hz as people write it. */
function hzLabel(hz: number) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1).replace(/\.0$/u, '')} кГц` : `${String(Math.round(hz))} Гц`;
}

/** How far before the song's start the timeline goes (px). */
const LEAD_PX = 14;

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly headers: HTMLElement;
  /** Map beat at the left edge (no further left than a few pixels before the song's start), pixels
   *  per beat, rows scrolled by. */
  private start = -1;
  get viewStart() {
    return Math.max(this.start, -LEAD_PX / this.pxPerBeat);
  }
  set viewStart(beat: number) {
    this.start = Math.max(beat, -LEAD_PX / this.pxPerBeat);
  }
  pxPerBeat = 60;
  scrollY = 0;
  /** How tall the rows are (1: normal). */
  rowScale = 1;
  private drag: Drag | null = null;
  private needsDraw = true;
  private hover: { x: number; y: number } | null = null;
  private followPlayhead = true;
  private headerKey = '';
  /** How the spectrogram is shown (kept between sessions). */
  look: SpectrogramLook = loadLook();
  /** The look each spectrogram was last painted with. */
  private painted = new WeakMap<Spectrogram, string>();

  constructor(private readonly editor: Editor, root: HTMLElement) {
    this.headers = root.querySelector<HTMLElement>('#track-headers')!;
    this.canvas = root.querySelector<HTMLCanvasElement>('#tracks')!;
    this.context = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement!);
    this.resize();
    // (the grid and speed controls follow keys and other changes)
    editor.onChange(() => this.syncPlayControls());
    editor.onChange((what) => {
      if (what === 'rows' || what === 'all') this.renderHeaders(true);
      this.needsDraw = true;
    });
    this.bindMouse();
    const loop = () => {
      if (this.editor.isPlaying()) {
        this.needsDraw = true;
        if (this.followPlayhead) {
          const beat = this.editor.playhead();
          const width = this.trackWidth / this.pxPerBeat;
          if (beat > this.viewStart + width * 0.85 || beat < this.viewStart) this.viewStart = beat - width * 0.15;
        }
      }
      if (this.needsDraw) {
        this.needsDraw = false;
        this.draw();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private get width() {
    return this.canvas.clientWidth;
  }

  private get height() {
    return this.canvas.clientHeight;
  }

  /** The width time is drawn across (right of the row scrollbar). */
  private get trackWidth() {
    return Math.max(10, this.width - GUTTER);
  }

  private rowHeight(row: Row) {
    return Math.round(baseRowHeight(row) * this.rowScale);
  }

  private get rowsTop() {
    return RULER_H;
  }

  private get rowsBottom() {
    return this.height - this.spectroHeight - NAV_H;
  }

  /** The spectrogram's height as drawn: what was asked for, leaving the rows some room. */
  private get spectroHeight() {
    return Math.max(0, Math.min(this.look.height, this.height - NAV_H - RULER_H - 60));
  }

  /** Changes how the spectrogram looks (and keeps it). */
  setLook(patch: Partial<SpectrogramLook>) {
    const heightChanged = patch.height !== undefined && patch.height !== this.look.height;
    this.look = { ...this.look, ...patch };
    this.look.lowHz = Math.max(DEFAULT_LOOK.lowHz, Math.min(this.look.lowHz, DEFAULT_LOOK.highHz / 1.5));
    this.look.highHz = Math.min(DEFAULT_LOOK.highHz, Math.max(this.look.highHz, this.look.lowHz * 1.5));
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify(this.look));
    } catch {
      // (only a convenience)
    }
    // (while its edge is dragged, draw() keeps the heading's height up)
    if (heightChanged && this.drag?.kind !== 'spectro') this.renderHeaders(true);
    this.needsDraw = true;
  }

  /** Over the spectrogram's top edge (its height is dragged there). */
  private onSpectroEdge(x: number, y: number) {
    return x >= GUTTER && Math.abs(y - this.rowsBottom) <= SPECTRO_GRIP;
  }

  private get navTop() {
    return this.height - NAV_H;
  }

  redraw() {
    this.needsDraw = true;
  }

  private resize() {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.canvas.style.width = `${String(Math.max(10, rect.width))}px`;
    this.canvas.style.height = `${String(rect.height)}px`;
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.headers.style.height = `${String(rect.height)}px`;
    this.renderHeaders(true);
    this.needsDraw = true;
  }

  // ----- coordinates ---------------------------------------------------------------------------------

  beatToX(beat: number) {
    return GUTTER + (beat - this.viewStart) * this.pxPerBeat;
  }

  xToBeat(x: number) {
    return this.viewStart + (x - GUTTER) / this.pxPerBeat;
  }

  /** Each row's top (in canvas pixels, scrolled). */
  private layout(): { row: Row; top: number; height: number }[] {
    let y = this.rowsTop - this.scrollY;
    return this.editor.rows.map((row) => {
      const height = this.rowHeight(row);
      const item = { row, top: y, height };
      y += height;
      return item;
    });
  }

  private rowsHeight() {
    return this.editor.rows.reduce((sum, row) => sum + this.rowHeight(row), 0);
  }

  private rowAt(y: number) {
    if (y < this.rowsTop || y >= this.rowsBottom) return null;
    return this.layout().find((item) => y >= item.top && y < item.top + item.height) ?? null;
  }

  private maxScroll() {
    return Math.max(0, this.rowsHeight() - (this.rowsBottom - this.rowsTop) + 20);
  }

  scrollRows(delta: number) {
    this.scrollY = Math.min(this.maxScroll(), Math.max(0, this.scrollY + delta));
    this.needsDraw = true;
  }

  /** Rows taller or shorter (the rows at `anchorY` stay where they are). */
  zoomRows(scale: number, anchorY = this.rowsTop) {
    const next = Math.min(3, Math.max(0.6, scale));
    if (Math.abs(next - this.rowScale) < 1e-4) return;
    const offset = anchorY - this.rowsTop + this.scrollY;
    const ratio = next / this.rowScale;
    this.rowScale = next;
    this.scrollY = Math.min(this.maxScroll(), Math.max(0, offset * ratio - (anchorY - this.rowsTop)));
    this.renderHeaders(true);
    this.needsDraw = true;
  }

  /** The row scrollbar: its track and thumb (null: everything fits). */
  private vbar() {
    const total = this.rowsHeight() + 20;
    const visible = this.rowsBottom - this.rowsTop;
    const thumb = Math.min(visible, Math.max(28, (visible / total) * visible));
    const max = this.maxScroll();
    const thumbTop = this.rowsTop + (max <= 0 ? 0 : (this.scrollY / max) * (visible - thumb));
    return { visible, total, thumb, thumbTop, fits: total <= visible };
  }

  /** The song overview: the beats it spans and where the view is in it. */
  private nav() {
    const from = -1;
    const to = Math.max(16, this.editor.endBeat + 2);
    const width = this.trackWidth;
    const toX = (beat: number) => GUTTER + ((beat - from) / (to - from)) * width;
    const toBeat = (x: number) => from + ((x - GUTTER) / width) * (to - from);
    const viewEnd = this.viewStart + this.trackWidth / this.pxPerBeat;
    return { from, to, toX, toBeat, x0: toX(this.viewStart), x1: toX(viewEnd) };
  }

  /** Clips shown on a row (lowest first). */
  private clipsOf(row: Row): ShownClip[] {
    return this.editor.rowClips(row);
  }

  private clipRect(shown: ShownClip, top: number, height: number) {
    const clip = shown.clip;
    const factor = LAYER_FACTOR[Math.min(shown.level, LAYER_FACTOR.length - 1)]!;
    const inner = height - 4;
    const h = Math.max(6, inner * factor);
    return { x: this.beatToX(clip.start), y: top + 2 + (inner - h), w: (clip.end - clip.start) * this.pxPerBeat, h };
  }

  /** What's under the mouse in the rows area. */
  private hit(x: number, y: number): { clip: LightClip; edge: 'start' | 'end' | null; row: Row } | { raw: RawEvent; row: Row } | { block: RingBlock; edge: 'start' | 'end' | null; row: Row } | null {
    const item = this.rowAt(y);
    if (item === null) return null;
    const { row, top, height } = item;
    if (row.kind === 'poses') {
      for (const block of [...this.blocksOf(row)].reverse()) {
        const x0 = this.beatToX(block.start);
        const x1 = this.beatToX(block.end);
        if (x < x0 - 2 || x > x1 + 2 || y < top + 2 || y > top + height - 2) continue;
        const edge = x1 - x0 > EDGE_PX * 3 ? (x - x0 < EDGE_PX ? 'start' : x1 - x < EDGE_PX ? 'end' : null) : x > x1 - EDGE_PX ? 'end' : null;
        return { block, edge, row };
      }
      return null;
    }
    if (row.kind === 'raw') {
      const events = this.visibleRaw(row.type);
      const found = events.find((event) => Math.abs(this.beatToX(event.beat) - x) <= 6);
      return found === undefined ? null : { raw: found, row };
    }
    const clips = this.clipsOf(row);
    // (the top layer wins; within its height)
    for (let i = clips.length - 1; i >= 0; i--) {
      const shown = clips[i]!;
      if (shown.role === 'background') continue;
      const clip = shown.clip;
      const rect = this.clipRect(shown, top, height);
      if (x < rect.x - 2 || x > rect.x + rect.w + 2 || y < rect.y || y > rect.y + rect.h) continue;
      const edge = rect.w > EDGE_PX * 3 ? (x - rect.x < EDGE_PX ? 'start' : rect.x + rect.w - x < EDGE_PX ? 'end' : null) : x > rect.x + rect.w - EDGE_PX ? 'end' : null;
      return { clip, edge, row };
    }
    return null;
  }

  // ----- drawing ---------------------------------------------------------------------------------------

  private colorCss(color: ClipColor, alpha = 1) {
    const colors = this.editor.preview.colors;
    const rgb = resolveRgb(color, { left: [...colors.environmentLeft], right: [...colors.environmentRight], white: [...colors.environmentWhite] });
    const k = Math.min(1.25, 0.35 + 0.65 * Math.min(1.5, color.brightness));
    const c = rgb.map((v) => Math.round(Math.min(1, v * k) * 255));
    return `rgba(${String(c[0])},${String(c[1])},${String(c[2])},${String(alpha)})`;
  }

  private draw() {
    const ctx = this.context;
    const width = this.width;
    const height = this.height;
    const editor = this.editor;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#15161b';
    ctx.fillRect(0, 0, width, height);
    if (editor.project === null) {
      ctx.fillStyle = '#7a7f8c';
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText('Откройте папку карты (Ctrl+O)', 20, 60);
      return;
    }
    const beatsVisible = this.trackWidth / this.pxPerBeat;
    const first = Math.floor(this.viewStart);
    const last = Math.ceil(this.viewStart + beatsVisible);

    // rows
    this.scrollY = Math.min(this.scrollY, this.maxScroll());
    if (editor.reveal !== null) {
      const wanted = this.layout().find((item) => item.row.key === editor.reveal);
      editor.reveal = null;
      if (wanted !== undefined && (wanted.top < this.rowsTop || wanted.top + wanted.height > this.rowsBottom)) {
        this.scrollY = Math.min(this.maxScroll(), Math.max(0, this.scrollY + wanted.top - (this.rowsTop + this.rowsBottom) / 2));
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.rowsTop, width, this.rowsBottom - this.rowsTop);
    ctx.clip();
    for (const { row, top, height: h } of this.layout()) {
      if (top + h < this.rowsTop || top > this.rowsBottom) continue;
      ctx.fillStyle = row.kind === 'group' ? '#1b1d24' : row.kind === 'custom' ? '#1a1c26' : row.kind === 'light' ? '#17181e' : '#191a1f';
      ctx.fillRect(0, top, width, h);
      if (row.kind === 'light' && editor.lightSelection.has(lightKey(row.type, row.id))) {
        ctx.fillStyle = 'rgba(90,170,255,0.07)';
        ctx.fillRect(0, top, width, h);
      }
      if (editor.pickedLight !== null && row.kind === 'light' && row.type === editor.pickedLight.type && row.id === editor.pickedLight.id) {
        ctx.fillStyle = 'rgba(60,255,120,0.07)';
        ctx.fillRect(0, top, width, h);
      }
      ctx.fillStyle = '#25272f';
      ctx.fillRect(0, top + h - 1, width, 1);
    }
    // grid
    this.drawGrid(first, last, this.rowsTop, this.rowsBottom);
    // clips and events
    for (const { row, top, height: h } of this.layout()) {
      if (top + h < this.rowsTop || top > this.rowsBottom) continue;
      if (row.kind === 'raw') this.drawRaw(row, top, h);
      else if (row.kind === 'poses') for (const block of this.blocksOf(row)) this.drawRingBlock(block, top, h);
      else for (const shown of this.clipsOf(row)) this.drawClip(shown, top, h);
    }
    // the clip being drawn
    const creating = this.drag?.kind === 'create' && this.drag.moved ? this.drag : null;
    if (creating !== null) {
      const item = this.layout().find((entry) => entry.row.key === creating.row.key);
      if (item !== undefined && item.row.kind === 'poses') {
        const [a, b] = [Math.min(creating.from, creating.to), Math.max(creating.from, creating.to)];
        ctx.globalAlpha = 0.6;
        this.drawRingBlock(this.newBlockFor(item.row, a, Math.max(b, a + 1)), item.top, item.height);
        ctx.globalAlpha = 1;
      } else if (item !== undefined && isLightRow(item.row)) {
        const [a, b] = [Math.min(creating.from, creating.to), Math.max(creating.from, creating.to)];
        const end = Math.max(b, a + Math.max(editor.snap, 0.0625));
        const shown = this.clipsOf(item.row);
        const level = Math.min(shown.length === 0 ? 0 : Math.max(...shown.map((entry) => entry.level)) + 1, 1);
        const tool = editor.tool;
        if (tool.kind === 'effect') {
          const effect = editor.makeEffect(tool.effect, tool.params, item.row, a, end, tool.name);
          if (effect !== null) {
            this.ghostChildren = editor.previewEffectChildren(effect);
            this.drawClip({ clip: editor.effectProxy(effect), effect, partial: false, level, role: 'own' }, item.top, item.height, true);
            this.ghostChildren = null;
          }
        } else {
          const ghost = editor.newClipForRow(item.row, a, end);
          if (ghost !== null) this.drawClip({ clip: ghost, partial: false, level, role: 'own' }, item.top, item.height, true);
        }
      }
    }
    if (this.drag?.kind === 'box') {
      const { x0, y0, x1, y1 } = this.drag;
      ctx.fillStyle = 'rgba(120,170,255,0.12)';
      ctx.strokeStyle = 'rgba(140,180,255,0.8)';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    ctx.restore();

    // ruler
    ctx.fillStyle = '#101115';
    ctx.fillRect(0, 0, width, RULER_H);
    ctx.font = '11px system-ui, sans-serif';
    const step = this.labelStep();
    for (let beat = Math.floor(first / step) * step; beat <= last; beat += step) {
      const x = this.beatToX(beat);
      ctx.fillStyle = beat % 4 === 0 ? '#9aa0ad' : '#5d6270';
      ctx.fillRect(x, RULER_H - (beat % 4 === 0 ? 10 : 6), 1, beat % 4 === 0 ? 10 : 6);
      if (beat % 4 === 0 || step < 4) ctx.fillText(String(beat), x + 3, 12);
    }
    ctx.fillStyle = '#2a2c34';
    ctx.fillRect(0, RULER_H - 1, width, 1);

    // spectrogram
    this.drawSpectrogram(this.rowsBottom, this.spectroHeight);

    // the song's preview (as Info.dat has it) on the ruler; the picked stretch of the song over all
    const preview = editor.songPreview;
    if (preview !== null) {
      const x0 = this.beatToX(editor.secondsToBeat(preview.start));
      const x1 = this.beatToX(editor.secondsToBeat(preview.start + preview.duration));
      if (x1 > GUTTER && x0 < width) {
        ctx.fillStyle = 'rgba(255,200,80,0.18)';
        ctx.fillRect(Math.max(GUTTER, x0), RULER_H - 9, x1 - Math.max(GUTTER, x0), 8);
        ctx.fillStyle = 'rgba(255,205,90,0.9)';
        ctx.fillRect(x0, RULER_H - 9, Math.max(1, x1 - x0), 2);
      }
    }
    const range = editor.songRange;
    if (range !== null) {
      const x0 = this.beatToX(Math.min(range.start, range.end));
      const x1 = this.beatToX(Math.max(range.start, range.end));
      ctx.fillStyle = 'rgba(110,170,255,0.13)';
      ctx.fillRect(x0, 0, x1 - x0, this.navTop);
      ctx.fillStyle = 'rgba(140,190,255,0.9)';
      ctx.fillRect(x0, 0, 1, this.navTop);
      ctx.fillRect(x1, 0, 1, this.navTop);
      ctx.fillRect(x0, 0, x1 - x0, 3);
    }
    // bookmarks: a line down the rows, a flag with the name on the ruler
    ctx.font = '600 10px system-ui, sans-serif';
    for (const flag of this.bookmarkFlags()) {
      const css = `rgb(${flag.bookmark.color.map((v) => Math.round(v * 255)).join(',')})`;
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = css;
      for (let y = RULER_H; y < this.navTop; y += 6) ctx.fillRect(flag.x, y, 1, 3);
      ctx.globalAlpha = 1;
      ctx.fillStyle = css;
      ctx.fillRect(flag.x, 0, 2, RULER_H);
      ctx.fillRect(flag.x, 0, flag.w, 14);
      ctx.fillStyle = '#0d0e12';
      ctx.fillText(flag.label, flag.x + 4, 10.5);
    }
    // playhead
    const px = this.beatToX(editor.playhead());
    if (px >= GUTTER - 6) {
      ctx.fillStyle = '#ff4d6d';
      ctx.fillRect(Math.round(px), 0, 1.5, this.navTop);
      ctx.beginPath();
      ctx.moveTo(px - 6, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px, 8);
      ctx.fill();
    }
    // the row scrollbar (left), the song overview (bottom)
    this.drawScrollbar();
    this.drawNav();
    // headers follow the rows
    const list = this.headers.querySelector<HTMLElement>('.th-rows');
    if (list !== null) {
      list.style.height = `${String(Math.max(0, this.rowsBottom - this.rowsTop))}px`;
      list.scrollTop = this.scrollY;
      const spectro = this.headers.querySelector<HTMLElement>('.th-spectro');
      if (spectro !== null) spectro.style.height = `${String(this.spectroHeight)}px`;
      // (the grid and speed: moved when the spectrogram grows or shrinks past their room)
      if ((this.spectroHeight >= PLAY_ROOM) !== this.playPlacedRoomy) this.renderHeaders(true);
      else this.syncPlayControls();
    }
  }

  private labelStep() {
    const minPx = 46;
    for (const step of [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64]) if (step * this.pxPerBeat >= minPx) return step;
    return 128;
  }

  private drawGrid(first: number, last: number, top: number, bottom: number) {
    const ctx = this.context;
    const snap = this.editor.snap;
    if (snap > 0 && snap * this.pxPerBeat >= 8) {
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      for (let beat = Math.floor(first / snap) * snap; beat <= last; beat += snap) ctx.fillRect(this.beatToX(beat), top, 1, bottom - top);
    }
    for (let beat = first; beat <= last; beat++) {
      ctx.fillStyle = beat % 4 === 0 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.06)';
      ctx.fillRect(this.beatToX(beat), top, 1, bottom - top);
    }
  }

  private drawScrollbar() {
    const ctx = this.context;
    ctx.fillStyle = '#121318';
    ctx.fillRect(0, 0, GUTTER, this.navTop);
    ctx.fillStyle = '#2a2c34';
    ctx.fillRect(GUTTER - 1, this.rowsTop, 1, this.rowsBottom - this.rowsTop);
    const bar = this.vbar();
    const active = this.drag?.kind === 'scroll' || this.drag?.kind === 'rowZoom';
    const x = 3;
    const w = GUTTER - 7;
    ctx.fillStyle = active ? '#6f7588' : '#454a58';
    roundRect(ctx, x, bar.thumbTop + 1, w, bar.thumb - 2, 4);
    // the grips: drag them to make the rows taller / shorter
    ctx.fillStyle = active ? '#c3c8d6' : '#8a90a0';
    roundRect(ctx, x + 1, bar.thumbTop + 2, w - 2, GRIP - 2, 3);
    roundRect(ctx, x + 1, bar.thumbTop + bar.thumb - GRIP, w - 2, GRIP - 2, 3);
  }

  private drawNav() {
    const ctx = this.context;
    const top = this.navTop;
    const width = this.width;
    ctx.fillStyle = '#0d0e12';
    ctx.fillRect(0, top, width, NAV_H);
    ctx.fillStyle = '#2a2c34';
    ctx.fillRect(0, top, width, 1);
    if (this.editor.project === null) return;
    const nav = this.nav();
    // the whole song, small: its spectrogram, and where the lights are
    const spectrogram = this.editor.spectrogram;
    if (spectrogram !== null) {
      const x0 = nav.toX(this.editor.secondsToBeat(0));
      const x1 = nav.toX(this.editor.secondsToBeat(spectrogram.frames * spectrogram.secondsPerFrame));
      ctx.globalAlpha = 0.55;
      ctx.drawImage(spectrogram.image, 0, 0, spectrogram.frames, spectrogram.image.height, x0, top + 2, Math.max(1, x1 - x0), NAV_H - 3);
      ctx.globalAlpha = 1;
    }
    // bookmarks
    for (const bookmark of this.editor.bookmarks) {
      ctx.fillStyle = `rgb(${bookmark.color.map((v) => Math.round(v * 255)).join(',')})`;
      ctx.fillRect(Math.round(nav.toX(bookmark.beat)), top + 2, 2, NAV_H - 4);
    }
    // the view
    const vx0 = Math.max(GUTTER, nav.x0);
    const vx1 = Math.min(width, Math.max(vx0 + 6, nav.x1));
    ctx.fillStyle = 'rgba(140,170,230,0.16)';
    ctx.fillRect(vx0, top + 2, vx1 - vx0, NAV_H - 4);
    ctx.strokeStyle = this.drag?.kind === 'nav' ? 'rgba(200,215,255,0.95)' : 'rgba(160,180,230,0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(vx0 + 0.5, top + 2.5, vx1 - vx0 - 1, NAV_H - 5);
    ctx.fillStyle = 'rgba(200,215,255,0.85)';
    ctx.fillRect(vx0, top + 2, 3, NAV_H - 4);
    ctx.fillRect(vx1 - 3, top + 2, 3, NAV_H - 4);
    // where the cursor is: red
    const px = nav.toX(this.editor.playhead());
    ctx.fillStyle = '#ff3355';
    ctx.fillRect(Math.round(px) - 1, top + 1, 2, NAV_H - 1);
    ctx.beginPath();
    ctx.moveTo(px - 4, top + 1);
    ctx.lineTo(px + 4, top + 1);
    ctx.lineTo(px, top + 6);
    ctx.fill();
    ctx.fillStyle = '#121318';
    ctx.fillRect(0, top + 1, GUTTER, NAV_H - 1);
  }

  private drawClip(shown: ShownClip, top: number, height: number, ghost = false) {
    const ctx = this.context;
    const clip = shown.clip;
    const { x, y, w, h } = this.clipRect(shown, top, height);
    if (x > this.width || x + w < GUTTER) return;
    if (shown.effect !== undefined) {
      this.drawEffect(shown, x, y, w, h, ghost);
      return;
    }
    const partial = shown.partial;
    const bpm = this.editor.songBpm;
    const gradient = ctx.createLinearGradient(x, 0, x + Math.max(1, w), 0);
    const startColor = this.colorCss(clip.color, 1);
    const endColor = this.colorCss(clip.endColor ?? clip.color, 1);
    const stop = (t: number) => Math.max(0, Math.min(1, t));
    if (clip.startMode === 'fade') {
      // the game's fade: dying out over 1.5 s
      const fadeBeats = (1.5 * bpm) / 60;
      gradient.addColorStop(0, startColor);
      gradient.addColorStop(stop(fadeBeats / Math.max(1e-6, clip.end - clip.start)), this.colorCss(clip.color, 0.08));
      gradient.addColorStop(1, this.colorCss(clip.color, 0.08));
    } else {
      const rise = clip.startMode === 'fadeIn' ? stop(clip.fadeIn / Math.max(1e-6, clip.end - clip.start)) : 0;
      gradient.addColorStop(0, rise > 0 ? this.colorCss(clip.color, 0.08) : startColor);
      if (rise > 0) gradient.addColorStop(rise, startColor);
      gradient.addColorStop(1, clip.endMode === 'fade' ? this.colorCss(clip.endColor ?? clip.color, 0.08) : endColor);
    }
    const background = shown.role === 'background';
    ctx.globalAlpha = ghost ? 0.6 : background ? 0.28 : 1;
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, w, h);
    if (partial) {
      // some lights of the group: striped
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 3;
      for (let sx = x - h; sx < x + w; sx += 9) {
        ctx.beginPath();
        ctx.moveTo(sx, y + h);
        ctx.lineTo(sx + h, y);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (clip.startMode === 'flash' || clip.startMode === 'fade') {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(x, y, Math.min(3, w), h);
    }
    // the end: off (a hard edge) / stays (an arrow on)
    if (clip.endMode === 'stay' && w > 28) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.moveTo(x + w - 7, y + h / 2 - 4);
      ctx.lineTo(x + w - 1, y + h / 2);
      ctx.lineTo(x + w - 7, y + h / 2 + 4);
      ctx.fill();
    }
    if (background) {
      ctx.globalAlpha = 1;
      return;
    }
    ctx.strokeStyle = this.editor.selection.has(clip.id) ? '#ffffff' : 'rgba(0,0,0,0.55)';
    ctx.lineWidth = this.editor.selection.has(clip.id) ? 2 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1);
    if (w > 26 && h >= 12) {
      // (the group's name where it shows on another row; the layer when it isn't the usual)
      const target = clip.target === undefined || shown.role === 'own' ? null : findGroup(this.editor.groups, clip.target)?.group.name ?? null;
      const label = [clip.layer >= 2 ? `L${String(clip.layer)}` : '', w > 70 && target !== null ? target : ''].filter((part) => part !== '').join(' · ');
      if (label !== '') {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w - 8, h);
        ctx.clip();
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(label, x + 5, y + h - 4);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** An effect: one block — inside it, a sketch of its events (a line per item it goes through). */
  private drawEffect(shown: ShownClip, x: number, y: number, w: number, h: number, ghost: boolean) {
    const ctx = this.context;
    const effect = shown.effect!;
    const background = shown.role === 'background';
    ctx.save();
    ctx.globalAlpha = ghost ? 0.6 : background ? 0.3 : 1;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#14151b';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = this.colorCss(effect.params.color, 0.1);
    ctx.fillRect(x, y, w, h);
    const children = ghost ? (this.ghostChildren ?? []) : this.editor.effectChildren(effect.id);
    const slots = Math.max(1, ...children.map((child) => (child.slot ?? 0) + 1));
    const laneH = Math.max(1, (h - 4) / slots);
    for (const child of children) {
      const cx = this.beatToX(child.start);
      const cw = Math.max(1.5, (child.end - child.start) * this.pxPerBeat);
      if (cx > this.width || cx + cw < x) continue;
      const slot = child.slot ?? 0;
      const ly = slot < 0 ? y + 2 : Math.floor(y + 2 + slot * laneH);
      const lh = slot < 0 ? h - 4 : Math.max(1.5, Math.round(laneH - (laneH > 3 ? 1 : 0)));
      const fades = child.endMode === 'fade';
      if (fades) {
        const gradient = ctx.createLinearGradient(cx, 0, cx + cw, 0);
        gradient.addColorStop(0, this.colorCss(child.color, 1));
        gradient.addColorStop(1, this.colorCss(child.color, 0.1));
        ctx.fillStyle = gradient;
      } else ctx.fillStyle = this.colorCss(child.color, 1);
      ctx.fillRect(cx, ly, cw, lh);
    }
    ctx.restore();
    if (background) return;
    ctx.globalAlpha = ghost ? 0.6 : 1;
    const selected = this.editor.selection.has(effect.id);
    ctx.strokeStyle = selected ? '#ffffff' : this.colorCss(effect.params.color, 0.9);
    ctx.lineWidth = selected ? 2 : 1.2;
    ctx.setLineDash(effect.custom === true ? [4, 3] : []);
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1);
    ctx.setLineDash([]);
    if (w > 40 && h >= 12) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w - 4, h);
      ctx.clip();
      ctx.font = '600 10px system-ui, sans-serif';
      const label = `${effect.custom === true ? '✎ ' : '≋ '}${effect.name}`;
      const tw = ctx.measureText(label).width;
      // (the name sits at the bottom right, where a forward wave has already passed)
      const lx = Math.max(x + 3, x + w - tw - 9);
      ctx.fillStyle = 'rgba(10,11,15,0.8)';
      ctx.fillRect(lx, y + h - 14, tw + 6, 12);
      ctx.fillStyle = '#e8ebf2';
      ctx.fillText(label, lx + 3, y + h - 4);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /** The blocks a ring poses row shows (turns or zooms). */
  private blocksOf(row: Extract<Row, { kind: 'poses' }>) {
    return this.editor.ringBlocks.filter((block) => isZoom(block) === (row.ring === 'zoom'));
  }

  /** A new block for a ring poses row. */
  private newBlockFor(row: Extract<Row, { kind: 'poses' }>, start: number, end: number) {
    const editor = this.editor;
    if (row.ring === 'zoom') return newZoomBlock(editor.zoomInfo[0], start, end, editor.zoomInfo.length > 1 ? (editor.zoomInfo[0]?.name ?? '') : '');
    // (rings drawn from geometry only turn ring by ring)
    const system = editor.ringInfo.find((item) => editor.geometryRings.has(item.name))?.name ?? editor.ringInfo[0]?.name ?? '';
    return newRingBlock(system, editor.geometryRings.has(system) ? 'tracks' : 'event', start, end);
  }

  /** A ring pose block: its poses as small rings at their times (a line out to where the turn ends);
   *  a zoom block: each pose's spacing as bars that close in or spread out. */
  private drawRingBlock(block: RingBlock, top: number, height: number) {
    const ctx = this.context;
    const x = this.beatToX(block.start);
    const w = (block.end - block.start) * this.pxPerBeat;
    if (x > this.width || x + w < GUTTER) return;
    const y = top + 3;
    const h = height - 6;
    const selected = this.editor.selection.has(block.id);
    const hue = isZoom(block) ? 190 : block.mode === 'tracks' ? 275 : 300;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = `hsl(${String(hue)} 35% 17%)`;
    ctx.fillRect(x, y, w, h);
    const cy = y + h / 2;
    const r = Math.max(3, Math.min(8, h / 2 - 3));
    const rings = this.editor.ringInfo.find((system) => system.name === block.system)?.rings ?? this.editor.ringInfo[0]?.rings ?? 1;
    const zoom = isZoom(block);
    const widest = Math.max(1e-3, ...block.poses.map((pose) => Math.abs(pose.step)));
    for (const pose of block.poses) {
      if (pose.beat > block.end - block.start + 1e-6) continue;
      const px = this.beatToX(block.start + pose.beat);
      if (zoom) {
        // (bars a pose's spacing apart: wider — the rings further from each other)
        const gap = 1.5 + (Math.abs(pose.step) / widest) * 5;
        ctx.fillStyle = `hsla(${String(hue)} 70% 65% / 0.35)`;
        ctx.fillRect(px, cy - 1, Math.max(0, pose.duration * this.pxPerBeat), 2);
        ctx.fillStyle = `hsl(${String(hue)} 75% 72%)`;
        for (let k = 0; k < 4; k++) ctx.fillRect(px + k * gap, cy - r, 1.5, r * 2);
        continue;
      }
      const span = (pose.duration + ringDelay(pose, pose.reverse ? 0 : rings - 1, rings)) * this.pxPerBeat;
      ctx.fillStyle = `hsla(${String(hue)} 70% 65% / 0.35)`;
      ctx.fillRect(px, cy - 1, Math.max(0, span), 2);
      ctx.strokeStyle = `hsl(${String(hue)} 75% 72%)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      const angle = (pose.angle * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(px, cy);
      ctx.lineTo(px - Math.sin(angle) * r, cy - Math.cos(angle) * r);
      ctx.stroke();
    }
    if (w > 60 && h >= 12) {
      ctx.font = '600 10px system-ui, sans-serif';
      const label = `${isZoom(block) ? '⇹' : '◎'} ${block.name}${!isZoom(block) && block.mode === 'tracks' ? ' · по кольцам' : ''}`;
      const tw = ctx.measureText(label).width;
      const lx = Math.max(x + 3, x + w - tw - 9);
      ctx.fillStyle = 'rgba(10,11,15,0.8)';
      ctx.fillRect(lx, y + h - 13, tw + 6, 12);
      ctx.fillStyle = '#e8ebf2';
      ctx.fillText(label, lx + 3, y + h - 3);
    }
    ctx.restore();
    ctx.strokeStyle = selected ? '#ffffff' : `hsl(${String(hue)} 60% 60%)`;
    ctx.lineWidth = selected ? 2 : 1.2;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1);
  }

  /** The events of the effect being drawn (for its ghost). */
  private ghostChildren: LightClip[] | null = null;

  private drawRaw(row: Extract<Row, { kind: 'raw' }>, top: number, height: number) {
    const ctx = this.context;
    const events = this.visibleRaw(row.type);
    const hue = row.type === 8 ? 300 : row.type === 9 ? 190 : row.type === 5 ? 45 : 140;
    if (row.type === RING_EVENT_TYPE || row.type === ZOOM_EVENT_TYPE) {
      // (the ring events the ring poses make: hollow — they belong to their blocks)
      ctx.strokeStyle = `hsl(${String(hue)} 70% 65%)`;
      ctx.lineWidth = 1.2;
      for (const event of this.editor.poseEvents()) {
        if (event.type !== row.type) continue;
        const x = this.beatToX(event.beat);
        if (x < -10 || x > this.width + 10) continue;
        const cy = top + height / 2;
        ctx.beginPath();
        ctx.moveTo(x, cy - 5);
        ctx.lineTo(x + 4, cy);
        ctx.lineTo(x, cy + 5);
        ctx.lineTo(x - 4, cy);
        ctx.closePath();
        ctx.stroke();
      }
    }
    for (const event of events) {
      const x = this.beatToX(event.beat);
      if (x < -10 || x > this.width + 10) continue;
      const selected = this.editor.selection.has(event.id);
      ctx.fillStyle = selected ? '#ffffff' : `hsl(${String(hue)} 70% 60%)`;
      const cy = top + height / 2;
      ctx.beginPath();
      ctx.moveTo(x, cy - 6);
      ctx.lineTo(x + 5, cy);
      ctx.lineTo(x, cy + 6);
      ctx.lineTo(x - 5, cy);
      ctx.fill();
    }
  }

  private drawSpectrogram(top: number, height: number) {
    const ctx = this.context;
    if (height <= 0) {
      ctx.fillStyle = this.drag?.kind === 'spectro' ? '#6f7588' : '#2a2c34';
      ctx.fillRect(0, top - 1, this.width, 2);
      return;
    }
    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(0, top, this.width, height);
    const spectrogram = this.editor.spectrogram;
    if (spectrogram !== null) {
      const look = this.look;
      const key = `${String(look.floor)}|${String(look.contrast)}`;
      if (this.painted.get(spectrogram) !== key) {
        paintSpectrogram(spectrogram, look);
        this.painted.set(spectrogram, key);
      }
      // the stretch of frequencies asked for: rows of the picture (its top is the highest band)
      const b0 = Math.max(-0.5, bandOfHz(spectrogram, look.lowHz));
      const b1 = Math.min(spectrogram.bands - 0.5, bandOfHz(spectrogram, look.highHz));
      const sy = spectrogram.bands - 0.5 - b1;
      const sh = Math.max(0.5, b1 - b0);
      // (chunks of 8 px: each drawn with the time it covers — exact also where the BPM changes)
      for (let x = GUTTER; x < this.width; x += 8) {
        const s0 = this.editor.beatToSeconds(this.xToBeat(x));
        const s1 = this.editor.beatToSeconds(this.xToBeat(x + 8));
        const f0 = s0 / spectrogram.secondsPerFrame;
        const f1 = s1 / spectrogram.secondsPerFrame;
        if (f1 <= 0 || f0 >= spectrogram.frames) continue;
        const a = Math.max(0, f0);
        const b = Math.min(spectrogram.frames, f1);
        const dx = x + ((a - f0) / (f1 - f0)) * 8;
        const dw = ((b - a) / (f1 - f0)) * 8;
        ctx.drawImage(spectrogram.image, a, sy, Math.max(0.01, b - a), sh, dx, top, dw + 0.5, height);
      }
      // frequencies at the left
      if (height >= 46) {
        ctx.font = '10px system-ui, sans-serif';
        let lastY = Infinity;
        for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
          const band = bandOfHz(spectrogram, hz);
          if (band <= b0 || band >= b1) continue;
          const y = top + height - ((band - b0) / (b1 - b0)) * height;
          if (lastY - y < 16 || y < top + 8) continue;
          lastY = y;
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.fillRect(GUTTER, Math.round(y), 6, 1);
          ctx.fillStyle = 'rgba(220,225,240,0.55)';
          ctx.fillText(hzLabel(hz), GUTTER + 8, y + 3);
        }
      }
    } else {
      ctx.fillStyle = '#4b4f5c';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(this.editor.clock === null ? '' : 'Спектрограмма считается…', 12, top + Math.min(height / 2 + 4, height - 3));
    }
    ctx.fillStyle = this.drag?.kind === 'spectro' ? '#6f7588' : '#2a2c34';
    ctx.fillRect(0, top, this.width, this.drag?.kind === 'spectro' ? 2 : 1);
    // bars over it
    const first = Math.floor(this.viewStart);
    const last = Math.ceil(this.viewStart + this.trackWidth / this.pxPerBeat);
    for (let beat = Math.ceil(first / 4) * 4; beat <= last; beat += 4) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(this.beatToX(beat), top, 1, height);
    }
  }

  /** Where the bookmarks' flags are on the ruler (name cut to fit). */
  private bookmarkFlags() {
    const ctx = this.context;
    ctx.font = '600 10px system-ui, sans-serif';
    return [...this.editor.bookmarks]
      .sort((a, b) => a.beat - b.beat)
      .map((bookmark) => {
        let label = bookmark.name;
        while (label.length > 1 && ctx.measureText(label).width > 110) label = label.slice(0, -1);
        if (label !== bookmark.name) label += '…';
        return { bookmark, x: Math.round(this.beatToX(bookmark.beat)), w: ctx.measureText(label).width + 8, label };
      })
      .filter((flag) => flag.x + flag.w > GUTTER && flag.x < this.width);
  }

  /** The bookmark whose flag is under a point of the ruler. */
  private bookmarkAt(x: number, y: number) {
    if (y > 15) return null;
    return [...this.bookmarkFlags()].reverse().find((flag) => x >= flag.x - 3 && x <= flag.x + flag.w)?.bookmark ?? null;
  }

  /** A bookmark at the song's place (asks its name). */
  async addBookmarkHere() {
    const editor = this.editor;
    if (editor.project === null) return;
    const name = await ask('Название метки', `Метка ${String(editor.bookmarks.length + 1)}`);
    if (name !== null) editor.addBookmark(editor.snapBeat(editor.playhead()), name);
  }

  private bookmarkMenu(x: number, y: number, id: string) {
    const editor = this.editor;
    const bookmark = editor.bookmarks.find((item) => item.id === id);
    if (bookmark === undefined) return;
    const colors: [string, [number, number, number]][] = [
      ['Голубая', [0.35, 0.75, 1]],
      ['Оранжевая', [1, 0.55, 0.3]],
      ['Зелёная', [0.5, 1, 0.5]],
      ['Розовая', [1, 0.4, 0.75]],
      ['Жёлтая', [1, 0.9, 0.35]],
      ['Сиреневая', [0.7, 0.55, 1]],
    ];
    showMenu(x, y, [
      { label: bookmark.name, heading: true },
      { label: 'Переименовать…', hint: 'двойной клик', action: () => void ask('Название метки', bookmark.name).then((name) => name !== null && editor.updateBookmark(id, (item) => (item.name = name))) },
      { label: 'Удалить метку', action: () => editor.deleteBookmark(id) },
      null,
      { label: 'Цвет', heading: true },
      ...colors.map(([label, color]) => ({ label, action: () => editor.updateBookmark(id, (item) => (item.color = [...color])) })),
    ]);
  }

  /** What can be done with what is picked: mirrored, copied, deleted. */
  private selectionMenu(x: number, y: number) {
    const editor = this.editor;
    const count = editor.selection.size;
    const clips = editor.selectedClips().length;
    const lanes = editor.selectionLanes();
    showMenu(x, y, [
      { label: `Выделено: ${String(count)}`, heading: true },
      { label: 'Зеркально по строкам', hint: 'первая строка ↔ последняя', disabled: lanes < 2, action: () => {
        const moved = editor.mirrorAcrossRows();
        editor.setStatus(`Отзеркалено по строкам: ${String(moved)} событий`);
      } },
      { label: 'Зеркально во времени', hint: 'начало ↔ конец', disabled: clips + editor.selectedRaw().length === 0, action: () => editor.mirrorInTime() },
      null,
      { label: 'Изменить свет…', hint: 'яркость, оттенок, градиент', disabled: clips === 0, action: () => adjustDialog(editor) },
      { label: 'Выделить по условиям…', action: () => selectByDialog(editor) },
      null,
      { label: 'Копировать', hint: 'Ctrl+C', action: () => editor.copy() },
      { label: 'Дублировать', hint: 'Ctrl+D', action: () => editor.duplicateSelection() },
      { label: `Удалить (${String(count)})`, hint: 'Delete', action: () => editor.deleteSelection() },
    ]);
  }

  /** What can be done with the picked stretch of the song. */
  private rangeMenu(x: number, y: number) {
    const editor = this.editor;
    const range = editor.songRange;
    if (range === null) return;
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    const seconds = editor.beatToSeconds(end) - editor.beatToSeconds(start);
    showMenu(x, y, [
      { label: `Выделено: ${seconds.toFixed(2)} с`, heading: true },
      { label: 'Сделать превью песни', hint: 'Info.dat — сразу', action: () => void editor.previewFromRange() },
      { label: 'Проиграть по кругу', hint: 'Esc — стоп', action: () => editor.startTrial({ clips: [], raw: [], start: start + 0.5, end: end - 1 }) },
      { label: 'Снять выделение', hint: 'Esc', action: () => editor.setSongRange(null) },
      { label: 'Выделить события в нём…', hint: 'по строкам, цвету', action: () => selectByDialog(editor) },
      { label: 'Свет по звуку…', hint: 'удары бочки, малого, хэтов', action: () => soundDialog(editor) },
      { label: 'Глитч колец здесь…', hint: 'скретчи, глюки', disabled: editor.ringInfo.length === 0, action: () => ringGlitchDialog(editor, null) },
      null,
      { label: 'Настройки спектрограммы…', action: () => this.openSpectroPanel(x, y - 200) },
    ]);
  }

  /** Where the grid and speed stand now (under the spectrogram's name or in the overview line). */
  private playPlacedRoomy = true;

  /** The grid and the playback speed (a slider; double click — 1×). */
  private playControls(compact: boolean) {
    const editor = this.editor;
    const box = document.createElement('div');
    box.className = `th-play${compact ? ' compact' : ''}`;
    const grid = document.createElement('select');
    grid.className = 'th-grid';
    grid.title = 'Сетка: к каким долям прилипают события';
    for (const [value, label] of GRIDS) grid.append(Object.assign(document.createElement('option'), { value: String(value), textContent: label }));
    grid.addEventListener('change', () => {
      editor.snap = Number(grid.value);
      this.redraw();
      grid.blur();
    });
    const speed = document.createElement('input');
    speed.type = 'range';
    speed.className = 'th-speed';
    speed.min = String(MIN_RATE);
    speed.max = String(MAX_RATE);
    speed.step = '0.05';
    speed.title = 'Скорость воспроизведения (высота звука меняется вместе с ней). Двойной клик — обычная';
    const value = document.createElement('span');
    value.className = 'th-speed-value';
    speed.addEventListener('input', () => editor.setRate(Number(speed.value)));
    speed.addEventListener('dblclick', () => editor.setRate(1));
    const label = (text: string, ...items: HTMLElement[]) => {
      const wrap = document.createElement('label');
      wrap.append(Object.assign(document.createElement('span'), { className: 'th-play-name', textContent: text }), ...items);
      return wrap;
    };
    box.append(label('Сетка', grid), label(compact ? '' : 'Скорость', speed, value));
    queueMicrotask(() => this.syncPlayControls());
    return box;
  }

  /** The grid and speed controls showing what the editor has. */
  syncPlayControls() {
    const editor = this.editor;
    const grid = this.headers.querySelector<HTMLSelectElement>('.th-grid');
    if (grid !== null && document.activeElement !== grid) {
      const known = GRIDS.find(([value]) => Math.abs(value - editor.snap) < 1e-9);
      grid.value = String(known?.[0] ?? 0.25);
    }
    const speed = this.headers.querySelector<HTMLInputElement>('.th-speed');
    if (speed !== null && document.activeElement !== speed) speed.value = String(editor.rate);
    const value = this.headers.querySelector<HTMLElement>('.th-speed-value');
    if (value !== null) value.textContent = `${String(Math.round(editor.rate * 100) / 100)}×`;
  }

  /** The spectrogram's settings: height, frequencies, level floor, contrast. */
  openSpectroPanel(x: number, y: number) {
    const body = document.createElement('div');
    body.className = 'ce-panel-body';
    const title = document.createElement('div');
    title.className = 'ce-menu-heading';
    title.style.padding = '0';
    title.textContent = 'Спектрограмма';
    const presets = document.createElement('div');
    presets.className = 'ce-panel-buttons';
    for (const [label, height] of [['Скрыть', 0], ['Низкая', 50], ['Средняя', 110], ['Высокая', 200], ['Очень высокая', 320]] as const) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', () => {
        this.setLook({ height });
        sync();
      });
      presets.append(button);
    }
    // (frequencies on a log scale: a slider position 0…1000 ↔ 30 Hz…16 kHz)
    const toHz = (value: number) => DEFAULT_LOOK.lowHz * (DEFAULT_LOOK.highHz / DEFAULT_LOOK.lowHz) ** (value / 1000);
    const fromHz = (hz: number) => (Math.log(hz / DEFAULT_LOOK.lowHz) / Math.log(DEFAULT_LOOK.highHz / DEFAULT_LOOK.lowHz)) * 1000;
    const rows: { input: HTMLInputElement; value: HTMLElement; read: () => number; show: () => string }[] = [];
    const slider = (label: string, min: number, max: number, step: number, read: () => number, show: () => string, write: (value: number) => void, hint: string) => {
      const row = document.createElement('label');
      row.className = 'ce-panel-row';
      row.title = hint;
      const name = document.createElement('span');
      name.textContent = label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      const value = document.createElement('span');
      value.className = 'ce-panel-value';
      input.addEventListener('input', () => {
        write(Number(input.value));
        sync();
      });
      row.append(name, input, value);
      rows.push({ input, value, read, show });
      return row;
    };
    const look = () => this.look;
    body.append(
      title,
      presets,
      slider('Высота', 0, 400, 2, () => look().height, () => `${String(Math.round(look().height))} px`, (value) => this.setLook({ height: value }), 'Высоту можно менять и мышью: тяните верхний край спектрограммы'),
      slider('Частоты от', 0, 1000, 1, () => fromHz(look().lowHz), () => hzLabel(look().lowHz), (value) => this.setLook({ lowHz: Math.min(toHz(value), look().highHz / 1.5) }), 'Нижняя граница показанных частот'),
      slider('до', 0, 1000, 1, () => fromHz(look().highHz), () => hzLabel(look().highHz), (value) => this.setLook({ highHz: Math.max(toHz(value), look().lowHz * 1.5) }), 'Верхняя граница показанных частот'),
      slider('Порог', 0, 0.85, 0.01, () => look().floor, () => `${String(Math.round(look().floor * 100))} %`, (value) => this.setLook({ floor: value }), 'Тихое ниже порога остаётся тёмным: удары и вокал виднее'),
      slider('Контраст', 0.4, 3, 0.05, () => look().contrast, () => look().contrast.toFixed(2), (value) => this.setLook({ contrast: value }), 'Больше — темнее фон и ярче громкие места'),
    );
    const reset = document.createElement('div');
    reset.className = 'ce-panel-buttons';
    const resetButton = document.createElement('button');
    resetButton.textContent = 'Как было';
    resetButton.addEventListener('click', () => {
      this.setLook({ ...DEFAULT_LOOK });
      sync();
    });
    reset.append(resetButton);
    body.append(reset);
    const sync = () => {
      for (const row of rows) {
        if (document.activeElement !== row.input) row.input.value = String(row.read());
        row.value.textContent = row.show();
      }
    };
    sync();
    showPanel(x, y, body);
  }

  // ----- headers -------------------------------------------------------------------------------------

  renderHeaders(force = false) {
    const editor = this.editor;
    const rows = editor.rows;
    const key = `${rows.map((row) => row.key + (row.kind === 'group' || row.kind === 'custom' ? (row.expanded ? '+' : '-') + row.label : '')).join(',')}|${String(editor.pickedLight?.type)}:${String(editor.pickedLight?.id)}|${[...editor.lightSelection].join(',')}|${String(editor.focus)}|${String(editor.project !== null)}`;
    if (!force && key === this.headerKey) return;
    this.headerKey = key;
    const box = this.headers;
    box.replaceChildren();
    box.append(this.headerTools());
    const list = document.createElement('div');
    list.className = 'th-rows';
    list.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) return;
      this.scrollRows(event.deltaY !== 0 ? event.deltaY : event.deltaX);
    }, { passive: false });
    for (const row of rows) list.append(this.headerRow(row));
    const tail = document.createElement('div');
    tail.style.height = '400px';
    list.append(tail);
    const spectro = document.createElement('div');
    spectro.className = 'th-spectro';
    const spectroHeight = this.spectroHeight;
    spectro.style.height = `${String(spectroHeight)}px`;
    spectro.style.display = spectroHeight <= 0 ? 'none' : '';
    if (spectroHeight >= 22) {
      const settings = document.createElement('button');
      settings.textContent = '⚙';
      settings.title = 'Настройки спектрограммы: высота, частоты, яркость';
      settings.addEventListener('click', (event) => {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        this.openSpectroPanel(rect.right + 4, rect.top);
      });
      const head = document.createElement('div');
      head.className = 'th-spectro-head';
      head.append(Object.assign(document.createElement('span'), { textContent: 'Спектрограмма' }), settings);
      spectro.append(head);
    }
    // the grid and the playback speed: under the rows' names (in the overview line when there is no room)
    const roomy = spectroHeight >= PLAY_ROOM;
    this.playPlacedRoomy = roomy;
    if (roomy) spectro.append(this.playControls(false));
    spectro.title = 'Верхний край спектрограммы тянется мышью; ПКМ — настройки';
    spectro.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.openSpectroPanel(event.clientX, event.clientY);
    });
    const nav = document.createElement('div');
    nav.className = 'th-nav';
    nav.style.height = `${String(NAV_H)}px`;
    if (roomy) nav.textContent = 'Вся песня';
    else nav.append(this.playControls(true));
    if (spectroHeight <= 0) {
      // (the spectrogram hidden: brought back from here)
      const show = document.createElement('button');
      show.className = 'th-tool';
      show.textContent = '▴ спектр.';
      show.title = 'Показать спектрограмму (её настройки — ПКМ здесь)';
      show.style.cssText = 'float:right;margin-top:-3px;padding:0 6px;font-size:11px';
      show.addEventListener('click', () => this.setLook({ height: DEFAULT_LOOK.height }));
      nav.append(show);
    }
    nav.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.openSpectroPanel(event.clientX, event.clientY - 220);
    });
    nav.title = 'Обзор песни: тяните рамку, чтобы листать, её края — чтобы менять масштаб; клик — перейти туда. Красная черта — курсор';
    box.append(list, spectro, nav);
    this.needsDraw = true;
  }

  /** Over the row names: going back out of a group, or making groups. */
  private headerTools() {
    const editor = this.editor;
    const tools = document.createElement('div');
    tools.className = 'th-ruler';
    tools.style.height = `${String(RULER_H)}px`;
    const button = (label: string, title: string, action: (event: MouseEvent) => void, disabled = false) => {
      const item = document.createElement('button');
      item.className = 'th-tool';
      item.textContent = label;
      item.title = title;
      item.disabled = disabled;
      item.addEventListener('click', action);
      return item;
    };
    if (editor.focus !== null) {
      tools.append(button('◂', 'Выйти из группы (Esc)', () => editor.enterGroup(null)));
      const path = editor.focusPath();
      path.forEach((group, index) => {
        const crumb = document.createElement('button');
        crumb.className = `th-crumb${index === path.length - 1 ? ' current' : ''}`;
        crumb.textContent = group.name;
        crumb.title = group.name;
        crumb.addEventListener('click', () => editor.enterGroup(group.id));
        if (index > 0) tools.append(Object.assign(document.createElement('span'), { className: 'th-crumb-sep', textContent: '›' }));
        tools.append(crumb);
      });
      return tools;
    }
    const count = editor.lightSelection.size;
    tools.append(
      button(count > 0 ? `＋ Группа (${String(count)})` : '＋ Группа', 'Сгруппировать выбранные light ID (Ctrl+G). Выбирайте их в строках ламп или на мини-карте', () => void this.groupSelected(), count === 0 || editor.project === null),
    );
    tools.append(
      button('Шаблоны ▾', 'Готовые группы: кольца, лазеры парами, лампы по порядку', (event) => {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        showMenu(rect.left, rect.bottom + 2, this.templateMenu());
      }, editor.project === null),
    );
    return tools;
  }

  /** The templates menu: ring groups, laser pairs, lights in order. */
  private templateMenu(): MenuItem[] {
    const editor = this.editor;
    const items: MenuItem[] = [];
    const types = [...editor.lightsByType.keys()].sort((a, b) => a - b);
    for (const type of editor.ringTypes()) {
      items.push({ label: `Кольца — ${lightGroupName(type)}`, heading: true });
      items.push({ label: 'По кольцам', hint: 'одно событие — одно кольцо', action: () => editor.ringPreset(type, 'rings') });
      items.push({ label: 'По линиям', hint: 'одно событие — одна линия', action: () => editor.ringPreset(type, 'lines') });
    }
    const moving = editor.movingLasers();
    if (moving.left.length + moving.right.length > 0) {
      items.push({ label: `Подвижные лазеры (${String(moving.left.length + moving.right.length)})`, heading: true });
      items.push({ label: 'По сторонам', hint: 'только вращающиеся: левые, правые', action: () => editor.movingLasersPreset('sides') });
      items.push({ label: 'Парами', hint: 'ближний левый с ближним правым…', action: () => editor.movingLasersPreset('pairs') });
    }
    if (types.includes(2) && types.includes(3)) {
      items.push({ label: 'Левые + правые лазеры', heading: true });
      items.push({ label: 'Парами', hint: 'ближний левый с ближним правым…', action: () => editor.laserPreset('pairs', 2, 3) });
      items.push({ label: 'По сторонам', hint: 'левые, потом правые', action: () => editor.laserPreset('sides', 2, 3) });
    }
    if (types.includes(0)) {
      items.push({ label: lightGroupName(0), heading: true });
      items.push({ label: 'Зеркальными парами', hint: 'левая и правая половины', action: () => editor.laserPreset('pairs', 0, null) });
      items.push({ label: 'По сторонам', action: () => editor.laserPreset('sides', 0, null) });
    }
    const replaced = editor.replacedTypes();
    const removed = editor.removedTypes();
    if (replaced.size > 0 || removed.length > 0) {
      items.push({ label: 'Скрытые строки', heading: true });
      for (const [type, id] of replaced) items.push({ label: `Вернуть «${lightGroupName(type)}»`, hint: `вместо неё — «${findGroup(editor.groups, id)?.group.name ?? ''}»`, action: () => editor.restoreType(type) });
      for (const type of removed) items.push({ label: `Вернуть «${lightGroupName(type)}»`, hint: 'удалена', action: () => editor.bringBackType(type) });
    }
    items.push({ label: 'Лампы одной группы по порядку', heading: true });
    for (const type of types) {
      items.push({ label: `${lightGroupName(type)}: слева направо`, action: () => editor.orderedPreset(type, 'x') });
      items.push({ label: `${lightGroupName(type)}: от ближних к дальним`, action: () => editor.orderedPreset(type, 'z') });
    }
    return items;
  }

  async groupSelected() {
    const editor = this.editor;
    if (editor.lightSelection.size === 0) return;
    const name = await ask('Название группы', `Группа ${String(editor.groups.length + 1)}`);
    if (name !== null) editor.groupSelectedLights(name);
  }

  private headerRow(row: Row) {
    const editor = this.editor;
    const item = document.createElement('div');
    item.className = `th-row th-${row.kind}`;
    item.style.height = `${String(this.rowHeight(row))}px`;
    if (this.rowScale < 0.85) item.classList.add('compact');
    item.style.paddingLeft = `${String(8 + row.depth * 14 + (row.kind === 'light' ? 22 : 0))}px`;
    item.dataset.key = row.key;
    const toggle = (expanded: boolean, enabled: boolean, title: string, act: () => void) => {
      const button = document.createElement('button');
      button.className = 'th-toggle';
      button.textContent = expanded ? '▾' : '▸';
      button.title = title;
      button.disabled = !enabled;
      button.addEventListener('mousedown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        act();
      });
      return button;
    };
    const swatch = (hue: number) => {
      const mark = document.createElement('span');
      mark.className = 'th-swatch';
      mark.style.background = `hsl(${String(hue)} 70% 55%)`;
      return mark;
    };
    const text = (value: string, className: string) => {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = value;
      return span;
    };
    if (row.kind === 'group') {
      item.append(
        toggle(row.expanded, row.lights.length > 0, row.expanded ? 'Свернуть' : `Раскрыть (${String(row.lights.length)} light ID)`, () => editor.toggleExpanded(row.type)),
        swatch(groupHue(row.type)),
        text(row.label, 'th-name'),
        text(row.lights.length > 0 ? String(row.lights.length) : '', 'th-count'),
      );
      item.title = 'Клик — выбрать все его лампы, ПКМ — действия';
      item.addEventListener('click', () => {
        if (!this.headerDragged) editor.selectLights(editor.rowLights(row).map((light) => lightKey(light.type, light.id)));
      });
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showMenu(event.clientX, event.clientY, [
          { label: row.expanded ? 'Свернуть' : 'Раскрыть light ID', action: () => editor.toggleExpanded(row.type), disabled: row.lights.length === 0 },
          { label: 'Выбрать все лампы', action: () => editor.selectLights(row.lights.map((id) => lightKey(row.type, id))) },
          { label: 'Группа из всех его ламп', action: () => void ask('Название группы', row.label).then((name) => name !== null && editor.addGroup(name, row.lights.map((id) => ({ kind: 'light', type: row.type, id })))) },
          ...(editor.ringTypes().includes(row.type)
            ? [null, { label: 'Группа по кольцам', hint: 'одно событие — одно кольцо', action: () => editor.ringPreset(row.type, 'rings') }, { label: 'Группа по линиям', hint: 'одно событие — одна линия', action: () => editor.ringPreset(row.type, 'lines') }]
            : []),
          null,
          { label: 'Свет по звуку…', hint: 'удары бочки, малого, хэтов', action: () => soundDialog(editor, row) },
          null,
          { label: 'Удалить строку', hint: 'вернуть — в «Шаблонах»', action: () => {
            if (window.confirm(`Убрать строку «${row.label}» с таймлайна? Её события останутся в карте (видны в группах с её лампами); вернуть строку можно в меню «Шаблоны» → «Скрытые строки».`)) editor.removeType(row.type);
          } },
        ]);
      });
    } else if (row.kind === 'custom') {
      const group = row.group;
      const lights = groupLights(group);
      const enter = document.createElement('button');
      enter.className = 'th-enter';
      enter.textContent = '⤵';
      enter.title = 'Войти в группу (двойной клик)';
      enter.addEventListener('mousedown', (event) => event.stopPropagation());
      enter.addEventListener('click', (event) => {
        event.stopPropagation();
        editor.enterGroup(group.id);
      });
      item.append(
        toggle(row.expanded, group.items.length > 0, row.expanded ? 'Свернуть' : 'Раскрыть', () => editor.toggleGroupExpanded(group.id)),
        swatch(customHue(group.name)),
        text(row.label, 'th-name'),
        text(String(lights.length), 'th-count'),
      );
      if (editor.focus !== group.id) item.append(enter);
      item.title = `${group.name}: ${String(lights.length)} ламп. Клик — выбрать его лампы, двойной — войти, ПКМ — действия`;
      item.addEventListener('click', () => {
        if (!this.headerDragged) editor.selectLights(lights.map((light) => lightKey(light.type, light.id)), 'replace', row.parent);
      });
      item.addEventListener('dblclick', () => editor.enterGroup(group.id));
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.groupMenu(event.clientX, event.clientY, row);
      });
    } else if (row.kind === 'light') {
      item.textContent = row.label;
      const key = lightKey(row.type, row.id);
      if (editor.lightSelection.has(key)) item.classList.add('selected');
      if (editor.pickedLight?.type === row.type && editor.pickedLight.id === row.id) item.classList.add('picked');
      item.title = 'Клик — выбрать лампу (Ctrl — добавить, Shift — диапазон), ПКМ — действия';
      item.addEventListener('click', (event) => {
        if (this.headerDragged) return;
        if (event.shiftKey && this.lastLightRow !== null) {
          const lightRows = editor.rows.filter((other): other is Extract<Row, { kind: 'light' }> => other.kind === 'light');
          const a = lightRows.findIndex((other) => other.key === this.lastLightRow);
          const b = lightRows.findIndex((other) => other.key === row.key);
          if (a >= 0 && b >= 0) {
            const range = lightRows.slice(Math.min(a, b), Math.max(a, b) + 1).map((other) => lightKey(other.type, other.id));
            editor.selectLights(range, 'add', row.parent);
          }
        } else {
          editor.selectLights([key], event.ctrlKey || event.metaKey ? 'toggle' : 'replace', row.parent);
          this.lastLightRow = row.key;
        }
        editor.pickLight(row.type, row.id);
      });
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (!editor.lightSelection.has(key)) editor.selectLights([key], 'replace', row.parent);
        const picked = editor.selectedLights();
        const groups = editor.groups;
        const addTo: MenuItem[] = [];
        const walk = (list: typeof groups, depth: number) => {
          for (const group of list) {
            addTo.push({ label: `${'  '.repeat(depth)}${group.name}`, action: () => editor.addLightsToGroup(group.id, picked) });
            walk(group.items.filter((child): child is (typeof groups)[number] => child.kind === 'group'), depth + 1);
          }
        };
        walk(groups, 0);
        showMenu(event.clientX, event.clientY, [
          { label: `Сгруппировать выбранные (${String(picked.length)})`, hint: 'Ctrl+G', action: () => void this.groupSelected() },
          ...(row.parent !== null ? [{ label: 'Убрать из группы', action: () => editor.removeLightsFromGroup(row.parent!, picked) }] : []),
          ...(addTo.length > 0 ? [null, { label: 'Добавить в группу', heading: true }, ...addTo] : []),
        ]);
      });
    } else if (row.kind === 'poses') {
      item.textContent = `${row.ring === 'zoom' ? '⇹' : '◎'} ${row.label}`;
      item.title = row.ring === 'zoom' ? 'Зум колец: протяните по строке, чтобы сделать блок; двойной клик по блоку — редактор расстояний между кольцами' : 'Точные позы колец: протяните по строке, чтобы сделать блок; двойной клик по блоку — редактор поз';
    } else {
      item.textContent = row.label;
    }
    // the lights and subgroups of a user's group, and the top rows of lights: dragged into another order
    const top = editor.focus === null && row.depth === 0 && (row.kind === 'group' || row.kind === 'custom');
    if (top) item.classList.add('th-draggable');
    if (((row.kind === 'light' || row.kind === 'custom') && row.parent !== null) || top) {
      item.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        this.headerDrag = { row, startY: event.clientY, active: false };
        this.headerDragged = false;
      });
    }
    return item;
  }

  private headerDrag: { row: Extract<Row, { kind: 'light' | 'custom' | 'group' }>; startY: number; active: boolean } | null = null;
  private headerDragged = false;
  private lastLightRow: string | null = null;

  /** Where a dragged row would go: the gap among its siblings nearest the mouse. */
  private headerDropTarget(clientY: number): { parent: string; from: number; to: number; y: number; top?: boolean } | null {
    const drag = this.headerDrag;
    if (drag === null) return null;
    if (drag.row.depth === 0 && (drag.row.kind === 'group' || (drag.row.kind === 'custom' && drag.row.parent === null))) return this.topDropTarget(clientY, drag.row.key);
    const dragged = drag.row;
    if (dragged.kind === 'group' || dragged.parent === null) return null;
    const parentId = dragged.parent;
    const parent = findGroup(this.editor.groups, parentId)?.group;
    if (parent === undefined) return null;
    const indexOf = (row: Row) => parent.items.findIndex((item) => (row.kind === 'custom' ? item.kind === 'group' && item.id === row.group.id : row.kind === 'light' && item.kind === 'light' && item.type === row.type && item.id === row.id));
    const from = indexOf(dragged);
    const list = this.headers.querySelector<HTMLElement>('.th-rows');
    if (from < 0 || list === null) return null;
    const siblings = this.editor.rows.filter((row) => (row.kind === 'light' || row.kind === 'custom') && row.parent === parentId);
    const listRect = list.getBoundingClientRect();
    let best: { to: number; y: number; d: number } | null = null;
    for (const row of siblings) {
      const element = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(row.key)}"]`);
      if (element === null) continue;
      const rect = element.getBoundingClientRect();
      const index = indexOf(row);
      // (a subgroup that is opened up: its rows below it belong to it)
      let bottom = rect.bottom;
      if (row.kind === 'custom' && row.expanded) {
        const at = this.editor.rows.indexOf(row);
        for (let i = at + 1; i < this.editor.rows.length && this.editor.rows[i]!.depth > row.depth; i++) {
          const inner = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(this.editor.rows[i]!.key)}"]`);
          if (inner !== null) bottom = inner.getBoundingClientRect().bottom;
        }
      }
      for (const [edge, to] of [[rect.top, index], [bottom, index + 1]] as const) {
        const d = Math.abs(clientY - edge);
        if (best === null || d < best.d) best = { to, y: edge - listRect.top, d };
      }
    }
    return best === null ? null : { parent: parentId, from, to: best.to, y: best.y };
  }

  /** Where a dragged top row would go: the gap among the top rows nearest the mouse (a top row with
   *  everything opened up under it counts as one). */
  private topDropTarget(clientY: number, key: string): { parent: string; from: number; to: number; y: number; top: true } | null {
    const list = this.headers.querySelector<HTMLElement>('.th-rows');
    const keys = this.editor.topRowKeys();
    const from = keys.indexOf(key);
    if (list === null || from < 0) return null;
    const listRect = list.getBoundingClientRect();
    const rows = this.editor.rows;
    let best: { to: number; y: number; d: number } | null = null;
    keys.forEach((topKey, index) => {
      const element = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(topKey)}"]`);
      if (element === null) return;
      const rect = element.getBoundingClientRect();
      let bottom = rect.bottom;
      const at = rows.findIndex((row) => row.key === topKey);
      for (let i = at + 1; i < rows.length && rows[i]!.depth > 0; i++) {
        const inner = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(rows[i]!.key)}"]`);
        if (inner !== null) bottom = inner.getBoundingClientRect().bottom;
      }
      for (const [edge, to] of [[rect.top, index], [bottom, index + 1]] as const) {
        const d = Math.abs(clientY - edge);
        if (best === null || d < best.d) best = { to, y: edge - listRect.top, d };
      }
    });
    return best === null ? null : { parent: '', from, to: (best as { to: number }).to, y: (best as { y: number }).y, top: true };
  }

  private groupMenu(x: number, y: number, row: Extract<Row, { kind: 'custom' }>) {
    const editor = this.editor;
    const group = row.group;
    const picked = editor.selectedLights();
    showMenu(x, y, [
      { label: 'Войти в группу', action: () => editor.enterGroup(group.id), disabled: editor.focus === group.id },
      { label: 'Переименовать…', action: () => void ask('Новое название', group.name).then((name) => name !== null && editor.renameGroup(group.id, name)) },
      { label: 'Выбрать её лампы', action: () => editor.selectLights(groupLights(group).map((light) => lightKey(light.type, light.id)), 'replace', group.id) },
      group.takesLights === true
        ? { label: 'Вернуть лампы в строки окружения', hint: 'они снова и там', action: () => editor.setTakesLights(group.id, false) }
        : { label: 'Забрать лампы из строк окружения', hint: 'там останутся остальные', action: () => editor.setTakesLights(group.id, true) },
      { label: 'Свет по звуку…', hint: 'удары бочки, малого, хэтов', action: () => soundDialog(editor, row) },
      null,
      { label: 'Сортировать', heading: true },
      ...SORTS.map(([key, label]) => ({ label, action: () => editor.sortGroup(group.id, key) })),
      null,
      { label: `Добавить выбранные лампы (${String(picked.length)})`, action: () => editor.addLightsToGroup(group.id, picked), disabled: picked.length === 0 },
      { label: `Убрать выбранные лампы`, action: () => editor.removeLightsFromGroup(group.id, picked), disabled: picked.length === 0 },
      { label: 'Подгруппа из выбранных', hint: 'Ctrl+G', action: () => void this.groupSelected(), disabled: picked.length === 0 },
      null,
      ...[...editor.replacedTypes()].filter(([, id]) => id === group.id).map(([type]) => ({ label: `Вернуть строку «${lightGroupName(type)}»`, hint: 'группа стоит вместо неё', action: () => editor.restoreType(type) })),
      ...(row.parent !== null ? [{ label: 'Разгруппировать', hint: 'лампы — в группу выше', action: () => editor.deleteGroup(group.id, true) }] : []),
      { label: 'Удалить группу', hint: 'события останутся на лампах', action: () => {
        if (window.confirm(`Удалить группу «${group.name}»? Её события останутся на тех же лампах.`)) editor.deleteGroup(group.id, false);
      } },
    ]);
  }

  // ----- mouse ---------------------------------------------------------------------------------------------

  private bindMouse() {
    const canvas = this.canvas;
    const local = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (this.editor.project === null) return;
      const { x, y } = local(event);
      if (!(y < RULER_H || (y >= this.rowsBottom && y < this.navTop))) {
        const hit = this.hit(x, y);
        if (hit !== null && this.editor.selection.has(hitId(hit))) this.selectionMenu(event.clientX, event.clientY);
        return;
      }
      const beat = this.xToBeat(x);
      const flag = y < RULER_H ? this.bookmarkAt(x, y) : null;
      if (flag !== null) {
        this.bookmarkMenu(event.clientX, event.clientY, flag.id);
        return;
      }
      const range = this.editor.songRange;
      if (range !== null && beat >= Math.min(range.start, range.end) && beat <= Math.max(range.start, range.end)) this.rangeMenu(event.clientX, event.clientY);
      else if (y >= this.rowsBottom) this.openSpectroPanel(event.clientX, event.clientY - 200);
    });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const { x, y } = local(event);
      if ((event.ctrlKey || event.metaKey) && event.altKey) {
        // Ctrl+Alt+wheel: the rows taller / shorter
        this.zoomRows(this.rowScale * Math.exp(-event.deltaY * 0.0015), Math.max(this.rowsTop, Math.min(this.rowsBottom, y)));
      } else if (event.ctrlKey || event.metaKey) {
        const beat = this.xToBeat(x);
        this.pxPerBeat = Math.min(800, Math.max(0.5, this.pxPerBeat * Math.exp(-event.deltaY * 0.0015)));
        this.viewStart = beat - (x - GUTTER) / this.pxPerBeat;
        this.followPlayhead = false;
      } else if (event.altKey || event.shiftKey || x < GUTTER) {
        // (Shift+wheel comes as a sideways wheel on some systems)
        this.scrollRows(event.deltaY !== 0 ? event.deltaY : event.deltaX);
      } else {
        this.viewStart += ((event.deltaX !== 0 ? event.deltaX : event.deltaY) / this.pxPerBeat) * 0.9;
        this.followPlayhead = false;
      }
      this.needsDraw = true;
    }, { passive: false });

    canvas.addEventListener('mousedown', (event) => {
      if (this.editor.project === null) return;
      const { x, y } = local(event);
      const beat = this.xToBeat(x);
      if (x < GUTTER && y >= this.rowsTop && y < this.rowsBottom) {
        // the row scrollbar: its grips zoom the rows, its thumb scrolls, a click beside it jumps
        const bar = this.vbar();
        if (y >= bar.thumbTop && y < bar.thumbTop + GRIP) this.drag = { kind: 'rowZoom', edge: 'top', grabY: y, thumb: bar.thumb, scale: this.rowScale, scrollY: this.scrollY };
        else if (y > bar.thumbTop + bar.thumb - GRIP && y <= bar.thumbTop + bar.thumb) this.drag = { kind: 'rowZoom', edge: 'bottom', grabY: y, thumb: bar.thumb, scale: this.rowScale, scrollY: this.scrollY };
        else {
          if ((y < bar.thumbTop || y > bar.thumbTop + bar.thumb) && this.maxScroll() > 0) {
            this.scrollY = Math.min(this.maxScroll(), Math.max(0, ((y - this.rowsTop - bar.thumb / 2) / Math.max(1, bar.visible - bar.thumb)) * this.maxScroll()));
          }
          this.drag = { kind: 'scroll', grabY: y, scrollY: this.scrollY };
        }
        this.needsDraw = true;
        return;
      }
      if (this.onSpectroEdge(x, y) && event.button === 0) {
        this.drag = { kind: 'spectro', grabY: y, height: this.spectroHeight };
        this.needsDraw = true;
        return;
      }
      const onSong = y < RULER_H || (y >= this.rowsBottom && y < this.navTop);
      // (right click there: a menu — opened on contextmenu, below, or this click would close it)
      if (onSong && event.button === 2) return;
      const flag = y < RULER_H && event.button === 0 ? this.bookmarkAt(x, y) : null;
      if (flag !== null) {
        this.editor.checkpoint();
        this.drag = { kind: 'bookmark', id: flag.id, grab: beat, origin: flag.beat, moved: false };
        return;
      }
      if (onSong && event.shiftKey && event.button === 0) {
        // Shift + drag over the ruler or the spectrogram: a stretch of the song
        const from = this.editor.snapBeat(Math.max(0, beat));
        this.drag = { kind: 'range', from };
        this.editor.setSongRange({ start: from, end: from });
        return;
      }
      if (y >= this.navTop) {
        // the song overview: drag the view (its ends: zoom), click elsewhere: go there
        const nav = this.nav();
        const x0 = Math.max(GUTTER, nav.x0);
        const x1 = Math.max(x0 + 6, nav.x1);
        let part: 'body' | 'left' | 'right';
        if (Math.abs(x - x0) <= 5) part = 'left';
        else if (Math.abs(x - x1) <= 5) part = 'right';
        else if (x > x0 && x < x1) part = 'body';
        else {
          const visibleBeats = this.trackWidth / this.pxPerBeat;
          this.viewStart = nav.toBeat(x) - visibleBeats / 2;
          part = 'body';
        }
        this.followPlayhead = false;
        this.drag = { kind: 'nav', part, grabX: x, viewStart: this.viewStart, pxPerBeat: this.pxPerBeat };
        this.needsDraw = true;
        return;
      }
      if (y < RULER_H || y >= this.rowsBottom) {
        this.drag = { kind: 'seek' };
        this.editor.seek(Math.max(0, beat));
        this.followPlayhead = true;
        return;
      }
      const hit = this.hit(x, y);
      const under = this.rowAt(y);
      if (under !== null && isLightRow(under.row)) this.editor.setActiveRow(under.row.key);
      if (event.button === 2) {
        // right click: on something picked — a menu (opened on contextmenu: a menu opened here would
        // close at once); on anything else — deleted
        if (hit !== null && this.editor.selection.has(hitId(hit))) return;
        if (hit !== null) {
          this.editor.select([hitId(hit)]);
          this.editor.deleteSelection();
        }
        return;
      }
      if (hit === null) {
        const item = this.rowAt(y);
        if (event.shiftKey || event.ctrlKey || event.metaKey || item === null) {
          this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, additive: event.shiftKey || event.ctrlKey || event.metaKey };
          return;
        }
        if (item.row.kind === 'raw') {
          // a marker for the other events (ring turns, zoom, laser speed…): placed by a click
          const project = this.editor.project;
          if (project === null) return;
          this.editor.checkpoint();
          const raw: RawEvent = { id: newId('r'), beat: this.editor.snapBeat(beat), type: item.row.type, value: item.row.type === 5 ? 1 : 0, floatValue: 1 };
          project.raw.push(raw);
          this.editor.selection = new Set([raw.id]);
          this.editor.changed();
          return;
        }
        const from = this.editor.snapBeat(beat);
        this.drag = { kind: 'create', row: item.row, from, to: from, x0: x, moved: false };
        this.needsDraw = true;
        return;
      }
      const id = hitId(hit);
      if (event.shiftKey || event.ctrlKey || event.metaKey) this.editor.select([id], 'toggle');
      else if (!this.editor.selection.has(id)) this.editor.select([id]);
      const edged = 'clip' in hit ? { edge: hit.edge, start: hit.clip.start, end: hit.clip.end } : 'block' in hit ? { edge: hit.edge, start: hit.block.start, end: hit.block.end } : null;
      if (edged !== null && edged.edge !== null) {
        const origin = new Map<string, { start: number; end: number }>();
        for (const clip of this.editor.selectedClips()) origin.set(clip.id, { start: clip.start, end: clip.end });
        this.editor.checkpoint();
        this.drag = { kind: 'resize', edge: edged.edge, origin, effectOrigin: this.effectOrigins(), blockOrigin: this.blockOrigins(true), anchor: edged.edge === 'start' ? edged.start : edged.end };
        return;
      }
      this.editor.checkpoint();
      if (event.altKey) {
        // Alt: drag a copy
        const project = this.editor.project;
        const copies = this.editor.selectedClips().map((clip) => cloneClip(clip));
        const rawCopies = project.raw.filter((event) => this.editor.selection.has(event.id)).map((event) => ({ ...event, id: newId('r') }));
        const effectCopies = this.editor.cloneEffectsInPlace(this.editor.selectedEffects());
        const blockCopies = this.editor.cloneRingBlocksInPlace(this.editor.selectedRingBlocks());
        project.clips.push(...copies);
        project.raw.push(...rawCopies);
        this.editor.selection = new Set([...copies.map((clip) => clip.id), ...rawCopies.map((event) => event.id), ...effectCopies, ...blockCopies]);
      }
      const origin = new Map<string, LightClip>();
      for (const clip of this.editor.selectedClips()) origin.set(clip.id, cloneClip(clip, { id: clip.id }));
      const rawOrigin = new Map<string, number>();
      for (const raw of this.editor.project.raw) if (this.editor.selection.has(raw.id)) rawOrigin.set(raw.id, raw.beat);
      const grabbed = 'clip' in hit ? hit.clip.start : 'block' in hit ? hit.block.start : hit.raw.beat;
      this.drag = { kind: 'move', origin, rawOrigin, effectOrigin: this.effectOrigins(), blockOrigin: this.blockOrigins(false), grabBeat: beat, anchor: grabbed, moved: false, rowKey: hit.row.key };
    });

    canvas.addEventListener('dblclick', (event) => {
      const { x, y } = local(event);
      const flag = y < RULER_H ? this.bookmarkAt(x, y) : null;
      if (flag !== null) {
        void ask('Название метки', flag.name).then((name) => name !== null && this.editor.updateBookmark(flag.id, (item) => (item.name = name)));
        return;
      }
      const hit = this.hit(x, y);
      if (hit !== null && 'block' in hit) {
        // (a block made by "Rings in steps": its simple window; others: the pose editor)
        if (hit.block.steps !== undefined) ringStepsDialog(this.editor, hit.block.id);
        else if (hit.block.glitch !== undefined) ringGlitchDialog(this.editor, hit.block.id);
        else this.editor.ringEditorHook?.(hit.block.id);
        return;
      }
      if (hit === null || !('clip' in hit)) return;
      const effect = this.editor.effectById(hit.clip.id);
      if (effect === undefined) return;
      // (a GLS block opens its own editor; other effects are gone into)
      if (effect.kind === 'gls' && effect.custom !== true && this.editor.glsEditorHook !== null) this.editor.glsEditorHook(effect.id);
      else this.editor.enterEffect(effect.id);
    });

    window.addEventListener('mousemove', (event) => {
      const { x, y } = local(event);
      this.hover = { x, y };
      if (this.headerDrag !== null) {
        this.moveHeaderDrag(event.clientY);
        return;
      }
      const drag = this.drag;
      if (drag === null) {
        let cursor = 'default';
        if (x >= 0 && x <= this.width && y >= 0 && y <= this.height) {
          if (this.onSpectroEdge(x, y)) cursor = 'ns-resize';
          else if (y < RULER_H && this.bookmarkAt(x, y) !== null) cursor = 'grab';
          else if (x < GUTTER && y >= this.rowsTop && y < this.rowsBottom) {
            const bar = this.vbar();
            cursor = (y >= bar.thumbTop && y < bar.thumbTop + GRIP) || (y > bar.thumbTop + bar.thumb - GRIP && y <= bar.thumbTop + bar.thumb) ? 'ns-resize' : 'default';
          } else if (y >= this.navTop) {
            const nav = this.nav();
            const x0 = Math.max(GUTTER, nav.x0);
            const x1 = Math.max(x0 + 6, nav.x1);
            cursor = Math.abs(x - x0) <= 5 || Math.abs(x - x1) <= 5 ? 'ew-resize' : x > x0 && x < x1 ? 'grab' : 'pointer';
          } else {
            const hit = this.hit(x, y);
            cursor = hit !== null && !('raw' in hit) && hit.edge !== null ? 'ew-resize' : hit !== null ? 'grab' : 'default';
          }
        }
        canvas.style.cursor = cursor;
        return;
      }
      const beat = this.xToBeat(x);
      const free = event.altKey && drag.kind !== 'move';
      const snap = (value: number) => (free ? value : this.editor.snapBeat(value));
      if (drag.kind === 'bookmark') {
        if (Math.abs(beat - drag.grab) * this.pxPerBeat > 3) drag.moved = true;
        const to = event.altKey ? drag.origin + beat - drag.grab : this.editor.snapBeat(drag.origin + beat - drag.grab);
        if (drag.moved) this.editor.updateBookmark(drag.id, (item) => (item.beat = Math.max(0, to)), false);
      } else if (drag.kind === 'range') {
        this.editor.setSongRange({ start: drag.from, end: event.altKey ? Math.max(0, beat) : this.editor.snapBeat(Math.max(0, beat)) });
      } else if (drag.kind === 'spectro') {
        const height = Math.round(drag.height - (y - drag.grabY));
        this.setLook({ height: height < 16 ? 0 : Math.min(this.height - NAV_H - RULER_H - 60, height) });
      } else if (drag.kind === 'rowZoom') {
        // the thumb's length follows the grip; the rows grow or shrink to match it
        const length = Math.max(20, drag.thumb + (drag.edge === 'bottom' ? y - drag.grabY : drag.grabY - y));
        this.zoomRows(drag.scale * (drag.thumb / length), drag.edge === 'bottom' ? this.rowsTop : this.rowsBottom);
      } else if (drag.kind === 'nav') {
        const nav = this.nav();
        const perPx = (nav.to - nav.from) / this.trackWidth;
        const delta = (x - drag.grabX) * perPx;
        const viewEnd = drag.viewStart + this.trackWidth / drag.pxPerBeat;
        if (drag.part === 'body') this.viewStart = drag.viewStart + delta;
        else if (drag.part === 'left') {
          const start = Math.min(viewEnd - 2, drag.viewStart + delta);
          this.pxPerBeat = Math.min(800, this.trackWidth / (viewEnd - start));
          this.viewStart = viewEnd - this.trackWidth / this.pxPerBeat;
        } else {
          const end = Math.max(drag.viewStart + 2, viewEnd + delta);
          this.pxPerBeat = Math.min(800, this.trackWidth / (end - drag.viewStart));
          this.viewStart = drag.viewStart;
        }
      } else if (drag.kind === 'scroll') {
        const bar = this.vbar();
        this.scrollY = Math.min(this.maxScroll(), Math.max(0, drag.scrollY + ((y - drag.grabY) / Math.max(1, bar.visible - bar.thumb)) * this.maxScroll()));
      } else if (drag.kind === 'seek') {
        this.editor.seek(Math.max(0, beat));
      } else if (drag.kind === 'create') {
        drag.to = snap(beat);
        if (Math.abs(x - drag.x0) > 4) drag.moved = true;
      } else if (drag.kind === 'box') {
        drag.x1 = x;
        drag.y1 = y;
      } else if (drag.kind === 'resize') {
        const delta = snap(beat) - drag.anchor;
        for (const [id, origin] of drag.effectOrigin) {
          const effect = this.editor.effectById(id);
          if (effect === undefined) continue;
          const min = Math.max(this.editor.snap, 1 / 16);
          if (drag.edge === 'start') this.editor.resizeEffect(effect, origin, Math.min(origin.end - min, origin.start + delta), origin.end);
          else this.editor.resizeEffect(effect, origin, origin.start, Math.max(origin.start + min, origin.end + delta));
        }
        for (const [id, origin] of drag.origin) {
          const clip = this.editor.clipById(id);
          if (clip === undefined) continue;
          const min = Math.max(this.editor.snap, 1 / 64);
          if (drag.edge === 'start') clip.start = Math.min(origin.end - min, origin.start + delta);
          else clip.end = Math.max(origin.start + min, origin.end + delta);
        }
        for (const [id, origin] of drag.blockOrigin) {
          // (a ring pose block: its poses stay where they are in the song)
          const block = this.editor.ringBlockById(id);
          if (block === undefined) continue;
          const min = Math.max(this.editor.snap, 0.25);
          if (drag.edge === 'start') {
            block.start = Math.min(origin.end - min, origin.start + delta);
            for (const pose of block.poses) pose.beat = Math.max(0, (origin.poses.get(pose.id) ?? pose.beat) - (block.start - origin.start));
          } else block.end = Math.max(origin.start + min, origin.end + delta);
        }
        this.editor.changed();
      } else {
        const delta = (event.shiftKey ? this.xToBeat(x) : snap(drag.anchor + (beat - drag.grabBeat))) - drag.anchor;
        if (Math.abs(beat - drag.grabBeat) * this.pxPerBeat > 2) drag.moved = true;
        for (const [id, origin] of drag.origin) {
          const clip = this.editor.clipById(id);
          if (clip === undefined) continue;
          clip.start = origin.start + delta;
          clip.end = origin.end + delta;
        }
        for (const [id, origin] of drag.rawOrigin) {
          const raw = this.editor.rawById(id);
          if (raw !== undefined) raw.beat = origin + delta;
        }
        for (const [id, origin] of drag.effectOrigin) {
          const effect = this.editor.effectById(id);
          if (effect !== undefined) this.editor.moveEffect(effect, origin, delta);
        }
        for (const [id, origin] of drag.blockOrigin) {
          const block = this.editor.ringBlockById(id);
          if (block === undefined) continue;
          block.start = origin.start + delta;
          block.end = origin.end + delta;
        }
        // one effect dragged onto another row: it runs over that row's lights now
        if (drag.effectOrigin.size === 1 && drag.origin.size === 0 && drag.rawOrigin.size === 0) {
          const target = this.rowAt(y)?.row;
          const [[id, origin]] = [...drag.effectOrigin];
          const effect = this.editor.effectById(id!);
          if (effect !== undefined && origin !== undefined && target !== undefined && isLightRow(target)) {
            if (target.key === drag.rowKey) {
              if (effect.target !== origin.target.target || effect.type !== origin.target.type) {
                delete effect.target;
                Object.assign(effect, structuredClone(origin.target));
                this.editor.retargetEffect(effect, target);
              }
            } else this.editor.retargetEffect(effect, target);
            // (made anew: the events' starting places follow the effect)
            origin.children = new Map(this.editor.effectChildren(effect.id).map((clip) => [clip.id, { start: clip.start - (effect.start - origin.start), end: clip.end - (effect.start - origin.start) }]));
          }
        }
        // one clip dragged onto another row: it goes there (it lights what that row stands for);
        // back on its own row: as it was
        if (drag.origin.size === 1 && drag.rawOrigin.size === 0) {
          const target = this.rowAt(y)?.row;
          const [[id, origin]] = [...drag.origin];
          const clip = this.editor.clipById(id!);
          if (clip !== undefined && origin !== undefined && target !== undefined && isLightRow(target)) {
            if (target.key === drag.rowKey) {
              clip.type = origin.type;
              clip.ids = origin.ids === null ? null : [...origin.ids];
              if (origin.target === undefined) delete clip.target;
              else clip.target = origin.target;
              if (origin.scope === undefined) delete clip.scope;
              else clip.scope = origin.scope;
            } else this.editor.retarget(clip, target);
          }
        }
        this.editor.changed();
      }
      this.needsDraw = true;
    });

    window.addEventListener('mouseup', (event) => {
      if (this.headerDrag !== null) {
        this.dropHeaderDrag(event.clientY);
        return;
      }
      const drag = this.drag;
      this.drag = null;
      if (drag === null) return;
      if (drag.kind === 'spectro') this.renderHeaders(true);
      if (drag.kind === 'bookmark' && !drag.moved) {
        // (a click on a flag: the song goes there)
        this.editor.undoDiscard();
        this.editor.seek(drag.origin);
      }
      if (drag.kind === 'range') {
        const range = this.editor.songRange;
        if (range !== null && Math.abs(range.end - range.start) * this.pxPerBeat < 3) this.editor.setSongRange(null);
        else if (range !== null) this.editor.setStatus(`Выделено: доли ${String(round3(Math.min(range.start, range.end)))}–${String(round3(Math.max(range.start, range.end)))}. ПКМ по выделению — превью песни, проиграть по кругу`);
      }
      if (drag.kind === 'create') {
        const row = drag.row;
        // (a click on an empty place: nothing made, what was selected let go)
        if (!drag.moved) {
          if (this.editor.selection.size > 0) this.editor.select([]);
          this.needsDraw = true;
          return;
        }
        if (row.kind === 'poses') {
          const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
          const block = this.newBlockFor(row, a, Math.max(b, a + 1));
          this.editor.addRingBlock(block);
          this.editor.ringEditorHook?.(block.id);
          this.needsDraw = true;
          return;
        }
        if (!isLightRow(row)) return;
        const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
        const end = b - a < 1e-6 ? a + Math.max(this.editor.snap, 0.25) : b;
        const tool = this.editor.tool;
        if (tool.kind === 'effect') {
          const effect = this.editor.makeEffect(tool.effect, tool.params, row, a, Math.max(end, a + 1), tool.name);
          if (effect !== null) {
            this.editor.addEffect(effect);
            if (effect.kind === 'gls') {
              // (a new GLS block opens its editor; the tool goes back to plain light)
              this.editor.tool = { kind: 'clip' };
              this.editor.glsEditorHook?.(effect.id);
            }
          }
        } else {
          const clip = this.editor.newClipForRow(row, a, end);
          if (clip !== null) this.editor.addClip(clip);
        }
      } else if (drag.kind === 'box') {
        const beats = [this.xToBeat(Math.min(drag.x0, drag.x1)), this.xToBeat(Math.max(drag.x0, drag.x1))];
        const ys = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
        const picked: string[] = [];
        for (const { row, top, height } of this.layout()) {
          if (top + height < ys[0]! || top > ys[1]!) continue;
          if (row.kind === 'raw') {
            for (const event of this.visibleRaw(row.type)) if (event.beat >= beats[0]! && event.beat <= beats[1]!) picked.push(event.id);
          } else if (row.kind === 'poses') {
            for (const block of this.blocksOf(row)) if (block.end > beats[0]! && block.start < beats[1]!) picked.push(block.id);
          } else for (const { clip, role } of this.clipsOf(row)) if (role !== 'background' && clip.end > beats[0]! && clip.start < beats[1]!) picked.push(clip.id);
        }
        this.editor.select(picked, drag.additive ? 'add' : 'replace');
      } else if (drag.kind === 'move' && !drag.moved) {
        // just a click: nothing moved — no undo step for it
        this.editor.undoDiscard();
      }
      this.needsDraw = true;
    });
  }

  /** The other events of a type shown on its row (a block's ring events only while it is gone into). */
  private visibleRaw(type: number) {
    const open = this.editor.openEffect;
    return this.editor.project?.raw.filter((event) => event.type === type && (event.group === undefined || event.group === open)) ?? [];
  }

  /** Where the selected effects (and their events) are now — before a drag. */
  private effectOrigins(): Map<string, EffectOrigin> {
    const out = new Map<string, EffectOrigin>();
    for (const effect of this.editor.selectedEffects()) {
      out.set(effect.id, {
        start: effect.start,
        end: effect.end,
        children: new Map([
          ...this.editor.effectChildren(effect.id).map((clip): [string, { start: number; end: number }] => [clip.id, { start: clip.start, end: clip.end }]),
          ...this.editor.effectRaw(effect.id).map((event): [string, { start: number; end: number }] => [event.id, { start: event.beat, end: event.beat }]),
        ]),
        target: { ...(effect.target === undefined ? {} : { target: effect.target }), type: effect.type, ids: effect.ids === null ? null : [...effect.ids] },
      });
    }
    return out;
  }

  /** Where the selected ring pose blocks are now — before a drag (`poses`: their poses too). */
  private blockOrigins(poses: boolean) {
    const out = new Map<string, { start: number; end: number; poses: Map<string, number> }>();
    for (const block of this.editor.selectedRingBlocks()) out.set(block.id, { start: block.start, end: block.end, poses: new Map(poses ? block.poses.map((pose) => [pose.id, pose.beat]) : []) });
    return out;
  }

  private moveHeaderDrag(clientY: number) {
    const drag = this.headerDrag!;
    if (!drag.active && Math.abs(clientY - drag.startY) < 5) return;
    drag.active = true;
    this.headerDragged = true;
    const list = this.headers.querySelector<HTMLElement>('.th-rows');
    if (list === null) return;
    let marker = list.querySelector<HTMLElement>('.th-drop');
    if (marker === null) {
      marker = document.createElement('div');
      marker.className = 'th-drop';
      list.append(marker);
    }
    const target = this.headerDropTarget(clientY);
    marker.style.display = target === null ? 'none' : 'block';
    if (target !== null) marker.style.top = `${String(target.y + list.scrollTop - 1)}px`;
  }

  private dropHeaderDrag(clientY: number) {
    const drag = this.headerDrag!;
    const target = drag.active ? this.headerDropTarget(clientY) : null;
    this.headerDrag = null;
    this.headers.querySelector('.th-drop')?.remove();
    if (target !== null && target.top === true) this.editor.moveTopRow(drag.row.key, target.to);
    else if (target !== null) this.editor.moveGroupItem(target.parent, target.from, target.to);
    // (the click that ends a drag doesn't pick the light)
    window.setTimeout(() => (this.headerDragged = false), 0);
  }

  /** Zoom so the whole song fits. */
  fit() {
    const end = Math.max(16, this.editor.endBeat);
    this.pxPerBeat = Math.max(0.5, this.trackWidth / (end + 4));
    this.viewStart = -1;
    this.needsDraw = true;
  }

  zoom(factor: number) {
    const center = this.editor.playhead();
    this.pxPerBeat = Math.min(800, Math.max(2, this.pxPerBeat * factor));
    this.viewStart = center - this.trackWidth / this.pxPerBeat / 2;
    this.needsDraw = true;
  }

  hoverBeat() {
    return this.hover === null ? null : this.xToBeat(this.hover.x);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (w <= 0 || h <= 0) return;
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.fill();
}

/** The id of what a click hit. */
function hitId(hit: { clip: LightClip } | { raw: RawEvent } | { block: RingBlock }) {
  return 'clip' in hit ? hit.clip.id : 'block' in hit ? hit.block.id : hit.raw.id;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
