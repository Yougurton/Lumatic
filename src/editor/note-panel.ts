import { tr } from './i18n';
import type { Editor } from './editor';
import { objectRightClick } from './object-menu';
import { ROW_WALL, WALL_SHAPES, wallFootprint, type MapNote } from './notes';
import { drawGameNote } from './note-draw';
import { newId } from './model';
import { strobeStepSelect } from './note-inspector';
import { onSettings, setSettings, settings } from './settings';

/**
 * The notes side's corner (where the lights side has its effects): the grid 4×3 as the player sees it,
 * at the song cursor (as ChroMapper's little grid). What's at the cursor is drawn whole; each hand's
 * note before it faded — where the swing comes from. A click on a cell puts in what the tool is (a drag from it: the arrow that way);
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

/** How comfortable each cut direction is for the right hand's next swing (0: awkward, 1: easy): after
 *  a backhand (a swing up) comes a forehand, after a forehand a backhand (BSMG's swing wheels). The
 *  left hand: the same mirrored. */
const FOREHAND: Record<number, number> = { 0: 0.25, 5: 0.08, 3: 0.5, 7: 0.8, 1: 1, 6: 0.95, 2: 0.7, 4: 0.4 };
const BACKHAND: Record<number, number> = { 0: 1, 5: 0.95, 3: 0.8, 7: 0.7, 1: 0.25, 6: 0.05, 2: 0.35, 4: 0.5 };
const MIRROR_DIR: Record<number, number> = { 0: 0, 1: 1, 2: 3, 3: 2, 4: 5, 5: 4, 6: 7, 7: 6 };

/** For the tool's hand, how comfortable each direction is after its last note before `beat` (none:
 *  no note before, or a dot). */
export function directionComfort(notes: readonly { b: number; c: number; d: number }[], color: number, beat: number): Record<number, number> | null {
  let last: { b: number; d: number } | undefined;
  for (const note of notes) if (note.c === color && note.b < beat - 1e-6 && (last === undefined || note.b > last.b)) last = note;
  if (last === undefined || last.d === 8) return null;
  const own = (direction: number) => (color === 0 ? MIRROR_DIR[direction]! : direction);
  const d = own(last.d);
  // (the last swing: the wheel it sits better on)
  const wasForehand = (FOREHAND[d] ?? 0) >= (BACKHAND[d] ?? 0);
  const wheel = wasForehand ? BACKHAND : FOREHAND;
  const out: Record<number, number> = {};
  for (let direction = 0; direction < 8; direction++) out[direction] = wheel[own(direction)] ?? 0.5;
  return out;
}

/** How far back (beats) the notes before the cursor are looked for. */
const BACK = 4;
/** How far ahead (beats) the coming walls show through. */
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
    this.canvas.title = 'Сетка 4×3 на доле курсора, как её видит игрок; предыдущая нота каждой руки — бледная.\nКлик — поставить, потянуть из клетки — стрелка в ту сторону, ПКМ — удалить, средняя кнопка — другой цвет.\nКолёсико — шаг сетки по песне. 1/2/3/4 — красная, синяя, бомба, стена; W/A/S/D/F — направление (две сразу — диагональ).';
    root.append(this.tools, this.label, this.canvas, this.volumeRow('Громкость песни', 'volume'), this.volumeRow('Удары нот', 'noteHitVolume'), this.scaleRow());
    this.renderTools();
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    editor.onChange(() => {
      this.renderTools();
      this.needsDraw = true;
    });
    // (the cursor moved: the directions' colours follow the notes before it)
    let toolsBeat = Number.NaN;
    const watch = () => {
      const beat = editor.snapBeat(editor.playhead());
      if (beat !== toolsBeat && editor.tab === 'notes') {
        toolsBeat = beat;
        this.renderTools();
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
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

  /** A loudness slider (0–100 %): the song's, the notes' hit sound's. */
  private volumeRow(name: string, key: 'volume' | 'noteHitVolume') {
    const row = document.createElement('label');
    row.className = 'np-scale';
    const input = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '1', step: '0.05', value: String(settings()[key]) });
    const value = Object.assign(document.createElement('span'), { className: 'ins-value' });
    const show = () => (value.textContent = `${String(Math.round(Number(input.value) * 100))}%`);
    show();
    input.addEventListener('input', () => {
      show();
      setSettings({ [key]: Number(input.value) });
    });
    input.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        input.value = String(Math.min(1, Math.max(0, Number(input.value) + (event.deltaY < 0 ? 0.05 : -0.05))));
        input.dispatchEvent(new Event('input'));
      },
      { passive: false },
    );
    // (changed elsewhere — the settings window: shown here too)
    onSettings((now) => {
      if (document.activeElement !== input && Number(input.value) !== now[key]) {
        input.value = String(now[key]);
        show();
      }
    });
    row.append(Object.assign(document.createElement('span'), { textContent: name }), input, value);
    return row;
  }

  /** The 3D track's scale: metres a beat (longer: the notes farther apart along it). */
  private scaleRow() {
    const row = document.createElement('label');
    row.className = 'np-scale';
    row.title = 'Масштаб 3D-дорожки: насколько далеко друг от друга стоят доли (колёсико над ползунком тоже работает)';
    const input = Object.assign(document.createElement('input'), { type: 'range', min: '0.4', max: '5', step: '0.1', value: String(settings().trackScale) });
    const value = Object.assign(document.createElement('span'), { className: 'ins-value' });
    const show = () => (value.textContent = `${Number(input.value).toFixed(1)} м/доля`);
    show();
    input.addEventListener('input', () => {
      show();
      setSettings({ trackScale: Number(input.value) });
    });
    input.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        input.value = String(Math.min(5, Math.max(0.4, Number(input.value) + (event.deltaY < 0 ? 0.1 : -0.1))));
        input.dispatchEvent(new Event('input'));
      },
      { passive: false },
    );
    row.append(Object.assign(document.createElement('span'), { textContent: 'Масштаб дорожки' }), input, value);
    return row;
  }

  /** The tools and the direction pad (drawn again when the tool changes). */
  renderTools() {
    const editor = this.editor;
    const tool = editor.noteTool;
    const scheme = editor.preview.colors;
    // (the directions coloured by how well they follow the hand's last note before the cursor)
    const comfort = tool.kind === 'red' || tool.kind === 'blue' ? directionComfort(editor.objects.notes, tool.kind === 'red' ? 0 : 1, editor.snapBeat(editor.playhead())) : null;
    const key = `${tool.kind}|${String(tool.direction)}|${editor.wallKind}|${JSON.stringify(editor.wallStrobe)}|${[...scheme.leftNote, ...scheme.rightNote, ...scheme.obstacle].join(',')}|${JSON.stringify(comfort)}`;
    if (this.tools.dataset.key === key) return;
    this.tools.dataset.key = key;
    const colors = editor.preview.colors;
    const css = (rgb: readonly number[]) => `rgb(${rgb.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')})`;
    // the four tools in a row, square, as the game's things: the left hand's note, the right hand's, a
    // bomb, a wall
    const row = document.createElement('div');
    row.className = 'np-tools4';
    for (const item of [
      { kind: 'red' as const, label: '◀ Левая', title: 'Левая рука — красная нота (1)', key: '1', color: colors.leftNote },
      { kind: 'blue' as const, label: 'Правая ▶', title: 'Правая рука — синяя нота (2)', key: '2', color: colors.rightNote },
      { kind: 'bomb' as const, label: 'Бомба', title: 'Бомба (3)', key: '3', color: [0.2, 0.21, 0.24] },
      { kind: 'wall' as const, label: 'Стена', title: 'Стена (4)', key: '4', color: colors.obstacle },
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'np-tool';
      button.classList.toggle('active', tool.kind === item.kind);
      button.title = item.title;
      button.append(toolIcon(item.kind, item.color, css), Object.assign(document.createElement('kbd'), { textContent: item.key }));
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
      const ease = comfort?.[item.dir];
      if (ease !== undefined) {
        // (green: follows the last swing well … red: awkward)
        button.style.background = `hsl(${String(Math.round(ease * 120))} 65% ${tool.direction === item.dir ? '42%' : '26%'})`;
        button.title += ' ' + (ease >= 0.75 ? tr('— удобно после прошлой ноты') : ease >= 0.4 ? tr('— можно') : tr('— неудобно после прошлой ноты'));
      }
      button.addEventListener('click', () => editor.setNoteDirection(item.dir));
      pad.append(button);
    }
    const side = document.createElement('div');
    side.className = 'np-side';
    if (tool.kind === 'wall') {
      for (const [kind, label, title] of [
        ['full', 'Полная', 'Стена во весь рост: от неё уходят в сторону (на 3D-стене — нижний ряд)'],
        ['crouch', 'Присед', 'Стена-присед из игры (на 3D-стене — средний и верхний ряды)'],
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
      // a strobe: the wall drawn along the timeline becomes short walls one after another
      const strobe = document.createElement('div');
      strobe.className = 'np-strobe';
      const on = Object.assign(document.createElement('input'), { type: 'checkbox', checked: editor.wallStrobe.on });
      const toggle = document.createElement('label');
      toggle.title = 'Протянутая по таймлайну стена станет рядом коротких стен с этим шагом (как строб у света)';
      toggle.append(on, ' ⚡ Строб');
      const step = strobeStepSelect(editor.wallStrobe.step);
      step.title = 'Шаг строба (доли)';
      const fill = Object.assign(document.createElement('input'), { type: 'number', min: '5', max: '100', step: '5', value: String(Math.round(editor.wallStrobe.fill * 100)) });
      fill.title = 'Длина каждой стены, % шага';
      const apply = () => {
        const part = Number(fill.value) / 100;
        editor.wallStrobe = { on: on.checked, step: Number(step.value) || 0.25, fill: part > 0 ? Math.min(1, part) : editor.wallStrobe.fill };
        editor.emit('selection');
      };
      on.addEventListener('change', apply);
      step.addEventListener('change', apply);
      fill.addEventListener('change', apply);
      strobe.append(toggle, step, fill, '%');
      side.append(strobe);
      side.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: editor.wallStrobe.on ? 'Строб: протяните по дорожкам таймлайна — получится ряд коротких стен. Из выделенной стены — кнопка в панели «Выделено».' : 'На 3D-стене и в сетке: нижний ряд — полная стена, выше — присед; протянуть вбок — шире. На таймлайне концы стены тянутся.' }));
    } else {
      side.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: 'W/A/S/D, F — точка; две сразу — диагональ. У выделенных нот меняется тоже.' }));
    }
    this.tools.replaceChildren(row, Object.assign(document.createElement('div'), { className: 'np-row' }), this.generatorRow());
    this.tools.lastElementChild!.previousElementSibling!.append(pad, side);
  }

  /** How many notes of each hand the generator makes at the cursor's beat. */
  private generateRed = 1;
  private generateBlue = 1;

  /** The note generator: so many red and blue notes at the cursor, made to fit what's before them —
   *  "another" for the next pattern in their place. */
  private generatorRow() {
    const editor = this.editor;
    const box = document.createElement('div');
    box.className = 'np-generator';
    const count = (value: number, color: string, set: (next: number) => void) => {
      const input = Object.assign(document.createElement('input'), { type: 'number', min: '0', max: '4', step: '1', value: String(value) });
      input.style.borderColor = color;
      input.title = 'Сколько нот этой руки (0–4)';
      input.addEventListener('change', () => set(Math.max(0, Math.min(4, Math.round(Number(input.value) || 0)))));
      return input;
    };
    const css = (rgb: readonly number[]) => `rgb(${rgb.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')})`;
    const make = document.createElement('button');
    make.type = 'button';
    make.textContent = '🎲 Сгенерировать';
    make.title = 'Ноты на доле курсора по парности и правилам: каждая рука — в другую сторону от своей прошлой ноты, на своей стороне, без перекрёстков и закрытого обзора';
    make.addEventListener('click', () => editor.generateNotes(this.generateRed, this.generateBlue, false));
    const other = document.createElement('button');
    other.type = 'button';
    other.textContent = '↻ Другой';
    other.title = 'Другой подходящий паттерн на их месте';
    other.addEventListener('click', () => editor.generateNotes(this.generateRed, this.generateBlue, true));
    box.append(
      Object.assign(document.createElement('span'), { className: 'nm-dim', textContent: 'Генератор:' }),
      count(this.generateRed, css(editor.preview.colors.leftNote), (next) => (this.generateRed = next)),
      count(this.generateBlue, css(editor.preview.colors.rightNote), (next) => (this.generateBlue = next)),
      make,
      other,
    );
    return box;
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
      // (Noodle's walls where their coordinates and size put them)
      const shape = wall.customData === undefined ? wall : wallFootprint(wall);
      const x0 = left + Math.max(0, shape.x) * cell;
      const x1 = left + Math.min(4, shape.x + shape.w) * cell;
      if (x1 <= x0) continue;
      const y0 = top + Math.max(0, 3 - (shape.y + shape.h) / (5 / 3)) * cell;
      const y1 = top + Math.min(3, 3 - shape.y / (5 / 3)) * cell;
      if (y1 <= y0) continue;
      ctx.fillStyle = this.rgb(colors.obstacle, alpha);
      ctx.fillRect(x0, Math.max(top, y0), x1 - x0, Math.max(4, y1 - Math.max(top, y0)));
      ctx.strokeStyle = this.rgb(colors.obstacle, now ? 0.9 : 0.4);
      ctx.strokeRect(x0 + 0.5, Math.max(top, y0) + 0.5, x1 - x0 - 1, Math.max(4, y1 - Math.max(top, y0)) - 1);
    }
    // the notes before the cursor (as in ChroMapper: the last ones of each hand, faded), then the ones
    // at the cursor
    const all = [...editor.objects.notes.map((item) => ({ kind: 'notes' as const, item })), ...editor.objects.bombs.map((item) => ({ kind: 'bombs' as const, item }))];
    const before = all.filter(({ item }) => item.b < beat - 1e-3 && item.b >= beat - BACK);
    const lastOf = (color: number) => Math.max(-Infinity, ...before.filter(({ kind, item }) => kind === 'notes' && (item as MapNote).c === color).map(({ item }) => item.b));
    const lastRed = lastOf(0);
    const lastBlue = lastOf(1);
    const previous = before.filter(({ kind, item }) => (kind === 'notes' ? Math.abs(item.b - ((item as MapNote).c === 0 ? lastRed : lastBlue)) < 1e-3 : Math.abs(item.b - Math.max(lastRed, lastBlue)) < 1e-3));
    for (const { kind, item } of previous) {
      const [cx, cy] = center(item.x, item.y);
      ctx.globalAlpha = 0.32;
      if (kind === 'bombs') this.bomb(ctx, cx, cy, cell * 0.6, false);
      else this.note(ctx, item as MapNote, cx, cy, cell * 0.6, this.rgb(noteColor((item as MapNote).c), 1), false);
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
    // the arrow being dragged out (a wall: the wall, as wide as the drag)
    const press = this.press;
    const hover = this.hoverPoint;
    if (press !== null && press.button === 0 && this.editor.noteTool.kind === 'wall') {
      const to = hover === null ? press.col : (this.cellAt(hover.x, hover.y)?.col ?? press.col);
      const crouch = (ROW_WALL[press.row] ?? 'full') === 'crouch';
      const x0 = left + Math.min(press.col, to) * cell;
      const wide = (Math.abs(to - press.col) + 1) * cell;
      ctx.fillStyle = this.rgb(colors.obstacle, 0.45);
      ctx.fillRect(x0 + 2, top + 2, wide - 4, (crouch ? cell : cell * 3) - 4);
      ctx.strokeStyle = this.rgb(colors.obstacle, 1);
      ctx.lineWidth = 2;
      ctx.strokeRect(x0 + 2, top + 2, wide - 4, (crouch ? cell : cell * 3) - 4);
    }
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
    drawGameNote(ctx, note, x, y, size, color, picked, note.id === '' ? undefined : this.editor.noteRoll(note.id));
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
        if (there !== null) objectRightClick(editor, event.clientX, event.clientY, there);
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
        // (the top row: a crouch wall, lower: a full one; dragged sideways: as wide as the drag went)
        const to = this.cellAt(x, y)?.col ?? press.col;
        editor.addObjects([{ kind: 'walls', item: { id: newId('n'), b: beat, x: Math.min(press.col, to), ...WALL_SHAPES[ROW_WALL[press.row] ?? 'full'], d: editor.snap || 1, w: Math.abs(to - press.col) + 1 } }], false);
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

/** A tool's picture, as the game's thing: a note (a rounded cube, lit from above, with its arrow), a
 *  bomb, a wall. */
function toolIcon(kind: 'red' | 'blue' | 'bomb' | 'wall', color: readonly number[], css: (rgb: readonly number[]) => string) {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.className = `np-icon np-icon-${kind}`;
  const ctx = canvas.getContext('2d')!;
  const shade = (k: number, alpha = 1) => {
    const rgb = color.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v * k)) * 255));
    return `rgba(${rgb.join(',')},${String(alpha)})`;
  };
  void css;
  if (kind === 'red' || kind === 'blue') {
    // the game's block seen face on (its front only, the whole button): a soft rounded square lit from
    // above, the white arrow a wide flat chevron along its top edge pointing down
    const pad = 3;
    const s = size - pad * 2;
    ctx.beginPath();
    ctx.roundRect(pad, pad, s, s, s * 0.2);
    const body = ctx.createLinearGradient(0, pad, 0, pad + s);
    body.addColorStop(0, shade(1.18));
    body.addColorStop(0.12, shade(1.05));
    body.addColorStop(0.75, shade(0.92));
    body.addColorStop(1, shade(0.78));
    ctx.fillStyle = body;
    ctx.fill();
    // the rounded edge: lighter at the top, darker at the sides and bottom
    const rim = ctx.createRadialGradient(size / 2, size / 2, s * 0.32, size / 2, size / 2, s * 0.72);
    rim.addColorStop(0, 'rgba(0,0,0,0)');
    rim.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = rim;
    ctx.fill();
    const gloss = ctx.createLinearGradient(0, pad, 0, pad + s * 0.18);
    gloss.addColorStop(0, 'rgba(255,255,255,0.45)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss;
    ctx.beginPath();
    ctx.roundRect(pad + s * 0.08, pad + 1, s * 0.84, s * 0.18, s * 0.08);
    ctx.fill();
    // the arrow: a wide band at the top narrowing to a point below it
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(pad + s * 0.17, pad + s * 0.17);
    ctx.lineTo(pad + s * 0.83, pad + s * 0.17);
    ctx.lineTo(pad + s * 0.83, pad + s * 0.22);
    ctx.lineTo(pad + s * 0.5, pad + s * 0.36);
    ctx.lineTo(pad + s * 0.17, pad + s * 0.22);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'bomb') {
    // schematic: a dark ball with eight spikes
    const cx = size / 2;
    const cy = size / 2;
    ctx.strokeStyle = '#c3c7d2';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (let k = 0; k < 8; k++) {
      const angle = (k / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * 20, cy + Math.sin(angle) * 20);
      ctx.lineTo(cx + Math.cos(angle) * 36, cy + Math.sin(angle) * 36);
      ctx.stroke();
    }
    ctx.fillStyle = '#2a2d35';
    ctx.beginPath();
    ctx.arc(cx, cy, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.stroke();
  } else {
    // schematic: a wall seen face on, a frame in its colour over a see-through fill, hatched
    const x = 22;
    const y = 10;
    const w = 52;
    const h = 76;
    ctx.fillStyle = shade(1, 0.28);
    ctx.fillRect(x, y, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = shade(1.3, 0.45);
    ctx.lineWidth = 3;
    for (let k = -h; k < w; k += 14) {
      ctx.beginPath();
      ctx.moveTo(x + k, y + h);
      ctx.lineTo(x + k + h, y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = shade(1.5);
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeRect(x, y, w, h);
  }
  return canvas;
}
