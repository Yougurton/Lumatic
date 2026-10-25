import { resolveRgb } from './bake';
import type { Editor, Row, ShownClip, SortKey } from './editor';
import { ask, showMenu, type MenuItem } from './menu';
import { cloneClip, findGroup, groupLights, lightKey, newId, type ClipColor, type LightClip, type RawEvent } from './model';
import { groupHue, lightGroupName } from './names';

/**
 * The timeline: a ruler, the rows (each light group, opened up into its lights on request, and the
 * other events), the song's spectrogram at the bottom. Light clips are rectangles from their start
 * to their end — the colour they light, a ramp where they fade in or out, a bright edge for a
 * flash; a clip on a higher layer is drawn over the ones under it but lower, so they still show
 * above it. A clip for only some lights of a group shows striped on the group's row.
 *
 * Mouse: drag on an empty spot of a row to draw a clip; drag a clip to move it, its edges to
 * resize; Shift/Ctrl+drag on an empty spot selects a box; Alt+drag copies; right click deletes.
 * Wheel: through time; Alt/Shift+wheel (or the wheel over the row names): through the rows;
 * Ctrl+wheel: zoom.
 *
 * Row names: ▸ opens a group up; a click picks lights (Ctrl adds, Shift a range) — for grouping
 * them (Ctrl+G) — right click: what can be done with it; the lights and subgroups of a group of the
 * user's can be dragged into another order.
 */

const RULER_H = 30;
const SCROLLBAR_W = 9;
const GROUP_H = 28;
const LIGHT_H = 20;
const RAW_H = 22;
const SPECTRO_H = 110;
const EDGE_PX = 6;

const rowHeight = (row: Row) => (row.kind === 'group' || row.kind === 'custom' ? GROUP_H : row.kind === 'light' ? LIGHT_H : RAW_H);

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

type Drag =
  | { kind: 'create'; row: Row; from: number; to: number }
  | { kind: 'move'; origin: Map<string, LightClip>; rawOrigin: Map<string, number>; grabBeat: number; anchor: number; moved: boolean; rowKey: string }
  | { kind: 'resize'; edge: 'start' | 'end'; origin: Map<string, { start: number; end: number }>; anchor: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: 'seek' }
  | { kind: 'scroll'; grabY: number; scrollY: number };

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly headers: HTMLElement;
  /** Map beat at the left edge, pixels per beat, rows scrolled by. */
  viewStart = -1;
  pxPerBeat = 60;
  scrollY = 0;
  private drag: Drag | null = null;
  private needsDraw = true;
  private hover: { x: number; y: number } | null = null;
  private followPlayhead = true;
  private headerKey = '';

  constructor(private readonly editor: Editor, root: HTMLElement) {
    this.headers = root.querySelector<HTMLElement>('#track-headers')!;
    this.canvas = root.querySelector<HTMLCanvasElement>('#tracks')!;
    this.context = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement!);
    this.resize();
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
          const width = this.width / this.pxPerBeat;
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

  private get rowsTop() {
    return RULER_H;
  }

  private get rowsBottom() {
    return this.height - SPECTRO_H;
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
    return (beat - this.viewStart) * this.pxPerBeat;
  }

  xToBeat(x: number) {
    return this.viewStart + x / this.pxPerBeat;
  }

  /** Each row's top (in canvas pixels, scrolled). */
  private layout(): { row: Row; top: number; height: number }[] {
    let y = this.rowsTop - this.scrollY;
    return this.editor.rows.map((row) => {
      const height = rowHeight(row);
      const item = { row, top: y, height };
      y += height;
      return item;
    });
  }

  private rowsHeight() {
    return this.editor.rows.reduce((sum, row) => sum + rowHeight(row), 0);
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
  private hit(x: number, y: number): { clip: LightClip; edge: 'start' | 'end' | null; row: Row } | { raw: RawEvent; row: Row } | null {
    const item = this.rowAt(y);
    if (item === null) return null;
    const { row, top, height } = item;
    if (row.kind === 'raw') {
      const events = this.editor.project?.raw.filter((event) => event.type === row.type) ?? [];
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
    const beatsVisible = width / this.pxPerBeat;
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
      else for (const shown of this.clipsOf(row)) this.drawClip(shown, top, h);
    }
    // the clip being drawn
    const creating = this.drag?.kind === 'create' ? this.drag : null;
    if (creating !== null) {
      const item = this.layout().find((entry) => entry.row.key === creating.row.key);
      if (item !== undefined && item.row.kind !== 'raw') {
        const [a, b] = [Math.min(creating.from, creating.to), Math.max(creating.from, creating.to)];
        const ghost = editor.newClipForRow(item.row, a, Math.max(b, a + Math.max(editor.snap, 0.0625)));
        const shown = this.clipsOf(item.row);
        if (ghost !== null) this.drawClip({ clip: ghost, partial: false, level: Math.min(shown.length === 0 ? 0 : Math.max(...shown.map((entry) => entry.level)) + 1, 1), role: 'own' }, item.top, item.height, true);
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
    this.drawScrollbar();

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
    this.drawSpectrogram(this.rowsBottom, SPECTRO_H);

    // playhead
    const px = this.beatToX(editor.playhead());
    ctx.fillStyle = '#ff4d6d';
    ctx.fillRect(Math.round(px), 0, 1.5, height);
    ctx.beginPath();
    ctx.moveTo(px - 6, 0);
    ctx.lineTo(px + 6, 0);
    ctx.lineTo(px, 8);
    ctx.fill();
    // headers follow the rows
    const list = this.headers.querySelector<HTMLElement>('.th-rows');
    if (list !== null) {
      list.style.height = `${String(Math.max(0, this.rowsBottom - this.rowsTop))}px`;
      list.scrollTop = this.scrollY;
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
    const total = this.rowsHeight() + 20;
    const visible = this.rowsBottom - this.rowsTop;
    if (total <= visible) return;
    const ctx = this.context;
    const x = this.width - SCROLLBAR_W;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x, this.rowsTop, SCROLLBAR_W, visible);
    const thumb = Math.max(24, (visible / total) * visible);
    const y = this.rowsTop + (this.scrollY / this.maxScroll()) * (visible - thumb);
    ctx.fillStyle = this.drag?.kind === 'scroll' ? '#7d8396' : '#4a4f5d';
    ctx.fillRect(x + 2, y, SCROLLBAR_W - 4, thumb);
  }

  private drawClip(shown: ShownClip, top: number, height: number, ghost = false) {
    const ctx = this.context;
    const clip = shown.clip;
    const { x, y, w, h } = this.clipRect(shown, top, height);
    if (x > this.width || x + w < 0) return;
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

  private drawRaw(row: Extract<Row, { kind: 'raw' }>, top: number, height: number) {
    const ctx = this.context;
    const events = this.editor.project?.raw.filter((event) => event.type === row.type) ?? [];
    const hue = row.type === 8 ? 300 : row.type === 9 ? 190 : row.type === 5 ? 45 : 140;
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
    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(0, top, this.width, height);
    const spectrogram = this.editor.spectrogram;
    if (spectrogram !== null) {
      // (chunks of 8 px: each drawn with the time it covers — exact also where the BPM changes)
      for (let x = 0; x < this.width; x += 8) {
        const s0 = this.editor.beatToSeconds(this.xToBeat(x));
        const s1 = this.editor.beatToSeconds(this.xToBeat(x + 8));
        const f0 = s0 / spectrogram.secondsPerFrame;
        const f1 = s1 / spectrogram.secondsPerFrame;
        if (f1 <= 0 || f0 >= spectrogram.frames) continue;
        const a = Math.max(0, f0);
        const b = Math.min(spectrogram.frames, f1);
        const dx = x + ((a - f0) / (f1 - f0)) * 8;
        const dw = ((b - a) / (f1 - f0)) * 8;
        ctx.drawImage(spectrogram.image, a, 0, Math.max(0.01, b - a), spectrogram.image.height, dx, top, dw + 0.5, height);
      }
    } else {
      ctx.fillStyle = '#4b4f5c';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(this.editor.clock === null ? '' : 'Спектрограмма считается…', 12, top + height / 2);
    }
    ctx.fillStyle = '#2a2c34';
    ctx.fillRect(0, top, this.width, 1);
    // bars over it
    const first = Math.floor(this.viewStart);
    const last = Math.ceil(this.viewStart + this.width / this.pxPerBeat);
    for (let beat = Math.ceil(first / 4) * 4; beat <= last; beat += 4) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(this.beatToX(beat), top, 1, height);
    }
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
    spectro.style.height = `${String(SPECTRO_H)}px`;
    spectro.textContent = 'Спектрограмма';
    box.append(list, spectro);
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
    const rings = editor.ringTypes();
    tools.append(
      button('Кольца ▾', 'Готовые группы колец', (event) => {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        showMenu(rect.left, rect.bottom + 2, this.ringMenu(rings));
      }, rings.length === 0),
    );
    return tools;
  }

  private ringMenu(types: number[]): MenuItem[] {
    const items: MenuItem[] = [];
    for (const type of types) {
      items.push({ label: lightGroupName(type), heading: true });
      items.push({ label: 'Группа по кольцам', hint: 'одно событие — одно кольцо', action: () => this.editor.ringPreset(type, 'rings') });
      items.push({ label: 'Группа по линиям', hint: 'одно событие — одна линия', action: () => this.editor.ringPreset(type, 'lines') });
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
    item.style.height = `${String(rowHeight(row))}px`;
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
      item.addEventListener('click', () => editor.selectLights(editor.rowLights(row).map((light) => lightKey(light.type, light.id))));
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showMenu(event.clientX, event.clientY, [
          { label: row.expanded ? 'Свернуть' : 'Раскрыть light ID', action: () => editor.toggleExpanded(row.type), disabled: row.lights.length === 0 },
          { label: 'Выбрать все лампы', action: () => editor.selectLights(row.lights.map((id) => lightKey(row.type, id))) },
          { label: 'Группа из всех его ламп', action: () => void ask('Название группы', row.label).then((name) => name !== null && editor.addGroup(name, row.lights.map((id) => ({ kind: 'light', type: row.type, id })))) },
          ...(editor.ringTypes().includes(row.type)
            ? [null, { label: 'Группа по кольцам', hint: 'одно событие — одно кольцо', action: () => editor.ringPreset(row.type, 'rings') }, { label: 'Группа по линиям', hint: 'одно событие — одна линия', action: () => editor.ringPreset(row.type, 'lines') }]
            : []),
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
      item.addEventListener('click', () => editor.selectLights(lights.map((light) => lightKey(light.type, light.id)), 'replace', row.parent));
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
    } else {
      item.textContent = row.label;
    }
    // the lights and subgroups of a user's group: dragged into another order
    if ((row.kind === 'light' || row.kind === 'custom') && row.parent !== null) {
      item.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        this.headerDrag = { row, startY: event.clientY, active: false };
        this.headerDragged = false;
      });
    }
    return item;
  }

  private headerDrag: { row: Extract<Row, { kind: 'light' | 'custom' }>; startY: number; active: boolean } | null = null;
  private headerDragged = false;
  private lastLightRow: string | null = null;

  /** Where a dragged row would go: the gap among its siblings nearest the mouse. */
  private headerDropTarget(clientY: number): { parent: string; from: number; to: number; y: number } | null {
    const drag = this.headerDrag;
    if (drag === null || drag.row.parent === null) return null;
    const parent = findGroup(this.editor.groups, drag.row.parent)?.group;
    if (parent === undefined) return null;
    const indexOf = (row: Row) => parent.items.findIndex((item) => (row.kind === 'custom' ? item.kind === 'group' && item.id === row.group.id : row.kind === 'light' && item.kind === 'light' && item.type === row.type && item.id === row.id));
    const from = indexOf(drag.row);
    const list = this.headers.querySelector<HTMLElement>('.th-rows');
    if (from < 0 || list === null) return null;
    const siblings = this.editor.rows.filter((row) => (row.kind === 'light' || row.kind === 'custom') && row.parent === drag.row.parent);
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
    return best === null ? null : { parent: drag.row.parent, from, to: best.to, y: best.y };
  }

  private groupMenu(x: number, y: number, row: Extract<Row, { kind: 'custom' }>) {
    const editor = this.editor;
    const group = row.group;
    const picked = editor.selectedLights();
    showMenu(x, y, [
      { label: 'Войти в группу', action: () => editor.enterGroup(group.id), disabled: editor.focus === group.id },
      { label: 'Переименовать…', action: () => void ask('Новое название', group.name).then((name) => name !== null && editor.renameGroup(group.id, name)) },
      { label: 'Выбрать её лампы', action: () => editor.selectLights(groupLights(group).map((light) => lightKey(light.type, light.id)), 'replace', group.id) },
      null,
      { label: 'Сортировать', heading: true },
      ...SORTS.map(([key, label]) => ({ label, action: () => editor.sortGroup(group.id, key) })),
      null,
      { label: `Добавить выбранные лампы (${String(picked.length)})`, action: () => editor.addLightsToGroup(group.id, picked), disabled: picked.length === 0 },
      { label: `Убрать выбранные лампы`, action: () => editor.removeLightsFromGroup(group.id, picked), disabled: picked.length === 0 },
      { label: 'Подгруппа из выбранных', hint: 'Ctrl+G', action: () => void this.groupSelected(), disabled: picked.length === 0 },
      null,
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
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const { x } = local(event);
      if (event.ctrlKey || event.metaKey) {
        const beat = this.xToBeat(x);
        this.pxPerBeat = Math.min(800, Math.max(4, this.pxPerBeat * Math.exp(-event.deltaY * 0.0015)));
        this.viewStart = beat - x / this.pxPerBeat;
      } else if (event.altKey || event.shiftKey) {
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
      if (x >= this.width - SCROLLBAR_W && y >= this.rowsTop && y < this.rowsBottom && this.maxScroll() > 0) {
        // the scrollbar: drag it, or a click above / below its thumb jumps there
        const visible = this.rowsBottom - this.rowsTop;
        const total = this.rowsHeight() + 20;
        const thumb = Math.max(24, (visible / total) * visible);
        const thumbTop = this.rowsTop + (this.scrollY / this.maxScroll()) * (visible - thumb);
        if (y < thumbTop || y > thumbTop + thumb) this.scrollY = Math.min(this.maxScroll(), Math.max(0, ((y - this.rowsTop - thumb / 2) / (visible - thumb)) * this.maxScroll()));
        this.drag = { kind: 'scroll', grabY: y, scrollY: this.scrollY };
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
      if (event.button === 2) {
        // right click: delete what's under it
        if (hit !== null) {
          this.editor.select(['clip' in hit ? hit.clip.id : hit.raw.id]);
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
          // a marker for the other events: one at the snapped beat
          const project = this.editor.project;
          this.editor.checkpoint();
          const raw: RawEvent = { id: newId('r'), beat: this.editor.snapBeat(beat), type: item.row.type, value: item.row.type === 5 ? 1 : 0, floatValue: 1 };
          project.raw.push(raw);
          this.editor.selection = new Set([raw.id]);
          this.editor.changed();
          return;
        }
        const from = this.editor.snapBeat(beat);
        this.drag = { kind: 'create', row: item.row, from, to: from };
        this.needsDraw = true;
        return;
      }
      const id = 'clip' in hit ? hit.clip.id : hit.raw.id;
      if (event.shiftKey || event.ctrlKey || event.metaKey) this.editor.select([id], 'toggle');
      else if (!this.editor.selection.has(id)) this.editor.select([id]);
      if ('clip' in hit && hit.edge !== null) {
        const origin = new Map<string, { start: number; end: number }>();
        for (const clip of this.editor.selectedClips()) origin.set(clip.id, { start: clip.start, end: clip.end });
        this.editor.checkpoint();
        this.drag = { kind: 'resize', edge: hit.edge, origin, anchor: hit.edge === 'start' ? hit.clip.start : hit.clip.end };
        return;
      }
      this.editor.checkpoint();
      if (event.altKey) {
        // Alt: drag a copy
        const project = this.editor.project;
        const copies = this.editor.selectedClips().map((clip) => cloneClip(clip));
        const rawCopies = project.raw.filter((event) => this.editor.selection.has(event.id)).map((event) => ({ ...event, id: newId('r') }));
        project.clips.push(...copies);
        project.raw.push(...rawCopies);
        this.editor.selection = new Set([...copies.map((clip) => clip.id), ...rawCopies.map((event) => event.id)]);
      }
      const origin = new Map<string, LightClip>();
      for (const clip of this.editor.selectedClips()) origin.set(clip.id, cloneClip(clip, { id: clip.id }));
      const rawOrigin = new Map<string, number>();
      for (const raw of this.editor.project.raw) if (this.editor.selection.has(raw.id)) rawOrigin.set(raw.id, raw.beat);
      const grabbed = 'clip' in hit ? hit.clip.start : hit.raw.beat;
      this.drag = { kind: 'move', origin, rawOrigin, grabBeat: beat, anchor: grabbed, moved: false, rowKey: hit.row.key };
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
        const hit = x >= 0 && x <= this.width ? this.hit(x, y) : null;
        canvas.style.cursor = hit !== null && 'clip' in hit && hit.edge !== null ? 'ew-resize' : hit !== null ? 'grab' : 'default';
        return;
      }
      const beat = this.xToBeat(x);
      const free = event.altKey && drag.kind !== 'move';
      const snap = (value: number) => (free ? value : this.editor.snapBeat(value));
      if (drag.kind === 'scroll') {
        const visible = this.rowsBottom - this.rowsTop;
        const thumb = Math.max(24, (visible / (this.rowsHeight() + 20)) * visible);
        this.scrollY = Math.min(this.maxScroll(), Math.max(0, drag.scrollY + ((y - drag.grabY) / Math.max(1, visible - thumb)) * this.maxScroll()));
      } else if (drag.kind === 'seek') {
        this.editor.seek(Math.max(0, beat));
      } else if (drag.kind === 'create') {
        drag.to = snap(beat);
      } else if (drag.kind === 'box') {
        drag.x1 = x;
        drag.y1 = y;
      } else if (drag.kind === 'resize') {
        const delta = snap(beat) - drag.anchor;
        for (const [id, origin] of drag.origin) {
          const clip = this.editor.clipById(id);
          if (clip === undefined) continue;
          const min = Math.max(this.editor.snap, 1 / 64);
          if (drag.edge === 'start') clip.start = Math.min(origin.end - min, origin.start + delta);
          else clip.end = Math.max(origin.start + min, origin.end + delta);
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
        // one clip dragged onto another row: it goes there (it lights what that row stands for);
        // back on its own row: as it was
        if (drag.origin.size === 1 && drag.rawOrigin.size === 0) {
          const target = this.rowAt(y)?.row;
          const [[id, origin]] = [...drag.origin];
          const clip = this.editor.clipById(id!);
          if (clip !== undefined && origin !== undefined && target !== undefined && target.kind !== 'raw') {
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
      if (drag.kind === 'create') {
        const row = drag.row;
        if (row.kind === 'raw') return;
        const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
        const end = b - a < 1e-6 ? a + Math.max(this.editor.snap, 0.25) : b;
        const clip = this.editor.newClipForRow(row, a, end);
        if (clip !== null) this.editor.addClip(clip);
      } else if (drag.kind === 'box') {
        const beats = [this.xToBeat(Math.min(drag.x0, drag.x1)), this.xToBeat(Math.max(drag.x0, drag.x1))];
        const ys = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
        const picked: string[] = [];
        for (const { row, top, height } of this.layout()) {
          if (top + height < ys[0]! || top > ys[1]!) continue;
          if (row.kind === 'raw') {
            for (const event of this.editor.project?.raw ?? []) if (event.type === row.type && event.beat >= beats[0]! && event.beat <= beats[1]!) picked.push(event.id);
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
    if (target !== null) this.editor.moveGroupItem(target.parent, target.from, target.to);
    // (the click that ends a drag doesn't pick the light)
    window.setTimeout(() => (this.headerDragged = false), 0);
  }

  /** Zoom so the whole song fits. */
  fit() {
    const end = Math.max(16, this.editor.endBeat);
    this.pxPerBeat = Math.max(2, this.width / (end + 4));
    this.viewStart = -1;
    this.needsDraw = true;
  }

  zoom(factor: number) {
    const center = this.editor.playhead();
    this.pxPerBeat = Math.min(800, Math.max(2, this.pxPerBeat * factor));
    this.viewStart = center - this.width / this.pxPerBeat / 2;
    this.needsDraw = true;
  }

  hoverBeat() {
    return this.hover === null ? null : this.xToBeat(this.hover.x);
  }
}
