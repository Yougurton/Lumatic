import type { Editor } from './editor';
import { DIR_ANGLE, type MapNote } from './notes';
import { newId } from './model';

/**
 * The notes side's corner (where the lights side has its effects): the grid 4×3 as the player sees it,
 * at the song cursor. What's at the cursor is drawn whole; what comes next fades in from behind, the
 * nearer the stronger. A click on a cell puts in what the tool is (a drag from it: the arrow that way);
 * on a note there: picks it, right click deletes it, middle click gives it the other colour. The wheel
 * moves the cursor a grid step (up: on through the song). Above it: the tools (1 red, 2 blue, 3 bomb,
 * 4 wall) and the arrow's direction (W/A/S/D, F — a dot; two at once — a diagonal).
 */

const DIRS: { dir: number; label: string; key: string }[] = [
  { dir: 4, label: '↖', key: 'W+A' },
  { dir: 0, label: '↑', key: 'W' },
  { dir: 5, label: '↗', key: 'W+D' },
  { dir: 2, label: '←', key: 'A' },
  { dir: 8, label: '•', key: 'F' },
  { dir: 3, label: '→', key: 'D' },
  { dir: 6, label: '↙', key: 'S+A' },
  { dir: 1, label: '↓', key: 'S' },
  { dir: 7, label: '↘', key: 'S+D' },
];

/** How far ahead (beats) the coming objects show through. */
const AHEAD = 2;

export class NotePanel {
  private readonly root: HTMLElement;
  private readonly tools = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly label = document.createElement('div');
  private press: { x: number; y: number; col: number; row: number; button: number } | null = null;
  private hoverCell: { col: number; row: number } | null = null;
  private needsDraw = true;
  private shownKey = '';
  private wheel = 0;

  constructor(
    private readonly editor: Editor,
    root: HTMLElement,
  ) {
    this.root = root;
    this.context = this.canvas.getContext('2d')!;
    this.tools.className = 'np-tools';
    this.canvas.className = 'np-grid';
    this.label.className = 'np-label nm-dim';
    this.canvas.title = 'Сетка 4×3 на доле курсора, как её видит игрок; следующие ноты — полупрозрачные.\nКлик — поставить, потянуть из клетки — стрелка в ту сторону, ПКМ — удалить, средняя кнопка — другой цвет.\nКолёсико — шаг сетки по песне. 1/2/3/4 — красная, синяя, бомба, стена; W/A/S/D/F — направление (две сразу — диагональ).';
    root.append(this.tools, this.label, this.canvas);
    this.renderTools();
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    editor.onChange(() => {
      this.renderTools();
      this.needsDraw = true;
    });
    this.bind();
    const loop = () => {
      const key = `${String(editor.snapBeat(editor.playhead()))}|${String(editor.noteVersion)}|${String(editor.noteSelection.size)}`;
      if (key !== this.shownKey) {
        this.shownKey = key;
        this.needsDraw = true;
      }
      if (this.needsDraw && editor.tab === 'notes') {
        this.needsDraw = false;
        this.draw();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** The tools and the direction pad (drawn again when the tool changes). */
  renderTools() {
    const editor = this.editor;
    const tool = editor.noteTool;
    const scheme = editor.preview.colors;
    const key = `${tool.kind}|${String(tool.direction)}|${editor.wallKind}|${[...scheme.leftNote, ...scheme.rightNote, ...scheme.obstacle].join(',')}`;
    if (this.tools.dataset.key === key) return;
    this.tools.dataset.key = key;
    const colors = editor.preview.colors;
    const css = (rgb: readonly number[]) => `rgb(${rgb.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')})`;
    const kinds: { kind: typeof tool.kind; label: string; key: string; swatch: string }[] = [
      { kind: 'red', label: 'Красная', key: '1', swatch: css(colors.leftNote) },
      { kind: 'blue', label: 'Синяя', key: '2', swatch: css(colors.rightNote) },
      { kind: 'bomb', label: 'Бомба', key: '3', swatch: '#3a3d46' },
      { kind: 'wall', label: 'Стена', key: '4', swatch: css(colors.obstacle) },
    ];
    const row = document.createElement('div');
    row.className = 'np-kinds';
    for (const item of kinds) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'np-kind';
      button.classList.toggle('active', tool.kind === item.kind);
      button.title = `${item.label} (${item.key})`;
      button.innerHTML = `<i style="background:${item.swatch}"></i><span>${item.label}</span>`;
      button.addEventListener('click', () => {
        editor.noteTool = { ...editor.noteTool, kind: item.kind };
        editor.emit('selection');
      });
      row.append(button);
    }
    const pad = document.createElement('div');
    pad.className = 'np-pad';
    for (const item of DIRS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      button.title = `Направление ${item.label} (${item.key})`;
      button.classList.toggle('active', tool.direction === item.dir);
      button.disabled = tool.kind === 'bomb' || tool.kind === 'wall';
      button.addEventListener('click', () => editor.setNoteDirection(item.dir));
      pad.append(button);
    }
    const side = document.createElement('div');
    side.className = 'np-side';
    if (tool.kind === 'wall') {
      for (const [kind, label, title] of [
        ['full', 'Во весь рост', 'Стена, от которой уходят в сторону'],
        ['crouch', 'Присед', 'Стена сверху: под ней приседают'],
      ] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.title = title;
        button.classList.toggle('active', editor.wallKind === kind);
        button.addEventListener('click', () => {
          editor.wallKind = kind;
          editor.emit('selection');
        });
        side.append(button);
      }
      side.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: 'На таймлайне стена тянется мышью по времени и по колонкам.' }));
    } else {
      side.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: 'W/A/S/D, F — точка; две сразу — диагональ. У выделенных нот меняется тоже.' }));
    }
    this.tools.replaceChildren(row, Object.assign(document.createElement('div'), { className: 'np-row' }));
    this.tools.lastElementChild!.append(pad, side);
  }

  private resize() {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.needsDraw = true;
  }

  /** The grid's cells on the canvas. */
  private geometry() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const cell = Math.max(10, Math.min((width - 16) / 4, (height - 16) / 3));
    const left = (width - cell * 4) / 2;
    const top = (height - cell * 3) / 2;
    return { cell, left, top, width, height };
  }

  private cellAt(x: number, y: number): { col: number; row: number } | null {
    const { cell, left, top } = this.geometry();
    const col = Math.floor((x - left) / cell);
    const fromTop = Math.floor((y - top) / cell);
    if (col < 0 || col > 3 || fromTop < 0 || fromTop > 2) return null;
    return { col, row: 2 - fromTop };
  }

  /** The note or bomb at the cursor in a cell. */
  private objectAt(col: number, row: number) {
    const beat = this.editor.snapBeat(this.editor.playhead());
    const same = (item: { b: number; x: number; y: number }) => Math.abs(item.b - beat) < 1e-3 && item.x === col && item.y === row;
    const note = this.editor.objects.notes.find(same);
    if (note !== undefined) return { kind: 'notes' as const, item: note };
    const bomb = this.editor.objects.bombs.find(same);
    return bomb === undefined ? null : { kind: 'bombs' as const, item: bomb };
  }

  private rgb(color: readonly number[], alpha: number) {
    return `rgba(${color.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')},${String(alpha)})`;
  }

  private draw() {
    const ctx = this.context;
    const editor = this.editor;
    const { cell, left, top, width, height } = this.geometry();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f1014';
    ctx.fillRect(0, 0, width, height);
    const beat = editor.snapBeat(editor.playhead());
    this.label.textContent = `Доля ${beat.toFixed(3)} · шаг ${editor.snap > 0 ? `1/${String(Math.round(1 / editor.snap))}` : 'свободно'}`;
    // cells
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 3; row++) {
        const x = left + col * cell;
        const y = top + (2 - row) * cell;
        const hover = this.hoverCell?.col === col && this.hoverCell.row === row;
        ctx.fillStyle = hover ? '#22252e' : (col + row) % 2 === 0 ? '#17191f' : '#191b22';
        ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, top + 0.5, cell * 4 - 1, cell * 3 - 1);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(left + cell * 2 - 0.5, top, 1, cell * 3);
    const colors = editor.preview.colors;
    const noteColor = (c: number) => (c === 0 ? colors.leftNote : colors.rightNote);
    const center = (x: number, y: number) => [left + (x + 0.5) * cell, top + (2 - y + 0.5) * cell] as const;
    // walls going on at the cursor, and the ones coming
    for (const wall of editor.objects.walls) {
      if (wall.b + wall.d < beat - 1e-6 || wall.b > beat + AHEAD) continue;
      const now = wall.b <= beat + 1e-6;
      const alpha = now ? 0.35 : 0.22 * (1 - (wall.b - beat) / AHEAD);
      const x0 = left + Math.max(0, wall.x) * cell;
      const x1 = left + Math.min(4, wall.x + wall.w) * cell;
      const y0 = top + Math.max(0, 3 - (wall.y + wall.h) / (5 / 3)) * cell;
      const y1 = top + Math.min(3, 3 - wall.y / (5 / 3)) * cell;
      ctx.fillStyle = this.rgb(colors.obstacle, alpha);
      ctx.fillRect(x0, Math.max(top, y0), x1 - x0, Math.max(4, y1 - Math.max(top, y0)));
      ctx.strokeStyle = this.rgb(colors.obstacle, now ? 0.9 : 0.4);
      ctx.strokeRect(x0 + 0.5, Math.max(top, y0) + 0.5, x1 - x0 - 1, Math.max(4, y1 - Math.max(top, y0)) - 1);
    }
    // the coming objects (farther: fainter and smaller), then the ones at the cursor
    const coming = [...editor.objects.notes.map((item) => ({ kind: 'notes' as const, item })), ...editor.objects.bombs.map((item) => ({ kind: 'bombs' as const, item }))]
      .filter(({ item }) => item.b > beat + 1e-3 && item.b <= beat + AHEAD)
      .sort((a, b) => b.item.b - a.item.b);
    for (const { kind, item } of coming) {
      const t = (item.b - beat) / AHEAD;
      const [cx, cy] = center(item.x, item.y);
      const size = cell * (0.62 - 0.3 * t);
      ctx.globalAlpha = 0.55 * (1 - t) + 0.08;
      if (kind === 'bombs') this.bomb(ctx, cx, cy, size, false);
      else this.note(ctx, item as MapNote, cx, cy, size, this.rgb(noteColor((item as MapNote).c), 1), false);
    }
    ctx.globalAlpha = 1;
    for (const kind of ['bombs', 'notes'] as const) {
      for (const item of editor.objects[kind]) {
        if (Math.abs(item.b - beat) > 1e-3) continue;
        const [cx, cy] = center(item.x, item.y);
        const picked = editor.noteSelection.has(item.id);
        if (kind === 'bombs') this.bomb(ctx, cx, cy, cell * 0.72, picked);
        else this.note(ctx, item as MapNote, cx, cy, cell * 0.72, this.rgb(noteColor((item as MapNote).c), 1), picked);
      }
    }
    // the arrow being dragged out
    const press = this.press;
    const hover = this.hoverPoint;
    if (press !== null && press.button === 0 && hover !== null && this.editor.noteTool.kind !== 'bomb' && this.editor.noteTool.kind !== 'wall') {
      const [cx, cy] = center(press.col, press.row);
      const dir = this.dragDirection(hover.x - press.x, hover.y - press.y);
      ctx.globalAlpha = 0.7;
      this.note(ctx, { id: '', b: beat, x: press.col, y: press.row, c: this.editor.noteTool.kind === 'red' ? 0 : 1, d: dir ?? this.editor.noteTool.direction, a: 0 }, cx, cy, cell * 0.72, this.rgb(noteColor(this.editor.noteTool.kind === 'red' ? 0 : 1), 1), true);
      ctx.globalAlpha = 1;
    }
  }

  private hoverPoint: { x: number; y: number } | null = null;

  private note(ctx: CanvasRenderingContext2D, note: MapNote, x: number, y: number, size: number, color: string, picked: boolean) {
    const half = size / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - half, y - half, size, size, size * 0.16);
    ctx.fill();
    ctx.strokeStyle = picked ? '#ffe27a' : 'rgba(0,0,0,0.5)';
    ctx.lineWidth = picked ? 3 : 1;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    if (note.d === 8) {
      ctx.beginPath();
      ctx.arc(x, y, size * 0.13, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const angle = (((DIR_ANGLE[note.d] ?? 270) + note.a) * Math.PI) / 180;
    const dx = Math.cos(angle);
    const dy = -Math.sin(angle);
    // (the game's arrow: a wide chevron near the edge the cut goes out of)
    const out = size * 0.36;
    const wing = size * 0.3;
    const inner = size * 0.14;
    ctx.beginPath();
    ctx.moveTo(x + dx * out - dy * wing, y + dy * out + dx * wing);
    ctx.lineTo(x + dx * out + dy * wing, y + dy * out - dx * wing);
    ctx.lineTo(x + dx * inner, y + dy * inner);
    ctx.closePath();
    ctx.fill();
  }

  private bomb(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, picked: boolean) {
    const r = size * 0.4;
    ctx.fillStyle = '#26282e';
    ctx.beginPath();
    for (let k = 0; k < 16; k++) {
      const angle = (k / 16) * Math.PI * 2;
      const radius = k % 2 === 0 ? r : r * 0.78;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = picked ? '#ffe27a' : '#9a9eaa';
    ctx.lineWidth = picked ? 3 : 1.2;
    ctx.stroke();
  }

  /** The arrow a drag out of a cell points (null: too short a drag). */
  private dragDirection(dx: number, dy: number): number | null {
    if (Math.hypot(dx, dy) < 12) return null;
    const angle = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
    const sector = Math.round(angle / 45) % 8;
    return [3, 5, 0, 4, 2, 6, 1, 7][sector]!;
  }

  private bind() {
    const canvas = this.canvas;
    const local = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('mousedown', (event) => {
      const { x, y } = local(event);
      const at = this.cellAt(x, y);
      if (at === null) return;
      event.preventDefault();
      this.press = { x, y, col: at.col, row: at.row, button: event.button };
    });
    canvas.addEventListener('mousemove', (event) => {
      const { x, y } = local(event);
      this.hoverPoint = { x, y };
      const at = this.cellAt(x, y);
      if (at?.col !== this.hoverCell?.col || at?.row !== this.hoverCell?.row) this.hoverCell = at;
      this.needsDraw = true;
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverCell = null;
      this.hoverPoint = null;
      this.needsDraw = true;
    });
    window.addEventListener('mouseup', (event) => {
      const press = this.press;
      this.press = null;
      if (press === null) return;
      this.needsDraw = true;
      const { x, y } = local(event);
      const editor = this.editor;
      const there = this.objectAt(press.col, press.row);
      if (press.button === 2) {
        if (there !== null) {
          editor.selectNotes([there.item.id]);
          editor.deleteNoteSelection();
        }
        return;
      }
      if (press.button === 1) {
        if (there !== null && there.kind === 'notes') editor.updateObjects([there.item.id], (_kind, item) => ((item as MapNote).c = 1 - (item as MapNote).c));
        return;
      }
      if (press.button !== 0) return;
      const dir = this.dragDirection(x - press.x, y - press.y);
      if (there !== null) {
        // (a drag out of a note there: its arrow turned that way; a click: it's picked)
        if (dir !== null && there.kind === 'notes') editor.updateObjects([there.item.id], (_kind, item) => ((item as MapNote).d = dir));
        else editor.selectNotes([there.item.id], event.shiftKey || event.ctrlKey ? 'toggle' : 'replace');
        return;
      }
      const beat = editor.snapBeat(editor.playhead());
      const tool = editor.noteTool;
      if (tool.kind === 'wall') {
        const crouch = editor.wallKind === 'crouch';
        editor.addObjects([{ kind: 'walls', item: { id: newId('n'), b: beat, x: press.col, y: crouch ? 2 : 0, d: editor.snap || 1, w: 1, h: crouch ? 3 : 5 } }], false);
      } else if (tool.kind === 'bomb') editor.addObjects([{ kind: 'bombs', item: { id: newId('n'), b: beat, x: press.col, y: press.row } }], false);
      else {
        const direction = dir ?? tool.direction;
        if (dir !== null) editor.noteTool = { ...tool, direction: dir };
        editor.addObjects([{ kind: 'notes', item: { id: newId('n'), b: beat, x: press.col, y: press.row, c: tool.kind === 'red' ? 0 : 1, d: direction, a: 0 } }], false);
      }
      editor.noteRow = press.row;
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const editor = this.editor;
        if (event.ctrlKey || event.metaKey) return;
        // (the wheel walks the song a grid step — up: on)
        this.wheel += event.deltaY;
        if (Math.abs(this.wheel) < 40) return;
        const step = editor.snap || 0.25;
        editor.seek(Math.max(0, editor.snapBeat(editor.playhead()) + (this.wheel < 0 ? step : -step)));
        this.wheel = 0;
      },
      { passive: false },
    );
  }
}
