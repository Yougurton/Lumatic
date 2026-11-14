import { DEFAULT_NJS, DIFFICULTY_NAMES, jumpEditor } from './jump';

/**
 * A map's difficulties as ChroMapper shows them: a tab for each mode (Standard, One Saber — and any the
 * map has besides) with how many it has, its five difficulties from Expert+ down, each ticked or not,
 * and the picked one's in-game label, NJS, offset and reaction time. A tick on makes a difficulty
 * (empty, or a copy of another one's notes and/or lights); a tick taken off one that exists deletes it
 * (asked first). Nothing is written here: the dialog does that with `entries()`.
 */

export interface DifficultyEntry {
  characteristic: string;
  difficulty: string;
  /** Its file, when it exists already. */
  file?: string;
  /** Ticked: there (made when it isn't yet). */
  enabled: boolean;
  /** An existing one unticked: to be deleted. */
  deleted?: boolean;
  njs: number;
  offset: number;
  label: string;
  /** To fill it with another difficulty's notes and/or lights (that one's file). */
  copy?: { from: string; fromName: string; what: 'notes' | 'lights' | 'all' };
}

const MODES: [string, string, string][] = [
  ['Standard', 'Стандарт', '⚔'],
  ['OneSaber', 'Одна сабля', '🗡'],
];

const WHAT: Record<'notes' | 'lights' | 'all', string> = { notes: 'ноты', lights: 'свет', all: 'ноты и свет' };

export function difficultyPanel(options: { bpm: number; entries: DifficultyEntry[]; nps?: (entry: DifficultyEntry) => number | undefined }) {
  const entries = options.entries.map((entry) => ({ ...entry }));
  const element = document.createElement('div');
  element.className = 'dp';
  const tabs = document.createElement('div');
  tabs.className = 'dp-tabs';
  const list = document.createElement('div');
  list.className = 'dp-list';
  const fields = document.createElement('div');
  fields.className = 'dp-fields';
  element.append(tabs, list, fields);
  const modes = [...MODES];
  for (const entry of entries) if (!modes.some(([id]) => id === entry.characteristic)) modes.push([entry.characteristic, entry.characteristic, '◇']);
  let mode = entries.find((entry) => entry.enabled)?.characteristic ?? 'Standard';
  let picked: string | null = null;
  let bpm = options.bpm;
  const key = (characteristic: string, difficulty: string) => `${characteristic}/${difficulty}`;
  const find = (characteristic: string, difficulty: string) => entries.find((entry) => entry.characteristic === characteristic && entry.difficulty === difficulty);
  const ensure = (characteristic: string, difficulty: string): DifficultyEntry => {
    let entry = find(characteristic, difficulty);
    if (entry === undefined) {
      entry = { characteristic, difficulty, enabled: false, njs: DEFAULT_NJS[difficulty] ?? 16, offset: 0, label: '' };
      entries.push(entry);
    }
    return entry;
  };
  const jump = jumpEditor({ bpm, difficulty: 'ExpertPlus', njs: 16, offset: 0 });
  const label = Object.assign(document.createElement('input'), { type: 'text', placeholder: 'без подписи' });
  const fieldTitle = document.createElement('div');
  fieldTitle.className = 'dp-field-title';
  const copyNote = document.createElement('div');
  copyNote.className = 'nm-dim';
  const labelRow = document.createElement('label');
  labelRow.className = 'dp-label';
  labelRow.append(Object.assign(document.createElement('span'), { textContent: 'Подпись в игре' }), label);
  fields.append(fieldTitle, labelRow, jump.element, copyNote);
  /** The picked one's fields into its entry. */
  const keep = () => {
    if (picked === null) return;
    const [characteristic, difficulty] = picked.split('/') as [string, string];
    const entry = find(characteristic, difficulty);
    if (entry === undefined) return;
    Object.assign(entry, jump.value(), { label: label.value.trim() });
  };
  const pick = (entry: DifficultyEntry | null) => {
    keep();
    picked = entry === null ? null : key(entry.characteristic, entry.difficulty);
    draw();
  };

  const draw = () => {
    tabs.replaceChildren(
      ...modes.map(([id, name, icon]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dp-tab';
        button.classList.toggle('active', id === mode);
        const count = entries.filter((entry) => entry.characteristic === id && entry.enabled).length;
        button.innerHTML = `<span class="dp-icon">${icon}</span><span>${name}</span><b>${String(count)}</b>`;
        button.addEventListener('click', () => {
          keep();
          mode = id;
          const first = entries.find((entry) => entry.characteristic === id && entry.enabled) ?? null;
          picked = first === null ? null : key(first.characteristic, first.difficulty);
          draw();
        });
        return button;
      }),
    );
    list.replaceChildren(
      ...[...DIFFICULTY_NAMES].reverse().map(([id, name]) => {
        const entry = find(mode, id);
        const row = document.createElement('div');
        row.className = 'dp-row';
        row.classList.toggle('on', entry?.enabled === true);
        row.classList.toggle('picked', picked === key(mode, id));
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: entry?.enabled === true });
        box.title = entry?.file !== undefined ? 'Снять — удалить сложность' : 'Отметить — создать сложность';
        box.addEventListener('click', (event) => event.stopPropagation());
        box.addEventListener('change', () => {
          const target = ensure(mode, id);
          if (!box.checked && target.file !== undefined && !target.deleted) {
            if (!window.confirm(`Удалить сложность ${name} (${target.file})? Её файл будет удалён${window.chroeditorNative !== undefined ? ' — копия останется в «Lumatic backups»' : ''}.`)) {
              box.checked = true;
              return;
            }
            target.deleted = true;
          } else if (box.checked) target.deleted = false;
          target.enabled = box.checked;
          if (!box.checked) delete target.copy;
          pick(box.checked ? target : picked === key(mode, id) ? null : findPicked());
        });
        const title = document.createElement('div');
        title.className = 'dp-name';
        const extra = entry?.deleted === true ? 'будет удалена' : entry?.copy !== undefined ? `копия «${entry.copy.fromName}»: ${WHAT[entry.copy.what]}` : entry?.enabled === true && entry.file === undefined ? 'новая' : (entry?.label ?? '');
        title.innerHTML = `<b>${name}</b><span>${extra}</span>`;
        row.append(box, title);
        if (entry?.enabled === true && entry.file !== undefined) {
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'dp-copy';
          copy.textContent = '⧉';
          copy.title = 'Скопировать эту сложность в другую…';
          copy.addEventListener('click', (event) => {
            event.stopPropagation();
            copyMenu(entry, name, copy);
          });
          row.append(copy);
        }
        row.addEventListener('click', () => {
          if (entry?.enabled === true) pick(entry);
        });
        return row;
      }),
    );
    // the picked one's fields
    const current = picked === null ? undefined : entries.find((entry) => key(entry.characteristic, entry.difficulty) === picked);
    fields.hidden = current === undefined || !current.enabled;
    if (current !== undefined && current.enabled) {
      const name = DIFFICULTY_NAMES.find(([id]) => id === current.difficulty)?.[1] ?? current.difficulty;
      fieldTitle.textContent = `${name} · ${modes.find(([id]) => id === current.characteristic)?.[1] ?? current.characteristic}`;
      label.value = current.label;
      jump.set({ bpm, difficulty: current.difficulty, njs: current.njs, offset: current.offset, nps: options.nps?.(current) });
      copyNote.textContent = current.copy !== undefined ? `Будет заполнена из «${current.copy.fromName}»: ${WHAT[current.copy.what]}.` : '';
    }
  };
  const findPicked = () => entries.find((entry) => entry.characteristic === mode && entry.enabled) ?? null;

  /** "Copy into…": which difficulty, and what of it. */
  const copyMenu = (source: DifficultyEntry, sourceName: string, anchor: HTMLElement) => {
    document.querySelector('.dp-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'dp-menu';
    const target = document.createElement('select');
    for (const [id] of modes) {
      for (const [difficulty, name] of [...DIFFICULTY_NAMES].reverse()) {
        if (id === source.characteristic && difficulty === source.difficulty) continue;
        const there = find(id, difficulty);
        const option = Object.assign(document.createElement('option'), { value: key(id, difficulty), textContent: `${name} · ${modes.find(([m]) => m === id)?.[1] ?? id}${there?.enabled === true ? ' (есть — заменится)' : ''}` });
        target.append(option);
      }
    }
    const what = document.createElement('select');
    for (const [value, text] of [
      ['notes', 'только ноты'],
      ['all', 'ноты и свет'],
      ['lights', 'только свет'],
    ] as const)
      what.append(Object.assign(document.createElement('option'), { value, textContent: text }));
    const go = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: 'Копировать' });
    const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Отмена' });
    menu.append(Object.assign(document.createElement('div'), { className: 'dp-field-title', textContent: `«${sourceName}» скопировать в:` }), target, what, Object.assign(document.createElement('div'), { className: 'nm-row' }));
    menu.lastElementChild!.append(cancel, go);
    cancel.addEventListener('click', () => menu.remove());
    go.addEventListener('click', () => {
      const [characteristic, difficulty] = target.value.split('/') as [string, string];
      const entry = ensure(characteristic, difficulty);
      if (entry.enabled && entry.file !== undefined && !window.confirm(`В «${DIFFICULTY_NAMES.find(([id]) => id === difficulty)?.[1] ?? difficulty}» уже есть сложность — заменить её ${WHAT[what.value as 'notes']}?`)) return;
      entry.enabled = true;
      entry.deleted = false;
      entry.copy = { from: source.file!, fromName: sourceName, what: what.value as 'notes' | 'lights' | 'all' };
      if (entry.file === undefined) Object.assign(entry, { njs: source.njs, offset: source.offset });
      menu.remove();
      keep();
      mode = characteristic;
      picked = key(characteristic, difficulty);
      draw();
    });
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${String(Math.max(8, rect.right - 260))}px`;
    menu.style.top = `${String(rect.bottom + 4)}px`;
    document.body.append(menu);
  };

  const start = findPicked();
  picked = start === null ? null : key(start.characteristic, start.difficulty);
  draw();
  return {
    element,
    entries: () => {
      keep();
      return entries.filter((entry) => entry.enabled || entry.deleted === true || entry.file !== undefined).map((entry) => ({ ...entry }));
    },
    setBpm(next: number) {
      bpm = next;
      if (picked !== null) jump.set({ bpm });
    },
    /** Picks a difficulty (to show its fields). */
    pick(characteristic: string, difficulty: string) {
      const entry = find(characteristic, difficulty);
      if (entry === undefined) return;
      keep();
      mode = characteristic;
      picked = key(characteristic, difficulty);
      draw();
    },
  };
}
