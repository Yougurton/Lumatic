import type { SchemeColors } from './bake';
import type { Editor } from './editor';
import { generateEffect, sketchLevel, type Effect, type EffectItem, type EffectKind, type EffectParams } from './effects';
import type { ClipColor, LightClip, RawEvent } from './model';
import { newColorBox } from './gls';
import { PresetPanel } from './presets';
import { newRingBlock } from './rings';

/**
 * The library on the right: effects (a card each, its sketch moving while the mouse is over it) —
 * click one, then drag along a row to draw it (or double-click it: it goes onto the row picked last,
 * at the cursor; ▶ tries it out in the 3D view first); ring forms and spins (one click puts the ring
 * event in at the cursor); and the user's presets.
 */

interface EffectCard {
  name: string;
  hint: string;
  kind: EffectKind;
  /** Beats it lasts when put in with a double click. */
  length: number;
  params: (colors: { main: ClipColor; other: ClipColor }) => Partial<EffectParams>;
}

const EFFECTS: EffectCard[] = [
  { name: 'GLS-группа', hint: 'Блок как в редакторе Beat Saber (Group Lighting System): коробки с фильтрами, распределение по времени и яркости, свои события, строб, вращение колец', kind: 'gls', length: 4, params: () => ({}) },
  { name: 'Волна', hint: 'Вспышка бежит по элементам группы по порядку', kind: 'wave', length: 4, params: () => ({ direction: 'forward', pulse: 1, startMode: 'flash', endMode: 'fade' }) },
  { name: 'Туда-обратно', hint: 'Волна проходит туда и обратно', kind: 'wave', length: 4, params: () => ({ direction: 'pingpong', repeats: 2, pulse: 0.75, startMode: 'flash', endMode: 'fade' }) },
  { name: 'От центра', hint: 'Волна расходится от середины к краям', kind: 'wave', length: 2, params: () => ({ direction: 'outward', pulse: 0.75, startMode: 'flash', endMode: 'fade' }) },
  { name: 'К центру', hint: 'Волна сходится от краёв к середине', kind: 'wave', length: 2, params: () => ({ direction: 'inward', pulse: 0.75, startMode: 'flash', endMode: 'fade' }) },
  {
    name: 'Радужная волна',
    hint: 'Волна, где каждый элемент своего оттенка',
    kind: 'wave',
    length: 4,
    params: () => ({ direction: 'forward', pulse: 1.5, startMode: 'on', endMode: 'fade', color: { ref: 'custom', rgb: [1, 0, 0], brightness: 1 }, color2: { ref: 'custom', rgb: [0.7, 0, 1], brightness: 1 }, hsv: true }),
  },
  { name: 'Цветная волна', hint: 'Волна с переходом цвета от первого элемента к последнему', kind: 'wave', length: 4, params: ({ other }) => ({ direction: 'forward', pulse: 1, startMode: 'flash', endMode: 'fade', color2: other }) },
  { name: 'Заполнение', hint: 'Элементы зажигаются по очереди и горят до конца', kind: 'fill', length: 4, params: () => ({ direction: 'forward', pulse: 2, startMode: 'on', endMode: 'fade' }) },
  { name: 'Стробоскоп', hint: 'Все лампы мигают разом', kind: 'strobe', length: 2, params: () => ({ pattern: 'all', rate: 0.25, duty: 0.5, startMode: 'on', endMode: 'off' }) },
  { name: 'Строб 2 цвета', hint: 'Мигание с чередованием двух цветов', kind: 'strobe', length: 2, params: ({ other }) => ({ pattern: 'all', rate: 0.25, duty: 0.6, startMode: 'on', endMode: 'off', color2: other }) },
  { name: 'Чередование', hint: 'Чётные и нечётные элементы мигают по очереди', kind: 'strobe', length: 2, params: () => ({ pattern: 'alternate', rate: 0.25, duty: 0.9, startMode: 'on', endMode: 'off' }) },
  { name: 'Бегущий огонь', hint: 'Огонёк бегает по элементам по кругу', kind: 'strobe', length: 4, params: () => ({ pattern: 'sequence', rate: 0.125, duty: 1, startMode: 'on', endMode: 'off' }) },
  { name: 'Пульс', hint: 'Вспышка на каждую долю, гаснущая к следующей', kind: 'strobe', length: 4, params: () => ({ pattern: 'all', rate: 1, duty: 0.95, startMode: 'flash', endMode: 'fade' }) },
  { name: 'Градиент', hint: 'Все элементы горят, цвет плавно меняется от первого к последнему', kind: 'gradient', length: 4, params: ({ other }) => ({ startMode: 'fadeIn', fadeIn: 0.5, endMode: 'fade', color2: other }) },
  { name: 'Мерцание', hint: 'Случайные лампы вспыхивают и гаснут', kind: 'twinkle', length: 4, params: () => ({ rate: 0.25, density: 0.3, duty: 1.5, startMode: 'flash', endMode: 'fade' }) },
];

interface RingCard {
  name: string;
  hint: string;
  type: 8 | 9;
  data: Record<string, number>;
}

const RINGS: RingCard[] = [
  { name: 'Ровно', hint: 'Все кольца встают ровно, одно за другим', type: 8, data: { rotation: 0, step: 0, prop: 50, speed: 2, direction: 0 } },
  { name: 'Спираль', hint: 'Каждое следующее кольцо повёрнуто на 15°', type: 8, data: { rotation: 0, step: 15, prop: 50, speed: 2, direction: 0 } },
  { name: 'Крутая спираль', hint: 'Каждое кольцо повёрнуто на 45°', type: 8, data: { rotation: 0, step: 45, prop: 50, speed: 2, direction: 0 } },
  { name: 'Крест', hint: 'Кольца через одно повёрнуты на 90°', type: 8, data: { rotation: 0, step: 90, prop: 50, speed: 2, direction: 0 } },
  { name: 'Поворот 90°', hint: 'Все кольца разом поворачиваются на 90°', type: 8, data: { rotation: 90, step: 0, prop: 50, speed: 2, direction: 0 } },
  { name: 'Поворот волной', hint: 'Поворот на 90° бежит от ближних колец к дальним', type: 8, data: { rotation: 90, step: 0, prop: 1, speed: 1, direction: 0 } },
  { name: 'Закрутка', hint: 'Пол-оборота со спиралью, волной', type: 8, data: { rotation: 180, step: 15, prop: 2, speed: 1, direction: 0 } },
  { name: 'Обратно', hint: 'Поворот на 90° в другую сторону (по часовой)', type: 8, data: { rotation: 90, step: 0, prop: 50, speed: 2, direction: 1 } },
  { name: 'Сжать', hint: 'Кольца сдвигаются ближе друг к другу', type: 9, data: { step: 0.5, speed: 2 } },
  { name: 'Растянуть', hint: 'Кольца расходятся дальше друг от друга', type: 9, data: { step: 4, speed: 2 } },
];

/** The effect sketch: 8 items in a row, lit as the effect would light them at `t`. */
function drawEffectSketch(canvas: HTMLCanvasElement, card: EffectCard, colors: SchemeColors, t: number | null) {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  ctx.fillStyle = '#0c0d11';
  ctx.fillRect(0, 0, width, height);
  const main: ClipColor = { ref: 'right', brightness: 1 };
  const other: ClipColor = { ref: 'left', brightness: 1 };
  const effect: Effect = {
    id: 'sketch',
    name: card.name,
    kind: card.kind,
    type: 0,
    ids: null,
    start: 0,
    end: card.length,
    layer: 1,
    ...(card.kind === 'gls' ? { gls: { boxes: [{ ...newColorBox(main), beatValue: 2, events: [{ id: 'a', beat: 0, transition: 'instant', color: main, brightness: 1, strobe: 0 }, { id: 'b', beat: 1.5, transition: 'fade', color: main, brightness: 0, strobe: 0 }] }] } } : {}),
    params: { color: main, color2: null, hsv: false, startMode: 'flash', endMode: 'fade', fadeIn: 0.25, pulse: 1, repeats: 1, direction: 'forward', rate: 0.25, duty: 0.5, pattern: 'all', density: 0.3, seed: 7, ...card.params({ main, other }) },
  };
  const items: EffectItem[] = Array.from({ length: 8 }, (_, id) => ({ kind: 'light', type: 0, id }));
  const clips: LightClip[] = generateEffect(effect, items, colors);
  const time = t ?? card.length * 0.45;
  const gap = width / 8;
  for (let i = 0; i < 8; i++) {
    const { level, color } = sketchLevel(clips, i, time, 2);
    const cx = gap * (i + 0.5);
    const rgb = color === null ? [0, 0, 0] : color.ref === 'custom' ? (color.rgb ?? [1, 1, 1]) : colors[color.ref];
    const k = Math.min(1.3, level);
    ctx.fillStyle = '#1d1f27';
    ctx.fillRect(cx - gap * 0.32, height * 0.2, gap * 0.64, height * 0.6);
    if (k > 0.02) {
      const c = rgb.map((v) => Math.round(Math.min(255, v * 255 * k + (k > 1 ? (k - 1) * 255 : 0))));
      ctx.shadowColor = `rgb(${c.join(',')})`;
      ctx.shadowBlur = 10 * k;
      ctx.fillStyle = `rgb(${c.join(',')})`;
      ctx.fillRect(cx - gap * 0.32, height * 0.2, gap * 0.64, height * 0.6);
      ctx.shadowBlur = 0;
    }
  }
  if (t !== null) {
    ctx.fillStyle = 'rgba(255,80,110,0.8)';
    ctx.fillRect((Math.min(t, card.length) / card.length) * width, height - 3, 2, 3);
  }
}

/** The ring sketch: 7 rings seen down the tunnel turning to the form. */
function drawRingSketch(canvas: HTMLCanvasElement, card: RingCard, t: number | null) {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  ctx.fillStyle = '#0c0d11';
  ctx.fillRect(0, 0, width, height);
  const time = t ?? 2.5;
  const rings = 7;
  const cx = width / 2;
  const cy = height / 2;
  for (let k = rings - 1; k >= 0; k--) {
    let angle: number;
    let scale = 1 / (1 + k * 0.32);
    if (card.type === 8) {
      const prop = card.data.prop ?? 50;
      const delay = prop >= 20 ? 0 : (k / Math.max(0.5, prop)) * 0.35;
      const speed = card.data.speed ?? 2;
      const progress = Math.min(1, Math.max(0, time - 0.3 - delay) * speed * 0.6);
      const eased = 1 - (1 - progress) ** 3;
      const from = 20;
      const sign = card.data.direction === 1 ? -1 : 1;
      const to = from + sign * (card.data.rotation ?? 0) + k * (card.data.step ?? 0);
      angle = ((from + (to - from) * eased) * Math.PI) / 180;
    } else {
      angle = (20 * Math.PI) / 180;
      const progress = Math.min(1, Math.max(0, time - 0.3) * 0.8);
      const eased = 1 - (1 - progress) ** 3;
      const spread = 1.5 + ((card.data.step ?? 1) - 1.5) * eased;
      scale = 1 / (1 + k * 0.2 * spread);
    }
    const size = Math.min(width, height * 1.6) * 0.42 * scale;
    ctx.save();
    ctx.translate(cx, cy);
    // (a growing angle turns the rings counterclockwise as the player sees them)
    ctx.rotate(-angle);
    const hue = 270 - k * 12;
    ctx.strokeStyle = `hsl(${String(hue)} 80% ${String(70 - k * 5)}%)`;
    ctx.lineWidth = Math.max(1, 3 * scale);
    ctx.strokeRect(-size, -size * 0.62, size * 2, size * 1.24);
    ctx.restore();
  }
}

export class Library {
  private tab: 'effects' | 'rings' | 'presets' = 'effects';
  private readonly body: HTMLElement;
  private readonly presetBox: HTMLElement;
  readonly presets: PresetPanel;
  private targetLabel: HTMLElement | null = null;
  /** Which ring system ring events go to (Chroma's nameFilter; null: all of them). */
  private ringFilter: string | null = null;
  private animating: { canvas: HTMLCanvasElement; draw: (t: number) => void; started: number } | null = null;

  constructor(private readonly editor: Editor, private readonly root: HTMLElement) {
    root.classList.add('lib');
    const tabs = document.createElement('div');
    tabs.className = 'lib-tabs';
    this.body = document.createElement('div');
    this.body.className = 'lib-body';
    this.presetBox = document.createElement('div');
    this.presetBox.className = 'lib-presets';
    this.presets = new PresetPanel(editor, this.presetBox);
    for (const [key, label] of [
      ['effects', 'Эффекты'],
      ['rings', 'Кольца'],
      ['presets', 'Пресеты'],
    ] as const) {
      const button = document.createElement('button');
      button.textContent = label;
      button.dataset.tab = key;
      button.addEventListener('click', () => {
        this.tab = key;
        this.render();
      });
      tabs.append(button);
    }
    root.append(tabs, this.body);
    editor.onChange((what) => {
      if (what === 'selection' || what === 'rows' || what === 'all') this.updateTarget();
    });
    const loop = () => {
      const anim = this.animating;
      if (anim !== null) anim.draw(((performance.now() - anim.started) / 1000) * 2);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.render();
  }

  private colors(): SchemeColors {
    return this.editor.scheme();
  }

  render() {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('.lib-tabs button')) button.classList.toggle('active', button.dataset.tab === this.tab);
    this.animating = null;
    this.body.replaceChildren();
    if (this.tab === 'presets') {
      this.body.append(this.presetBox);
      return;
    }
    const head = document.createElement('div');
    head.className = 'lib-head';
    this.targetLabel = document.createElement('span');
    this.targetLabel.className = 'lib-target';
    head.append(this.targetLabel);
    if (this.tab === 'effects') {
      const plain = document.createElement('button');
      plain.textContent = 'Обычный свет';
      plain.title = 'Рисовать обычные события (Esc)';
      plain.className = this.editor.tool.kind === 'clip' ? 'active' : '';
      plain.addEventListener('click', () => this.arm(null));
      head.append(plain);
    }
    this.body.append(head);
    if (this.tab === 'rings') {
      const systems = this.editor.preview.ringSystems().filter((system) => system.rotates || system.zooms);
      if (systems.length > 1) {
        const pick = document.createElement('select');
        pick.className = 'lib-select';
        pick.title = 'Какие кольца поворачивать (Chroma nameFilter)';
        pick.append(Object.assign(document.createElement('option'), { value: '', textContent: 'Все кольца' }));
        for (const system of systems) pick.append(Object.assign(document.createElement('option'), { value: system.name, textContent: `${ringSystemName(system.name)} (${String(system.rings)})` }));
        pick.value = this.ringFilter ?? '';
        pick.addEventListener('change', () => (this.ringFilter = pick.value === '' ? null : pick.value));
        head.append(pick);
      } else this.ringFilter = null;
    }
    this.updateTarget();
    const grid = document.createElement('div');
    grid.className = 'lib-grid';
    if (this.tab === 'effects') for (const card of EFFECTS) grid.append(this.effectCard(card));
    else for (const card of RINGS) grid.append(this.ringCard(card));
    if (this.tab === 'rings' && this.editor.ringInfo.length > 0) {
      // the exact poses: a block of them at the cursor, its editor opened
      const poses = document.createElement('button');
      poses.className = 'lib-poses';
      poses.textContent = '◎ Точные позы колец…';
      poses.title = 'Блок поз у курсора: угол каждого кольца, спирали, волны, ручная раскладка — с предпросмотром';
      poses.addEventListener('click', () => {
        const editor = this.editor;
        if (editor.project === null) return;
        const start = editor.snapBeat(editor.playhead());
        const block = newRingBlock(editor.ringInfo[0]!.name, 'event', start, start + 4);
        editor.addRingBlock(block);
        editor.ringEditorHook?.(block.id);
      });
      this.body.append(poses);
    }
    const tip = document.createElement('div');
    tip.className = 'lib-tip';
    tip.textContent =
      this.tab === 'effects'
        ? 'Клик — выбрать эффект и протянуть по строке таймлайна. Двойной клик — вставить на выбранную строку у курсора. ▶ — попробовать в окне просмотра.'
        : 'Клик — вставить событие колец у курсора. ▶ — посмотреть в окне просмотра. Наведите на карточку, чтобы увидеть схему.';
    this.body.append(grid, tip);
  }

  private updateTarget() {
    if (this.targetLabel === null) return;
    const row = this.editor.libraryRow();
    this.targetLabel.textContent = this.tab === 'rings' ? 'События колец — у курсора' : row === null ? 'Откройте карту' : `Строка: ${row.label}`;
    this.targetLabel.title = 'Строка, на которую эффект ставится двойным кликом: последняя, по которой вы кликнули на таймлайне';
  }

  /** Effect cards: click arms the tool for drawing. */
  private arm(card: EffectCard | null) {
    const editor = this.editor;
    if (card === null || (editor.tool.kind === 'effect' && editor.tool.name === card.name)) editor.tool = { kind: 'clip' };
    else editor.tool = { kind: 'effect', name: card.name, effect: card.kind, params: card.params(this.cardColors()) };
    editor.setStatus(editor.tool.kind === 'effect' ? `Протяните по строке таймлайна, чтобы нарисовать «${card!.name}» (Esc — обычный свет)` : 'Рисование обычного света');
    this.render();
  }

  private cardColors() {
    const main = { ...this.editor.brush.color };
    const other: ClipColor = main.ref === 'left' ? { ref: 'right', brightness: main.brightness } : { ref: 'left', brightness: main.brightness };
    return { main, other };
  }

  private cardFrame(name: string, hint: string, canvas: HTMLCanvasElement, draw: (t: number | null) => void, onTry: () => void) {
    const card = document.createElement('div');
    card.className = 'lib-card';
    card.title = hint;
    canvas.width = 200;
    canvas.height = 64;
    draw(null);
    const label = document.createElement('div');
    label.className = 'lib-name';
    label.textContent = name;
    const play = document.createElement('button');
    play.className = 'lib-try';
    play.textContent = '▶';
    play.title = 'Попробовать в окне просмотра (не добавляя)';
    play.addEventListener('click', (event) => {
      event.stopPropagation();
      onTry();
    });
    play.addEventListener('dblclick', (event) => event.stopPropagation());
    card.append(canvas, label, play);
    card.addEventListener('mouseenter', () => (this.animating = { canvas, draw: (t) => draw(t % 5), started: performance.now() }));
    card.addEventListener('mouseleave', () => {
      if (this.animating?.canvas === canvas) this.animating = null;
      draw(null);
    });
    return card;
  }

  private effectCard(card: EffectCard) {
    const canvas = document.createElement('canvas');
    const element = this.cardFrame(card.name, card.hint, canvas, (t) => drawEffectSketch(canvas, card, this.colors(), t === null ? null : t % (card.length + 1)), () => this.tryEffect(card));
    if (this.editor.tool.kind === 'effect' && this.editor.tool.name === card.name) element.classList.add('armed');
    element.addEventListener('click', () => this.arm(card));
    element.addEventListener('dblclick', () => this.insertEffect(card));
    return element;
  }

  private ringCard(card: RingCard) {
    const canvas = document.createElement('canvas');
    const element = this.cardFrame(card.name, card.hint, canvas, (t) => drawRingSketch(canvas, card, t), () => this.tryRing(card));
    element.addEventListener('click', () => this.insertRing(card));
    return element;
  }

  private effectAtCursor(card: EffectCard): Effect | null {
    const editor = this.editor;
    const row = editor.libraryRow();
    if (row === null || editor.project === null) return null;
    const start = editor.snapBeat(editor.playhead());
    return editor.makeEffect(card.kind, card.params(this.cardColors()), row, start, start + card.length, card.name);
  }

  private insertEffect(card: EffectCard) {
    const effect = this.effectAtCursor(card);
    if (effect === null) return;
    this.editor.tool = { kind: 'clip' };
    this.editor.addEffect(effect);
    this.render();
    if (effect.kind === 'gls') this.editor.glsEditorHook?.(effect.id);
  }

  private tryEffect(card: EffectCard) {
    const effect = this.effectAtCursor(card);
    if (effect === null) return;
    this.editor.startTrial({ clips: this.editor.previewEffectChildren(effect), raw: [], start: effect.start, end: effect.end });
    this.editor.setStatus(`Пробую «${card.name}» — Esc, чтобы остановить`);
  }

  private ringEvent(card: RingCard): Omit<RawEvent, 'id'> {
    return { beat: this.editor.snapBeat(this.editor.playhead()), type: card.type, value: 0, floatValue: 1, customData: { ...card.data, ...(this.ringFilter === null ? {} : { nameFilter: this.ringFilter }) } };
  }

  private insertRing(card: RingCard) {
    if (this.editor.project === null) return;
    this.editor.addRaw([this.ringEvent(card)]);
    this.editor.setStatus(`«${card.name}» добавлено на ${String(this.editor.snapBeat(this.editor.playhead()))} долю`);
  }

  private tryRing(card: RingCard) {
    if (this.editor.project === null) return;
    const event = { ...this.ringEvent(card), id: 'trial' };
    this.editor.startTrial({ clips: [], raw: [event], start: event.beat, end: event.beat + 4 });
    this.editor.setStatus(`Пробую «${card.name}» — Esc, чтобы остановить`);
  }
}

/** A ring system's name as people say it. */
export function ringSystemName(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes('small')) return 'Малые кольца';
  if (lower.includes('big')) return 'Большие кольца';
  if (lower.includes('panel')) return 'Панели';
  return name === '' ? 'Кольца' : name;
}
