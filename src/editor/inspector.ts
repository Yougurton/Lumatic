import type { Editor } from './editor';
import { otherEventName } from './names';
import { KIND_NAMES, type Direction, type Effect, type EffectParams, type StrobePattern } from './effects';
import { findGroup, groupLights, type ClipColor, type EndMode, type LightClip, type Rgb, type StartMode } from './model';

/**
 * The panel on the right: what the selected clips do (their start, their end, colour, gradient,
 * layer, times) — or, with nothing selected, the "brush" new clips are drawn with. A change applies
 * to every selected clip (one undo step).
 */

const START_MODES: [StartMode, string, string][] = [
  ['on', 'Вкл', 'Свет загорается сразу'],
  ['flash', 'Вспышка', 'Вспышка, оседающая в цвет'],
  ['fade', 'Угасание', 'Вспышка, гаснущая сама (игровой fade, 1.5 с)'],
  ['fadeIn', 'Нарастание', 'Плавно разгорается из темноты'],
];

const END_MODES: [EndMode, string, string][] = [
  ['off', 'Выкл', 'В конце гаснет (или возвращается к слою ниже)'],
  ['fade', 'Затухание', 'Плавно гаснет к концу (или перетекает в слой ниже)'],
  ['stay', 'Остаётся', 'Остаётся гореть до следующего события'],
];

function toHex(rgb: Rgb) {
  return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function fromHex(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class Inspector {
  constructor(private readonly editor: Editor, private readonly root: HTMLElement) {
    editor.onChange((what) => {
      if (what !== 'time') this.render();
    });
    this.render();
  }

  /** The values shown: the first selected clip's (or the brush). */
  private current(): { clips: LightClip[]; source: Omit<LightClip, 'id' | 'type' | 'ids' | 'start' | 'end'> & { start?: number; end?: number } } {
    const clips = this.editor.selectedClips();
    const first = clips[0];
    if (first !== undefined) return { clips, source: first };
    const brush = this.editor.brush;
    return { clips, source: { ...brush, color: brush.color, endColor: brush.endColor, hsv: brush.hsv } };
  }

  private apply(change: (target: { startMode: StartMode; fadeIn: number; endMode: EndMode; color: ClipColor; endColor: ClipColor | null; layer: number; hsv?: boolean }) => void) {
    if (this.editor.selection.size > 0 && this.editor.selectedClips().length > 0) this.editor.updateSelected((clip) => change(clip));
    else {
      change(this.editor.brush);
      this.render();
    }
  }

  render() {
    const root = this.root;
    root.replaceChildren();
    const open = this.editor.openEffect === null ? undefined : this.editor.effectById(this.editor.openEffect);
    if (open !== undefined) {
      const bar = document.createElement('div');
      bar.className = 'ins-inside';
      const text = document.createElement('span');
      text.textContent = `Внутри эффекта «${open.name}»`;
      const out = document.createElement('button');
      out.textContent = 'Выйти';
      out.title = 'Выйти из эффекта (Esc)';
      out.addEventListener('click', () => this.editor.enterEffect(null));
      bar.append(text, out);
      root.append(bar);
    }
    const effects = this.editor.selectedEffects();
    if (effects.length > 0 && this.editor.selectedClips().length === 0) {
      this.renderEffects(effects);
      return;
    }
    const { clips, source } = this.current();
    const rawSelected = (this.editor.project?.raw ?? []).filter((event) => this.editor.selection.has(event.id));
    const title = document.createElement('h3');
    title.textContent = clips.length > 0 ? (clips.length === 1 ? 'Событие света' : `Выбрано: ${String(clips.length)}`) : rawSelected.length > 0 ? 'Другие события' : 'Кисть (новые события)';
    root.append(title);
    if (clips.length === 0 && rawSelected.length > 0) {
      this.renderRaw(rawSelected);
      return;
    }

    root.append(this.section('Начало', this.buttons(START_MODES, source.startMode, (mode) => this.apply((target) => (target.startMode = mode)))));
    if (source.startMode === 'fadeIn') {
      root.append(this.numberField('Нарастание, долей', source.fadeIn, 0.0625, (value) => this.apply((target) => (target.fadeIn = Math.max(0.01, value)))));
    }
    root.append(this.section('Конец', this.buttons(END_MODES, source.endMode, (mode) => this.apply((target) => (target.endMode = mode)))));
    root.append(this.section('Цвет', this.colorPicker(source.color, (color) => this.apply((target) => (target.color = color)))));
    const gradient = document.createElement('label');
    gradient.className = 'ins-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = source.endColor !== null;
    box.addEventListener('change', () => this.apply((target) => (target.endColor = box.checked ? { ...target.color, ref: target.color.ref === 'left' ? 'right' : 'left' } : null)));
    gradient.append(box, ' Градиент к концу');
    root.append(gradient);
    if (source.endColor !== null) {
      root.append(this.section('Цвет в конце', this.colorPicker(source.endColor, (color) => this.apply((target) => (target.endColor = color)))));
      const hsv = document.createElement('label');
      hsv.className = 'ins-check';
      const hsvBox = document.createElement('input');
      hsvBox.type = 'checkbox';
      hsvBox.checked = source.hsv === true;
      hsvBox.addEventListener('change', () => this.apply((target) => (target.hsv = hsvBox.checked)));
      hsv.append(hsvBox, ' Через оттенки (HSV)');
      root.append(hsv);
    }
    root.append(this.numberField('Слой', source.layer, 1, (value) => this.apply((target) => (target.layer = Math.max(0, Math.round(value))))));
    if (clips.length === 1) {
      const clip = clips[0]!;
      root.append(
        this.numberField('Начало, доля', clip.start, this.editor.snap || 0.25, (value) => this.editor.updateSelected((target) => (target.start = Math.min(value, target.end - 0.01)))),
        this.numberField('Конец, доля', clip.end, this.editor.snap || 0.25, (value) => this.editor.updateSelected((target) => (target.end = Math.max(value, target.start + 0.01)))),
      );
      const lights = document.createElement('div');
      lights.className = 'ins-note';
      const target = clip.target === undefined ? undefined : findGroup(this.editor.groups, clip.target)?.group;
      lights.textContent = target !== undefined ? `Группа «${target.name}» (${String(groupLights(target).length)} ламп)` : clip.ids === null ? 'Все лампы группы' : `Лампы: ${clip.ids.join(', ')}`;
      root.append(lights);
    }
    if (clips.length === 0) {
      const note = document.createElement('div');
      note.className = 'ins-note';
      note.textContent = 'Протяните по строке таймлайна, чтобы нарисовать событие. Shift — выделение рамкой, Alt — копия при перетаскивании, ПКМ — удалить, ПКМ по выделенному — меню (зеркало, копия). Shift+протянуть по линейке — участок песни, B — метка. Колесо — по времени, Alt+колесо или колесо над названиями — по строкам, Ctrl+колесо — масштаб.';
      root.append(note);
    }
  }

  private renderEffects(effects: Effect[]) {
    const root = this.root;
    const editor = this.editor;
    const effect = effects[0]!;
    const p = effect.params;
    const change = (patch: (params: EffectParams, effect: Effect) => void) => editor.updateEffects((item) => patch(item.params, item));
    const title = document.createElement('h3');
    title.textContent = effects.length === 1 ? `Эффект: ${KIND_NAMES[effect.kind]}` : `Эффектов: ${String(effects.length)}`;
    root.append(title);
    if (effects.length === 1) {
      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'ins-text';
      name.value = effect.name;
      name.addEventListener('change', () => change((_params, item) => (item.name = name.value.trim() || item.name)));
      name.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') name.blur();
      });
      root.append(name);
    }
    if (effects.some((item) => item.custom === true)) {
      const note = document.createElement('div');
      note.className = 'ins-warn';
      note.textContent = 'События эффекта изменены вручную — настройки ниже к ним не применяются.';
      const reset = document.createElement('button');
      reset.textContent = 'Сбросить к настройкам';
      reset.addEventListener('click', () => {
        for (const item of effects) editor.resetEffect(item.id);
      });
      note.append(reset);
      root.append(note);
    }
    const actions = document.createElement('div');
    actions.className = 'ins-buttons ins-actions';
    const action = (label: string, hint: string, act: () => void) => {
      const button = document.createElement('button');
      button.textContent = label;
      button.title = hint;
      button.addEventListener('click', act);
      actions.append(button);
    };
    if (effects.length === 1 && effect.kind === 'gls' && effect.custom !== true) action('Редактор GLS', 'Открыть редактор блока (двойной клик по нему)', () => editor.glsEditorHook?.(effect.id));
    if (effects.length === 1) action('Войти', 'Открыть события эффекта для правки вручную', () => editor.enterEffect(effect.id));
    action('▶ Проиграть', 'Проиграть эффект по кругу в окне просмотра', () => editor.startTrial({ clips: [], raw: [], start: Math.min(...effects.map((item) => item.start)), end: Math.max(...effects.map((item) => item.end)) }));
    if (effects.length === 1) action('Разобрать', 'Превратить эффект в обычные события', () => editor.explodeEffect(effect.id));
    root.append(actions);

    if (effects.every((item) => item.kind === 'gls')) {
      root.append(this.numberField('Слой', effect.layer, 1, (value) => editor.updateEffects((item) => (item.layer = Math.max(0, Math.round(value))))));
      const boxes = effect.gls?.boxes ?? [];
      const note = document.createElement('div');
      note.className = 'ins-note';
      note.textContent = `Коробок: ${String(boxes.length)} (света ${String(boxes.filter((box) => box.kind === 'color').length)}, вращения ${String(boxes.filter((box) => box.kind === 'rotation').length)}). Событий света: ${String(editor.effectChildren(effect.id).length)}, событий колец: ${String(editor.effectRaw(effect.id).length)}.`;
      root.append(note);
      return;
    }
    // the colour(s)
    root.append(this.section('Цвет', this.colorPicker(p.color, (color) => change((params) => (params.color = color)))));
    const secondLabel = effect.kind === 'strobe' ? ' Чередовать со вторым цветом' : effect.kind === 'twinkle' ? ' Случайные цвета до второго' : ' Градиент по элементам';
    const second = this.check(secondLabel, p.color2 !== null, (on) => change((params) => (params.color2 = on ? { ...params.color, ref: params.color.ref === 'left' ? 'right' : 'left', rgb: undefined } : null)));
    root.append(second);
    if (p.color2 !== null) {
      root.append(this.section('Второй цвет', this.colorPicker(p.color2, (color) => change((params) => (params.color2 = color)))));
      if (effect.kind !== 'strobe') root.append(this.check(' Через оттенки (HSV, радуга)', p.hsv, (on) => change((params) => (params.hsv = on))));
    }

    const directions: [Direction, string, string][] = [
      ['forward', '→', 'По порядку'],
      ['backward', '←', 'В обратном порядке'],
      ['pingpong', '⇄', 'Туда и обратно'],
      ['outward', '↔', 'От центра'],
      ['inward', '→←', 'К центру'],
    ];
    if (effect.kind === 'wave' || effect.kind === 'fill' || effect.kind === 'gradient' || (effect.kind === 'strobe' && p.pattern === 'sequence')) {
      root.append(this.section('Направление', this.buttons(effect.kind === 'wave' ? directions : directions.filter(([key]) => key !== 'pingpong'), p.direction, (value) => change((params) => (params.direction = value)))));
    }
    if (effect.kind === 'wave') {
      root.append(
        this.numberField('Длина вспышки, долей', p.pulse, 0.125, (value) => change((params) => (params.pulse = Math.max(1 / 32, value)))),
        this.numberField('Сколько раз пройти', p.repeats, 1, (value) => change((params) => (params.repeats = Math.max(1, Math.round(value))))),
      );
    }
    if (effect.kind === 'fill') root.append(this.numberField('Время заполнения, долей', p.pulse, 0.25, (value) => change((params) => (params.pulse = Math.max(0, value)))));
    if (effect.kind === 'strobe' || effect.kind === 'twinkle') {
      const rates: [string, string, string][] = [
        ['1', '1', 'Раз в долю'],
        ['0.5', '1/2', 'Два раза в долю'],
        ['0.25', '1/4', 'Четыре раза в долю'],
        ['0.125', '1/8', 'Восемь раз в долю'],
        ['0.0625', '1/16', 'Шестнадцать раз в долю'],
      ];
      root.append(this.section('Частота', this.buttons(rates, String(p.rate), (value) => change((params) => (params.rate = Number(value))))));
      root.append(this.slider(effect.kind === 'strobe' ? 'Горит, доля шага' : 'Длительность вспышки', p.duty, 0.05, effect.kind === 'strobe' ? 1 : 4, 0.05, (value) => change((params) => (params.duty = value))));
    }
    if (effect.kind === 'strobe') {
      const patterns: [StrobePattern, string, string][] = [
        ['all', 'Все вместе', 'Все лампы мигают разом'],
        ['alternate', 'Чередование', 'Чётные и нечётные по очереди'],
        ['sequence', 'По очереди', 'Бегущий огонь'],
      ];
      root.append(this.section('Рисунок', this.buttons(patterns, p.pattern, (value) => change((params) => (params.pattern = value)))));
    }
    if (effect.kind === 'twinkle') {
      root.append(this.slider('Доля ламп за раз', p.density, 0.05, 1, 0.05, (value) => change((params) => (params.density = value))));
      const reroll = document.createElement('button');
      reroll.textContent = '🎲 Другой узор';
      reroll.addEventListener('click', () => change((params) => (params.seed = Math.floor(Math.random() * 1e6))));
      root.append(reroll);
    }
    root.append(this.section('Начало вспышки', this.buttons(START_MODES, p.startMode, (mode) => change((params) => (params.startMode = mode)))));
    if (p.startMode === 'fadeIn') root.append(this.numberField('Нарастание, долей', p.fadeIn, 0.0625, (value) => change((params) => (params.fadeIn = Math.max(0.01, value)))));
    root.append(this.section('Конец вспышки', this.buttons(END_MODES, p.endMode, (mode) => change((params) => (params.endMode = mode)))));
    root.append(this.numberField('Слой', effect.layer, 1, (value) => editor.updateEffects((item) => {
      item.layer = Math.max(0, Math.round(value));
      for (const clip of editor.effectChildren(item.id)) clip.layer = item.layer;
    })));
    if (effects.length === 1) {
      root.append(
        this.numberField('Начало, доля', effect.start, editor.snap || 0.25, (value) => editor.updateEffects((item) => {
          const shift = value - item.start;
          item.start += shift;
          item.end += shift;
          for (const clip of editor.effectChildren(item.id)) {
            clip.start += shift;
            clip.end += shift;
          }
        })),
        this.numberField('Длина, долей', effect.end - effect.start, editor.snap || 0.25, (value) => editor.updateEffects((item) => (item.end = item.start + Math.max(0.0625, value)))),
      );
      const target = effect.target === undefined ? undefined : findGroup(editor.groups, effect.target)?.group;
      const note = document.createElement('div');
      note.className = 'ins-note';
      note.textContent = `${target !== undefined ? `Идёт по группе «${target.name}»` : 'Идёт по лампам строки'}: ${String(editor.effectItemsOf(effect).length)} элементов, ${String(editor.effectChildren(effect.id).length)} событий. Перетащите эффект на другую строку, чтобы он шёл по ней.`;
      root.append(note);
    }
  }

  private check(label: string, checked: boolean, change: (on: boolean) => void) {
    const wrap = document.createElement('label');
    wrap.className = 'ins-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => change(box.checked));
    wrap.append(box, label);
    return wrap;
  }

  private slider(label: string, value: number, min: number, max: number, step: number, change: (value: number) => void) {
    const wrap = document.createElement('div');
    wrap.className = 'ins-section';
    const name = document.createElement('div');
    name.className = 'ins-label';
    name.textContent = label;
    const line = document.createElement('div');
    line.className = 'ins-bright';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const shown = document.createElement('span');
    shown.className = 'ins-value';
    shown.textContent = value.toFixed(2);
    input.addEventListener('input', () => (shown.textContent = Number(input.value).toFixed(2)));
    input.addEventListener('change', () => change(Number(input.value)));
    line.append(input, shown);
    wrap.append(name, line);
    return wrap;
  }

  private renderRaw(events: { type: number; value: number; floatValue: number; customData?: Record<string, unknown> }[]) {
    const first = events[0]!;
    const note = document.createElement('div');
    note.className = 'ins-note';
    const names: Record<string, string> = { rotation: 'поворот', step: 'шаг', prop: 'распространение', speed: 'скорость', direction: 'направление', nameFilter: 'кольца', counterSpin: 'встречно', reset: 'сброс' };
    const lines = [`${otherEventName(first.type)} · событий: ${String(events.length)}`, `значение ${String(first.value)}, float ${String(first.floatValue)}`];
    for (const [key, value] of Object.entries(first.customData ?? {})) {
      const bare = key.replace(/^_/u, '');
      lines.push(`${names[bare] ?? bare}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    }
    note.innerText = lines.join('\n');
    this.root.append(note);
  }

  private section(label: string, content: HTMLElement) {
    const wrap = document.createElement('div');
    wrap.className = 'ins-section';
    const name = document.createElement('div');
    name.className = 'ins-label';
    name.textContent = label;
    wrap.append(name, content);
    return wrap;
  }

  private buttons<T extends string>(options: [T, string, string][], current: T, pick: (value: T) => void) {
    const row = document.createElement('div');
    row.className = 'ins-buttons';
    for (const [value, label, title] of options) {
      const button = document.createElement('button');
      button.textContent = label;
      button.title = title;
      if (value === current) button.classList.add('active');
      button.addEventListener('click', () => pick(value));
      row.append(button);
    }
    return row;
  }

  private colorPicker(color: ClipColor, change: (color: ClipColor) => void) {
    const wrap = document.createElement('div');
    wrap.className = 'ins-color';
    const colors = this.editor.preview.colors;
    const refs: [ClipColor['ref'], string, Rgb][] = [
      ['left', 'Левый', [...colors.environmentLeft]],
      ['right', 'Правый', [...colors.environmentRight]],
      ['white', 'Белый', [...colors.environmentWhite]],
    ];
    for (const [ref, label, rgb] of refs) {
      const swatch = document.createElement('button');
      swatch.className = `ins-swatch${color.ref === ref ? ' active' : ''}`;
      swatch.title = `${label} цвет схемы`;
      swatch.style.background = toHex(rgb);
      swatch.addEventListener('click', () => change({ ...color, ref, rgb: undefined }));
      wrap.append(swatch);
    }
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.title = 'Свой цвет (Chroma)';
    custom.className = color.ref === 'custom' ? 'active' : '';
    custom.value = toHex(color.ref === 'custom' ? (color.rgb ?? [1, 1, 1]) : refs.find(([ref]) => ref === color.ref)?.[2] ?? [1, 1, 1]);
    custom.addEventListener('change', () => change({ ...color, ref: 'custom', rgb: fromHex(custom.value) }));
    wrap.append(custom);
    const brightness = document.createElement('input');
    brightness.type = 'range';
    brightness.min = '0';
    brightness.max = '2';
    brightness.step = '0.05';
    brightness.value = String(color.brightness);
    brightness.title = 'Яркость';
    const value = document.createElement('span');
    value.className = 'ins-value';
    value.textContent = color.brightness.toFixed(2);
    brightness.addEventListener('input', () => (value.textContent = Number(brightness.value).toFixed(2)));
    brightness.addEventListener('change', () => change({ ...color, brightness: Number(brightness.value) }));
    const line = document.createElement('div');
    line.className = 'ins-bright';
    line.append(brightness, value);
    const box = document.createElement('div');
    box.append(wrap, line);
    return box;
  }

  private numberField(label: string, value: number, step: number, change: (value: number) => void) {
    const wrap = document.createElement('label');
    wrap.className = 'ins-number';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(step);
    input.value = String(Math.round(value * 10000) / 10000);
    input.addEventListener('change', () => {
      const number = Number(input.value);
      if (Number.isFinite(number)) change(number);
    });
    // (Enter: done — the keys go back to the editor)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === 'Escape') input.blur();
    });
    wrap.append(label, input);
    return wrap;
  }
}
