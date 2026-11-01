import type { Editor } from './editor';
import { mirrorObjects } from './notes-timeline';
import { jumpOf, jumpWarnings } from './jump';
import { CHECK_RULES, type MapIssue } from './checks';
import { onSettings, settings } from './settings';
import { WALL_NAMES, type WallKind, WALL_SHAPES, wallKindOf, type MapArc, type MapChain, type MapNote, type MapWall } from './notes';

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

export { jumpOf } from './jump';

export class NoteInspector {
  private shownKey = '';

  constructor(
    private readonly editor: Editor,
    private readonly root: HTMLElement,
  ) {
    editor.onChange(() => this.render());
    onSettings((now, before) => {
      if (now.disabledChecks === before.disabledChecks && now.checkPreset === before.checkPreset) return;
      this.shownKey = '';
      this.render();
    });
    this.render();
  }

  /** The panel's tab: the selected objects, the checker's finds, the difficulty's numbers. */
  private view: 'picked' | 'issues' | 'stats' = 'picked';
  private shownSelection = '';
  private shownIssues: MapIssue[] | null = null;
  /** A click on a find selects what's at fault — and stays on the finds. */
  private keepView = false;

  render() {
    const editor = this.editor;
    if (editor.tab !== 'notes') return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && this.root.contains(active)) return;
    const issues = editor.project === null ? [] : editor.mapIssues();
    const selection = [...editor.noteSelection].join(',');
    const key = `${String(editor.noteVersion)}|${selection}|${editor.row?.key ?? ''}|${this.view}`;
    if (key === this.shownKey && issues === this.shownIssues) return;
    if (selection !== this.shownSelection) {
      if (selection !== '' && !this.keepView) this.view = 'picked';
      this.keepView = false;
      this.shownSelection = selection;
    }
    this.shownKey = `${String(editor.noteVersion)}|${selection}|${editor.row?.key ?? ''}|${this.view}`;
    this.shownIssues = issues;
    const root = this.root;
    root.replaceChildren();
    if (editor.project === null) {
      root.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: 'Откройте карту' }));
      return;
    }
    const errors = issues.filter((issue) => issue.level === 'error').length;
    const warnings = issues.filter((issue) => issue.level === 'warn').length + this.jumpIssues().length;
    const tabs = document.createElement('div');
    tabs.className = 'ni-tabs';
    const tab = (id: typeof this.view, label: string, badge?: HTMLElement) => {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
      button.classList.toggle('active', this.view === id);
      if (badge !== undefined) button.append(badge);
      button.addEventListener('click', () => {
        this.view = id;
        this.render();
      });
      tabs.append(button);
    };
    tab('picked', editor.noteSelection.size > 0 ? `Выделено (${String(editor.noteSelection.size)})` : 'Выделено');
    const badge = document.createElement('span');
    badge.className = 'ni-badge';
    if (errors > 0) badge.append(Object.assign(document.createElement('b'), { className: 'bad', textContent: String(errors) }));
    if (warnings > 0) badge.append(Object.assign(document.createElement('b'), { className: 'warn', textContent: String(warnings) }));
    if (errors + warnings === 0) badge.append(Object.assign(document.createElement('b'), { className: 'ok', textContent: '✓' }));
    tab('issues', 'Ошибки', badge);
    tab('stats', 'Статистика');
    root.append(tabs);
    if (this.view === 'issues') root.append(this.checks());
    else if (this.view === 'stats') root.append(this.stats());
    else root.append(this.picked());
  }

  /** What BSMG's tables say about the difficulty's NJS, jump and notes a second. */
  private jumpIssues() {
    const editor = this.editor;
    const info = editor.row?.infoDifficulty;
    if (info === undefined || settings().disabledChecks.includes('jump')) return [];
    const njs = info.noteJumpSpeed > 0 ? info.noteJumpSpeed : 16;
    const jump = jumpOf(editor.songBpm, njs, info.noteStartBeatOffset);
    return jumpWarnings(info.difficulty, njs, jump.distance, jump.reaction, this.nps());
  }

  private nps() {
    const editor = this.editor;
    const beats = editor.objects.notes.map((note) => note.b);
    const span = beats.length > 1 ? editor.beatToSeconds(Math.max(...beats)) - editor.beatToSeconds(Math.min(...beats)) : 0;
    return span > 0 ? beats.length / span : 0;
  }

  /** The difficulty's numbers. */
  private stats() {
    const editor = this.editor;
    const objects = editor.objects;
    const red = objects.notes.filter((note) => note.c === 0).length;
    const blue = objects.notes.length - red;
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
    stat('Нот в секунду', this.nps().toFixed(2), 'От первой ноты до последней');
    const info = editor.row?.infoDifficulty;
    if (info !== undefined) {
      const njs = info.noteJumpSpeed > 0 ? info.noteJumpSpeed : 16;
      const jump = jumpOf(editor.songBpm, njs, info.noteStartBeatOffset);
      stat('Скорость нот (NJS)', `${String(njs)}, смещение ${String(info.noteStartBeatOffset)}`, 'Меняется в свойствах карты');
      stat('Подлёт', `${jump.half.toFixed(2)} доли · ${jump.distance.toFixed(1)} м`, 'Половина времени подлёта (доли) и дальность появления нот (метры)');
      stat('Время реакции', `${String(Math.round(jump.reaction))} мс`, 'Сколько нота видна до удара');
      for (const warning of this.jumpIssues()) stats.append(Object.assign(document.createElement('div'), { className: `jump-${warning.level}`, textContent: `⚠ ${warning.text}` }));
    }
    return stats;
  }

  /** The selected objects: what can be done with them, and one of them edited by hand. */
  private picked() {
    const editor = this.editor;
    const picked = editor.selectedObjects();
    const section = document.createElement('div');
    section.className = 'ins-section';
    if (picked.length === 0) {
      section.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: 'Ничего не выделено. Клик по ноте на таймлайне или в сетке — выделить; Shift — добавить; протянуть по пустому месту — рамка.' }));
      return section;
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
        const kinds: WallKind[] = wallKindOf(wall) === 'deep' ? ['full', 'deep', 'crouch'] : ['full', 'crouch'];
        field('Вид', select(kinds.map((kind, index) => [index, WALL_NAMES[kind]]), kinds.indexOf(wallKindOf(wall)), (value) => Object.assign(wall, WALL_SHAPES[kinds[value]!])));
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
    const walls = picked.filter(({ kind }) => kind === 'walls').map(({ item }) => item as MapWall);
    if (walls.length > 0) section.append(this.strobeForm(walls));
    return section;
  }

  /** The selected walls made into strobes: up to which beat, how often, how long each flash. */
  private strobeForm(walls: MapWall[]) {
    const editor = this.editor;
    const box = document.createElement('div');
    box.className = 'ni-strobe';
    box.append(Object.assign(document.createElement('h3'), { textContent: walls.length === 1 ? 'Строб из стены' : `Строб из стен (${String(walls.length)})` }));
    const form = document.createElement('div');
    form.className = 'ni-form';
    const line = (label: string, input: HTMLElement) => {
      const item = document.createElement('label');
      item.append(Object.assign(document.createElement('span'), { textContent: label }), input);
      form.append(item);
    };
    const start = Math.min(...walls.map((wall) => wall.b));
    const until = Object.assign(document.createElement('input'), { type: 'number', step: 'any', value: String(Math.round((start + 4) * 1000) / 1000) });
    const step = strobeStepSelect(editor.wallStrobe.step);
    const fill = Object.assign(document.createElement('input'), { type: 'number', min: '5', max: '100', step: '5', value: String(Math.round(editor.wallStrobe.fill * 100)) });
    line('До доли', until);
    line('Шаг', step);
    line('Длина стены, % шага', fill);
    const go = Object.assign(document.createElement('button'), { type: 'button', textContent: '⚡ Сделать строб', title: 'Каждая выделенная стена повторится с этим шагом до указанной доли' });
    go.addEventListener('click', () => {
      const end = Number(until.value.replace(',', '.'));
      const every = Number(step.value);
      const part = Number(fill.value) / 100;
      if (!Number.isFinite(end) || !(every > 0) || !(part > 0)) return;
      editor.wallStrobe = { ...editor.wallStrobe, step: every, fill: part };
      editor.strobeSelectedWalls(end, every, part);
    });
    box.append(form, go);
    return box;
  }

  /** The map checker's finds: how many, and each one (a click goes there and selects what's at fault). */
  private checks() {
    const editor = this.editor;
    const issues = editor.mapIssues();
    const box = document.createElement('div');
    box.className = 'ins-section ni-checks';
    const jump = this.jumpIssues();
    const errors = issues.filter((issue) => issue.level === 'error').length;
    const warnings = issues.filter((issue) => issue.level === 'warn').length + jump.length;
    const head = document.createElement('h3');
    head.textContent = 'Проверка карты';
    const summary = document.createElement('span');
    summary.className = 'ni-check-sum';
    summary.textContent = errors + warnings === 0 ? '✓ всё в порядке' : `${String(errors)} ош. · ${String(warnings)} пред.`;
    summary.classList.toggle('bad', errors > 0);
    summary.classList.toggle('ok', errors + warnings === 0);
    head.append(' ', summary);
    box.append(head);
    for (const warning of jump) box.append(Object.assign(document.createElement('div'), { className: `jump-${warning.level}`, textContent: `⚠ ${warning.text}` }));
    if (issues.length === 0) {
      box.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: 'Правила BSMG, BeatLeader и ScoreSaber. Отключить отдельные — в настройках, «Проверка карты».' }));
      return box;
    }
    const list = document.createElement('div');
    list.className = 'ni-check-list';
    const names = new Map(CHECK_RULES.map((rule) => [rule.id, rule]));
    const item = (issue: MapIssue) => {
      const line = document.createElement('button');
      line.type = 'button';
      line.className = `ni-check ni-check-${issue.level}`;
      const rule = names.get(issue.rule);
      line.title = rule === undefined ? '' : `${rule.name} (${rule.source}): ${rule.about}`;
      const where = Object.assign(document.createElement('b'), { textContent: (Math.round(issue.beat * 100) / 100).toString() });
      line.append(Object.assign(document.createElement('span'), { className: 'ni-check-icon', textContent: issue.level === 'error' ? '⛔' : issue.level === 'warn' ? '⚠' : 'ℹ' }), where, Object.assign(document.createElement('span'), { textContent: issue.text }));
      line.addEventListener('click', () => {
        editor.seek(Math.max(0, issue.beat));
        const ids = issue.ids.filter((id) => editor.objectById(id) !== null);
        if (ids.length > 0 && ids.join(',') !== [...editor.noteSelection].join(',')) {
          this.keepView = true;
          editor.selectNotes(ids);
        }
      });
      return line;
    };
    const shown = 60;
    list.append(...issues.slice(0, shown).map(item));
    if (issues.length > shown) {
      const more = Object.assign(document.createElement('button'), { type: 'button', className: 'ni-check-more', textContent: `Показать все (${String(issues.length)})` });
      more.addEventListener('click', () => {
        more.remove();
        list.append(...issues.slice(shown).map(item));
      });
      list.append(more);
    }
    box.append(list);
    return box;
  }
}

/** The strobe's steps (beats). */
export function strobeStepSelect(value: number) {
  const select = document.createElement('select');
  for (const [text, step] of [
    ['1', 1],
    ['1/2', 0.5],
    ['1/3', 1 / 3],
    ['1/4', 0.25],
    ['1/6', 1 / 6],
    ['1/8', 0.125],
    ['1/12', 1 / 12],
    ['1/16', 0.0625],
  ] as const)
    select.append(Object.assign(document.createElement('option'), { value: String(step), textContent: text }));
  select.value = String(value);
  if (select.selectedIndex < 0) select.value = '0.25';
  return select;
}
