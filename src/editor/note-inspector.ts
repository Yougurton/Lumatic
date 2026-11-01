import type { Editor } from './editor';
import { mirrorObjects } from './notes-timeline';
import { ROW_WALL, WALL_NAMES, WALL_SHAPES, wallKindOf, type MapArc, type MapChain, type MapNote, type MapWall } from './notes';

/**
 * The notes side's panel beside the timeline: what the difficulty has (notes, bombs, walls, arcs,
 * chains, notes a second), how fast the notes come (NJS, half jump, jump distance), and the selected
 * objects — one of them edited by hand, many mirrored, recoloured or deleted at once.
 */

const ROWS = ['Низ', 'Середина', 'Верх'];
const DIRS: [number, string][] = [
  [0, '↑'],
  [1, '↓'],
  [2, '←'],
  [3, '→'],
  [4, '↖'],
  [5, '↗'],
  [6, '↙'],
  [7, '↘'],
  [8, '• точка'],
];

/** The half jump (beats) and the jump distance (metres) as the game works them out. */
export function jumpOf(bpm: number, njs: number, offset: number) {
  const beat = 60 / bpm;
  let half = 4;
  while (njs * beat * half > 17.999) half /= 2;
  half = Math.max(half + offset, 0.25);
  return { half, distance: njs * beat * half * 2 };
}

export class NoteInspector {
  private shownKey = '';

  constructor(
    private readonly editor: Editor,
    private readonly root: HTMLElement,
  ) {
    editor.onChange(() => this.render());
    this.render();
  }

  render() {
    const editor = this.editor;
    if (editor.tab !== 'notes') return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && this.root.contains(active)) return;
    const key = `${String(editor.noteVersion)}|${[...editor.noteSelection].join(',')}|${editor.row?.key ?? ''}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    const root = this.root;
    root.replaceChildren();
    const objects = editor.objects;
    if (editor.project === null) {
      root.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: 'Откройте карту' }));
      return;
    }
    root.append(Object.assign(document.createElement('h3'), { textContent: 'Ноты сложности' }));
    const red = objects.notes.filter((note) => note.c === 0).length;
    const blue = objects.notes.length - red;
    const beats = objects.notes.map((note) => note.b);
    const span = beats.length > 1 ? editor.beatToSeconds(Math.max(...beats)) - editor.beatToSeconds(Math.min(...beats)) : 0;
    const nps = span > 0 ? objects.notes.length / span : 0;
    const stats = document.createElement('div');
    stats.className = 'ni-stats';
    const stat = (label: string, value: string, title = '') => {
      const item = document.createElement('div');
      item.title = title;
      item.append(Object.assign(document.createElement('span'), { textContent: label }), Object.assign(document.createElement('b'), { textContent: value }));
      stats.append(item);
    };
    stat('Ноты', `${String(objects.notes.length)} (${String(red)} кр. / ${String(blue)} син.)`);
    stat('Бомбы', String(objects.bombs.length));
    stat('Стены', String(objects.walls.length));
    stat('Дуги / цепи', `${String(objects.arcs.length)} / ${String(objects.chains.length)}`);
    stat('Нот в секунду', nps.toFixed(2), 'От первой ноты до последней');
    const info = editor.row?.infoDifficulty;
    if (info !== undefined) {
      const njs = info.noteJumpSpeed > 0 ? info.noteJumpSpeed : 16;
      const jump = jumpOf(editor.songBpm, njs, info.noteStartBeatOffset);
      stat('Скорость нот (NJS)', `${String(njs)}, смещение ${String(info.noteStartBeatOffset)}`, 'Меняется в свойствах карты');
      stat('Подлёт', `${jump.half.toFixed(2)} доли · ${jump.distance.toFixed(1)} м`, 'Половина времени подлёта (доли) и дальность появления нот (метры)');
    }
    root.append(stats);

    const picked = editor.selectedObjects();
    const section = document.createElement('div');
    section.className = 'ins-section';
    if (picked.length === 0) {
      section.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: 'Ничего не выделено. Клик по ноте на таймлайне или в сетке — выделить; Shift — добавить; протянуть по пустому месту — рамка.' }));
      root.append(section);
      return;
    }
    section.append(Object.assign(document.createElement('h3'), { textContent: picked.length === 1 ? 'Выделенный объект' : `Выделено: ${String(picked.length)}` }));
    const buttons = document.createElement('div');
    buttons.className = 'ni-buttons';
    const button = (label: string, title: string, run: () => void) => {
      const item = Object.assign(document.createElement('button'), { type: 'button', textContent: label, title });
      item.addEventListener('click', run);
      buttons.append(item);
    };
    button('⇋ Зеркало', 'Отразить слева направо: колонки, стрелки, цвета (M)', () => mirrorObjects(editor));
    button('◐ Цвет', 'Поменять цвет нот (средняя кнопка мыши по ноте)', () =>
      editor.updateObjects(editor.noteSelection, (kind, item) => {
        if ('c' in item) item.c = 1 - item.c;
        void kind;
      }),
    );
    button('🗑 Удалить', 'Удалить выделенное (Delete)', () => editor.deleteNoteSelection());
    if (picked.length === 2 && picked.every(({ kind }) => kind === 'notes')) {
      button('〜 Дуга', 'Дуга от первой ноты ко второй: подсказывает плавный замах между ними (V)', () => editor.makeArc());
      button('⛓ Цепь', 'Цепь: голова — первая нота, звенья тянутся до места второй (C)', () => editor.makeChain());
    }
    section.append(buttons);
    if (picked.length === 1) {
      const { kind, item } = picked[0]!;
      const form = document.createElement('div');
      form.className = 'ni-form';
      const field = (label: string, input: HTMLElement) => {
        const line = document.createElement('label');
        line.append(Object.assign(document.createElement('span'), { textContent: label }), input);
        form.append(line);
      };
      const number = (value: number, step: number, set: (value: number) => void) => {
        const input = Object.assign(document.createElement('input'), { type: 'number', step: String(step), value: String(value) });
        input.addEventListener('change', () => {
          const next = Number(input.value.replace(',', '.'));
          if (Number.isFinite(next)) editor.updateObjects([item.id], () => set(next));
        });
        return input;
      };
      const select = (options: [number, string][], value: number, set: (value: number) => void) => {
        const input = document.createElement('select');
        for (const [optionValue, text] of options) input.append(Object.assign(document.createElement('option'), { value: String(optionValue), textContent: text }));
        input.value = String(value);
        input.addEventListener('change', () => editor.updateObjects([item.id], () => set(Number(input.value))));
        return input;
      };
      field('Доля', number(item.b, editor.snap || 0.25, (value) => (item.b = Math.max(0, value))));
      if (kind === 'arcs') {
        const arc = item as MapArc;
        field('Конец (доля)', number(arc.tb, editor.snap || 0.25, (value) => (arc.tb = Math.max(arc.b, value))));
        field('Сила у головы', number(arc.mu, 0.1, (value) => (arc.mu = value)));
        field('Сила у хвоста', number(arc.tmu, 0.1, (value) => (arc.tmu = value)));
        field('Середина', select([[0, 'Прямо'], [1, 'По часовой'], [2, 'Против часовой']], arc.m, (value) => (arc.m = value)));
        field('Направление хвоста', select(DIRS, arc.tc, (value) => (arc.tc = value)));
      } else if (kind === 'chains') {
        const chain = item as MapChain;
        field('Конец (доля)', number(chain.tb, editor.snap || 0.25, (value) => (chain.tb = Math.max(chain.b, value))));
        field('Звеньев', number(chain.sc, 1, (value) => (chain.sc = Math.max(2, Math.min(32, Math.round(value))))));
        field('Сжатие', number(chain.s, 0.1, (value) => (chain.s = Math.max(0.05, Math.min(1, value)))));
        field('Направление', select(DIRS.slice(0, 8), chain.d, (value) => (chain.d = value)));
      } else if (kind === 'walls') {
        const wall = item as MapWall;
        field('Длина (доли)', number(wall.d, editor.snap || 0.25, (value) => (wall.d = Math.max(0, value))));
        field('Колонка', select([0, 1, 2, 3].map((x) => [x, String(x + 1)]), wall.x, (value) => (wall.x = Math.min(value, 4 - wall.w))));
        field('Ширина', select([1, 2, 3, 4].map((w) => [w, String(w)]), wall.w, (value) => (wall.w = Math.min(value, 4 - wall.x))));
        field('Вид', select(ROW_WALL.map((kind, index) => [index, WALL_NAMES[kind]]), ROW_WALL.indexOf(wallKindOf(wall)), (value) => Object.assign(wall, WALL_SHAPES[ROW_WALL[value]!])));
      } else {
        field('Колонка', select([0, 1, 2, 3].map((x) => [x, String(x + 1)]), item.x, (value) => (item.x = value)));
        field('Ряд', select([0, 1, 2].map((y) => [y, ROWS[y]!]), (item as MapNote).y, (value) => ((item as MapNote).y = value)));
        if (kind === 'notes') {
          const note = item as MapNote;
          field('Цвет', select([[0, 'Красная (левая)'], [1, 'Синяя (правая)']], note.c, (value) => (note.c = value)));
          field('Направление', select(DIRS, note.d, (value) => (note.d = value)));
          field('Поворот стрелки, °', number(note.a, 15, (value) => (note.a = value)));
        }
      }
      section.append(form);
    }
    root.append(section);
  }
}
