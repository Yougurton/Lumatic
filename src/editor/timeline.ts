import { resolveRgb } from './bake';
import type { Editor, Row } from './editor';
import { clipHas, cloneClip, newId, type ClipColor, type LightClip, type RawEvent } from './model';
import { groupHue } from './names';

/**
 * The timeline: a ruler, the rows (each light group, opened up into its lights on request, and the
 * other events), the song's spectrogram at the bottom. Light clips are rectangles from their start
 * to their end — the colour they light, a ramp where they fade in or out, a bright edge for a
 * flash; a clip on a higher layer is drawn over the ones under it but lower, so they still show
 * above it. A clip for only some lights of a group shows striped on the group's row.
 *
 * Mouse: drag on an empty spot of a row to draw a clip; drag a clip to move it, its edges to
 * resize; Shift/Ctrl+drag on an empty spot selects a box; Alt+drag copies; right click deletes.
 * Wheel: through time; Shift+wheel: through the rows; Ctrl+wheel: zoom.
 */

const RULER_H = 26;
const GROUP_H = 28;
const LIGHT_H = 20;
const RAW_H = 22;
const SPECTRO_H = 110;
const EDGE_PX = 6;

const rowHeight = (row: Row) => (row.kind === 'group' ? GROUP_H : row.kind === 'light' ? LIGHT_H : RAW_H);
const LAYER_FACTOR = [1, 0.8, 0.64, 0.52, 0.44];

type Drag =
  | { kind: 'create'; row: Row; from: number; to: number }
  | { kind: 'move'; origin: Map<string, { start: number; end: number; type: number; ids: number[] | null }>; rawOrigin: Map<string, number>; grabBeat: number; anchor: number; moved: boolean; rowIndex: number }
  | { kind: 'resize'; edge: 'start' | 'end'; origin: Map<string, { start: number; end: number }>; anchor: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: 'seek' };

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

  /** Clips shown on a row (lowest layer first). */
  private clipsOf(row: Row): LightClip[] {
    const project = this.editor.project;
    if (project === null || row.kind === 'raw') return [];
    return project.clips
      .filter((clip) => clip.type === row.type && (row.kind === 'group' || clipHas(clip, row.id)))
      .sort((a, b) => a.layer - b.layer || a.start - b.start);
  }

  private clipRect(clip: LightClip, top: number, height: number) {
    const factor = LAYER_FACTOR[Math.min(clip.layer, LAYER_FACTOR.length - 1)]!;
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
      const clip = clips[i]!;
      const rect = this.clipRect(clip, top, height);
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
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.rowsTop, width, this.rowsBottom - this.rowsTop);
    ctx.clip();
    for (const { row, top, height: h } of this.layout()) {
      if (top + h < this.rowsTop || top > this.rowsBottom) continue;
      ctx.fillStyle = row.kind === 'group' ? '#1b1d24' : row.kind === 'light' ? '#17181e' : '#191a1f';
      ctx.fillRect(0, top, width, h);
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
      else for (const clip of this.clipsOf(row)) this.drawClip(clip, row, top, h);
    }
    // the clip being drawn
    const creating = this.drag?.kind === 'create' ? this.drag : null;
    if (creating !== null) {
      const item = this.layout().find((entry) => entry.row.key === creating.row.key);
      if (item !== undefined && item.row.kind !== 'raw') {
        const [a, b] = [Math.min(creating.from, creating.to), Math.max(creating.from, creating.to)];
        const ghost = editor.newClip(item.row.type, null, a, Math.max(b, a + Math.max(editor.snap, 0.0625)));
        this.drawClip(ghost, item.row, item.top, item.height, true);
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

  private drawClip(clip: LightClip, row: Row, top: number, height: number, ghost = false) {
    const ctx = this.context;
    const { x, y, w, h } = this.clipRect(clip, top, height);
    if (x > this.width || x + w < 0) return;
    const partial = row.kind === 'group' && clip.ids !== null;
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
    ctx.globalAlpha = ghost ? 0.6 : 1;
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
    ctx.strokeStyle = this.editor.selection.has(clip.id) ? '#ffffff' : 'rgba(0,0,0,0.55)';
    ctx.lineWidth = this.editor.selection.has(clip.id) ? 2 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1);
    if (clip.layer > 0 && w > 26 && h >= 12) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`L${String(clip.layer)}`, x + 5, y + h - 4);
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
    const rows = this.editor.rows;
    const key = rows.map((row) => row.key + (row.kind === 'group' && row.expanded ? '+' : '')).join(',') + `|${String(this.editor.pickedLight?.type)}:${String(this.editor.pickedLight?.id)}`;
    if (!force && key === this.headerKey) return;
    this.headerKey = key;
    const box = this.headers;
    box.replaceChildren();
    const ruler = document.createElement('div');
    ruler.className = 'th-ruler';
    ruler.style.height = `${String(RULER_H)}px`;
    ruler.textContent = 'Такты';
    const list = document.createElement('div');
    list.className = 'th-rows';
    for (const row of rows) {
      const item = document.createElement('div');
      item.className = `th-row th-${row.kind}`;
      item.style.height = `${String(rowHeight(row))}px`;
      if (row.kind === 'group') {
        const toggle = document.createElement('button');
        toggle.className = 'th-toggle';
        toggle.textContent = row.expanded ? '▾' : '▸';
        toggle.title = row.expanded ? 'Свернуть' : `Раскрыть (${String(row.lights.length)} light ID)`;
        toggle.disabled = row.lights.length === 0;
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          this.editor.toggleExpanded(row.type);
        });
        const swatch = document.createElement('span');
        swatch.className = 'th-swatch';
        swatch.style.background = `hsl(${String(groupHue(row.type))} 70% 55%)`;
        const name = document.createElement('span');
        name.className = 'th-name';
        name.textContent = row.label;
        const count = document.createElement('span');
        count.className = 'th-count';
        count.textContent = row.lights.length > 0 ? String(row.lights.length) : '';
        item.append(toggle, swatch, name, count);
      } else if (row.kind === 'light') {
        item.textContent = row.label;
        if (this.editor.pickedLight?.type === row.type && this.editor.pickedLight.id === row.id) item.classList.add('picked');
        item.addEventListener('click', () => this.editor.pickLight(row.type, row.id));
      } else {
        item.textContent = row.label;
      }
      list.append(item);
    }
    const tail = document.createElement('div');
    tail.style.height = '400px';
    list.append(tail);
    const spectro = document.createElement('div');
    spectro.className = 'th-spectro';
    spectro.style.height = `${String(SPECTRO_H)}px`;
    spectro.textContent = 'Спектрограмма';
    box.append(ruler, list, spectro);
    this.needsDraw = true;
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
      } else if (event.shiftKey) {
        const max = Math.max(0, this.rowsHeight() - (this.rowsBottom - this.rowsTop) + 20);
        this.scrollY = Math.min(max, Math.max(0, this.scrollY + event.deltaY));
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
      const origin = new Map<string, { start: number; end: number; type: number; ids: number[] | null }>();
      for (const clip of this.editor.selectedClips()) origin.set(clip.id, { start: clip.start, end: clip.end, type: clip.type, ids: clip.ids === null ? null : [...clip.ids] });
      const rawOrigin = new Map<string, number>();
      for (const raw of this.editor.project.raw) if (this.editor.selection.has(raw.id)) rawOrigin.set(raw.id, raw.beat);
      const grabbed = 'clip' in hit ? hit.clip.start : hit.raw.beat;
      const rowIndex = this.editor.rows.findIndex((row) => row.key === hit.row.key);
      this.drag = { kind: 'move', origin, rawOrigin, grabBeat: beat, anchor: grabbed, moved: false, rowIndex };
    });

    window.addEventListener('mousemove', (event) => {
      const { x, y } = local(event);
      this.hover = { x, y };
      const drag = this.drag;
      if (drag === null) {
        const hit = x >= 0 && x <= this.width ? this.hit(x, y) : null;
        canvas.style.cursor = hit !== null && 'clip' in hit && hit.edge !== null ? 'ew-resize' : hit !== null ? 'grab' : 'default';
        return;
      }
      const beat = this.xToBeat(x);
      const free = event.altKey && drag.kind !== 'move';
      const snap = (value: number) => (free ? value : this.editor.snapBeat(value));
      if (drag.kind === 'seek') {
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
        // one clip dragged onto another row: it goes there (a group: all of its lights; a light:
        // that one)
        if (drag.origin.size === 1 && drag.rawOrigin.size === 0) {
          const target = this.rowAt(y)?.row;
          const [[id, origin]] = [...drag.origin];
          const clip = this.editor.clipById(id!);
          if (clip !== undefined && origin !== undefined && target !== undefined) {
            if (target.kind === 'group') {
              clip.type = target.type;
              clip.ids = target.type === origin.type ? origin.ids : null;
            } else if (target.kind === 'light') {
              clip.type = target.type;
              clip.ids = target.type === origin.type && origin.ids !== null && origin.ids.includes(target.id) ? origin.ids : [target.id];
            }
          }
        }
        this.editor.changed();
      }
      this.needsDraw = true;
    });

    window.addEventListener('mouseup', () => {
      const drag = this.drag;
      this.drag = null;
      if (drag === null) return;
      if (drag.kind === 'create') {
        const row = drag.row;
        if (row.kind === 'raw') return;
        const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
        const end = b - a < 1e-6 ? a + Math.max(this.editor.snap, 0.25) : b;
        this.editor.addClip(this.editor.newClip(row.type, row.kind === 'light' ? [row.id] : null, a, end));
      } else if (drag.kind === 'box') {
        const beats = [this.xToBeat(Math.min(drag.x0, drag.x1)), this.xToBeat(Math.max(drag.x0, drag.x1))];
        const ys = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
        const picked: string[] = [];
        for (const { row, top, height } of this.layout()) {
          if (top + height < ys[0]! || top > ys[1]!) continue;
          if (row.kind === 'raw') {
            for (const event of this.editor.project?.raw ?? []) if (event.type === row.type && event.beat >= beats[0]! && event.beat <= beats[1]!) picked.push(event.id);
          } else for (const clip of this.clipsOf(row)) if (clip.end > beats[0]! && clip.start < beats[1]!) picked.push(clip.id);
        }
        this.editor.select(picked, drag.additive ? 'add' : 'replace');
      } else if (drag.kind === 'move' && !drag.moved) {
        // just a click: nothing moved — no undo step for it
        this.editor.undoDiscard();
      }
      this.needsDraw = true;
    });
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
