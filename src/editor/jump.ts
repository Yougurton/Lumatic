import { tr } from './i18n';
/**
 * How fast a difficulty's notes come and how far ahead they show: the note jump speed (NJS), the start
 * offset, and what they give — the half jump (beats), the jump distance (metres) and the reaction time
 * (how long a note is seen before it's hit). A reaction time typed in sets the offset that gives it.
 * Checked against BSMG's basic mapping guide (its tables of NJS, jump distance and notes a second for
 * each difficulty) and a reaction time too short to read.
 */

/** BSMG's ranges from typical community spreads (bsmg.wiki/mapping/basic-mapping). */
export const DIFFICULTY_RANGES: Record<string, { nps: [number, number]; njs: [number, number]; jd: [number, number] }> = {
  Easy: { nps: [0.82, 2.29], njs: [10, 12], jd: [25, 30] },
  Normal: { nps: [1.05, 3.41], njs: [10, 12], jd: [25, 30] },
  Hard: { nps: [1.73, 5.22], njs: [10, 15], jd: [23, 30] },
  Expert: { nps: [2.42, 7.81], njs: [12, 18], jd: [21, 27] },
  ExpertPlus: { nps: [3.21, 10.66], njs: [15, 23], jd: [19, 27] },
};

/** A new difficulty's NJS (within its BSMG range). */
export const DEFAULT_NJS: Record<string, number> = { Easy: 10, Normal: 11, Hard: 12, Expert: 14, ExpertPlus: 16 };

export const DIFFICULTY_NAMES: [string, string, number][] = [
  ['Easy', 'Easy', 1],
  ['Normal', 'Normal', 3],
  ['Hard', 'Hard', 5],
  ['Expert', 'Expert', 7],
  ['ExpertPlus', 'Expert+', 9],
];

/** The game's half jump before the offset (beats). */
function baseHalf(bpm: number, njs: number) {
  const beat = 60 / bpm;
  let half = 4;
  while (njs * beat * half > 17.999) half /= 2;
  return half;
}

/** The half jump (beats), the jump distance (metres) and the reaction time (ms). */
export function jumpOf(bpm: number, njs: number, offset: number) {
  const half = Math.max(baseHalf(bpm, njs) + offset, 0.25);
  const beat = 60 / bpm;
  return { half, distance: njs * beat * half * 2, reaction: half * beat * 1000 };
}

/** The offset that gives a reaction time (ms). */
export function offsetForReaction(bpm: number, njs: number, reaction: number) {
  const half = (reaction / 1000) * (bpm / 60);
  return Math.round((half - baseHalf(bpm, njs)) * 1000) / 1000;
}

/** What BSMG's guide (and reading the notes) would say about these. */
export function jumpWarnings(difficulty: string, njs: number, distance: number, reaction: number, nps?: number): { text: string; level: 'warn' | 'bad' }[] {
  const out: { text: string; level: 'warn' | 'bad' }[] = [];
  const range = DIFFICULTY_RANGES[difficulty];
  const name = DIFFICULTY_NAMES.find(([id]) => id === difficulty)?.[1] ?? difficulty;
  if (reaction < 350) out.push({ level: 'bad', text: `Очень мало времени на реакцию: ${String(Math.round(reaction))} мс. Ноты появляются слишком близко — их трудно прочитать.` });
  else if (reaction < 450) out.push({ level: 'warn', text: `Мало времени на реакцию: ${String(Math.round(reaction))} мс — подойдёт только опытным игрокам.` });
  else if (range !== undefined && (difficulty === 'Easy' || difficulty === 'Normal' || difficulty === 'Hard') && reaction < 600) out.push({ level: 'warn', text: `Для ${name} обычно дают больше времени на реакцию (от 600 мс).` });
  if (reaction > 1300) out.push({ level: 'warn', text: `Ноты видны очень заранее (${String(Math.round(reaction))} мс): на экране много нот сразу, их легко перепутать.` });
  if (range !== undefined) {
    if (njs < range.njs[0] || njs > range.njs[1]) out.push({ level: 'warn', text: `NJS ${String(njs)} вне обычного для ${name} (${String(range.njs[0])}–${String(range.njs[1])}, по BSMG).` });
    if (distance < range.jd[0] || distance > range.jd[1]) out.push({ level: 'warn', text: tr('Дальность появления {0} м вне обычной для {1} ({2}–{3} м, по BSMG).', distance.toFixed(1), name, range.jd[0], range.jd[1]) });
    if (nps !== undefined && nps > 0 && (nps < range.nps[0] || nps > range.nps[1])) out.push({ level: 'warn', text: `Нот в секунду ${nps.toFixed(2)} — вне обычного для ${name} (${String(range.nps[0])}–${String(range.nps[1])}, по официальным картам).` });
  }
  return out;
}

/**
 * The fields for a difficulty's NJS, offset and reaction time, with what they give and what's wrong
 * with them. `value()`: what's in them.
 */
export function jumpEditor(start: { bpm: number; difficulty: string; njs: number; offset: number; nps?: number }) {
  let state = { ...start };
  const element = document.createElement('div');
  element.className = 'jump-editor';
  element.innerHTML = `
    <div class="jump-fields">
      <label title="Скорость нот (м/с): выше — точнее нужно попадать, ниже — легче читать">NJS<input type="number" data-id="njs" min="1" max="50" step="any"></label>
      <label title="Сдвиг появления нот (доли): плюс — ноты появляются раньше и дальше, минус — позже и ближе">Смещение<input type="number" data-id="offset" step="any"></label>
      <label title="Сколько видна нота до удара. Впишите своё — смещение подстроится">Время реакции, мс<input type="number" data-id="rt" min="100" max="3000" step="any"></label>
    </div>
    <label class="adjust-check jump-keep"><input type="checkbox" data-id="keep"> При смене NJS держать время реакции</label>
    <div class="nm-dim" data-id="readout"></div>
    <div data-id="warnings" class="jump-warnings"></div>`;
  const el = <T extends HTMLElement>(id: string) => element.querySelector<T>(`[data-id="${id}"]`)!;
  const draw = (except?: string) => {
    const jump = jumpOf(state.bpm, state.njs, state.offset);
    if (except !== 'njs') el<HTMLInputElement>('njs').value = String(state.njs);
    if (except !== 'offset') el<HTMLInputElement>('offset').value = String(Math.round(state.offset * 1000) / 1000);
    if (except !== 'rt') el<HTMLInputElement>('rt').value = String(Math.round(jump.reaction));
    el('readout').textContent = `Подлёт: ${jump.half.toFixed(2)} доли · дальность появления ${jump.distance.toFixed(1)} м · время реакции ${String(Math.round(jump.reaction))} мс`;
    const warnings = jumpWarnings(state.difficulty, state.njs, jump.distance, jump.reaction, state.nps);
    el('warnings').replaceChildren(
      ...(warnings.length === 0
        ? [Object.assign(document.createElement('div'), { className: 'jump-ok', textContent: '✓ В пределах рекомендаций BSMG' })]
        : warnings.map((warning) => Object.assign(document.createElement('div'), { className: `jump-${warning.level}`, textContent: `⚠ ${warning.text}` }))),
    );
  };
  el('njs').addEventListener('input', () => {
    const njs = Number(el<HTMLInputElement>('njs').value);
    if (!(njs > 0)) return;
    const reaction = jumpOf(state.bpm, state.njs, state.offset).reaction;
    state.njs = njs;
    if (el<HTMLInputElement>('keep').checked) state.offset = offsetForReaction(state.bpm, njs, reaction);
    draw('njs');
  });
  el('offset').addEventListener('input', () => {
    const offset = Number(el<HTMLInputElement>('offset').value.replace(',', '.'));
    if (!Number.isFinite(offset)) return;
    state.offset = offset;
    draw('offset');
  });
  el('rt').addEventListener('input', () => {
    const reaction = Number(el<HTMLInputElement>('rt').value);
    if (!(reaction >= 100)) return;
    state.offset = offsetForReaction(state.bpm, state.njs, reaction);
    draw('rt');
  });
  for (const id of ['njs', 'offset', 'rt']) el(id).addEventListener('change', () => draw());
  draw();
  return {
    element,
    value: () => ({ njs: state.njs, offset: state.offset }),
    /** Other values (another difficulty picked, the tempo changed…). */
    set(patch: Partial<typeof state>) {
      state = { ...state, ...patch };
      draw();
    },
  };
}
