import { NO_ADJUSTMENT, type Adjustment } from './adjust';
import type { Editor } from './editor';
import { isLightRow } from './editor';
import { EASINGS } from './rings';

/**
 * "Change the light": the selected events brighter or dimmer, in another hue, more or less saturated —
 * one setting for all of them or from one at the selection's start to another at its end; pulses
 * over the selection; a flutter. Every change is tried at once on the timeline and in the 3D view;
 * "Apply" keeps it (one undo step), "Cancel" puts the events back.
 */
export function adjustDialog(editor: Editor) {
  if (editor.selectedClips().length === 0) return;
  const adjustment: Adjustment = structuredClone(NO_ADJUSTMENT);
  let pulse = { cycles: 4, depth: 0.6 };
  let flutter = { multiplier: 0.7, turbulence: 0.3, seed: 1 };
  let pulseOn = false;
  let flutterOn = false;
  editor.startTrying();

  const shade = document.createElement('div');
  shade.className = 'ce-shade adjust-shade';
  const box = document.createElement('div');
  box.className = 'ce-dialog adjust-dialog';
  box.innerHTML = `
    <div class="ce-dialog-title">Изменить свет выделенного (${String(editor.selectedClips().length)})</div>
    <label class="adjust-check"><input type="checkbox" data-id="gradient"> Плавно от начала выделения к концу</label>
    <div class="adjust-grid">
      <span></span><span class="adjust-head">в начале</span><span class="adjust-head adjust-end">в конце</span>
    </div>
    <div class="adjust-more" data-id="gradient-more">
      <label>Переход <select data-id="easing">${EASINGS.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label>
      <label class="adjust-check"><input type="checkbox" data-id="per-row"> Каждая строка сама по себе</label>
    </div>
    <label class="adjust-check"><input type="checkbox" data-id="pulse"> Пульсация</label>
    <div class="adjust-more adjust-pair" data-id="pulse-more">
      <label>Волн <input type="number" data-id="cycles" min="1" step="1"></label>
      <label>Глубина <input type="number" data-id="depth" min="0" max="1" step="0.05"></label>
    </div>
    <label class="adjust-check"><input type="checkbox" data-id="flutter"> Дрожание (каждое событие делится надвое)</label>
    <div class="adjust-more adjust-pair" data-id="flutter-more">
      <label>Вторая половина × <input type="number" data-id="multiplier" min="0" step="0.05"></label>
      <label>Разброс ± <input type="number" data-id="turbulence" min="0" max="1" step="0.05"></label>
      <button type="button" data-id="reroll">🎲 Другое</button>
    </div>
    <div class="ce-dialog-buttons"><button type="button" data-id="reset">Сбросить</button><span class="adjust-gap"></span><button type="button" data-id="cancel">Отмена</button><button type="button" class="primary" data-id="apply">Применить</button></div>`;
  shade.append(box);
  document.body.append(shade);
  const el = <T extends HTMLElement>(id: string) => box.querySelector<T>(`[data-id="${id}"]`)!;
  const grid = box.querySelector<HTMLElement>('.adjust-grid')!;

  // ----- brightness, hue, saturation: the start and the end
  const rows: [keyof Pick<Adjustment, 'brightness' | 'hue' | 'saturation'>, string, number, number?, number?][] = [
    ['brightness', 'Яркость ×', 0.05, 0],
    ['hue', 'Оттенок, °', 5, -360, 360],
    ['saturation', 'Насыщенность ±', 0.05, -1, 1],
  ];
  const inputs: HTMLInputElement[] = [];
  for (const [key, label, step, min, max] of rows) {
    grid.append(Object.assign(document.createElement('span'), { textContent: label }));
    for (const end of [0, 1] as const) {
      const input = document.createElement('input');
      input.type = 'number';
      input.step = String(step);
      if (min !== undefined) input.min = String(min);
      if (max !== undefined) input.max = String(max);
      input.dataset.key = key;
      input.dataset.end = String(end);
      if (end === 1) input.classList.add('adjust-end');
      input.addEventListener('input', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        adjustment[key][end] = value;
        if (!adjustment.gradient) adjustment[key][1] = value;
        schedule();
      });
      inputs.push(input);
      grid.append(input);
    }
  }
  const number = (id: string, read: () => number, write: (value: number) => void) => {
    const input = el<HTMLInputElement>(id);
    input.value = String(read());
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (Number.isFinite(value)) {
        write(value);
        schedule();
      }
    });
  };
  number('cycles', () => pulse.cycles, (value) => (pulse = { ...pulse, cycles: Math.max(1, Math.round(value)) }));
  number('depth', () => pulse.depth, (value) => (pulse = { ...pulse, depth: value }));
  number('multiplier', () => flutter.multiplier, (value) => (flutter = { ...flutter, multiplier: value }));
  number('turbulence', () => flutter.turbulence, (value) => (flutter = { ...flutter, turbulence: value }));

  const gradient = el<HTMLInputElement>('gradient');
  const perRow = el<HTMLInputElement>('per-row');
  const easing = el<HTMLSelectElement>('easing');
  const pulseCheck = el<HTMLInputElement>('pulse');
  const flutterCheck = el<HTMLInputElement>('flutter');
  /** The form as the settings are. */
  const show = () => {
    for (const input of inputs) input.value = String(adjustment[input.dataset.key as 'hue'][Number(input.dataset.end) as 0 | 1]);
    gradient.checked = adjustment.gradient;
    perRow.checked = adjustment.perRow;
    easing.value = adjustment.easing;
    pulseCheck.checked = pulseOn;
    flutterCheck.checked = flutterOn;
    box.querySelectorAll<HTMLElement>('.adjust-end').forEach((item) => (item.style.visibility = adjustment.gradient ? '' : 'hidden'));
    el('gradient-more').hidden = !adjustment.gradient;
    el('pulse-more').hidden = !pulseOn;
    el('flutter-more').hidden = !flutterOn;
  };
  gradient.addEventListener('change', () => {
    adjustment.gradient = gradient.checked;
    if (!adjustment.gradient) for (const key of ['brightness', 'hue', 'saturation'] as const) adjustment[key][1] = adjustment[key][0];
    show();
    schedule();
  });
  perRow.addEventListener('change', () => {
    adjustment.perRow = perRow.checked;
    schedule();
  });
  easing.addEventListener('change', () => {
    adjustment.easing = easing.value;
    schedule();
  });
  pulseCheck.addEventListener('change', () => {
    pulseOn = pulseCheck.checked;
    show();
    schedule();
  });
  flutterCheck.addEventListener('change', () => {
    flutterOn = flutterCheck.checked;
    show();
    schedule();
  });
  el('reroll').addEventListener('click', () => {
    flutter = { ...flutter, seed: flutter.seed + 1 };
    schedule();
  });
  el('reset').addEventListener('click', () => {
    Object.assign(adjustment, structuredClone(NO_ADJUSTMENT));
    pulseOn = false;
    flutterOn = false;
    show();
    schedule();
  });

  // ----- tried at once (a little after the last change)
  const current = (): Adjustment => ({ ...adjustment, pulse: pulseOn ? pulse : null, flutter: flutterOn ? flutter : null });
  let timer = 0;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => editor.adjustSelection(current()), 120);
  };
  const close = (keep: boolean) => {
    window.clearTimeout(timer);
    if (keep) editor.adjustSelection(current());
    editor.finishTrying(keep);
    shade.remove();
    window.removeEventListener('keydown', keys, true);
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(false);
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLSelectElement)) {
      event.stopPropagation();
      close(true);
    } else if ((event.ctrlKey || event.metaKey) && /^[zy]$/iu.test(event.key)) event.stopPropagation();
  };
  window.addEventListener('keydown', keys, true);
  el('cancel').addEventListener('click', () => close(false));
  el('apply').addEventListener('click', () => close(true));
  show();
}

/**
 * "Select by…": the events of these rows, of this colour, within these beats — instead of what is
 * selected now or added to it.
 */
export function selectByDialog(editor: Editor) {
  const project = editor.project;
  if (project === null) return;
  const rows = editor.rows.filter(isLightRow);
  const picked = editor.selectedClips();
  const own = new Set(rows.filter((row) => editor.rowClips(row).some((item) => item.role === 'own' && picked.some((clip) => clip.id === item.clip.id))).map((row) => row.key));
  const range = editor.songRange;
  const ends = project.clips.map((clip) => clip.end);
  const from = range !== null ? Math.min(range.start, range.end) : 0;
  const to = range !== null ? Math.max(range.start, range.end) : Math.ceil(Math.max(0, ...ends));

  const shade = document.createElement('div');
  shade.className = 'ce-shade';
  const box = document.createElement('div');
  box.className = 'ce-dialog adjust-dialog';
  box.innerHTML = `
    <div class="ce-dialog-title">Выделить события</div>
    <div class="adjust-pair">
      <label>С доли <input type="number" data-id="from" step="0.25" min="0" value="${String(from)}"></label>
      <label>По долю <input type="number" data-id="to" step="0.25" min="0" value="${String(to)}"></label>
    </div>
    <label>Цвет <select data-id="color"><option value="any">любой</option><option value="left">левый</option><option value="right">правый</option><option value="white">белый</option><option value="custom">свой (Chroma)</option></select></label>
    <div class="adjust-head">Строки <button type="button" data-id="all">все</button> <button type="button" data-id="none">ни одной</button></div>
    <div class="adjust-rows" data-id="rows"></div>
    <label class="adjust-check"><input type="checkbox" data-id="effects" checked> И события эффектов</label>
    <label class="adjust-check"><input type="checkbox" data-id="add"> Добавить к выделенному</label>
    <div class="nm-dim" data-id="count"></div>
    <div class="ce-dialog-buttons"><button type="button" data-id="cancel">Отмена</button><button type="button" class="primary" data-id="select">Выделить</button></div>`;
  shade.append(box);
  document.body.append(shade);
  const el = <T extends HTMLElement>(id: string) => box.querySelector<T>(`[data-id="${id}"]`)!;
  const list = el<HTMLElement>('rows');
  const checks = rows.map((row) => {
    const label = document.createElement('label');
    label.className = 'adjust-check';
    label.style.paddingLeft = `${String(row.depth * 12)}px`;
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = own.size === 0 || own.has(row.key);
    check.addEventListener('change', count);
    label.append(check, ` ${row.label}`);
    list.append(label);
    return { row, check };
  });
  const criteria = () => ({
    rows: checks.every((item) => item.check.checked) ? [] : checks.filter((item) => item.check.checked).map((item) => item.row.key),
    color: el<HTMLSelectElement>('color').value as 'any',
    from: Number(el<HTMLInputElement>('from').value) || 0,
    to: Number(el<HTMLInputElement>('to').value) || 0,
    effects: el<HTMLInputElement>('effects').checked,
  });
  function count() {
    const found = criteria().rows.length === 0 && checks.every((item) => !item.check.checked) ? [] : editor.clipsMatching(criteria());
    el('count').textContent = `Подходит событий: ${String(found.length)}`;
    return found;
  }
  for (const id of ['from', 'to', 'color', 'effects']) el(id).addEventListener('input', count);
  el('all').addEventListener('click', () => {
    for (const item of checks) item.check.checked = true;
    count();
  });
  el('none').addEventListener('click', () => {
    for (const item of checks) item.check.checked = false;
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
    }
  };
  window.addEventListener('keydown', keys, true);
  shade.addEventListener('mousedown', (event) => event.target === shade && close());
  el('cancel').addEventListener('click', close);
  el('select').addEventListener('click', () => {
    const found = count();
    editor.select(found, el<HTMLInputElement>('add').checked ? 'add' : 'replace');
    editor.setStatus(`Выделено событий: ${String(found.length)}`);
    close();
  });
  count();
}
