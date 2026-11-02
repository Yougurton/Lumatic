import { resolveRgb } from './bake';
import type { Editor } from './editor';
import type { Effect } from './effects';
import { beatsLabel, drum, numberDrum } from './grids';
import { defaultFilter, filterFor, filterUnits, glsNeededLength, spreadOf, newColorBox, newRotationBox, type GlsBox, type GlsColorEvent, type GlsEasing, type GlsRotationEvent, type GlsSpread, type GlsTransition } from './gls';
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
  /** What the box's lane and the result show (beats from the block's start); null: all of the block. */
  private view: { from: number; to: number } | null = null;
  /** Tapping events in while it plays (T: down — on, up — off). */
  private recording = false;
  private tap: { beat: number } | null = null;
  private keyUpHandler = (event: KeyboardEvent) => this.onKeyUp(event);
  /** The spread handle on the lane being dragged. */
  private knobDrag: { startX: number; startY: number; beatValue: number; value: number } | null = null;

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
    this.view = null;
    const shade = document.createElement('div');
    shade.className = 'gls-dock';
    document.body.append(shade);
    this.shade = shade;
    this.place();
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('keydown', this.keyHandler, true);
    window.addEventListener('keyup', this.keyUpHandler, true);
    this.recording = false;
    this.render();
    const tick = () => {
      // (recording: the block over and over, kept here — a change to the block ends the editor's loop)
      const effect = this.effect();
      if (this.recording && effect !== undefined && this.editor.isPlaying() && this.editor.playhead() >= effect.end) {
        // (a light still held at the loop's end: off right there)
        if (this.tap !== null) this.tapUp(effect.end - effect.start);
        this.editor.seek(Math.max(0, effect.start - 0.5), true);
      }
      this.drawResultPlayhead();
      this.drawLanePlayhead();
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
    window.removeEventListener('keyup', this.keyUpHandler, true);
    this.recording = false;
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
    // (a drum's own keys: left to it — it stops them itself)
    if (target.closest('.drum') !== null && /^(Arrow(Left|Right|Up|Down)|Home|End|Enter|[\d.,/])$/u.test(event.key)) return;
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
    if (event.code === 'KeyR' && !ctrl) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.toggleRecording();
      return;
    }
    if (event.code === 'KeyT' && !ctrl && this.recording) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) this.tapDown();
      return;
    }
    // (the rest of the editor's keys don't reach the timeline behind)
    event.stopImmediatePropagation();
  }

  /** One change to the block: an undo step, its events made anew — and the block made longer when its
   *  events don't fit in it any more (to the next step of the grid). */
  private change(patch: (effect: Effect) => void) {
    const current = this.effect();
    if (current === undefined) return;
    const items = this.editor.effectItemsOf(current).length;
    this.editor.updateEffect(this.effectId, (effect) => {
      effect.gls ??= { boxes: [] };
      patch(effect);
      const needed = glsNeededLength(effect.gls, items);
      if (effect.start + needed > effect.end + 1e-6) {
        const step = this.editor.snap > 0 ? this.editor.snap : 1 / 64;
        effect.end = effect.start + Math.ceil((needed - 1e-6) / step) * step;
      }
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

  // ----- tapping events in ---------------------------------------------------------------------------

  private onKeyUp(event: KeyboardEvent) {
    if (event.code !== 'KeyT' || this.tap === null) return;
    event.stopImmediatePropagation();
    this.tapUp();
  }

  private toggleRecording() {
    this.recording = !this.recording;
    this.tap = null;
    // (recording: it plays — the block over and over)
    const effect = this.effect();
    if (this.recording && effect !== undefined && !this.editor.isPlaying()) {
      this.editor.seek(Math.max(0, effect.start - 0.5));
      this.editor.togglePlay();
    }
    this.render();
  }

  /** Where the song is in the block (beats from its start, on the grid; null: outside it — taps
   *  never make the block longer). */
  private tapBeat() {
    const effect = this.effect();
    if (effect === undefined) return null;
    const step = this.editor.snap > 0 ? this.editor.snap : 1 / 16;
    const length = effect.end - effect.start;
    const beat = Math.round((this.editor.playhead() - effect.start) / step) * step;
    return beat < -step / 2 || beat >= length - 1e-6 ? null : Math.max(0, beat);
  }

  /** T down: the light on here (a ring box: a turn like the last one). */
  private tapDown() {
    const box = this.box();
    const beat = this.tapBeat();
    if (box === undefined || beat === null) return;
    const id = newId('v');
    this.eventId = id;
    this.tap = { beat };
    const color = this.editor.brush.color;
    this.changeBox((item) => {
      if (item.kind === 'color') {
        item.events = item.events.filter((event) => Math.abs(event.beat - beat) > 1e-4);
        item.events.push({ id, beat, transition: 'instant', color: { ...color, brightness: 1 }, brightness: Math.max(0.05, color.brightness), strobe: 0 });
      } else {
        const last = [...item.rotations].sort((a, b) => b.beat - a.beat)[0];
        item.rotations = item.rotations.filter((event) => Math.abs(event.beat - beat) > 1e-4);
        item.rotations.push({ ...(last ?? { angle: 90, loops: 0, direction: 'cw', easing: 'outQuad' }), id, beat } as GlsRotationEvent);
      }
    });
  }

  /** T up: held a while — off here; a quick tap — a flash fading out over a grid step. */
  private tapUp(at?: number) {
    const tap = this.tap;
    this.tap = null;
    const box = this.box();
    const effect = this.effect();
    if (tap === null || box === undefined || effect === undefined || box.kind !== 'color') return;
    const step = this.editor.snap > 0 ? this.editor.snap : 1 / 16;
    const length = effect.end - effect.start;
    // (let go past the block's end, or the song looped: off at the end)
    const now = at ?? this.tapBeat() ?? length;
    const held = now - tap.beat >= step - 1e-6;
    const beat = Math.min(length, held ? now : tap.beat + step);
    // (off at the block's end: the block's end puts it out anyway — no event, the block stays as long)
    if (beat >= length - 1e-6) return;
    this.changeBox((item) => {
      // (what was there between is replaced by this)
      item.events = item.events.filter((event) => !(event.beat > tap.beat + 1e-4 && event.beat <= beat + 1e-4));
      const on = item.events.find((event) => Math.abs(event.beat - tap.beat) < 1e-4);
      item.events.push({ id: newId('v'), beat, transition: held ? 'instant' : 'fade', color: { ...(on?.color ?? this.editor.brush.color) }, brightness: 0, strobe: 0 });
    });
  }

  // ----- rendering -------------------------------------------------------------------------------------

  private render() {
    const shade = this.shade;
    const effect = this.effect();
    if (shade === null || effect === undefined) return;
    if (holdWhileTyping(shade, () => this.render())) return;
    const scroll = [...shade.querySelectorAll<HTMLElement>('.gls-col')].map((col) => col.scrollTop);
    // (a drum being turned with the keys keeps the focus in its new self)
    const focused = document.activeElement instanceof HTMLElement && shade.contains(document.activeElement) ? document.activeElement.dataset.wheelKey : undefined;
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
    if (focused !== undefined) shade.querySelector<HTMLElement>(`[data-wheel-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
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
      const effect = this.effect()!;
      const count = this.editor.effectItemsOf(effect).length;
      col.append(heading('Какие элементы'));
      col.append(this.lampPicker(effect, box));
      // the usual picks, one click
      const quick = document.createElement('div');
      quick.className = 'gls-quick';
      const pick = (label: string, title: string, elements: (index: number) => boolean) =>
        quick.append(
          button(label, title, () =>
            this.changeBox((item) => (item.filter = filterFor(Array.from({ length: count }, (_, index) => index).filter(elements), count, item.filter))),
          ),
        );
      const picked = new Set(filterUnits({ ...box.filter, limit: 1, random: box.filter.random === 'pick' ? 'none' : box.filter.random }, count).flat());
      pick('Все', 'Все элементы', () => true);
      pick('1, 3, 5…', 'Через один, с первого', (index) => index % 2 === 0);
      pick('2, 4, 6…', 'Через один, со второго', (index) => index % 2 === 1);
      pick('◧ ½', 'Первая половина', (index) => index < Math.ceil(count / 2));
      pick('½ ◨', 'Вторая половина', (index) => index >= Math.floor(count / 2));
      pick('⇄', 'Наоборот: невыбранные', (index) => !picked.has(index));
      col.append(quick);
      col.append(labeled('Порядок', this.orderDrum(box)));
      // the game's own settings, for exact work: folded away
      const more = document.createElement('details');
      more.className = 'gls-more';
      more.open = this.moreOpen;
      more.addEventListener('toggle', () => (this.moreOpen = more.open));
      more.append(Object.assign(document.createElement('summary'), { textContent: 'Точнее (как в игре)' }));
      const kinds: ['division' | 'step' | 'custom', string][] = [
        ['division', 'Секции'],
        ['step', 'Шаг и сдвиг'],
        ['custom', 'Выбранные'],
      ];
      more.append(
        labeled(
          'Фильтр',
          drum({
            key: `gls-filter-type:${box.id}`,
            count: kinds.length,
            label: (index) => kinds[index]![1],
            initial: Math.max(0, kinds.findIndex(([kind]) => kind === box.filter.type)),
            change: (index) =>
              this.changeBox((item) => {
                const kind = kinds[index]![0];
                if (kind === 'custom') item.filter.elements = filterUnits({ ...item.filter, reverse: false, order: 'line', random: 'none', limit: 1 }, count).flat();
                item.filter.type = kind;
              }),
          }),
        ),
      );
      if (box.filter.type === 'division') {
        more.append(
          labeled('Секций', numberDrum(`gls-sections:${box.id}`, box.filter.sections, (value) => this.changeBox((item) => (item.filter.sections = Math.max(1, Math.round(value)))), { step: 1, min: 1, max: Math.max(2, count) })),
          labeled('Номер секции', numberDrum(`gls-section:${box.id}`, box.filter.section + 1, (value) => this.changeBox((item) => (item.filter.section = Math.max(0, Math.round(value) - 1))), { step: 1, min: 1, max: Math.max(1, box.filter.sections) })),
        );
      } else if (box.filter.type === 'step') {
        more.append(
          labeled('Шаг (0 — один)', numberDrum(`gls-step:${box.id}`, box.filter.step, (value) => this.changeBox((item) => (item.filter.step = Math.max(0, Math.round(value)))), { step: 1, min: 0, max: Math.max(1, count) })),
          labeled('Сдвиг (с какого)', numberDrum(`gls-offset:${box.id}`, box.filter.offset + 1, (value) => this.changeBox((item) => (item.filter.offset = Math.max(0, Math.round(value) - 1))), { step: 1, min: 1, max: Math.max(1, count) })),
        );
      }
      more.append(labeled('Куски (0 — нет)', numberDrum(`gls-chunks:${box.id}`, box.filter.chunks, (value) => this.changeBox((item) => (item.filter.chunks = Math.max(0, Math.round(value)))), { step: 1, min: 0, max: Math.max(1, count) })));
      more.append(labeled('Сколько взять, %', numberDrum(`gls-limit:${box.id}`, Math.round(box.filter.limit * 100), (value) => this.changeBox((item) => (item.filter.limit = Math.min(1, Math.max(0.01, value / 100)))), { step: 5, min: 5, max: 100 })));
      more.append(check('Случайные элементы (не все)', box.filter.random === 'pick', (on) => this.changeBox((item) => (item.filter.random = on ? 'pick' : 'none'))));
      if (box.filter.random !== 'none') more.append(button('🎲 Другой случай', 'Другое случайное распределение', () => this.changeBox((item) => (item.filter.seed = Math.floor(Math.random() * 1e6)))));
      col.append(more);
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
    col.append(labeled(box.beatSpread === 'wave' ? 'Волна на всех, долей' : 'Шаг на элемент, долей', numberDrum(`gls-beat:${box.id}`, box.beatValue, (value) => this.changeBox((item) => (item.beatValue = Math.max(0, value))), { step: 1 / 16, min: 0, max: 64, beats: true })));
    col.append(heading(box.kind === 'color' ? 'Распределение яркости' : 'Распределение угла'));
    col.append(toggle(spreads(), box.valueSpread, (value) => this.changeBox((item) => (item.valueSpread = value))));
    col.append(labeled(box.kind === 'color' ? (box.valueSpread === 'wave' ? 'Последнему элементу +' : 'Каждому следующему +') : box.valueSpread === 'wave' ? 'Последнему кольцу, °' : 'Каждому кольцу, °', box.kind === 'color' ? numberDrum(`gls-value:${box.id}`, box.value, (value) => this.changeBox((item) => (item.value = value)), { step: 0.05, min: -1.5, max: 1.5, digits: 2 }) : numberDrum(`gls-angle:${box.id}`, box.value, (value) => this.changeBox((item) => (item.value = value)), { step: 5, min: -360, max: 360 })));
    if (box.kind === 'color') {
      const tip = document.createElement('div');
      tip.className = 'gls-note';
      tip.textContent = 'Или тяните ручку ◆ на дорожке событий: вправо — дольше волна, вверх/вниз — ярче/тусклее последний элемент.';
      col.append(tip);
    }
    if (box.kind === 'color') col.append(labeled('Сглаживание', select(EASINGS, box.easing, (value) => this.changeBox((item) => (item.easing = value)))));
    col.append(check('Затрагивать первое событие', box.affectFirst, (on) => this.changeBox((item) => (item.affectFirst = on))));
    return col;
  }

  private moreOpen = false;

  /**
   * The group's elements as lamps: the picked ones lit, numbered in the order the box's events go over
   * them; a click (or a drag across) picks and unpicks — the filter that does just that is found.
   */
  private lampPicker(effect: Effect, box: GlsBox) {
    const items = this.editor.effectItemsOf(effect);
    const count = items.length;
    const units = filterUnits(box.filter, count);
    const order = new Map<number, number>();
    units.forEach((unit, k) => unit.forEach((item) => order.set(item, k)));
    const holder = document.createElement('div');
    holder.className = `gls-lamps${count > 24 ? ' small' : ''}`;
    const chosen = new Set(order.keys());
    let paint: boolean | null = null;
    const cells: HTMLElement[] = [];
    const apply = (index: number) => {
      if (paint === null) return;
      if (paint) chosen.add(index);
      else chosen.delete(index);
      cells[index]?.classList.toggle('on', paint);
    };
    const commit = () => {
      if (paint === null) return;
      paint = null;
      this.changeBox((item) => (item.filter = filterFor([...chosen], count, item.filter)));
    };
    items.forEach((item, index) => {
      const cell = document.createElement('span');
      cell.className = 'gls-lamp';
      const k = order.get(index);
      cell.title = `${item.kind === 'group' ? (findGroup(this.editor.groups, item.id)?.group.name ?? '') : `ID ${String(item.id)}`}${k === undefined ? '' : ` — ${String(k + 1)}-й в очереди`}`;
      if (k !== undefined) {
        cell.classList.add('on');
        // (the order shown: early ones bright, late ones darker)
        const t = units.length > 1 ? k / (units.length - 1) : 0;
        cell.style.setProperty('--lamp', `hsl(205 85% ${String(Math.round(72 - t * 34))}%)`);
        if (count <= 48) cell.textContent = String(k + 1);
      }
      cell.addEventListener('mousedown', (event) => {
        event.preventDefault();
        paint = !chosen.has(index);
        apply(index);
        window.addEventListener('mouseup', commit, { once: true });
      });
      cell.addEventListener('mouseenter', () => apply(index));
      cells.push(cell);
      holder.append(cell);
    });
    const wrap = document.createElement('div');
    wrap.append(holder, Object.assign(document.createElement('div'), { className: 'gls-note', textContent: 'Щёлкните или проведите по лампам. Цифра — очередь в волне.' }));
    return wrap;
  }

  /** The order the box's events go over its elements: a drum. */
  private orderDrum(box: GlsBox) {
    const options: ['line' | 'reverse' | 'outward' | 'inward' | 'shuffle', string][] = [
      ['line', '→ По порядку'],
      ['reverse', '← Обратно'],
      ['outward', '↔ От центра'],
      ['inward', '→← К центру'],
      ['shuffle', '🔀 Вперемешку'],
    ];
    const f = box.filter;
    const current = f.random === 'shuffle' ? 'shuffle' : f.order === 'outward' || f.order === 'inward' ? f.order : f.reverse ? 'reverse' : 'line';
    return drum({
      key: `gls-order:${box.id}`,
      count: options.length,
      label: (index) => options[index]![1],
      initial: Math.max(0, options.findIndex(([value]) => value === current)),
      change: (index) =>
        this.changeBox((item) => {
          const value = options[index]![0];
          item.filter.random = value === 'shuffle' ? 'shuffle' : item.filter.random === 'shuffle' ? 'none' : item.filter.random;
          item.filter.order = value === 'outward' || value === 'inward' ? value : 'line';
          item.filter.reverse = value === 'reverse';
        }),
    });
  }

  private laneColumn(effect: Effect) {
    const col = document.createElement('div');
    col.className = 'gls-col gls-lane-col';
    const box = this.box();
    if (box === undefined) return col;
    const title = heading(box.kind === 'color' ? 'События коробки' : 'Повороты');
    const record = button(this.recording ? '⏺ Запись идёт' : '⏺ Запись', 'Запись по тапам (R): блок играет по кругу, T — поставить событие (держите — горит, пока держите; коротко — вспышка)', () => this.toggleRecording());
    record.classList.add('gls-record');
    record.classList.toggle('active', this.recording);
    title.append(record, this.zoomButtons(effect));
    col.append(title);
    const hint = document.createElement('div');
    hint.className = 'gls-note';
    hint.textContent = this.recording
      ? 'Запись: жмите T в такт — держите, пока свет должен гореть; коротко — вспышка. Встаёт на сетку. R — остановить запись.'
      : 'Клик по дорожке — новое событие, перетаскивание — сдвинуть, Delete — удалить. Ctrl+колесо — масштаб, Shift+колесо — вдоль блока. R — запись по тапам.';
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

  /** The beats shown (from the block's start): all of it, or as zoomed. */
  private shown(effect: Effect) {
    const length = Math.max(0.25, effect.end - effect.start);
    const view = this.view;
    return view === null ? { from: 0, to: length } : view;
  }

  /** Zoomed by `factor` (under 1: closer) around `beat` (from the block's start); null: all again. */
  private zoomView(effect: Effect, factor: number | null, beat?: number) {
    if (factor === null) {
      this.view = null;
    } else {
      const { from, to } = this.shown(effect);
      const at = beat ?? (from + to) / 2;
      const length = Math.max(0.25, effect.end - effect.start);
      const span = Math.min(length * 4, Math.max(1 / 16, (to - from) * factor));
      const start = Math.max(-length * 0.05, at - (at - from) * (span / (to - from)));
      this.view = { from: start, to: start + span };
    }
    this.redrawViews();
  }

  private panView(effect: Effect, beats: number) {
    const { from, to } = this.shown(effect);
    const length = Math.max(0.25, effect.end - effect.start);
    const shift = Math.max(-length * 0.05 - from, beats);
    this.view = { from: from + shift, to: to + shift };
    this.redrawViews();
  }

  private redrawViews() {
    const effect = this.effect();
    const box = this.box();
    if (effect === undefined) return;
    const lane = this.shade?.querySelector<HTMLCanvasElement>('canvas.gls-lane');
    if (lane !== undefined && lane !== null && box !== undefined) this.drawLane(lane, effect, box);
    const result = this.shade?.querySelector<HTMLCanvasElement>('canvas.gls-result-canvas');
    if (result !== undefined && result !== null) this.drawResult(result, effect);
  }

  /** Ctrl+wheel: zoom (around the mouse), Shift+wheel: along the block; the wheel alone: the song's
   *  cursor a grid step. `beatAt`: the beat (from the block's start) under the mouse. */
  private bindZoom(canvas: HTMLCanvasElement, beatAt: (x: number) => number) {
    canvas.addEventListener(
      'wheel',
      (event) => {
        const effect = this.effect();
        if (effect === undefined) return;
        event.preventDefault();
        const x = event.clientX - canvas.getBoundingClientRect().left;
        if (event.ctrlKey || event.metaKey) this.zoomView(effect, Math.exp(event.deltaY * 0.0015), beatAt(x));
        else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
          const { from, to } = this.shown(effect);
          this.panView(effect, ((event.deltaX !== 0 ? event.deltaX : event.deltaY) / Math.max(1, canvas.clientWidth)) * (to - from));
        } else {
          const step = this.editor.snap || 0.25;
          this.editor.seek(Math.max(0, this.editor.snapBeat(this.editor.playhead()) + (event.deltaY > 0 ? step : -step)));
        }
      },
      { passive: false },
    );
  }

  /** −, +, ⤢ for the lane and the result. */
  private zoomButtons(effect: Effect) {
    const holder = document.createElement('span');
    holder.className = 'gls-zoom';
    holder.append(
      button('−', 'Отдалить (Ctrl+колесо)', () => this.zoomView(effect, 1.5)),
      button('+', 'Приблизить (Ctrl+колесо)', () => this.zoomView(effect, 1 / 1.5)),
      button('⤢', 'Весь блок', () => this.zoomView(effect, null)),
    );
    return holder;
  }

  private laneGeometry(canvas: HTMLCanvasElement, effect: Effect) {
    const width = canvas.clientWidth;
    const length = Math.max(0.25, effect.end - effect.start);
    const { from, to } = this.shown(effect);
    const pad = 12;
    return {
      width,
      height: canvas.clientHeight,
      pad,
      length,
      from,
      to,
      toX: (beat: number) => pad + ((beat - from) / (to - from)) * (width - pad * 2),
      toBeat: (x: number) => from + ((x - pad) / (width - pad * 2)) * (to - from),
    };
  }

  /** The lane's brightness scale: a level → y, y → a level. */
  private laneScale(height: number) {
    const top = 16;
    const bottom = height - 8;
    const span = bottom - top - 6;
    return { top, bottom, y: (brightness: number) => bottom - (Math.min(1.5, brightness) / 1.5) * span, level: (y: number) => ((bottom - y) / span) * 1.5 };
  }

  /**
   * The spread handle: the box's events as the last of its elements gets them (moved on by the time
   * spread, brighter by the brightness spread) — the handle on its first event the spread touches.
   */
  private spreadKnob(canvas: HTMLCanvasElement, effect: Effect, box: GlsBox) {
    if (box.kind !== 'color' || box.events.length === 0) return null;
    const m = filterUnits(box.filter, this.editor.effectItemsOf(effect).length).length;
    if (m < 2) return null;
    const events = [...box.events].sort((a, b) => a.beat - b.beat);
    const index = box.affectFirst || events.length === 1 ? 0 : 1;
    const base = events[index]!;
    const shift = spreadOf(box.beatSpread, box.beatValue, m - 1, m, null, false);
    const extra = spreadOf(box.valueSpread, box.value, m - 1, m, box.easing, true);
    const g = this.laneGeometry(canvas, effect);
    const scale = this.laneScale(g.height);
    return { m, events, index, base, shift, extra, x: g.toX(base.beat + shift), y: scale.y(Math.max(0, base.brightness + extra)) };
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
    // beats (as fine as the zoom allows; their numbers where there's room)
    ctx.font = '10px system-ui, sans-serif';
    const span = g.to - g.from;
    const inner = g.width - g.pad * 2;
    const snap = this.editor.snap > 0 ? this.editor.snap : 0.25;
    const step = [snap, 1 / 16, 0.125, 0.25, 0.5, 1, 2, 4, 8].filter((value) => value >= snap - 1e-9).find((value) => (value * inner) / span >= 6) ?? 16;
    const label = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16].find((value) => (value * inner) / span >= 40) ?? 32;
    for (let beat = Math.max(0, Math.ceil(g.from / step) * step); beat <= g.to + 1e-6; beat += step) {
      const whole = Math.abs(beat / label - Math.round(beat / label)) < 1e-6;
      ctx.fillStyle = whole ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.fillRect(Math.round(g.toX(beat)), top, 1, bottom - top);
      if (whole) {
        ctx.fillStyle = '#7d8394';
        ctx.fillText(String(Math.round(beat * 1000) / 1000), g.toX(beat) + 2, 11);
      }
    }
    // past the block's end: dimmed
    const endX = g.toX(g.length);
    if (endX < g.width) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(endX, 0, g.width - endX, g.height);
      ctx.fillStyle = 'rgba(120,160,255,0.7)';
      ctx.fillRect(endX, 0, 1.5, g.height);
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
      if (last !== null) ctx.lineTo(g.toX(Math.max(g.length, g.to)), last.y);
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
      // the spread: when each element starts (ticks), the last one's light (dashed) and the handle
      const knob = this.spreadKnob(canvas, effect, box);
      if (knob !== null) {
        const first = knob.events[0]!.beat;
        ctx.fillStyle = 'rgba(255,214,90,0.75)';
        for (let k = 0; k < knob.m; k++) ctx.fillRect(Math.round(g.toX(first + spreadOf(box.beatSpread, box.beatValue, k, knob.m, null, false))), bottom - 5, 1.5, 5);
        ctx.strokeStyle = 'rgba(255,214,90,0.6)';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        let ghost: { x: number; y: number } | null = null;
        knob.events.forEach((event, index) => {
          const level = event.transition === 'extend' ? null : Math.max(0, event.brightness + (index === 0 && !box.affectFirst ? 0 : knob.extra));
          const x = g.toX(event.beat + knob.shift);
          const yy = level === null ? (ghost?.y ?? y(0)) : y(level);
          if (ghost === null) ctx.moveTo(x, yy);
          else if (event.transition === 'fade') ctx.lineTo(x, yy);
          else {
            ctx.lineTo(x, ghost.y);
            ctx.lineTo(x, yy);
          }
          ghost = { x, y: yy };
        });
        if (ghost !== null) ctx.lineTo(g.toX(Math.max(g.length, g.to)), (ghost as { y: number }).y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffd65a';
        ctx.strokeStyle = '#1a1300';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(knob.x, knob.y - 7);
        ctx.lineTo(knob.x + 7, knob.y);
        ctx.lineTo(knob.x, knob.y + 7);
        ctx.lineTo(knob.x - 7, knob.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ffd65a';
        ctx.fillText(`${box.beatSpread === 'wave' ? 'волна' : 'шаг'} ${beatsText(box.beatValue)} · ${knob.extra >= 0 ? '+' : ''}${knob.extra.toFixed(2)}`, Math.min(g.width - 120, knob.x + 10), Math.max(26, knob.y - 8));
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
    this.laneCanvas = { canvas, image: ctx.getImageData(0, 0, canvas.width, canvas.height), effect };
  }

  private laneCanvas: { canvas: HTMLCanvasElement; image: ImageData; effect: Effect } | null = null;

  /** The song's cursor over the box's lane (drawn every frame over its picture). */
  private drawLanePlayhead() {
    const lane = this.laneCanvas;
    if (lane === null || !lane.canvas.isConnected) return;
    const ctx = lane.canvas.getContext('2d')!;
    ctx.putImageData(lane.image, 0, 0);
    const g = this.laneGeometry(lane.canvas, lane.effect);
    const x = g.toX(this.editor.playhead() - lane.effect.start);
    if (x < 0 || x > g.width) return;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#ff4d6d';
    ctx.fillRect(x, 0, 1.5, g.height);
  }

  private bindLane(canvas: HTMLCanvasElement, effect: Effect, box: GlsBox) {
    this.bindZoom(canvas, (x) => this.laneGeometry(canvas, this.effect() ?? effect).toBeat(x));
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
      if (item !== undefined) item.beat = Math.min(Math.max(g.length, g.to), snap(g.toBeat(x)));
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
      // the spread handle: dragged — sideways the time spread, up and down the brightness spread
      const knob = this.spreadKnob(canvas, effect, box);
      const point = local(event);
      if (knob !== null && Math.hypot(point.x - knob.x, point.y - knob.y) <= 9) {
        const scale = this.laneScale(g.height);
        const original = { beatValue: box.beatValue, value: box.value };
        const step = this.editor.snap > 0 ? this.editor.snap : 1 / 16;
        const drag = (move: MouseEvent) => {
          const at = local(move);
          const shift = Math.max(0, g.toBeat(at.x) - knob.base.beat);
          const extra = Math.round((scale.level(at.y) - knob.base.brightness) * 20) / 20;
          // (wave: the last of m is at (m − 1)/m of it; step: (m − 1) steps — the value itself on the
          // grid; the brightness the same way)
          const raw = box.beatSpread === 'wave' ? (shift * knob.m) / (knob.m - 1) : shift / (knob.m - 1);
          box.beatValue = Math.max(0, Math.round(raw / step) * step);
          box.value = box.valueSpread === 'wave' ? extra : extra / (knob.m - 1);
          this.drawLane(canvas, effect, box);
        };
        const done = () => {
          window.removeEventListener('mousemove', drag);
          const next = { beatValue: Math.round(box.beatValue * 10000) / 10000, value: Math.round(box.value * 1000) / 1000 };
          Object.assign(box, original);
          if (next.beatValue === original.beatValue && next.value === original.value) return;
          this.changeBox((item) => Object.assign(item, next));
        };
        window.addEventListener('mousemove', drag);
        window.addEventListener('mouseup', done, { once: true });
        return;
      }
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
      // (past the block's end too: the block grows to take it)
      const beat = Math.min(Math.max(g.length, g.to), snap(g.toBeat(x)));
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
    wrap.classList.toggle('folded', !resultOpen);
    const title = heading(`${resultOpen ? '▾' : '▸'} Результат по элементам`);
    title.classList.add('gls-fold');
    title.title = 'Свернуть / развернуть. Клик по результату — песня туда';
    title.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button') !== null) return;
      resultOpen = !resultOpen;
      this.render();
    });
    if (resultOpen) title.append(this.zoomButtons(effect));
    wrap.append(title);
    if (!resultOpen) return wrap;
    const canvas = document.createElement('canvas');
    canvas.className = 'gls-result-canvas';
    wrap.append(canvas);
    // a click: the song there (the 3D view shows that moment)
    canvas.addEventListener('mousedown', (event) => {
      const current = this.effect() ?? effect;
      const { from, to } = this.shown(current);
      const x = event.clientX - canvas.getBoundingClientRect().left;
      const beat = from + ((x - 96) / Math.max(1, canvas.clientWidth - 96 - 8)) * (to - from);
      if (beat >= 0) this.editor.seek(current.start + beat);
    });
    this.bindZoom(canvas, (x) => {
      const { from, to } = this.shown(this.effect() ?? effect);
      return from + ((x - 96) / Math.max(1, canvas.clientWidth - 96 - 8)) * (to - from);
    });
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
    const { from, to } = this.shown(effect);
    const toX = (beat: number) => labelW + ((beat - effect.start - from) / (to - from)) * (width - labelW - 8);
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
    ctx.save();
    ctx.beginPath();
    ctx.rect(labelW, 0, width - labelW, height);
    ctx.clip();
    const beatStep = [1 / 16, 0.125, 0.25, 0.5, 1, 2, 4, 8].find((value) => (value * (width - labelW)) / (to - from) >= 14) ?? 16;
    for (let beat = Math.max(0, Math.ceil(from / beatStep) * beatStep); beat <= Math.min(length, to) + 1e-6; beat += beatStep) {
      ctx.fillStyle = Math.abs(beat - Math.round(beat)) < 1e-6 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
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
    // past the block's end: dimmed
    const endX = toX(effect.end);
    if (endX < width) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(endX, 0, width - endX, height);
    }
    ctx.restore();
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

/** The result under the lanes open (kept while the editor runs). */
let resultOpen = true;

function describeFilter(box: GlsBox) {
  const f = box.filter;
  const base = f.type === 'custom' ? `выбрано ${String(f.elements?.length ?? 0)}` : f.type === 'division' ? (f.sections <= 1 ? 'все' : `секция ${String(f.section + 1)}/${String(f.sections)}`) : f.step === 0 ? `№${String(f.offset + 1)}` : `каждый ${String(f.step)}-й с ${String(f.offset + 1)}`;
  const order = f.random === 'shuffle' ? ', вперемешку' : f.order === 'outward' ? ', от центра' : f.order === 'inward' ? ', к центру' : f.reverse ? ', обратно' : '';
  return `${base}${order}`;
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

/** Beats as a short text (fractions where they are the grid's). */
function beatsText(beats: number) {
  return `${beatsLabel(beats)} д.`;
}
