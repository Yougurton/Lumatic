import { resolveRgb } from './bake';
import type { Editor } from './editor';
import type { Effect } from './effects';
import { defaultFilter, filterUnits, newColorBox, newRotationBox, type GlsBox, type GlsColorEvent, type GlsEasing, type GlsRotationEvent, type GlsSpread, type GlsTransition } from './gls';
import { ringSystemName } from './library';
import { findGroup, newId, type ClipColor, type Rgb } from './model';

/**
 * The editor of a GLS block, docked where the timeline is (the 3D view above stays in sight and shows
 * the block: picking an event puts the song there), as in the game's lighting editor: on the left its boxes (the upper wins
 * where they pick the same element), in the middle the chosen box's filter and spreads, on the right
 * its lane of events (click: a new one, drag: move, Delete: remove) and the chosen event; at the
 * bottom what comes out — a row per element of the group, its light over the block's time.
 * Every change is one undo step; the block's events are made anew at once.
 */

const EASINGS: [GlsEasing, string][] = [
  ['none', 'Без перехода'],
  ['linear', 'Линейно'],
  ['inQuad', 'Разгон (InQuad)'],
  ['outQuad', 'Торможение (OutQuad)'],
  ['inOutQuad', 'Разгон и торможение'],
];

const TRANSITIONS: [GlsTransition, string, string][] = [
  ['instant', 'Сразу', 'Значение ставится мгновенно'],
  ['fade', 'Плавно', 'Плавный переход от предыдущего события к этому'],
  ['extend', 'Продлить', 'Держит предыдущее значение до этого места, следующий переход начинается отсюда'],
];

const STROBES = [0, 1, 2, 4, 8, 16, 32];

export class GlsEditor {
  private shade: HTMLElement | null = null;
  private effectId = '';
  private boxId: string | null = null;
  private eventId: string | null = null;
  private laneDrag: { id: string; startX: number; moved: boolean } | null = null;
  private keyHandler = (event: KeyboardEvent) => this.onKey(event);
  private resizeHandler = () => this.place();
  private raf = 0;

  constructor(private readonly editor: Editor) {
    editor.glsEditorHook = (id) => this.open(id);
    editor.onChange((what) => {
      if (this.shade === null) return;
      if (this.effect() === undefined) {
        this.close();
        return;
      }
      if (what === 'clips' || what === 'all') this.render();
    });
  }

  private effect(): Effect | undefined {
    return this.editor.effectById(this.effectId);
  }

  private box(): GlsBox | undefined {
    const boxes = this.effect()?.gls?.boxes ?? [];
    return boxes.find((box) => box.id === this.boxId) ?? boxes[0];
  }

  open(id: string) {
    const effect = this.editor.effectById(id);
    if (effect === undefined || effect.kind !== 'gls') return;
    this.close();
    this.effectId = id;
    this.boxId = effect.gls?.boxes[0]?.id ?? null;
    this.eventId = null;
    const shade = document.createElement('div');
    shade.className = 'gls-dock';
    document.body.append(shade);
    this.shade = shade;
    this.place();
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('keydown', this.keyHandler, true);
    this.render();
    const tick = () => {
      this.drawResultPlayhead();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  close() {
    if (this.shade === null) return;
    this.shade.remove();
    this.shade = null;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('keydown', this.keyHandler, true);
    this.editor.stopTrial();
  }

  /** Over the timeline (as the ring editor). */
  private place() {
    const dock = this.shade;
    const timeline = document.getElementById('timeline');
    if (dock === null || timeline === null) return;
    const rect = timeline.getBoundingClientRect();
    const height = Math.max(420, rect.height);
    dock.style.left = `${String(rect.left)}px`;
    dock.style.top = `${String(Math.min(rect.top, window.innerHeight - height))}px`;
    dock.style.width = `${String(rect.width)}px`;
    dock.style.height = `${String(height)}px`;
  }

  private onKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    const typing = target instanceof HTMLInputElement && ['text', 'number'].includes(target.type);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (this.editor.previewExtra !== null) this.editor.stopTrial();
      else this.close();
      return;
    }
    if (typing) {
      event.stopImmediatePropagation();
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.code === 'KeyZ') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) this.editor.redo();
      else this.editor.undo();
      return;
    }
    if (ctrl && event.code === 'KeyY') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.editor.redo();
      return;
    }
    if ((event.code === 'Delete' || event.code === 'Backspace') && this.eventId !== null) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.deleteEvent();
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.play();
      return;
    }
    // (the rest of the editor's keys don't reach the timeline behind)
    event.stopImmediatePropagation();
  }

  /** One change to the block: an undo step, its events made anew. */
  private change(patch: (effect: Effect) => void) {
    this.editor.updateEffect(this.effectId, (effect) => {
      effect.gls ??= { boxes: [] };
      patch(effect);
    });
  }

  private changeBox(patch: (box: GlsBox) => void) {
    const id = this.box()?.id;
    this.change((effect) => {
      const box = effect.gls!.boxes.find((item) => item.id === id);
      if (box !== undefined) patch(box);
    });
  }

  private play() {
    const effect = this.effect();
    if (effect === undefined) return;
    if (this.editor.previewExtra !== null) this.editor.stopTrial();
    else this.editor.startTrial({ clips: [], raw: [], start: effect.start, end: effect.end });
  }

  // ----- rendering -------------------------------------------------------------------------------------

  private render() {
    const shade = this.shade;
    const effect = this.effect();
    if (shade === null || effect === undefined) return;
    if (holdWhileTyping(shade, () => this.render())) return;
    const scroll = [...shade.querySelectorAll<HTMLElement>('.gls-col')].map((col) => col.scrollTop);
    shade.replaceChildren();
    const dialog = document.createElement('div');
    dialog.className = 'gls-dialog';
    dialog.append(this.header(effect), scrubStrip(this.editor, () => this.effect() ?? null));
    const body = document.createElement('div');
    body.className = 'gls-body';
    body.append(this.boxList(effect), this.boxSettings(), this.laneColumn(effect));
    dialog.append(body, this.result(effect));
    shade.append(dialog);
    [...shade.querySelectorAll<HTMLElement>('.gls-col')].forEach((col, index) => (col.scrollTop = scroll[index] ?? 0));
  }

  private header(effect: Effect) {
    const head = document.createElement('div');
    head.className = 'gls-head';
    const title = document.createElement('span');
    title.className = 'gls-title';
    title.textContent = 'GLS-группа';
    const name = textInput(effect.name, (value) => this.change((item) => (item.name = value || item.name)));
    name.className = 'gls-name';
    const target = effect.target === undefined ? undefined : findGroup(this.editor.groups, effect.target)?.group;
    const where = document.createElement('span');
    where.className = 'gls-dim';
    where.textContent = `${target !== undefined ? `на группе «${target.name}»` : 'на строке ламп'} · элементов: ${String(this.editor.effectItemsOf(effect).length)}`;
    const length = labeled('Длина, долей', numberInput(effect.end - effect.start, 0.25, (value) => this.change((item) => (item.end = item.start + Math.max(0.25, value)))));
    const layer = labeled('Слой', numberInput(effect.layer, 1, (value) => this.change((item) => (item.layer = Math.max(0, Math.round(value))))));
    const play = button(this.editor.previewExtra !== null ? '■ Стоп' : '▶ Проиграть', 'Проиграть блок по кругу в окне просмотра (Пробел)', () => {
      this.play();
      this.render();
    });
    const done = button('Готово', 'Закрыть (Esc)', () => this.close());
    done.classList.add('primary');
    head.append(title, name, where, length, layer, play, done);
    return head;
  }

  private boxList(effect: Effect) {
    const col = document.createElement('div');
    col.className = 'gls-col gls-boxes';
    col.append(heading('Коробки'));
    const note = document.createElement('div');
    note.className = 'gls-note';
    note.textContent = 'Верхняя коробка перекрывает нижние на общих элементах.';
    col.append(note);
    const boxes = effect.gls?.boxes ?? [];
    const items = this.editor.effectItemsOf(effect).length;
    boxes.forEach((box, index) => {
      const row = document.createElement('div');
      row.className = `gls-box${box.id === this.box()?.id ? ' active' : ''}`;
      const label = document.createElement('div');
      label.className = 'gls-box-name';
      label.textContent = `${String(index + 1)}. ${box.kind === 'color' ? 'Свет' : 'Вращение колец'}`;
      const info = document.createElement('div');
      info.className = 'gls-dim';
      info.textContent = box.kind === 'color' ? `${describeFilter(box)} · ${String(filterUnits(box.filter, items).length)} эл. · ${String(box.events.length)} соб.` : `${box.rings === '' ? 'все кольца' : ringSystemName(box.rings)} · ${String(box.rotations.length)} соб.`;
      const tools = document.createElement('div');
      tools.className = 'gls-box-tools';
      tools.append(
        button('↑', 'Выше (важнее)', () => this.change((item) => swap(item.gls!.boxes, index, index - 1)), index === 0),
        button('↓', 'Ниже', () => this.change((item) => swap(item.gls!.boxes, index, index + 1)), index === boxes.length - 1),
        button('⧉', 'Копия коробки', () => {
          const copy: GlsBox = { ...structuredClone(box), id: newId('b') };
          copy.events = copy.events.map((event) => ({ ...event, id: newId('v') }));
          copy.rotations = copy.rotations.map((event) => ({ ...event, id: newId('v') }));
          this.boxId = copy.id;
          this.change((item) => item.gls!.boxes.splice(index + 1, 0, copy));
        }),
        button('✕', 'Удалить коробку', () => this.change((item) => item.gls!.boxes.splice(index, 1)), boxes.length <= 1),
      );
      row.append(label, info, tools);
      row.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).tagName === 'BUTTON') return;
        this.boxId = box.id;
        this.eventId = null;
        this.render();
      });
      col.append(row);
    });
    const add = document.createElement('div');
    add.className = 'gls-add';
    const color = this.editor.brush.color;
    const rings = this.editor.preview.ringSystems().some((system) => system.rotates);
    add.append(
      button('＋ Свет', 'Новая коробка света', () => {
        const box = newColorBox(color);
        this.boxId = box.id;
        this.change((item) => item.gls!.boxes.push(box));
      }),
      button('＋ Вращение колец', rings ? 'Коробка вращения колец' : 'В этом окружении нет вращающихся колец', () => {
        const box = newRotationBox();
        this.boxId = box.id;
        this.change((item) => item.gls!.boxes.push(box));
      }, !rings),
    );
    col.append(add);
    // the game's "super add": a box per element (V2-style lighting inside one block)
    const each = button('Каждому элементу — своя коробка', 'Сделать по коробке на каждый элемент (шаг 0, сдвиг 1, 2, 3…) — как ручной свет V2', () => {
      const template = this.box();
      if (template === undefined || template.kind !== 'color') return;
      this.change((item) => {
        const count = Math.min(64, items);
        const made: GlsBox[] = [];
        for (let i = 0; i < count; i++) {
          const copy: GlsBox = { ...structuredClone(template), id: newId('b'), filter: { ...defaultFilter(), type: 'step', step: 0, offset: i } };
          copy.events = copy.events.map((event) => ({ ...event, id: newId('v') }));
          made.push(copy);
        }
        item.gls!.boxes = [...made, ...item.gls!.boxes.filter((box) => box.kind === 'rotation')];
        this.boxId = made[0]?.id ?? null;
      });
    }, this.box()?.kind !== 'color' || items > 64);
    each.className = 'gls-wide';
    col.append(each);
    return col;
  }

  private boxSettings() {
    const col = document.createElement('div');
    col.className = 'gls-col gls-settings';
    const box = this.box();
    if (box === undefined) return col;
    if (box.kind === 'color') {
      col.append(heading('Фильтр'));
      col.append(toggle([['division', 'Секции'], ['step', 'Шаг и сдвиг']], box.filter.type, (value) => this.changeBox((item) => (item.filter.type = value))));
      if (box.filter.type === 'division') {
        col.append(
          labeled('Секций', numberInput(box.filter.sections, 1, (value) => this.changeBox((item) => (item.filter.sections = Math.max(1, Math.round(value)))))),
          labeled('Номер секции', numberInput(box.filter.section + 1, 1, (value) => this.changeBox((item) => (item.filter.section = Math.max(0, Math.round(value) - 1))))),
        );
      } else {
        col.append(
          labeled('Шаг (0 — один)', numberInput(box.filter.step, 1, (value) => this.changeBox((item) => (item.filter.step = Math.max(0, Math.round(value)))))),
          labeled('Сдвиг (с какого)', numberInput(box.filter.offset + 1, 1, (value) => this.changeBox((item) => (item.filter.offset = Math.max(0, Math.round(value) - 1))))),
        );
      }
      col.append(check('Обратный порядок', box.filter.reverse, (on) => this.changeBox((item) => (item.filter.reverse = on))));
      col.append(labeled('Куски (0 — нет)', numberInput(box.filter.chunks, 1, (value) => this.changeBox((item) => (item.filter.chunks = Math.max(0, Math.round(value)))))));
      col.append(labeled('Случайно', select([['none', 'Нет'], ['shuffle', 'Перемешать порядок'], ['pick', 'Случайные элементы']], box.filter.random, (value) => this.changeBox((item) => (item.filter.random = value)))));
      col.append(labeled('Сколько взять, %', numberInput(Math.round(box.filter.limit * 100), 5, (value) => this.changeBox((item) => (item.filter.limit = Math.min(1, Math.max(0.01, value / 100)))))));
      if (box.filter.random !== 'none') col.append(button('🎲 Другой случай', 'Другое случайное распределение', () => this.changeBox((item) => (item.filter.seed = Math.floor(Math.random() * 1e6)))));
    } else {
      col.append(heading('Кольца'));
      const systems = this.editor.preview.ringSystems().filter((system) => system.rotates);
      col.append(labeled('Какие', select([['', 'Все кольца'], ...systems.map((system): [string, string] => [system.name, `${ringSystemName(system.name)} (${String(system.rings)})`])], box.rings, (value) => this.changeBox((item) => (item.rings = value)))));
      const note = document.createElement('div');
      note.className = 'gls-note';
      note.textContent = 'Вращение крутит все кольца выбранной системы (так устроены события колец Chroma). Лазеры классических окружений поворачивать событиями нельзя.';
      col.append(note);
    }
    col.append(heading('Распределение по времени'));
    col.append(toggle(spreads(), box.beatSpread, (value) => this.changeBox((item) => (item.beatSpread = value))));
    col.append(labeled(box.beatSpread === 'wave' ? 'Волна на всех, долей' : 'Шаг на элемент, долей', numberInput(box.beatValue, 0.125, (value) => this.changeBox((item) => (item.beatValue = Math.max(0, value))))));
    col.append(heading(box.kind === 'color' ? 'Распределение яркости' : 'Распределение угла'));
    col.append(toggle(spreads(), box.valueSpread, (value) => this.changeBox((item) => (item.valueSpread = value))));
    col.append(labeled(box.kind === 'color' ? (box.valueSpread === 'wave' ? 'Последнему элементу +' : 'Каждому следующему +') : box.valueSpread === 'wave' ? 'Последнему кольцу, °' : 'Каждому кольцу, °', numberInput(box.value, box.kind === 'color' ? 0.05 : 5, (value) => this.changeBox((item) => (item.value = value)))));
    if (box.kind === 'color') col.append(labeled('Сглаживание', select(EASINGS, box.easing, (value) => this.changeBox((item) => (item.easing = value)))));
    col.append(check('Затрагивать первое событие', box.affectFirst, (on) => this.changeBox((item) => (item.affectFirst = on))));
    return col;
  }

  private laneColumn(effect: Effect) {
    const col = document.createElement('div');
    col.className = 'gls-col gls-lane-col';
    const box = this.box();
    if (box === undefined) return col;
    col.append(heading(box.kind === 'color' ? 'События коробки' : 'Повороты'));
    const hint = document.createElement('div');
    hint.className = 'gls-note';
    hint.textContent = 'Клик по дорожке — новое событие, перетаскивание — сдвинуть, Delete — удалить.';
    col.append(hint);
    const canvas = document.createElement('canvas');
    canvas.className = 'gls-lane';
    col.append(canvas);
    requestAnimationFrame(() => this.drawLane(canvas, effect, box));
    this.bindLane(canvas, effect, box);
    if (box.kind === 'color') {
      const event = box.events.find((item) => item.id === this.eventId);
      if (event !== undefined) col.append(this.colorEventPanel(event));
    } else {
      const event = box.rotations.find((item) => item.id === this.eventId);
      if (event !== undefined) col.append(this.rotationEventPanel(event));
    }
    return col;
  }

  private colorEventPanel(event: GlsColorEvent) {
    const panel = document.createElement('div');
    panel.className = 'gls-event';
    const set = (patch: (item: GlsColorEvent) => void) => this.changeBox((box) => {
      const item = box.events.find((entry) => entry.id === event.id);
      if (item !== undefined) patch(item);
    });
    panel.append(labeled('Доля', numberInput(event.beat, this.editor.snap || 0.25, (value) => set((item) => (item.beat = Math.max(0, value))))));
    panel.append(toggle(TRANSITIONS.map(([key, label]) => [key, label]), event.transition, (value) => set((item) => (item.transition = value))));
    const colors = this.editor.preview.colors;
    const swatches = document.createElement('div');
    swatches.className = 'gls-swatches';
    const refs: [ClipColor['ref'], string, readonly number[]][] = [
      ['left', 'Красный (левый)', colors.environmentLeft],
      ['right', 'Синий (правый)', colors.environmentRight],
      ['white', 'Белый', colors.environmentWhite],
    ];
    for (const [ref, title, rgb] of refs) {
      const swatch = button('', title, () => set((item) => (item.color = { ref, brightness: 1 })));
      swatch.className = `ins-swatch${event.color.ref === ref ? ' active' : ''}`;
      swatch.style.background = hex(rgb as Rgb);
      swatches.append(swatch);
    }
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.title = 'Свой цвет (Chroma)';
    custom.value = hex(event.color.ref === 'custom' ? (event.color.rgb ?? [1, 1, 1]) : (refs.find(([ref]) => ref === event.color.ref)?.[2] as Rgb | undefined) ?? [1, 1, 1]);
    if (event.color.ref === 'custom') custom.classList.add('active');
    custom.addEventListener('change', () => set((item) => (item.color = { ref: 'custom', rgb: fromHex(custom.value), brightness: 1 })));
    swatches.append(custom);
    panel.append(swatches);
    panel.append(slider('Яркость', event.brightness, 0, 1.5, 0.05, (value) => set((item) => (item.brightness = value))));
    panel.append(labeled('Строб, вспышек в долю', select(STROBES.map((value): [string, string] => [String(value), value === 0 ? 'Нет' : `${String(value)}`]), String(event.strobe), (value) => set((item) => (item.strobe = Number(value))))));
    panel.append(button('Удалить событие', 'Delete', () => this.deleteEvent()));
    return panel;
  }

  private rotationEventPanel(event: GlsRotationEvent) {
    const panel = document.createElement('div');
    panel.className = 'gls-event';
    const set = (patch: (item: GlsRotationEvent) => void) => this.changeBox((box) => {
      const item = box.rotations.find((entry) => entry.id === event.id);
      if (item !== undefined) patch(item);
    });
    panel.append(labeled('Доля', numberInput(event.beat, this.editor.snap || 0.25, (value) => set((item) => (item.beat = Math.max(0, value))))));
    panel.append(labeled('Поворот, °', numberInput(event.angle, 5, (value) => set((item) => (item.angle = Math.round(value / 5) * 5)))));
    const quick = document.createElement('div');
    quick.className = 'gls-swatches';
    for (const angle of [0, 45, 90, 135, 180, 270]) quick.append(button(`${String(angle)}°`, `Поворот на ${String(angle)}°`, () => set((item) => (item.angle = angle))));
    panel.append(quick);
    panel.append(labeled('Целых оборотов', numberInput(event.loops, 1, (value) => set((item) => (item.loops = Math.max(0, Math.round(value)))))));
    // ('cw' is Chroma's direction 0 — which turns the rings counterclockwise as the player sees them)
    panel.append(toggle([['cw', 'Против часовой'], ['ccw', 'По часовой']], event.direction, (value) => set((item) => (item.direction = value))));
    panel.append(labeled('Сглаживание', select(EASINGS, event.easing, (value) => set((item) => (item.easing = value)))));
    panel.append(button('Удалить событие', 'Delete', () => this.deleteEvent()));
    return panel;
  }

  private deleteEvent() {
    const id = this.eventId;
    if (id === null) return;
    this.eventId = null;
    this.changeBox((box) => {
      box.events = box.events.filter((event) => event.id !== id);
      box.rotations = box.rotations.filter((event) => event.id !== id);
    });
  }

  // ----- the lane --------------------------------------------------------------------------------------

  private laneGeometry(canvas: HTMLCanvasElement, effect: Effect) {
    const width = canvas.clientWidth;
    const length = Math.max(0.25, effect.end - effect.start);
    const pad = 12;
    return { width, height: canvas.clientHeight, pad, length, toX: (beat: number) => pad + (beat / length) * (width - pad * 2), toBeat: (x: number) => ((x - pad) / (width - pad * 2)) * length };
  }

  private drawLane(canvas: HTMLCanvasElement, effect: Effect, box: GlsBox) {
    if (!canvas.isConnected || canvas.clientWidth === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const g = this.laneGeometry(canvas, effect);
    ctx.fillStyle = '#101116';
    ctx.fillRect(0, 0, g.width, g.height);
    const top = 16;
    const bottom = g.height - 8;
    // beats
    ctx.font = '10px system-ui, sans-serif';
    const snap = this.editor.snap > 0 ? this.editor.snap : 0.25;
    for (let beat = 0; beat <= g.length + 1e-6; beat += snap) {
      const whole = Math.abs(beat - Math.round(beat)) < 1e-6;
      ctx.fillStyle = whole ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.fillRect(Math.round(g.toX(beat)), top, 1, bottom - top);
      if (whole) {
        ctx.fillStyle = '#7d8394';
        ctx.fillText(String(Math.round(beat)), g.toX(beat) + 2, 11);
      }
    }
    const scheme = this.editor.scheme();
    if (box.kind === 'color') {
      // the brightness line the events make (up: brighter)
      const events = [...box.events].sort((a, b) => a.beat - b.beat);
      const y = (brightness: number) => bottom - Math.min(1.5, brightness) / 1.5 * (bottom - top - 6);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let last: { x: number; y: number; b: number } | null = null;
      const shown = new Map<string, number>();
      for (const event of events) {
        const x = g.toX(event.beat);
        const value: number = event.transition === 'extend' ? (last?.b ?? 0) : event.brightness;
        shown.set(event.id, value);
        if (last === null) ctx.moveTo(x, y(value));
        else if (event.transition === 'fade') ctx.lineTo(x, y(value));
        else {
          ctx.lineTo(x, last.y);
          ctx.lineTo(x, y(value));
        }
        last = { x, y: y(value), b: value };
      }
      if (last !== null) ctx.lineTo(g.toX(g.length), last.y);
      ctx.stroke();
      for (const event of events) {
        const x = g.toX(event.beat);
        const rgb = resolveRgb(event.color, scheme);
        const selected = event.id === this.eventId;
        ctx.fillStyle = event.transition === 'extend' ? '#8a8f9c' : hex(rgb);
        const level = shown.get(event.id) ?? event.brightness;
        ctx.fillRect(x - 5, y(level) - 5, 10, 10);
        ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.7)';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(x - 5, y(level) - 5, 10, 10);
        ctx.fillStyle = '#c9cdd8';
        const mark = event.transition === 'fade' ? '╱' : event.transition === 'extend' ? '→' : '';
        ctx.fillText(`${mark}${event.strobe > 0 ? ` /${String(event.strobe)}` : ''}`, x + 7, bottom - 2);
      }
    } else {
      for (const event of [...box.rotations].sort((a, b) => a.beat - b.beat)) {
        const x = g.toX(event.beat);
        const selected = event.id === this.eventId;
        const cy = (top + bottom) / 2;
        ctx.strokeStyle = selected ? '#ffffff' : '#b78cff';
        ctx.lineWidth = selected ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.arc(x, cy, 10, 0, Math.PI * 2);
        ctx.stroke();
        // (drawn as the player sees it: Chroma's direction 0 — 'cw' here — turns them counterclockwise)
        const angle = ((event.angle + event.loops * 360) * Math.PI) / 180 * (event.direction === 'cw' ? -1 : 1);
        ctx.beginPath();
        ctx.moveTo(x, cy);
        ctx.lineTo(x + Math.sin(angle) * 10, cy - Math.cos(angle) * 10);
        ctx.stroke();
        ctx.fillStyle = '#c9cdd8';
        ctx.fillText(`${event.direction === 'cw' ? '↺' : '↻'}${String(event.angle + event.loops * 360)}°`, x + 13, cy + 4);
      }
    }
  }

  private bindLane(canvas: HTMLCanvasElement, effect: Effect, box: GlsBox) {
    const local = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const snap = (beat: number) => {
      const step = this.editor.snap > 0 ? this.editor.snap : 0;
      return Math.max(0, step > 0 ? Math.round(beat / step) * step : beat);
    };
    const list = () => (box.kind === 'color' ? box.events : box.rotations) as { id: string; beat: number }[];
    let origin = 0;
    const move = (event: MouseEvent) => {
      const drag = this.laneDrag;
      if (drag === null) return;
      const { x } = local(event);
      if (!drag.moved && Math.abs(x - drag.startX) < 4) return;
      drag.moved = true;
      const g = this.laneGeometry(canvas, effect);
      const item = list().find((entry) => entry.id === drag.id);
      // (moved on screen while dragging; one undo step when let go)
      if (item !== undefined) item.beat = Math.min(g.length, snap(g.toBeat(x)));
      this.drawLane(canvas, effect, box);
    };
    const up = () => {
      const drag = this.laneDrag;
      this.laneDrag = null;
      window.removeEventListener('mousemove', move);
      if (drag === null) return;
      if (!drag.moved) {
        this.render();
        return;
      }
      const item = list().find((entry) => entry.id === drag.id);
      const beat = item?.beat ?? origin;
      if (item !== undefined) item.beat = origin;
      this.changeBox((target) => {
        const entry = ((target.kind === 'color' ? target.events : target.rotations) as { id: string; beat: number }[]).find((value) => value.id === drag.id);
        if (entry !== undefined) entry.beat = beat;
      });
    };
    canvas.addEventListener('mousedown', (event) => {
      const g = this.laneGeometry(canvas, effect);
      const { x } = local(event);
      const hit = list().map((item) => ({ item, d: Math.abs(g.toX(item.beat) - x) })).filter((entry) => entry.d <= 7).sort((a, b) => a.d - b.d)[0];
      if (hit !== undefined) {
        this.eventId = hit.item.id;
        origin = hit.item.beat;
        // (the 3D view shows the block at that event)
        if (this.editor.previewExtra === null && !this.editor.isPlaying()) this.editor.seek(effect.start + hit.item.beat + 0.02);
        this.laneDrag = { id: hit.item.id, startX: x, moved: false };
        this.drawLane(canvas, effect, box);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up, { once: true });
        return;
      }
      // a new event here: like the one before it (a colour event fades in to it after the first)
      const beat = Math.min(g.length, snap(g.toBeat(x)));
      const id = newId('v');
      this.eventId = id;
      this.changeBox((item) => {
        if (item.kind === 'color') {
          const before = [...item.events].filter((entry) => entry.beat <= beat).sort((a, b) => b.beat - a.beat)[0];
          item.events.push({ id, beat, transition: before === undefined ? 'instant' : 'fade', color: { ...(before?.color ?? this.editor.brush.color) }, brightness: before !== undefined && before.brightness > 0 ? 0 : 1, strobe: 0 });
        } else {
          item.rotations.push({ id, beat, angle: 90, loops: 0, direction: 'cw', easing: 'outQuad' });
        }
      });
    });
  }

  // ----- the result ------------------------------------------------------------------------------------

  private result(effect: Effect) {
    const wrap = document.createElement('div');
    wrap.className = 'gls-result';
    wrap.append(heading('Что получается: элементы группы во времени блока'));
    const canvas = document.createElement('canvas');
    canvas.className = 'gls-result-canvas';
    wrap.append(canvas);
    requestAnimationFrame(() => this.drawResult(canvas, effect));
    return wrap;
  }

  private resultCanvas: { canvas: HTMLCanvasElement; image: ImageData | null; toX: (beat: number) => number } | null = null;

  private drawResult(canvas: HTMLCanvasElement, effect: Effect) {
    if (!canvas.isConnected || canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    ctx.fillStyle = '#0c0d11';
    ctx.fillRect(0, 0, width, height);
    const items = this.editor.effectItemsOf(effect);
    const labelW = 96;
    const length = Math.max(0.25, effect.end - effect.start);
    const toX = (beat: number) => labelW + ((beat - effect.start) / length) * (width - labelW - 8);
    const rowH = Math.max(3, Math.min(18, (height - 4) / Math.max(1, items.length)));
    const scheme = this.editor.scheme();
    ctx.font = `${String(Math.min(11, Math.max(8, rowH - 3)))}px system-ui, sans-serif`;
    items.forEach((item, index) => {
      const y = 2 + index * rowH;
      ctx.fillStyle = index % 2 === 0 ? '#121319' : '#0f1015';
      ctx.fillRect(0, y, width, rowH);
      if (rowH >= 9) {
        ctx.fillStyle = '#8a90a0';
        const name = item.kind === 'group' ? (findGroup(this.editor.groups, item.id)?.group.name ?? '') : `ID ${String(item.id)}`;
        ctx.fillText(name.slice(0, 14), 6, y + rowH - 3);
      }
    });
    for (let beat = 0; beat <= length + 1e-6; beat += 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(toX(effect.start + beat), 0, 1, height);
    }
    for (const clip of this.editor.effectChildren(effect.id)) {
      const slot = clip.slot ?? 0;
      const x0 = toX(clip.start);
      const x1 = toX(clip.end);
      const y = slot < 0 ? 2 : 2 + slot * rowH;
      const h = slot < 0 ? items.length * rowH : rowH - 1;
      const c0 = resolveRgb(clip.color, scheme);
      const a0 = clip.startMode === 'fadeIn' ? 0.05 : Math.min(1, clip.color.brightness);
      const end = clip.endColor ?? clip.color;
      const c1 = resolveRgb(end, scheme);
      const a1 = clip.endMode === 'fade' ? 0.05 : Math.min(1, (clip.endColor ?? clip.color).brightness);
      const gradient = ctx.createLinearGradient(x0, 0, Math.max(x0 + 1, x1), 0);
      gradient.addColorStop(0, rgba(c0, a0));
      if (clip.startMode === 'fadeIn') gradient.addColorStop(Math.min(1, clip.fadeIn / Math.max(1e-6, clip.end - clip.start)), rgba(c0, Math.min(1, clip.color.brightness)));
      gradient.addColorStop(1, rgba(c1, a1));
      ctx.fillStyle = gradient;
      ctx.fillRect(x0, y, Math.max(1, x1 - x0), h);
    }
    // ring turns
    for (const event of this.editor.effectRaw(effect.id)) {
      const x = toX(event.beat);
      ctx.fillStyle = '#b78cff';
      ctx.beginPath();
      ctx.moveTo(x, height - 10);
      ctx.lineTo(x + 5, height - 5);
      ctx.lineTo(x, height);
      ctx.lineTo(x - 5, height - 5);
      ctx.fill();
    }
    this.resultCanvas = { canvas, image: ctx.getImageData(0, 0, canvas.width, canvas.height), toX };
  }

  /** The cursor over the result while it plays. */
  private drawResultPlayhead() {
    const result = this.resultCanvas;
    if (result === null || result.image === null || !result.canvas.isConnected) return;
    const ctx = result.canvas.getContext('2d')!;
    ctx.putImageData(result.image, 0, 0);
    const ratio = window.devicePixelRatio || 1;
    const x = result.toX(this.editor.playhead());
    if (x < 0 || x > result.canvas.clientWidth) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#ff4d6d';
    ctx.fillRect(x, 0, 1.5, result.canvas.clientHeight);
  }
}

// ----- small pieces -----------------------------------------------------------------------------------

function describeFilter(box: GlsBox) {
  const f = box.filter;
  const base = f.type === 'division' ? (f.sections <= 1 ? 'все' : `секция ${String(f.section + 1)}/${String(f.sections)}`) : f.step === 0 ? `№${String(f.offset + 1)}` : `каждый ${String(f.step)}-й с ${String(f.offset + 1)}`;
  return `${base}${f.reverse ? ', обратно' : ''}`;
}

function spreads(): [GlsSpread, string][] {
  return [
    ['wave', 'Волна'],
    ['step', 'Шаг'],
  ];
}

function swap<T>(list: T[], a: number, b: number) {
  if (b < 0 || b >= list.length) return;
  [list[a], list[b]] = [list[b]!, list[a]!];
}

export function heading(text: string) {
  const element = document.createElement('div');
  element.className = 'gls-heading';
  element.textContent = text;
  return element;
}

export function button(label: string, title: string, action: () => void, disabled = false) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.title = title;
  element.disabled = disabled;
  element.addEventListener('click', action);
  return element;
}

export function labeled(label: string, control: HTMLElement) {
  const wrap = document.createElement('label');
  wrap.className = 'gls-field';
  const text = document.createElement('span');
  text.textContent = label;
  wrap.append(text, control);
  return wrap;
}

export function numberInput(value: number, step: number, change: (value: number) => void) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(Math.round(value * 1000) / 1000);
  input.addEventListener('change', () => {
    const number = Number(input.value);
    if (Number.isFinite(number)) change(number);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
  return input;
}

export function textInput(value: string, change: (value: string) => void) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('change', () => change(input.value.trim()));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
  return input;
}

export function select<T extends string>(options: [T, string][], current: T, change: (value: T) => void) {
  const element = document.createElement('select');
  for (const [value, label] of options) element.append(Object.assign(document.createElement('option'), { value, textContent: label }));
  element.value = current;
  element.addEventListener('change', () => change(element.value as T));
  return element;
}

export function toggle<T extends string>(options: [T, string][], current: T, change: (value: T) => void) {
  const row = document.createElement('div');
  row.className = 'ins-buttons gls-toggle';
  for (const [value, label] of options) {
    const element = button(label, '', () => change(value));
    if (value === current) element.classList.add('active');
    row.append(element);
  }
  return row;
}

export function check(label: string, checked: boolean, change: (on: boolean) => void) {
  const wrap = document.createElement('label');
  wrap.className = 'ins-check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => change(box.checked));
  wrap.append(box, ` ${label}`);
  return wrap;
}

function slider(label: string, value: number, min: number, max: number, step: number, change: (value: number) => void) {
  const wrap = document.createElement('div');
  wrap.className = 'gls-field';
  const text = document.createElement('span');
  text.textContent = label;
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
  wrap.append(text, line);
  return wrap;
}

function hex(rgb: readonly number[]) {
  return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function fromHex(value: string): Rgb {
  const n = Number.parseInt(value.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgba(rgb: readonly number[], alpha: number) {
  return `rgba(${rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')},${String(Math.max(0, Math.min(1, alpha)))})`;
}

let pointerDown = false;
window.addEventListener('mousedown', () => (pointerDown = true), true);
window.addEventListener('mouseup', () => window.setTimeout(() => (pointerDown = false), 0), true);

/**
 * Whether a panel shouldn't be drawn again now: one of its number or text fields is being typed in
 * (drawn again, the field would be a new one — the keys lost, the arrows stepping in another). Then it
 * is drawn when the field is left — after the click that left it, so that click isn't lost.
 */
export function holdWhileTyping(root: HTMLElement, redraw: () => void): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !['number', 'text', 'search'].includes(active.type) || !root.contains(active)) return false;
  const holding = (root as HTMLElement & { lumaticHolding?: boolean });
  if (holding.lumaticHolding === true) return true;
  holding.lumaticHolding = true;
  active.addEventListener(
    'blur',
    () => {
      const later = () => {
        if (pointerDown) {
          window.setTimeout(later, 30);
          return;
        }
        holding.lumaticHolding = false;
        redraw();
      };
      window.setTimeout(later, 0);
    },
    { once: true },
  );
  return true;
}

/** A lane under the song in a scrub strip: what a window puts on the song's own time (ring poses). */
export interface StripLane {
  /** Its height (px). */
  height: number;
  /** What it shows now: it's drawn again when this changes. */
  key(): string;
  /** Drawn at `top` (`x`: a song beat's place). */
  draw(ctx: CanvasRenderingContext2D, x: (beat: number) => number, top: number, height: number, width: number): void;
  /** A press on it at `beat` (`x`: its place): what dragging from there does, or nothing (the song's
   *  cursor is moved then, as on the strip above it). */
  press(beat: number, x: number, place: (beat: number) => number): { move(beat: number, x: number): void; up(): void } | null;
}

/** How far each block's strip is zoomed (by its id): kept while the window is drawn again. */
const stripViews = new Map<string, { from: number; to: number }>();

/**
 * A strip of the song around a block (the GLS and ring pose windows cover the timeline): the block
 * marked, the cursor on it; dragging along it — the song goes there (the 3D view shows that moment),
 * the wheel — a grid step at a time, Ctrl+wheel (or −/+) — zoom, Shift+wheel — along the song. A lane
 * under it (ring poses) can be given.
 */
export function scrubStrip(editor: Editor, range: () => { id?: string; start: number; end: number } | null, lane: StripLane | null = null) {
  const SONG = 44;
  const wrap = document.createElement('div');
  wrap.className = 'scrub-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'scrub-strip';
  canvas.style.height = `${String(SONG + (lane?.height ?? 0))}px`;
  canvas.title = 'Тяните по полосе — курсор песни идёт за мышью (в окне просмотра — этот момент); колесо — на шаг сетки, Ctrl+колесо — масштаб, Shift+колесо — вдоль песни';
  wrap.append(canvas);
  let drawn = '';
  /** The block's own view (it and a little around it). */
  const whole = (block: { start: number; end: number }) => {
    const pad = Math.max(1, (block.end - block.start) * 0.15);
    return { from: Math.max(0, block.start - pad), to: block.end + pad };
  };
  const span = () => {
    const block = range();
    if (block === null) return null;
    const kept = block.id === undefined ? undefined : stripViews.get(block.id);
    return { block, ...(kept ?? whole(block)) };
  };
  const setView = (from: number, to: number) => {
    const block = range();
    if (block?.id === undefined) return;
    const length = Math.min(4000, Math.max(0.25, to - from));
    const start = Math.max(0, from);
    stripViews.set(block.id, { from: start, to: start + length });
  };
  /** Zoomed by `factor` (under 1: closer) around `beat`. */
  const zoom = (factor: number, beat?: number) => {
    const view = span();
    if (view === null) return;
    const at = beat ?? Math.min(view.to, Math.max(view.from, editor.playhead()));
    setView(at - (at - view.from) * factor, at + (view.to - at) * factor);
  };
  const controls = document.createElement('div');
  controls.className = 'scrub-zoom';
  const control = (label: string, title: string, action: () => void) => {
    const item = Object.assign(document.createElement('button'), { type: 'button', textContent: label, title });
    item.addEventListener('mousedown', (event) => event.stopPropagation());
    item.addEventListener('click', action);
    controls.append(item);
  };
  // (in the small windows over everything — lasers, ring glitch, rings in steps — the block plays from
  // here, and with Space; the ring and GLS windows have their own ▶)
  let playing: Editor['previewExtra'] = null;
  const play = () => {
    const block = range();
    if (block === null) return;
    if (editor.previewExtra !== null) {
      editor.stopTrial();
      playing = null;
      return;
    }
    editor.startTrial({ clips: [], raw: [], start: block.start, end: block.end });
    playing = editor.previewExtra;
  };
  const inDialog = () => canvas.closest('.ce-shade') !== null;
  const keys = (event: KeyboardEvent) => {
    if (!canvas.isConnected) {
      window.removeEventListener('keydown', keys, true);
      return;
    }
    const target = event.target as HTMLElement;
    if (event.code !== 'Space' || !inDialog() || target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    play();
  };
  window.addEventListener('keydown', keys, true);
  control('▶', 'Проиграть блок по кругу (Пробел)', play);
  control('−', 'Отдалить (Ctrl+колесо)', () => zoom(1.5));
  control('+', 'Приблизить (Ctrl+колесо)', () => zoom(1 / 1.5));
  control('⤢', 'Весь блок', () => {
    const block = range();
    if (block?.id !== undefined) stripViews.delete(block.id);
  });
  wrap.append(controls);

  const draw = () => {
    if (!canvas.isConnected) {
      // (the window closed while its block played: stopped)
      if (playing !== null && editor.previewExtra === playing) editor.stopTrial();
      return;
    }
    requestAnimationFrame(draw);
    const playButton = controls.firstElementChild as HTMLButtonElement | null;
    if (playButton !== null) {
      playButton.hidden = !inDialog();
      playButton.textContent = editor.previewExtra !== null ? '■' : '▶';
    }
    const beat = editor.playhead();
    // (zoomed in while the song plays: the view goes along with it)
    const block = range();
    const kept = block?.id === undefined ? undefined : stripViews.get(block.id);
    if (kept !== undefined && editor.isPlaying() && (beat > kept.to || beat < kept.from)) setView(beat - (kept.to - kept.from) * 0.1, beat + (kept.to - kept.from) * 0.9);
    const view = span();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const key = `${String(width)} ${String(height)} ${String(beat)} ${JSON.stringify(view)} ${editor.spectrogram === null ? '' : 's'} ${lane?.key() ?? ''}`;
    if (view === null || width === 0 || key === drawn) return;
    drawn = key;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const x = (value: number) => ((value - view.from) / (view.to - view.from)) * width;
    ctx.fillStyle = '#121318';
    ctx.fillRect(0, 0, width, height);
    // the song's spectrogram under it (dimmed): what is heard there
    const picture = editor.spectrogram;
    if (picture !== null) {
      const from = editor.beatToSeconds(view.from) / picture.secondsPerFrame;
      const to = editor.beatToSeconds(view.to) / picture.secondsPerFrame;
      const first = Math.max(0, Math.floor(from));
      const last = Math.min(picture.frames, Math.ceil(to));
      if (last > first) {
        ctx.globalAlpha = 0.75;
        ctx.imageSmoothingEnabled = true;
        // (one canvas column per frame; the stretch shown placed where its beats are)
        const left = ((first - from) / (to - from)) * width;
        const right = ((last - from) / (to - from)) * width;
        ctx.drawImage(picture.image, first, 0, last - first, picture.image.height, left, 0, right - left, SONG);
        ctx.globalAlpha = 1;
      }
    }
    ctx.fillStyle = 'rgba(90,130,220,0.22)';
    ctx.fillRect(x(view.block.start), 0, x(view.block.end) - x(view.block.start), SONG);
    ctx.fillStyle = 'rgba(120,160,255,0.9)';
    ctx.fillRect(x(view.block.start), SONG - 3, x(view.block.end) - x(view.block.start), 3);
    if (lane !== null) {
      ctx.fillStyle = '#0f1014';
      ctx.fillRect(0, SONG, width, height - SONG);
      ctx.fillStyle = 'rgba(90,130,220,0.08)';
      ctx.fillRect(x(view.block.start), SONG, x(view.block.end) - x(view.block.start), height - SONG);
    }
    // (beats; their numbers where there's room)
    const step = [1 / 16, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32].find((value) => (value * width) / (view.to - view.from) >= 8) ?? 64;
    const label = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64].find((value) => (value * width) / (view.to - view.from) >= 44) ?? 128;
    ctx.font = '10px system-ui, sans-serif';
    for (let at = Math.ceil(view.from / step) * step; at <= view.to; at += step) {
      const whole = Math.abs(at / label - Math.round(at / label)) < 1e-6;
      ctx.fillStyle = whole ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
      ctx.fillRect(Math.round(x(at)), whole ? 0 : SONG * 0.55, 1, height - (whole ? 0 : SONG * 0.55));
      if (whole) {
        ctx.fillStyle = '#d6d9e4';
        ctx.fillText(String(Math.round(at * 100) / 100), x(at) + 3, 11);
      }
    }
    if (lane !== null) lane.draw(ctx, x, SONG, height - SONG, width);
    const cursor = x(beat);
    ctx.fillStyle = '#ff5a5a';
    ctx.fillRect(Math.round(cursor) - 1, 0, 2, height);
    ctx.fillStyle = '#fff';
    const text = `доля ${String(Math.round((beat - view.block.start) * 1000) / 1000)} в блоке`;
    ctx.fillText(text, Math.min(width - ctx.measureText(text).width - 70, cursor + 5), SONG - 7);
  };
  const beatAt = (clientX: number) => {
    const view = span();
    if (view === null) return 0;
    const rect = canvas.getBoundingClientRect();
    return view.from + ((clientX - rect.left) / rect.width) * (view.to - view.from);
  };
  const place = (beat: number) => {
    const view = span();
    if (view === null) return 0;
    return ((beat - view.from) / (view.to - view.from)) * canvas.clientWidth;
  };
  canvas.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    // the lane: what it does with a press (a pose picked, moved, made)
    if (lane !== null && event.clientY - rect.top >= SONG) {
      const drag = lane.press(beatAt(event.clientX), event.clientX - rect.left, place);
      if (drag !== null) {
        const move = (next: MouseEvent) => drag.move(beatAt(next.clientX), next.clientX - rect.left);
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          drag.up();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return;
      }
    }
    if (editor.previewExtra !== null) editor.stopTrial();
    if (editor.isPlaying()) editor.togglePlay();
    editor.seek(Math.max(0, beatAt(event.clientX)));
    const move = (next: MouseEvent) => editor.seek(Math.max(0, beatAt(next.clientX)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const view = span();
      if (view === null) return;
      if (event.ctrlKey || event.metaKey) {
        zoom(Math.exp(event.deltaY * 0.0015), beatAt(event.clientX));
        return;
      }
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
        const shift = (delta / Math.max(1, canvas.clientWidth)) * (view.to - view.from);
        setView(view.from + shift, view.to + shift);
        return;
      }
      const step = editor.snap || 0.25;
      editor.seek(Math.max(0, editor.snapBeat(editor.playhead()) + (event.deltaY > 0 ? step : -step)));
    },
    { passive: false },
  );
  requestAnimationFrame(draw);
  return wrap;
}
