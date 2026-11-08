import type { Editor } from './editor';
import { matchObjects, type NoteCriteria } from './note-filter';
import { allObjects, objectSpan, type ObjectKind } from './notes';

const KINDS: [ObjectKind, string][] = [
  ['notes', 'Ноты'],
  ['bombs', 'Бомбы'],
  ['walls', 'Стены'],
  ['arcs', 'Дуги'],
  ['chains', 'Цепи'],
];
/** The directions as the grid shows them: up-left, up, up-right / left, dot, right / down-left… */
const DIRECTIONS: [number, string][] = [
  [4, '↖'],
  [0, '↑'],
  [5, '↗'],
  [2, '←'],
  [8, '•'],
  [3, '→'],
  [6, '↙'],
  [1, '↓'],
  [7, '↘'],
];

/**
 * "Select by…" on the notes side: the notes, bombs, walls, arcs and chains of these kinds, colours,
 * directions, columns and rows within a stretch of beats — instead of what is selected, added to it or
 * only the selected ones that fit.
 */
export function noteSelectDialog(editor: Editor) {
  if (editor.row === null) return;
  const range = editor.songRange;
  const every = allObjects(editor.objects);
  const last = Math.ceil(Math.max(0, ...every.map(({ kind, item }) => objectSpan(kind, item)[1])));
  const from = range !== null ? Math.min(range.start, range.end) : 0;
  const to = range !== null ? Math.max(range.start, range.end) : last;
  const round = (value: number) => String(Math.round(value * 1000) / 1000);

  const shade = document.createElement('div');
  shade.className = 'ce-shade';
  const box = document.createElement('div');
  box.className = 'ce-dialog adjust-dialog note-select';
  const toggles = (name: string, items: [number | string, string][]) => items.map(([value, label]) => `<label class="ns-toggle"><input type="checkbox" data-${name}="${String(value)}" checked><span>${label}</span></label>`).join('');
  box.innerHTML = `
    <div class="ce-dialog-title">Выделить объекты</div>
    <div class="adjust-pair">
      <label>С доли <input type="number" data-id="from" step="0.25" min="0" value="${round(from)}"></label>
      <label>По долю <input type="number" data-id="to" step="0.25" min="0" value="${round(to)}"></label>
      <button type="button" data-id="whole">вся песня</button>
    </div>
    <div class="adjust-head">Что</div>
    <div class="ns-row">${toggles('kind', KINDS)}</div>
    <div class="adjust-head">Цвет</div>
    <div class="ns-row">${toggles('color', [
      [0, 'Красные'],
      [1, 'Синие'],
    ])}</div>
    <div class="ns-columns">
      <div>
        <div class="adjust-head">Направление <button type="button" data-id="dirs">все</button></div>
        <div class="ns-dirs">${toggles('dir', DIRECTIONS)}</div>
      </div>
      <div>
        <div class="adjust-head">Колонки</div>
        <div class="ns-row">${toggles('col', [0, 1, 2, 3].map((col) => [col, String(col + 1)]))}</div>
        <div class="adjust-head">Ряды (снизу)</div>
        <div class="ns-row">${toggles('row', [0, 1, 2].map((row) => [row, String(row + 1)]))}</div>
      </div>
    </div>
    <label>Выделение <select data-id="mode"><option value="replace">заменить</option><option value="add">добавить к выделенному</option><option value="within">оставить из выделенного подходящие</option></select></label>
    <div class="nm-dim" data-id="count"></div>
    <div class="ce-dialog-buttons"><button type="button" data-id="cancel">Отмена</button><button type="button" class="primary" data-id="select">Выделить</button></div>`;
  shade.append(box);
  document.body.append(shade);
  const el = <T extends HTMLElement>(id: string) => box.querySelector<T>(`[data-id="${id}"]`)!;
  const checked = (name: string) => [...box.querySelectorAll<HTMLInputElement>(`input[data-${name}]`)].filter((input) => input.checked).map((input) => input.dataset[name]!);
  const criteria = (): NoteCriteria => ({
    from: Number(el<HTMLInputElement>('from').value) || 0,
    to: Number(el<HTMLInputElement>('to').value) || 0,
    kinds: checked('kind') as ObjectKind[],
    colors: checked('color').map(Number),
    directions: checked('dir').map(Number),
    columns: checked('col').map(Number),
    rows: checked('row').map(Number),
  });
  const found = () => {
    const ids = matchObjects(editor.objects, criteria());
    return el<HTMLSelectElement>('mode').value === 'within' ? ids.filter((id) => editor.noteSelection.has(id)) : ids;
  };
  const count = () => {
    const ids = found();
    el('count').textContent = `Подходит объектов: ${String(ids.length)}`;
    return ids;
  };
  box.addEventListener('input', count);
  box.addEventListener('change', count);
  el('whole').addEventListener('click', () => {
    el<HTMLInputElement>('from').value = '0';
    el<HTMLInputElement>('to').value = String(last);
    count();
  });
  el('dirs').addEventListener('click', () => {
    const inputs = [...box.querySelectorAll<HTMLInputElement>('input[data-dir]')];
    const all = inputs.every((input) => input.checked);
    for (const input of inputs) input.checked = !all;
    count();
  });
  const close = () => {
    shade.remove();
    window.removeEventListener('keydown', keys, true);
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter') {
      event.stopPropagation();
      el('select').click();
    }
  };
  window.addEventListener('keydown', keys, true);
  shade.addEventListener('mousedown', (event) => event.target === shade && close());
  el('cancel').addEventListener('click', close);
  el('select').addEventListener('click', () => {
    const ids = count();
    editor.selectNotes(ids, el<HTMLSelectElement>('mode').value === 'add' ? 'add' : 'replace');
    editor.setStatus(`Выделено объектов: ${String(editor.noteSelection.size)}`);
    close();
  });
  count();
}
