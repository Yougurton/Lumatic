import type { Editor } from './editor';
import type { ClipColor, EndMode, LightClip, Rgb, StartMode } from './model';

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
      lights.textContent = clip.ids === null ? 'Все лампы группы' : `Лампы: ${clip.ids.join(', ')}`;
      root.append(lights);
    }
    if (clips.length === 0) {
      const note = document.createElement('div');
      note.className = 'ins-note';
      note.textContent = 'Протяните по строке таймлайна, чтобы нарисовать событие. Shift — выделение рамкой, Alt — копия при перетаскивании, ПКМ — удалить.';
      root.append(note);
    }
  }

  private renderRaw(events: { type: number; value: number; floatValue: number; customData?: Record<string, unknown> }[]) {
    const first = events[0]!;
    const note = document.createElement('div');
    note.className = 'ins-note';
    note.textContent = `Событий: ${String(events.length)}. Значение ${String(first.value)}, float ${String(first.floatValue)}${first.customData === undefined ? '' : `, ${JSON.stringify(first.customData)}`}`;
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
    wrap.append(label, input);
    return wrap;
  }
}
