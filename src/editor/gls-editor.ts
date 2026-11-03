import { resolveRgb } from './bake';
import type { Editor } from './editor';
import { actionFor, comboOf } from './hotkeys';
import type { Effect } from './effects';
import { easingPicker } from './easing-picker';
import { beatDrumStep, beatsLabel, drum, GRIDS, nextGrid, numberDrum } from './grids';
import { showMenu } from './menu';
import { addPreset, presetFromSelection } from './presets';
import { defaultFilter, ease, filterFor, filterUnits, glsNeededLength, pointsToBlocks, spreadOf, type GlsBlock, type GlsLane, newColorBox, newRotationBox, type GlsBox, type GlsColorEvent, type GlsEasing, type GlsRotationEvent, type GlsSpread, type GlsTransition } from './gls';
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

/** One of a block's groups as the editor shows it ('' : the block's own). */
interface ShownLane {
  id: string;
  name: string;
  target: Pick<Effect, 'target' | 'type' | 'ids'>;
  boxes: GlsBox[];
}

const EASINGS: [GlsEasing, string][] = [
  ['none', 'Без перехода'],
  ['linear', 'Линейно'],
  ['inQuad', 'Разгон (InQuad)'],
  ['outQuad', 'Торможение (OutQuad)'],
  ['inOutQuad', 'Разгон и торможение'],
];

/** How a GLS easing goes (for its pick's pictures): 'none' — at once. */
const glsCurve = (kind: GlsEasing) => (t: number) => (kind === 'none' ? (t > 0 ? 1 : 0) : ease(kind, t));

const TRANSITIONS: [GlsTransition, string, string][] = [
  ['instant', 'Сразу', 'Значение ставится мгновенно'],
  ['fade', 'Плавно', 'Плавный переход от предыдущего события к этому'],
  ['extend', 'Продлить', 'Держит предыдущее значение до этого места, следующий переход начинается отсюда'],
];

const STROBES = [0, 1, 2, 4, 8, 16, 32];

export class GlsEditor {
  private shade: HTMLElement | null = null;
  /** The picked box's settings, shown where the effects library is while the block is edited. */
  private side: HTMLElement | null = null;
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
      if (what === 'clips' || what === 'all' || what === 'grid') this.render();
    });
  }

  private effect(): Effect | undefined {
    return this.editor.effectById(this.effectId);
  }

  /** The block's groups: its own first, then the ones added — each with what it runs over and its boxes. */
  private lanes(effect: Effect | undefined = this.effect()): ShownLane[] {
    if (effect === undefined) return [];
    const name = (target: Pick<Effect, 'target' | 'type' | 'ids'>) => (target.target !== undefined ? (findGroup(this.editor.groups, target.target)?.group.name ?? 'группа') : (this.editor.rows.find((row) => row.kind === 'group' && row.type === target.type) as { label?: string } | undefined)?.label ?? `тип ${String(target.type)}`);
    return [
      { id: '', name: name(effect), target: effect, boxes: effect.gls?.boxes ?? [] },
      ...(effect.gls?.lanes ?? []).map((lane) => ({ id: lane.id, name: name(lane), target: lane, boxes: lane.boxes })),
    ];
  }

  private allBoxes(effect: Effect | undefined = this.effect()) {
    return this.lanes(effect).flatMap((lane) => lane.boxes);
  }

  private box(): GlsBox | undefined {
    const boxes = this.allBoxes();
    return boxes.find((box) => box.id === this.boxId) ?? boxes[0];
  }

  /** The group a box is on. */
  private laneOf(id: string | undefined, effect: Effect | undefined = this.effect()) {
    return this.lanes(effect).find((lane) => lane.boxes.some((box) => box.id === id)) ?? this.lanes(effect)[0];
  }

  /** What the box's group runs over. */
  private itemsOfBox(box: GlsBox | undefined) {
    const lane = this.laneOf(box?.id);
    return lane === undefined ? [] : this.editor.effectItemsOf(lane.target);
  }

  open(id: string) {
    const effect = this.editor.effectById(id);
    if (effect === undefined || effect.kind !== 'gls') return;
    this.close();
    this.effectId = id;
    this.boxId = effect.gls?.boxes[0]?.id ?? null;
    this.eventId = null;
    this.view = null;
    // (boxes made before 0.19: their point events made into blocks, the same light)
    const old = this.allBoxes(effect).some((box) => box.kind === 'color' && box.blocks === undefined);
    if (old) {
      const scheme = this.editor.scheme();
      this.editor.updateEffect(id, (item) => {
        const length = item.end - item.start;
        for (const box of [...(item.gls?.boxes ?? []), ...(item.gls?.lanes ?? []).flatMap((lane) => lane.boxes)]) {
          if (box.kind !== 'color' || box.blocks !== undefined) continue;
          box.blocks = pointsToBlocks(box.events, length, scheme);
          box.events = [];
        }
      });
    }
    const shade = document.createElement('div');
    shade.className = 'gls-dock';
    document.body.append(shade);
    this.shade = shade;
    const library = document.getElementById('library');
    if (library !== null) {
      this.side = document.createElement('div');
      this.side.className = 'gls-side-panel';
      library.classList.add('gls-side');
      library.append(this.side);
    }
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
      // (zoomed in: the lanes follow the song's cursor when it goes out of sight)
      if (effect !== undefined && this.view !== null) {
        const at = this.editor.playhead() - effect.start;
        const { from, to } = this.view;
        if ((at < from || at > to) && at > -1 && at < effect.end - effect.start + 1) {
          const span = to - from;
          this.view = { from: at - span * 0.1, to: at + span * 0.9 };
          this.redrawViews();
        }
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
    this.side?.remove();
    this.side = null;
    document.getElementById('library')?.classList.remove('gls-side');
    this.editor.glsInspect = null;
    this.editor.emit('selection');
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
    // (the inspector on the right stays in sight: the picked block is edited there)
    const inspector = document.getElementById('inspector')?.getBoundingClientRect();
    const right = inspector !== undefined && inspector.width > 0 ? inspector.left : rect.right;
    dock.style.left = `${String(rect.left)}px`;
    dock.style.top = `${String(Math.min(rect.top, window.innerHeight - height))}px`;
    dock.style.width = `${String(Math.max(320, right - rect.left))}px`;
    dock.style.height = `${String(height)}px`;
  }


  private onKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    const typing = target instanceof HTMLInputElement && ['text', 'number'].includes(target.type);
    // (an open list — an easing's — closes first, by its own Escape)
    if (event.key === 'Escape' && document.querySelector('.ep-list') !== null) return;
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
    // (the song's speed: the same keys as on the timeline, − / +)
    const action = actionFor(comboOf(event) ?? '');
    if (action === 'faster' || action === 'slower') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.editor.stepRate(action === 'faster');
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
    this.editor.updateEffect(this.effectId, (effect) => {
      effect.gls ??= { boxes: [] };
      patch(effect);
      // (each of its groups with its own elements)
      const needed = Math.max(...this.lanes(effect).map((lane) => glsNeededLength({ boxes: lane.boxes }, this.editor.effectItemsOf(lane.target).length)));
      if (effect.start + needed > effect.end + 1e-6) {
        const step = this.editor.snap > 0 ? this.editor.snap : 1 / 64;
        effect.end = effect.start + Math.ceil((needed - 1e-6) / step) * step;
      }
    });
  }

  private changeBox(patch: (box: GlsBox) => void) {
    const id = this.box()?.id;
    this.change((effect) => {
      const boxes = this.allBoxes(effect);
      const box = boxes.find((item) => item.id === id);
      if (box === undefined) return;
      patch(box);
      // (linked boxes share their events)
      if (box.link !== undefined) for (const other of boxes) if (other !== box && other.link === box.link) other.blocks = structuredClone(box.blocks ?? []);
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

  /** A new block as the brush draws (its colour, how it comes on and goes, its gradient). */
  private brushBlock(start: number, end: number): GlsBlock {
    const brush = this.editor.brush;
    return {
      id: newId('v'),
      start,
      end,
      color: { ...brush.color },
      endColor: brush.endColor === null ? null : { ...brush.endColor },
      startMode: brush.startMode,
      fadeIn: brush.fadeIn,
      endMode: brush.endMode,
      ...(brush.fadeOut === undefined ? {} : { fadeOut: brush.fadeOut }),
      ...(brush.hsv ? { hsv: true } : {}),
      strobe: 0,
    };
  }

  /** T down: a block from here (as the brush draws), as long as it's held; a ring box: a turn like the last one. */
  private tapDown() {
    const box = this.box();
    const beat = this.tapBeat();
    if (box === undefined || beat === null) return;
    const id = newId('v');
    this.eventId = id;
    this.tap = { beat };
    const step = this.editor.snap > 0 ? this.editor.snap : 1 / 16;
    this.changeBox((item) => {
      if (item.kind === 'color') {
        // (what it starts over is cut where it starts)
        const blocks = (item.blocks ?? []).filter((block) => Math.abs(block.start - beat) > 1e-4);
        for (const block of blocks) if (block.start < beat && block.end > beat) block.end = beat;
        item.blocks = [...blocks, { ...this.brushBlock(beat, beat + step), id }];
      } else {
        const last = [...item.rotations].sort((a, b) => b.beat - a.beat)[0];
        item.rotations = item.rotations.filter((event) => Math.abs(event.beat - beat) > 1e-4);
        item.rotations.push({ ...(last ?? { angle: 90, loops: 0, direction: 'cw', easing: 'outQuad' }), id, beat } as GlsRotationEvent);
      }
    });
  }

  /** T up: held a while — the block lasts until here; a quick tap — a flash, a grid step long, fading out. */
  private tapUp(at?: number) {
    const tap = this.tap;
    this.tap = null;
    const box = this.box();
    const effect = this.effect();
    const id = this.eventId;
    if (tap === null || box === undefined || effect === undefined || box.kind !== 'color') return;
    const step = this.editor.snap > 0 ? this.editor.snap : 1 / 16;
    const length = effect.end - effect.start;
    // (let go past the block's end, or the song looped: to the end)
    const now = at ?? this.tapBeat() ?? length;
    const held = now - tap.beat >= step - 1e-6;
    const end = Math.min(length, held ? now : tap.beat + step);
    this.changeBox((item) => {
      const block = item.blocks?.find((entry) => entry.id === id);
      if (block === undefined) return;
      block.end = Math.max(block.start + 1 / 64, end);
      if (!held) block.endMode = 'fade';
      // (what it now covers goes)
      item.blocks = item.blocks!.filter((entry) => entry === block || !(entry.start > block.start + 1e-4 && entry.start < block.end - 1e-4));
    });
  }

  // ----- rendering -------------------------------------------------------------------------------------

  private render() {
    const shade = this.shade;
    const effect = this.effect();
    if (shade === null || effect === undefined) return;
    if (holdWhileTyping(shade, () => this.render()) || (this.side !== null && holdWhileTyping(this.side, () => this.render()))) return;
    const scroll = [...shade.querySelectorAll<HTMLElement>('.gls-col')].map((col) => col.scrollTop);
    const sideScroll = this.side?.scrollTop ?? 0;
    // (a drum being turned with the keys keeps the focus in its new self)
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && (shade.contains(active) || this.side?.contains(active) === true) ? active.dataset.wheelKey : undefined;
    shade.replaceChildren();
    const dialog = document.createElement('div');
    dialog.className = 'gls-dialog';
    dialog.append(this.header(effect), scrubStrip(this.editor, () => this.effect() ?? null, null, false));
    const body = document.createElement('div');
    body.className = 'gls-body';
    body.append(this.boxList(effect), this.laneColumn(effect));
    dialog.append(body, this.result(effect));
    shade.append(dialog);
    // the picked box's settings: where the effects are while the block is edited
    if (this.side !== null) {
      const box = this.box();
      const lane = this.laneOf(box?.id);
      const title = Object.assign(document.createElement('div'), { className: 'gls-side-title', textContent: box === undefined || lane === undefined ? 'GLS' : `${lane.name} · ${String(lane.boxes.indexOf(box) + 1)}. ${box.kind === 'color' ? 'Свет' : 'Кольца'}` });
      this.side.replaceChildren(title, this.boxSettings());
      this.side.scrollTop = sideScroll;
    }
    [...shade.querySelectorAll<HTMLElement>('.gls-col')].forEach((col, index) => (col.scrollTop = scroll[index] ?? 0));
    if (focused !== undefined) (shade.querySelector<HTMLElement>(`[data-wheel-key="${CSS.escape(focused)}"]`) ?? this.side?.querySelector<HTMLElement>(`[data-wheel-key="${CSS.escape(focused)}"]`))?.focus({ preventScroll: true });
    // the picked block (or ring turn): in the inspector on the right, as a clip is
    this.inspect();
  }

  /** What the inspector on the right shows: the picked block, a ring turn — or the brush. */
  private inspect() {
    const box = this.box();
    const block = box?.kind === 'color' ? box.blocks?.find((item) => item.id === this.eventId) : undefined;
    const turn = box?.kind === 'rotation' ? box.rotations.find((item) => item.id === this.eventId) : undefined;
    if (block !== undefined) {
      this.editor.glsInspect = {
        block: {
          source: { ...block, fadeIn: block.fadeIn, start: block.start, end: block.end },
          apply: (change) =>
            this.changeBox((item) => {
              const target = item.blocks?.find((entry) => entry.id === block.id);
              if (target !== undefined) change(target);
            }),
          remove: () => this.deleteEvent(),
        },
      };
    } else if (turn !== undefined) {
      this.editor.glsInspect = { render: (root) => root.append(heading('Поворот колец'), this.rotationEventPanel(turn)) };
    } else this.editor.glsInspect = {};
    this.editor.emit('selection');
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
    const lanes = this.lanes(effect);
    where.textContent = lanes.length > 1 ? `групп: ${String(lanes.length)} · элементов: ${String(lanes.reduce((sum, lane) => sum + this.editor.effectItemsOf(lane.target).length, 0))}` : `${target !== undefined ? `на группе «${target.name}»` : 'на строке ламп'} · элементов: ${String(this.editor.effectItemsOf(effect).length)}`;
    const length = labeled('Длина, долей', numberInput(effect.end - effect.start, 0.25, (value) => this.change((item) => (item.end = item.start + Math.max(0.25, value)))));
    const layer = labeled('Слой', numberInput(effect.layer, 1, (value) => this.change((item) => (item.layer = Math.max(0, Math.round(value))))));
    const play = button(this.editor.previewExtra !== null ? '■ Стоп' : '▶ Проиграть', 'Проиграть блок по кругу в окне просмотра (Пробел)', () => {
      this.play();
      this.render();
    });
    const done = button('Готово', 'Закрыть (Esc)', () => this.close());
    done.classList.add('primary');
    const keep = button('💾 В пресеты', 'Сохранить блок в пресеты (вкладка «Пресеты»): вставляется на другие группы — фильтры подстраиваются под число их элементов', () => {
      const before = this.editor.selection;
      this.editor.selection = new Set([effect.id]);
      const preset = presetFromSelection(this.editor, effect.name || 'GLS-блок');
      this.editor.selection = before;
      if (preset === null) return;
      addPreset(this.editor, preset);
      this.editor.emit('selection');
      this.editor.setStatus(`Пресет «${preset.name}» сохранён`);
    });
    head.append(title, name, where, speedControl(this.editor), length, layer, play, keep, done);
    return head;
  }

  private boxList(effect: Effect) {
    const col = document.createElement('div');
    col.className = 'gls-col gls-boxes';
    const lanes = this.lanes(effect);
    const current = this.box();
    const allColor = lanes.flatMap((lane) => lane.boxes.filter((box) => box.kind === 'color').map((box) => ({ lane, box })));
    const label = (lane: ShownLane, box: GlsBox) => `${lane.name} · ${String(lane.boxes.indexOf(box) + 1)}. ${box.kind === 'color' ? 'Свет' : 'Кольца'}`;
    /** A change to the boxes of one group (the block's own or an added one). */
    const changeLane = (laneId: string, patch: (boxes: GlsBox[], effect: Effect) => void) =>
      this.change((item) => {
        const boxes = laneId === '' ? item.gls!.boxes : item.gls!.lanes?.find((lane) => lane.id === laneId)?.boxes;
        if (boxes !== undefined) patch(boxes, item);
      });
    for (const lane of lanes) {
      const head = document.createElement('div');
      head.className = 'gls-lane-head';
      const items = this.editor.effectItemsOf(lane.target).length;
      head.append(Object.assign(document.createElement('b'), { textContent: lane.name }), Object.assign(document.createElement('span'), { className: 'gls-dim', textContent: `${String(items)} эл.` }));
      if (lane.id !== '') {
        head.append(
          button('✕', 'Убрать группу из блока', () =>
            this.change((item) => {
              item.gls!.lanes = (item.gls!.lanes ?? []).filter((entry) => entry.id !== lane.id);
            }),
          ),
        );
      }
      col.append(head);
      lane.boxes.forEach((box, index) => {
        const row = document.createElement('div');
        row.className = `gls-box${box.id === current?.id ? ' active' : ''}`;
        const name = document.createElement('div');
        name.className = 'gls-box-name';
        name.textContent = `${String(index + 1)}. ${box.kind === 'color' ? 'Свет' : 'Вращение колец'}${box.link !== undefined ? ' 🔗' : ''}`;
        const info = document.createElement('div');
        info.className = 'gls-dim';
        info.textContent = box.kind === 'color' ? `${describeFilter(box)} · ${String(filterUnits(box.filter, items).length)} эл. · ${String((box.blocks ?? box.events).length)} соб.` : `${box.rings === '' ? 'все кольца' : ringSystemName(box.rings)} · ${String(box.rotations.length)} соб.`;
        const tools = document.createElement('div');
        tools.className = 'gls-box-tools';
        tools.append(
          button('↑', 'Выше (важнее)', () => changeLane(lane.id, (boxes) => swap(boxes, index, index - 1)), index === 0),
          button('↓', 'Ниже', () => changeLane(lane.id, (boxes) => swap(boxes, index, index + 1)), index === lane.boxes.length - 1),
          button('⧉', 'Копия коробки', () => {
            const copy = copyBox(box);
            this.boxId = copy.id;
            changeLane(lane.id, (boxes) => boxes.splice(index + 1, 0, copy));
          }),
        );
        if (box.kind === 'color') {
          const link = button('🔗', 'Связать события с другой коробкой, зеркальная копия в другую группу…', () => {
            const rect = link.getBoundingClientRect();
            const others = allColor.filter((entry) => entry.box !== box);
            showMenu(rect.left, rect.bottom + 2, [
              { label: 'Взять события у…', heading: true },
              ...others.map((entry) => ({
                label: `${label(entry.lane, entry.box)}${entry.box.link !== undefined && entry.box.link === box.link ? ' (связаны)' : ''}`,
                action: () =>
                  this.change((item) => {
                    const boxes = this.allBoxes(item);
                    const mine = boxes.find((value) => value.id === box.id);
                    const theirs = boxes.find((value) => value.id === entry.box.id);
                    if (mine === undefined || theirs === undefined) return;
                    theirs.link ??= newId('k');
                    mine.link = theirs.link;
                    mine.blocks = structuredClone(theirs.blocks ?? []);
                  }),
              })),
              ...(box.link === undefined ? [] : [{ label: 'Развязать', action: () => this.changeBox((item) => delete item.link) }]),
              null,
              { label: 'Зеркальная копия в группу (связана)…', heading: true },
              ...lanes
                .filter((other) => other.id !== lane.id)
                .map((other) => ({
                  label: other.name,
                  action: () => {
                    const copy = copyBox(box);
                    copy.filter.reverse = !copy.filter.reverse;
                    const key = box.link ?? newId('k');
                    copy.link = key;
                    this.boxId = copy.id;
                    this.change((item) => {
                      const mine = this.allBoxes(item).find((value) => value.id === box.id);
                      if (mine !== undefined) mine.link = key;
                      const boxes = other.id === '' ? item.gls!.boxes : item.gls!.lanes?.find((entry) => entry.id === other.id)?.boxes;
                      boxes?.unshift(copy);
                    });
                  },
                })),
              ...(lanes.length < 2 ? [{ label: 'Сначала добавьте в блок ещё группу', disabled: true }] : []),
            ]);
          });
          tools.append(link);
        }
        tools.append(button('✕', 'Удалить коробку', () => changeLane(lane.id, (boxes) => boxes.splice(index, 1)), lanes.length === 1 && lane.boxes.length <= 1));
        row.append(name, info, tools);
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
      add.append(
        button('＋ Свет', `Новая коробка света в «${lane.name}»`, () => {
          const box = newColorBox(this.editor.brush.color);
          this.boxId = box.id;
          changeLane(lane.id, (boxes) => boxes.push(box));
        }),
      );
      if (lane.id === '') {
        const rings = this.editor.preview.ringSystems().some((system) => system.rotates);
        add.append(
          button('＋ Кольца', rings ? 'Коробка вращения колец' : 'В этом окружении нет вращающихся колец', () => {
            const box = newRotationBox();
            this.boxId = box.id;
            changeLane('', (boxes) => boxes.push(box));
          }, !rings),
        );
      }
      col.append(add);
    }
    // more groups in the same block (the timing shared, each with its own boxes)
    const more = button('＋ Группа в блок…', 'Добавить в этот блок ещё одну группу ламп — со своими коробками', () => {
      const rect = more.getBoundingClientRect();
      const taken = new Set(lanes.map((lane) => JSON.stringify([lane.target.target ?? null, lane.target.target === undefined ? lane.target.type : null])));
      const rows = this.editor.rows.filter((row) => row.kind === 'custom' || row.kind === 'group');
      const entry = (row: (typeof rows)[number]) => {
        const target = this.editor.targetOfRow(row);
        if (target === null) return null;
        if (taken.has(JSON.stringify([target.target ?? null, target.target === undefined ? target.type : null]))) return null;
        return {
          label: row.kind === 'custom' ? row.group.name : row.label,
          action: () => {
            const lane: GlsLane = { id: newId('l'), ...(target.target === undefined ? {} : { target: target.target }), type: target.type, ids: target.ids === null ? null : [...target.ids], boxes: [newColorBox(this.editor.brush.color)] };
            this.boxId = lane.boxes[0]!.id;
            this.change((item) => {
              item.gls!.lanes = [...(item.gls!.lanes ?? []), lane];
            });
          },
        };
      };
      const custom = rows.filter((row) => row.kind === 'custom').map(entry).filter((item) => item !== null);
      const plain = rows.filter((row) => row.kind === 'group').map(entry).filter((item) => item !== null);
      showMenu(rect.left, rect.bottom + 2, [
        ...(custom.length > 0 ? [{ label: 'Ваши группы', heading: true }, ...custom] : []),
        ...(plain.length > 0 ? [{ label: 'Строки ламп', heading: true }, ...plain] : []),
      ]);
    });
    more.className = 'gls-wide';
    col.append(more);
    // the game's "super add": a box per element (V2-style lighting inside one block)
    const lane = this.laneOf(current?.id);
    const items = lane === undefined ? 0 : this.editor.effectItemsOf(lane.target).length;
    const each = button('Каждому элементу — своя коробка', 'Сделать по коробке на каждый элемент (шаг 0, сдвиг 1, 2, 3…) — как ручной свет V2', () => {
      const template = this.box();
      if (template === undefined || template.kind !== 'color' || lane === undefined) return;
      changeLane(lane.id, (boxes) => {
        const count = Math.min(64, items);
        const made: GlsBox[] = [];
        for (let i = 0; i < count; i++) {
          const copy = copyBox(template);
          copy.filter = { ...defaultFilter(), type: 'step', step: 0, offset: i };
          made.push(copy);
        }
        const rings = boxes.filter((box) => box.kind === 'rotation');
        boxes.splice(0, boxes.length, ...made, ...rings);
        this.boxId = made[0]?.id ?? null;
      });
    }, current?.kind !== 'color' || items > 64);
    each.className = 'gls-wide';
    col.append(each);
    return col;
  }

  /** The box panel's tab: which elements (and how the game's filter has it) or the spreads. */
  private sideTab: 'elements' | 'spread' = 'elements';

  private boxSettings() {
    const col = document.createElement('div');
    col.className = 'gls-col gls-settings';
    const box = this.box();
    if (box === undefined) return col;
    // tabs, as the library's
    const tabs = document.createElement('div');
    tabs.className = 'lib-tabs gls-side-tabs';
    for (const [key, label] of [
      ['elements', box.kind === 'color' ? 'Элементы' : 'Кольца'],
      ['spread', 'Распределение'],
    ] as const) {
      const tab = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
      tab.classList.toggle('active', this.sideTab === key);
      tab.addEventListener('click', () => {
        this.sideTab = key;
        this.render();
      });
      tabs.append(tab);
    }
    col.append(tabs);
    if (this.sideTab === 'elements') this.elementsTab(col, box);
    else this.spreadTab(col, box);
    return col;
  }

  /** Which elements the box lights and in what order — the lamps, the order, the game's own filter. */
  private elementsTab(col: HTMLElement, box: GlsBox) {
    if (box.kind !== 'color') {
      const systems = this.editor.preview.ringSystems().filter((system) => system.rotates);
      col.append(labeled('Какие кольца', select([['', 'Все кольца'], ...systems.map((system): [string, string] => [system.name, `${ringSystemName(system.name)} (${String(system.rings)})`])], box.rings, (value) => this.changeBox((item) => (item.rings = value)))));
      const note = document.createElement('div');
      note.className = 'gls-note';
      note.textContent = 'Вращение крутит все кольца выбранной системы (так устроены события колец Chroma). Лазеры классических окружений поворачивать событиями нельзя.';
      col.append(note);
      return;
    }
    const effect = this.effect()!;
    const count = this.itemsOfBox(box).length;
    col.append(this.lampPicker(effect, box));
    const picked = new Set(filterUnits({ ...box.filter, limit: 1, random: box.filter.random === 'pick' ? 'none' : box.filter.random }, count).flat());
    const invert = button('⇄ Инвертировать', 'Выбрать невыбранные лампы, а выбранные снять', () =>
      this.changeBox((item) => (item.filter = filterFor(Array.from({ length: count }, (_, index) => index).filter((index) => !picked.has(index)), count, item.filter))),
    );
    invert.className = 'gls-invert';
    col.append(invert);
    // the order: a list
    col.append(heading('Порядок'));
    col.append(this.orderList(box));
    if (box.filter.random !== 'none') {
      const seed = document.createElement('div');
      seed.className = 'gls-seed';
      seed.append(
        labeled('Сид случайности', numberInput(box.filter.seed, 1, (value) => this.changeBox((item) => (item.filter.seed = Math.max(0, Math.round(value)))))),
        button('🎲', 'Другой случайный сид', () => this.changeBox((item) => (item.filter.seed = Math.floor(Math.random() * 1e6)))),
      );
      col.append(seed);
    }
    // the game's own filter, for exact work (not folded away)
    col.append(heading('Фильтр (как в игре)'));
    const kinds: ['division' | 'step' | 'custom', string][] = [
      ['division', 'Секции'],
      ['step', 'Шаг и сдвиг'],
      ['custom', 'Выбранные'],
    ];
    col.append(
      toggle(
        kinds.map(([kind, label]) => [kind, label]),
        box.filter.type,
        (kind) =>
          this.changeBox((item) => {
            if (kind === 'custom') item.filter.elements = filterUnits({ ...item.filter, reverse: false, order: 'line', random: 'none', limit: 1 }, count).flat();
            item.filter.type = kind;
          }),
      ),
    );
    if (box.filter.type === 'division') {
      col.append(
        labeled('Секций', numberDrum(`gls-sections:${box.id}`, box.filter.sections, (value) => this.changeBox((item) => (item.filter.sections = Math.max(1, Math.round(value)))), { step: 1, min: 1, max: Math.max(2, count) })),
        labeled('Номер секции', numberDrum(`gls-section:${box.id}`, box.filter.section + 1, (value) => this.changeBox((item) => (item.filter.section = Math.max(0, Math.round(value) - 1))), { step: 1, min: 1, max: Math.max(1, box.filter.sections) })),
      );
    } else if (box.filter.type === 'step') {
      col.append(
        labeled('Шаг (0 — один)', numberDrum(`gls-step:${box.id}`, box.filter.step, (value) => this.changeBox((item) => (item.filter.step = Math.max(0, Math.round(value)))), { step: 1, min: 0, max: Math.max(1, count) })),
        labeled('Сдвиг (с какого)', numberDrum(`gls-offset:${box.id}`, box.filter.offset + 1, (value) => this.changeBox((item) => (item.filter.offset = Math.max(0, Math.round(value) - 1))), { step: 1, min: 1, max: Math.max(1, count) })),
      );
    }
    col.append(labeled('Куски (0 — нет)', numberDrum(`gls-chunks:${box.id}`, box.filter.chunks, (value) => this.changeBox((item) => (item.filter.chunks = Math.max(0, Math.round(value)))), { step: 1, min: 0, max: Math.max(1, count) })));
    col.append(labeled('Сколько взять, %', numberDrum(`gls-limit:${box.id}`, Math.round(box.filter.limit * 100), (value) => this.changeBox((item) => (item.filter.limit = Math.min(1, Math.max(0.01, value / 100)))), { step: 5, min: 5, max: 100 })));
    col.append(check('Случайные элементы (не все)', box.filter.random === 'pick', (on) => this.changeBox((item) => (item.filter.random = on ? 'pick' : 'none'))));
  }

  /** How the box's events spread over its elements: in time, in brightness (angle), in hue. */
  private spreadTab(col: HTMLElement, box: GlsBox) {
    col.append(heading('По времени'));
    col.append(toggle(spreads(), box.beatSpread, (value) => this.changeBox((item) => (item.beatSpread = value))));
    col.append(labeled(box.beatSpread === 'wave' ? 'Волна на всех, долей' : 'Шаг на элемент, долей', numberDrum(`gls-beat:${box.id}:${String(beatDrumStep(this.editor.snap))}`, box.beatValue, (value) => this.changeBox((item) => (item.beatValue = Math.max(0, value))), { step: beatDrumStep(this.editor.snap), min: 0, max: 64, beats: true })));
    col.append(heading(box.kind === 'color' ? 'По яркости и оттенку' : 'По углу'));
    col.append(toggle(spreads(), box.valueSpread, (value) => this.changeBox((item) => (item.valueSpread = value))));
    const wave = box.valueSpread === 'wave';
    if (box.kind === 'color') {
      col.append(labeled(wave ? 'Яркость последнему элементу +' : 'Яркость каждому следующему +', numberDrum(`gls-value:${box.id}`, box.value, (value) => this.changeBox((item) => (item.value = value)), { step: 0.05, min: -1.5, max: 1.5, digits: 2 })));
      col.append(slider(wave ? 'Оттенок последнему элементу, °' : 'Оттенок каждому следующему, °', box.hueSpread ?? 0, -360, 360, 5, (value) => this.changeBox((item) => (item.hueSpread = value))));
      col.append(labeled('Сглаживание', easingPicker(EASINGS, box.easing, (value) => this.changeBox((item) => (item.easing = value)), glsCurve)));
      const tip = document.createElement('div');
      tip.className = 'gls-note';
      tip.textContent = 'Или тяните ручку ◆ на дорожке событий: вправо — дольше волна, вверх/вниз — ярче/тусклее последний элемент. Градиент по радуге внутри блока — справа, «Градиент к концу» + «Через оттенки».';
      col.append(tip);
    } else col.append(labeled(wave ? 'Последнему кольцу, °' : 'Каждому кольцу, °', numberDrum(`gls-angle:${box.id}`, box.value, (value) => this.changeBox((item) => (item.value = value)), { step: 5, min: -360, max: 360 })));
    col.append(check('Затрагивать первое событие', box.affectFirst, (on) => this.changeBox((item) => (item.affectFirst = on))));
  }

  private moreOpen = false;

  /**
   * The group's elements as lamps: the picked ones lit, numbered in the order the box's events go over
   * them; a click (or a drag across) picks and unpicks — the filter that does just that is found.
   */
  private lampPicker(effect: Effect, box: GlsBox) {
    void effect;
    const items = this.itemsOfBox(box);
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

  /** The order the box's events go over its elements: a list. */
  private orderList(box: GlsBox) {
    const options: ['line' | 'reverse' | 'outward' | 'inward' | 'shuffle', string, string][] = [
      ['line', '→ По порядку', 'Как идут элементы группы'],
      ['reverse', '← Обратно', 'С последнего к первому'],
      ['outward', '↔ От центра', 'Из середины к краям, симметричные пары вместе'],
      ['inward', '→← К центру', 'С краёв к середине, симметричные пары вместе'],
      ['shuffle', '🔀 Вперемешку', 'В случайном порядке (сид — ниже)'],
    ];
    const f = box.filter;
    const current = f.random === 'shuffle' ? 'shuffle' : f.order === 'outward' || f.order === 'inward' ? f.order : f.reverse ? 'reverse' : 'line';
    const list = document.createElement('div');
    list.className = 'gls-order';
    for (const [value, label, title] of options) {
      const item = button(label, title, () =>
        this.changeBox((target) => {
          target.filter.random = value === 'shuffle' ? 'shuffle' : target.filter.random === 'shuffle' ? 'none' : target.filter.random;
          target.filter.order = value === 'outward' || value === 'inward' ? value : 'line';
          target.filter.reverse = value === 'reverse';
        }),
      );
      item.classList.toggle('active', value === current);
      list.append(item);
    }
    return list;
  }

  private laneColumn(effect: Effect) {
    const col = document.createElement('div');
    col.className = 'gls-col gls-lane-col';
    const current = this.box();
    const title = heading('События коробок');
    const record = button(this.recording ? '⏺ Запись идёт' : '⏺ Запись', 'Запись по тапам (R) в выбранную коробку: блок играет по кругу, T — поставить событие (держите — горит, пока держите; коротко — вспышка)', () => this.toggleRecording());
    record.classList.add('gls-record');
    record.classList.toggle('active', this.recording);
    title.append(record, this.zoomButtons(effect));
    col.append(title);
    const hint = document.createElement('div');
    hint.className = 'gls-note';
    hint.textContent = this.recording
      ? 'Запись в выбранную коробку: жмите T в такт — держите, пока свет должен гореть; коротко — вспышка. Встаёт на сетку. R — остановить.'
      : 'Протяните по пустому месту — новый блок (кистью справа); за блок — сдвинуть, за край — растянуть; Delete — удалить. Alt+колесо — сетка, Ctrl+колесо — масштаб. Кольца: клик — поворот.';
    col.append(hint);
    this.laneCanvases.clear();
    // every box of every group: a lane each, the picked one marked
    for (const lane of this.lanes(effect)) {
      lane.boxes.forEach((box, index) => {
        const row = document.createElement('div');
        row.className = `gls-lane-row${box.id === current?.id ? ' active' : ''}`;
        const name = document.createElement('div');
        name.className = 'gls-lane-name';
        name.textContent = `${lane.name} · ${String(index + 1)}. ${box.kind === 'color' ? 'Свет' : 'Кольца'}${box.link !== undefined ? ' 🔗' : ''}`;
        name.addEventListener('click', () => {
          this.boxId = box.id;
          this.eventId = null;
          this.render();
        });
        const canvas = document.createElement('canvas');
        canvas.className = 'gls-lane';
        row.append(name, canvas);
        col.append(row);
        requestAnimationFrame(() => this.drawLane(canvas, effect, box));
        this.bindLane(canvas, effect, box);
      });
    }
    return col;
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
    panel.append(labeled('Сглаживание', easingPicker(EASINGS, event.easing, (value) => set((item) => (item.easing = value)), glsCurve)));
    panel.append(button('Удалить событие', 'Delete', () => this.deleteEvent()));
    return panel;
  }

  private deleteEvent() {
    const id = this.eventId;
    if (id === null) return;
    this.eventId = null;
    this.changeBox((box) => {
      box.events = box.events.filter((event) => event.id !== id);
      if (box.blocks !== undefined) box.blocks = box.blocks.filter((block) => block.id !== id);
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

  /** The middle button held on a canvas of the block's lanes: the view dragged along (`margin`: the
   *  pixels on the left before its beats start). */
  private middlePan(canvas: HTMLCanvasElement, margin = 0) {
    canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const effect = this.effect();
      if (effect === undefined) return;
      let last = event.clientX;
      const move = (next: MouseEvent) => {
        const current = this.effect();
        if (current === undefined) return;
        const { from, to } = this.shown(current);
        this.panView(current, ((last - next.clientX) / Math.max(1, canvas.clientWidth - margin)) * (to - from));
        last = next.clientX;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    // (no browser autoscroll on a middle click)
    canvas.addEventListener('auxclick', (event) => event.preventDefault());
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
    void box;
    // (each lane its own box: drawn as they were bound)
    for (const canvas of this.shade?.querySelectorAll<HTMLCanvasElement>('canvas.gls-lane') ?? []) canvas.dispatchEvent(new Event('gls-redraw'));
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
        if (event.altKey) {
          // the grid a step finer or coarser (as on the timeline)
          this.gridWheel += event.deltaY;
          if (Math.abs(this.gridWheel) < 40) return;
          this.editor.snap = nextGrid(this.editor.snap, this.gridWheel < 0);
          this.gridWheel = 0;
          this.editor.setStatus(`Сетка: ${GRIDS.find(([value]) => Math.abs(value - this.editor.snap) < 1e-9)?.[1] ?? ''}`);
          this.editor.emit('selection');
          this.redrawViews();
        } else if (event.ctrlKey || event.metaKey) this.zoomView(effect, Math.exp(event.deltaY * 0.0015), beatAt(x));
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

  private gridWheel = 0;

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
    return { top, bottom, y: (brightness: number) => bottom - (Math.min(1.5, Math.max(0, brightness)) / 1.5) * span, level: (y: number) => ((bottom - y) / span) * 1.5 };
  }

  /**
   * The spread handle: the box's blocks as the last of its elements gets them (moved on by the time
   * spread, brighter by the brightness spread) — the handle on the first block the spread touches.
   */
  private spreadKnob(canvas: HTMLCanvasElement, effect: Effect, box: GlsBox) {
    const blocks = [...(box.blocks ?? [])].sort((a, b) => a.start - b.start);
    if (box.kind !== 'color' || blocks.length === 0) return null;
    const m = filterUnits(box.filter, this.itemsOfBox(box).length).length;
    if (m < 2) return null;
    const index = box.affectFirst || blocks.length === 1 ? 0 : 1;
    const base = blocks[index]!;
    const shift = spreadOf(box.beatSpread, box.beatValue, m - 1, m, null, false);
    const extra = spreadOf(box.valueSpread, box.value, m - 1, m, box.easing, true);
    const g = this.laneGeometry(canvas, effect);
    const scale = this.laneScale(g.height);
    return { m, blocks, index, base, shift, extra, x: g.toX(base.start + shift), y: scale.y(base.color.brightness + extra) };
  }

  /** A block's light as a line over the lane: (beat, brightness) from its start to its end. */
  private envelope(block: GlsBlock, extra = 0): [number, number][] {
    const b0 = Math.max(0, block.color.brightness + extra);
    const b1 = Math.max(0, (block.endColor ?? block.color).brightness + extra);
    const span = Math.max(1e-6, block.end - block.start);
    const at = (beat: number) => b0 + (b1 - b0) * ((beat - block.start) / span);
    const points: [number, number][] = [];
    if (block.startMode === 'fade') return [[block.start, 0], [block.start, b0 * 1.2], [block.end, 0]];
    if (block.startMode === 'fadeIn') points.push([block.start, 0], [block.start + Math.min(block.fadeIn, span), at(block.start + Math.min(block.fadeIn, span))]);
    else if (block.startMode === 'flash') points.push([block.start, 0], [block.start, b0 * 1.2], [block.start + Math.min(span / 4, 0.125), b0]);
    else points.push([block.start, 0], [block.start, b0]);
    if (block.endMode === 'fade') {
      const from = block.fadeOut !== undefined && block.fadeOut > 0 ? Math.max(points.at(-1)![0], block.end - block.fadeOut) : points.at(-1)![0];
      if (from > points.at(-1)![0] + 1e-6) points.push([from, at(from)]);
      points.push([block.end, 0]);
    } else points.push([block.end, b1], [block.end, block.endMode === 'off' ? 0 : b1]);
    return points;
  }

  /** What of a block is at a point of the lane (null: none). */
  private blockZone(g: ReturnType<GlsEditor['laneGeometry']>, blocks: GlsBlock[], point: { x: number; y: number }): { block: GlsBlock; zone: 'startLevel' | 'endLevel' | 'level' | 'start' | 'end' | 'move' } | null {
    const scale = this.laneScale(g.height);
    const ordered = [...blocks].sort((a, b) => (a.id === this.eventId ? -1 : b.id === this.eventId ? 1 : 0));
    const { x: px, y: py } = point;
    for (const block of ordered) {
      const x0 = g.toX(block.start);
      const x1 = g.toX(block.end);
      if (px < x0 - 6 || px > x1 + 6) continue;
      const y0 = scale.y(block.color.brightness);
      const y1 = scale.y((block.endColor ?? block.color).brightness);
      const wide = x1 - x0 > 16;
      if (wide && Math.abs(px - x0) <= 7 && Math.abs(py - y0) <= 7) return { block, zone: 'startLevel' };
      if (wide && Math.abs(px - x1) <= 7 && Math.abs(py - y1) <= 7) return { block, zone: 'endLevel' };
      if (px > x0 + 4 && px < x1 - 4) {
        const topY = y0 + ((y1 - y0) * (px - x0)) / Math.max(1, x1 - x0);
        if (Math.abs(py - topY) <= 5) return { block, zone: 'level' };
      }
      if (x1 - x0 > 8 && Math.abs(px - x0) <= 5) return { block, zone: 'start' };
      if (x1 - x0 > 8 && Math.abs(px - x1) <= 5) return { block, zone: 'end' };
      if (px >= x0 && px <= x1) return { block, zone: 'move' };
    }
    return null;
  }

  private drawLane(canvas: HTMLCanvasElement, effect: Effect, box: GlsBox) {
    if (!canvas.isConnected || canvas.clientWidth === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const g = this.laneGeometry(canvas, effect);
    const { top, bottom, y } = this.laneScale(g.height);
    ctx.fillStyle = '#101116';
    ctx.fillRect(0, 0, g.width, g.height);
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
      // the blocks: each its light (up: brighter) in its colour, the gradient across it
      const blocks = [...(box.blocks ?? [])].sort((a, b) => a.start - b.start);
      for (const block of blocks) {
        const points = this.envelope(block);
        const x0 = g.toX(block.start);
        const x1 = g.toX(block.end);
        const c0 = resolveRgb(block.color, scheme);
        const c1 = resolveRgb(block.endColor ?? block.color, scheme);
        const fill = ctx.createLinearGradient(x0, 0, Math.max(x0 + 1, x1), 0);
        fill.addColorStop(0, rgba(c0, 0.55));
        fill.addColorStop(1, rgba(c1, 0.55));
        ctx.beginPath();
        points.forEach(([beat, level], index) => (index === 0 ? ctx.moveTo(g.toX(beat), y(level)) : ctx.lineTo(g.toX(beat), y(level))));
        ctx.lineTo(x1, bottom);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        if (block.strobe > 0) {
          // (a strobe: stripes at its rate)
          ctx.save();
          ctx.clip();
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          const period = 1 / block.strobe;
          const duty = block.strobeDuty ?? 0.5;
          if (block.strobeWith === 'color' && block.strobeColor !== undefined) ctx.fillStyle = rgba(resolveRgb(block.strobeColor, scheme), 0.55);
          else if (block.strobeWith === 'dim') ctx.fillStyle = `rgba(0,0,0,${String(0.45 * (1 - (block.strobeDim ?? 0.3)))})`;
          for (let beat = block.start + period * duty; beat < block.end; beat += period) ctx.fillRect(g.toX(beat), top, Math.max(1, g.toX(beat + period * (1 - duty)) - g.toX(beat)), bottom - top);
          ctx.restore();
        }
        const selected = block.id === this.eventId;
        ctx.strokeStyle = selected ? '#ffffff' : rgba(c0, 1);
        ctx.lineWidth = selected ? 2 : 1.3;
        ctx.beginPath();
        points.forEach(([beat, level], index) => (index === 0 ? ctx.moveTo(g.toX(beat), y(level)) : ctx.lineTo(g.toX(beat), y(level))));
        ctx.stroke();
        if (block.endMode === 'stay') {
          // (stays lit: an arrow on past its end)
          ctx.fillStyle = rgba(c1, 0.9);
          const yy = y((block.endColor ?? block.color).brightness);
          ctx.beginPath();
          ctx.moveTo(x1 + 1, yy - 4);
          ctx.lineTo(x1 + 6, yy);
          ctx.lineTo(x1 + 1, yy + 4);
          ctx.fill();
        }
        if (selected) {
          // (its ends: grab to stretch)
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x0 - 1, bottom - 10, 3, 10);
          ctx.fillRect(x1 - 2, bottom - 10, 3, 10);
        }
        if (block.strobe > 0 && x1 - x0 > 26) {
          ctx.fillStyle = '#e6e8ef';
          ctx.fillText(`/${String(block.strobe)}`, x0 + 4, bottom - 3);
        }
      }
      // the spread: when each element starts (ticks), the last one's light (dashed) and the handle
      const knob = this.spreadKnob(canvas, effect, box);
      if (knob !== null) {
        const first = knob.blocks[0]!.start;
        ctx.fillStyle = 'rgba(255,214,90,0.75)';
        for (let k = 0; k < knob.m; k++) ctx.fillRect(Math.round(g.toX(first + spreadOf(box.beatSpread, box.beatValue, k, knob.m, null, false))), bottom - 5, 1.5, 5);
        ctx.strokeStyle = 'rgba(255,214,90,0.6)';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.2;
        knob.blocks.forEach((block, index) => {
          const moved = { ...block, start: block.start + knob.shift, end: block.end + knob.shift };
          ctx.beginPath();
          this.envelope(moved, index === 0 && !box.affectFirst ? 0 : knob.extra).forEach(([beat, level], at) => (at === 0 ? ctx.moveTo(g.toX(beat), y(level)) : ctx.lineTo(g.toX(beat), y(level))));
          ctx.stroke();
        });
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
      if (blocks.length === 0) {
        ctx.fillStyle = '#7d8394';
        ctx.fillText('Протяните по дорожке — новый блок света (кистью справа)', g.pad + 6, (top + bottom) / 2);
      }
    } else {
      // ring turns: a block each, until the next turn
      const turns = [...box.rotations].sort((a, b) => a.beat - b.beat);
      turns.forEach((event, index) => {
        const x0 = g.toX(event.beat);
        const x1 = g.toX(event.beat + turnLength(turns, index));
        const selected = event.id === this.eventId;
        const cy = (top + bottom) / 2;
        ctx.fillStyle = selected ? 'rgba(183,140,255,0.45)' : 'rgba(183,140,255,0.25)';
        ctx.fillRect(x0, top + 6, Math.max(3, x1 - x0 - 2), bottom - top - 12);
        ctx.strokeStyle = selected ? '#ffffff' : '#b78cff';
        ctx.lineWidth = selected ? 2 : 1.2;
        ctx.strokeRect(x0 + 0.5, top + 6.5, Math.max(3, x1 - x0 - 3), bottom - top - 13);
        // (drawn as the player sees it: Chroma's direction 0 — 'cw' here — turns them counterclockwise)
        const angle = (((event.angle + event.loops * 360) * Math.PI) / 180) * (event.direction === 'cw' ? -1 : 1);
        ctx.beginPath();
        ctx.arc(x0 + 14, cy, 9, 0, Math.PI * 2);
        ctx.moveTo(x0 + 14, cy);
        ctx.lineTo(x0 + 14 + Math.sin(angle) * 9, cy - Math.cos(angle) * 9);
        ctx.stroke();
        if (x1 - x0 > 46) {
          ctx.fillStyle = '#e6e0f5';
          ctx.fillText(`${event.direction === 'cw' ? '↺' : '↻'}${String(event.angle + event.loops * 360)}°`, x0 + 27, cy + 4);
          if (x1 - x0 > 110) ctx.fillText(EASINGS.find(([key]) => key === event.easing)?.[1] ?? '', x0 + 27, cy + 17);
        }
      });
    }
    this.laneCanvases.set(canvas, { image: ctx.getImageData(0, 0, canvas.width, canvas.height), effect });
  }

  private laneCanvases = new Map<HTMLCanvasElement, { image: ImageData; effect: Effect }>();

  /** The song's cursor over the boxes' lanes (drawn every frame over their pictures). */
  private drawLanePlayhead() {
    for (const [canvas, lane] of this.laneCanvases) {
      if (!canvas.isConnected) continue;
      const ctx = canvas.getContext('2d')!;
      ctx.putImageData(lane.image, 0, 0);
      const g = this.laneGeometry(canvas, lane.effect);
      const x = g.toX(this.editor.playhead() - lane.effect.start);
      if (x < 0 || x > g.width) continue;
      const ratio = window.devicePixelRatio || 1;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = '#ff4d6d';
      ctx.fillRect(x, 0, 1.5, g.height);
    }
  }

  private bindLane(canvas: HTMLCanvasElement, effect: Effect, box: GlsBox) {
    this.bindZoom(canvas, (x) => this.laneGeometry(canvas, this.effect() ?? effect).toBeat(x));
    canvas.addEventListener('gls-redraw', () => this.drawLane(canvas, this.effect() ?? effect, box));
    // (the mouse shows what a drag would do)
    canvas.addEventListener('mousemove', (event) => {
      if (event.buttons !== 0 || box.kind !== 'color') return;
      const rect = canvas.getBoundingClientRect();
      const zone = this.blockZone(this.laneGeometry(canvas, this.effect() ?? effect), box.blocks ?? [], { x: event.clientX - rect.left, y: event.clientY - rect.top });
      canvas.style.cursor = zone === null ? 'crosshair' : zone.zone === 'move' ? 'grab' : zone.zone === 'start' || zone.zone === 'end' ? 'ew-resize' : 'ns-resize';
    });
    this.middlePan(canvas);
    // (a lane of another box: that box picked first — and drawn so)
    canvas.addEventListener('mousedown', () => {
      if (this.boxId === box.id) return;
      this.boxId = box.id;
      this.eventId = null;
      for (const row of this.shade?.querySelectorAll('.gls-lane-row') ?? []) row.classList.toggle('active', row.contains(canvas));
    });
    const local = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const grid = () => (this.editor.snap > 0 ? this.editor.snap : 0);
    const snap = (beat: number) => {
      const step = grid();
      return Math.max(0, step > 0 ? Math.round(beat / step) * step : beat);
    };
    /** Something dragged on the lane: moved on screen, one undo step when let go. */
    const drag = (onMove: (at: { x: number; y: number }) => void, onDone: (moved: boolean) => void, startX: number) => {
      let moved = false;
      const move = (event: MouseEvent) => {
        const at = local(event);
        if (!moved && Math.abs(at.x - startX) < 4) return;
        moved = true;
        onMove(at);
        this.drawLane(canvas, effect, box);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener(
        'mouseup',
        () => {
          window.removeEventListener('mousemove', move);
          onDone(moved);
        },
        { once: true },
      );
    };
    canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const g = this.laneGeometry(canvas, effect);
      const point = local(event);
      const { x } = point;
      // the spread handle: dragged — sideways the time spread, up and down the brightness spread
      const knob = this.spreadKnob(canvas, effect, box);
      // (a block's corner or top right there wins, unless the handle is right under the mouse)
      const under = box.kind === 'color' ? this.blockZone(g, box.blocks ?? [], point) : null;
      const onKnob = knob === null ? Infinity : Math.hypot(point.x - knob.x, point.y - knob.y);
      if (knob !== null && onKnob <= 9 && (under === null || under.zone === 'move' || onKnob <= 4)) {
        const scale = this.laneScale(g.height);
        const original = { beatValue: box.beatValue, value: box.value };
        const step = this.editor.snap > 0 ? this.editor.snap : 1 / 16;
        drag(
          (at) => {
            const shift = Math.max(0, g.toBeat(at.x) - knob.base.start);
            const extra = Math.round((scale.level(at.y) - knob.base.color.brightness) * 20) / 20;
            // (wave: the last of m is at (m − 1)/m of it; step: (m − 1) steps — the value itself on
            // the grid; the brightness the same way)
            const raw = box.beatSpread === 'wave' ? (shift * knob.m) / (knob.m - 1) : shift / (knob.m - 1);
            box.beatValue = Math.max(0, Math.round(raw / step) * step);
            box.value = box.valueSpread === 'wave' ? extra : extra / (knob.m - 1);
          },
          (moved) => {
            const next = { beatValue: Math.round(box.beatValue * 10000) / 10000, value: Math.round(box.value * 1000) / 1000 };
            Object.assign(box, original);
            if (!moved || (next.beatValue === original.beatValue && next.value === original.value)) return;
            this.changeBox((item) => Object.assign(item, next));
          },
          x,
        );
        return;
      }
      const beat = g.toBeat(x);
      if (box.kind === 'color') {
        const blocks = box.blocks ?? [];
        // what of a block is under the mouse: its top corners (brightness at its start, at its end),
        // its top (all its brightness), its sides (stretch), its body (move) — the picked one first
        const zone = this.blockZone(g, blocks, point);
        if (zone !== null) {
          const hit = zone.block;
          this.eventId = hit.id;
          const original = structuredClone(hit);
          const grab = beat - hit.start;
          const scale = this.laneScale(g.height);
          const startLevel = scale.level(point.y);
          const level = (y: number) => Math.round(Math.min(1.5, Math.max(0, scale.level(y))) * 20) / 20;
          // (the 3D view shows the block at that moment)
          if (this.editor.previewExtra === null && !this.editor.isPlaying()) this.editor.seek(effect.start + hit.start + 0.02);
          this.drawLane(canvas, effect, box);
          const vertical = zone.zone === 'startLevel' || zone.zone === 'endLevel' || zone.zone === 'level';
          let moved = false;
          const move = (next: MouseEvent) => {
            const at = local(next);
            if (!moved && Math.abs(at.x - x) < 4 && Math.abs(at.y - point.y) < 4) return;
            moved = true;
            const to = g.toBeat(at.x);
            const length = original.end - original.start;
            const min = grid() > 0 ? grid() : 1 / 64;
            if (zone.zone === 'move') {
              hit.start = snap(to - grab);
              hit.end = hit.start + length;
            } else if (zone.zone === 'start') hit.start = Math.min(original.end - min, snap(to));
            else if (zone.zone === 'end') hit.end = Math.max(original.start + min, snap(to));
            else if (zone.zone === 'startLevel') {
              // (a ramp: the end keeps its brightness)
              hit.endColor = original.endColor ?? { ...original.color };
              hit.color = { ...original.color, brightness: level(at.y) };
            } else if (zone.zone === 'endLevel') hit.endColor = { ...(original.endColor ?? original.color), brightness: level(at.y) };
            else {
              const delta = Math.round((scale.level(at.y) - startLevel) * 20) / 20;
              hit.color = { ...original.color, brightness: Math.min(1.5, Math.max(0, original.color.brightness + delta)) };
              if (original.endColor !== null) hit.endColor = { ...original.endColor, brightness: Math.min(1.5, Math.max(0, original.endColor.brightness + delta)) };
            }
            this.drawLane(canvas, effect, box);
          };
          window.addEventListener('mousemove', move);
          window.addEventListener(
            'mouseup',
            () => {
              window.removeEventListener('mousemove', move);
              const next = structuredClone(hit);
              Object.assign(hit, original);
              if (!moved) {
                this.render();
                return;
              }
              next.start = Math.round(next.start * 1e6) / 1e6;
              next.end = Math.round(next.end * 1e6) / 1e6;
              this.changeBox((item) => {
                const block = item.blocks?.find((entry) => entry.id === hit.id);
                if (block !== undefined) Object.assign(block, next);
              });
            },
            { once: true },
          );
          void vertical;
          return;
        }
        // empty lane: a new block, drawn by dragging (a click: a grid step long)
        const from = snap(beat);
        const made = this.brushBlock(from, from + (grid() > 0 ? grid() : 0.25));
        this.eventId = made.id;
        const live = [...blocks, made];
        box.blocks = live;
        this.drawLane(canvas, effect, box);
        drag(
          (at) => {
            const to = snap(g.toBeat(at.x));
            made.start = Math.min(from, to);
            made.end = Math.max(from, to, made.start + (grid() > 0 ? grid() : 1 / 64));
          },
          () => {
            box.blocks = blocks;
            const block = { ...made };
            this.changeBox((item) => (item.blocks = [...(item.blocks ?? []), block]));
          },
          x,
        );
        return;
      }
      // ring turns: blocks — the body moves, the right end sets how long the turn takes; on an empty
      // spot a drag puts a new one in (as long as dragged)
      const turns = [...box.rotations].sort((a, b) => a.beat - b.beat);
      const span = (index: number) => [turns[index]!.beat, turns[index]!.beat + turnLength(turns, index)] as const;
      const found = turns.map((item, index) => ({ item, index })).find(({ index }) => {
        const [from, to] = span(index);
        return x >= g.toX(from) - 4 && x <= g.toX(to) + 4;
      });
      if (found !== undefined) {
        const { item, index } = found;
        const [from, to] = span(index);
        const resize = Math.abs(g.toX(to) - x) <= 6;
        this.eventId = item.id;
        const original = { beat: item.beat, duration: item.duration };
        const grab = beat - from;
        if (this.editor.previewExtra === null && !this.editor.isPlaying()) this.editor.seek(effect.start + item.beat + 0.02);
        this.drawLane(canvas, effect, box);
        drag(
          (at) => {
            const there = g.toBeat(at.x);
            if (resize) item.duration = Math.max(grid() > 0 ? grid() : 1 / 16, snap(there) - item.beat);
            else item.beat = Math.min(Math.max(g.length, g.to), snap(there - grab));
          },
          (moved) => {
            const next = { beat: item.beat, duration: item.duration };
            item.beat = original.beat;
            if (original.duration === undefined) delete item.duration;
            else item.duration = original.duration;
            if (!moved) {
              this.render();
              return;
            }
            this.changeBox((target) => {
              const entry = target.rotations.find((value) => value.id === item.id);
              if (entry === undefined) return;
              entry.beat = next.beat;
              if (next.duration !== undefined) entry.duration = next.duration;
            });
          },
          x,
        );
        return;
      }
      const startBeat = Math.min(Math.max(g.length, g.to), snap(beat));
      const id = newId('v');
      const made: GlsRotationEvent = { id, beat: startBeat, angle: 90, loops: 0, direction: 'cw', easing: 'outQuad' };
      const turnsBefore = box.rotations;
      box.rotations = [...turnsBefore, made];
      this.eventId = id;
      this.drawLane(canvas, effect, box);
      drag(
        (at) => {
          const there = snap(g.toBeat(at.x));
          if (there > startBeat) made.duration = there - startBeat;
        },
        () => {
          box.rotations = turnsBefore;
          const turn = { ...made };
          this.changeBox((item) => item.rotations.push(turn));
        },
        x,
      );
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
    this.middlePan(canvas, 104);
    // a click (and a drag): the song there (the 3D view shows that moment)
    canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const seek = (clientX: number) => {
        const current = this.effect() ?? effect;
        const { from, to } = this.shown(current);
        const x = clientX - canvas.getBoundingClientRect().left;
        const beat = from + ((x - 96) / Math.max(1, canvas.clientWidth - 96 - 8)) * (to - from);
        this.editor.seek(Math.max(0, current.start + Math.max(0, beat)));
      };
      seek(event.clientX);
      const move = (next: MouseEvent) => seek(next.clientX);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', () => window.removeEventListener('mousemove', move), { once: true });
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
    // (every group of the block, one after another: as the block's events number their elements)
    const lanes = this.lanes(effect).map((lane) => this.editor.effectItemsOf(lane.target));
    const items = lanes.flat();
    const starts = new Set<number>();
    let at = 0;
    for (const lane of lanes) {
      if (at > 0) starts.add(at);
      at += lane.length;
    }
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
    // (where the next group begins: a line across)
    ctx.fillStyle = 'rgba(140,180,255,0.45)';
    for (const index of starts) ctx.fillRect(0, 2 + index * rowH - 1, width, 1.5);
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

/** How long a ring turn lasts on the lane: its own length, or until the next turn (at most 2 beats). */
function turnLength(turns: GlsRotationEvent[], index: number) {
  const turn = turns[index]!;
  return turn.duration ?? Math.max(0.25, Math.min(2, (turns[index + 1]?.beat ?? turn.beat + 2) - turn.beat));
}

/** A copy of a box (its own ids; unlinked). */
function copyBox(box: GlsBox): GlsBox {
  const copy: GlsBox = { ...structuredClone(box), id: newId('b') };
  delete copy.link;
  copy.events = copy.events.map((event) => ({ ...event, id: newId('v') }));
  if (copy.blocks !== undefined) copy.blocks = copy.blocks.map((block) => ({ ...block, id: newId('v') }));
  copy.rotations = copy.rotations.map((event) => ({ ...event, id: newId('v') }));
  return copy;
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
/** The strip's view of one block taken over by another (the poses and the zoom at the same place:
 *  switching between them keeps the zoom of the strip). */
export function shareStripView(from: string, to: string) {
  const view = stripViews.get(from);
  if (view !== undefined) stripViews.set(to, { ...view });
  else stripViews.delete(to);
}

/** The song's speed: a small slider with its % (a double click — the usual), kept up to date. */
export function speedControl(editor: Editor): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'speed-control';
  const speed = document.createElement('input');
  speed.type = 'range';
  speed.className = 'scrub-speed';
  speed.min = '0.1';
  speed.max = '2';
  speed.step = '0.05';
  speed.value = String(editor.rate);
  speed.title = 'Скорость воспроизведения. Двойной клик — обычная';
  const value = Object.assign(document.createElement('span'), { className: 'scrub-speed-value', textContent: `${String(Math.round(editor.rate * 100))}%` });
  speed.addEventListener('mousedown', (event) => event.stopPropagation());
  speed.addEventListener('input', () => editor.setRate(Number(speed.value)));
  speed.addEventListener('dblclick', () => editor.setRate(1));
  // (changed elsewhere — the timeline, the − / + keys: shown here too)
  const sync = () => {
    if (!wrap.isConnected) return;
    if (document.activeElement !== speed && Number(speed.value) !== editor.rate) speed.value = String(editor.rate);
    value.textContent = `${String(Math.round(editor.rate * 100))}%`;
    requestAnimationFrame(sync);
  };
  requestAnimationFrame(sync);
  wrap.append(speed, value);
  return wrap;
}

export function scrubStrip(editor: Editor, range: () => { id?: string; start: number; end: number } | null, lane: StripLane | null = null, withSpeed = true) {
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
  // the song's speed (as under the timeline's spectrogram) — on the strip, unless the window has it
  // in its own head
  if (withSpeed) controls.prepend(speedControl(editor));
  wrap.append(controls);

  const draw = () => {
    if (!canvas.isConnected) {
      // (the window closed while its block played: stopped)
      if (playing !== null && editor.previewExtra === playing) editor.stopTrial();
      return;
    }
    requestAnimationFrame(draw);
    const playButton = controls.querySelector<HTMLButtonElement>('button');
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
    const key = `${String(width)} ${String(height)} ${String(beat)} ${JSON.stringify(view)} ${editor.spectrogram === null ? '' : 's'} ${lane?.key() ?? ''} ${String(editor.snap)}`;
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
    if (lane !== null) {
      // the grid poses snap to (Alt+wheel), where its lines aren't too close
      const grid = editor.snap;
      if (grid > 0 && (grid * width) / (view.to - view.from) >= 5) {
        ctx.fillStyle = 'rgba(140,170,255,0.13)';
        for (let at = Math.max(view.block.start, Math.ceil((view.from - view.block.start) / grid) * grid + view.block.start); at <= Math.min(view.to, view.block.end) + 1e-9; at += grid) ctx.fillRect(Math.round(x(at)), SONG, 1, height - SONG);
      }
      lane.draw(ctx, x, SONG, height - SONG, width);
      ctx.fillStyle = 'rgba(214,217,228,0.55)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`сетка ${GRIDS.find(([value]) => Math.abs(value - grid) < 1e-9)?.[1] ?? beatsLabel(grid)}`, 6, height - 6);
    }
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
    // the middle button: the view dragged along the song
    if (event.button === 1) {
      const view = span();
      if (view === null) return;
      const grab = event.clientX;
      const pan = (next: MouseEvent) => {
        const shift = ((grab - next.clientX) / Math.max(1, rect.width)) * (view.to - view.from);
        setView(view.from + shift, view.to + shift);
      };
      const up = () => {
        window.removeEventListener('mousemove', pan);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', pan);
      window.addEventListener('mouseup', up);
      return;
    }
    if (event.button !== 0) return;
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
  // (no browser autoscroll on a middle click)
  canvas.addEventListener('auxclick', (event) => event.preventDefault());
  let gridWheel = 0;
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const view = span();
      if (view === null) return;
      if (event.altKey) {
        // the grid a step finer or coarser (as on the timeline)
        gridWheel += event.deltaY;
        if (Math.abs(gridWheel) < 40) return;
        editor.snap = nextGrid(editor.snap, gridWheel < 0);
        gridWheel = 0;
        editor.setStatus(`Сетка: ${GRIDS.find(([value]) => Math.abs(value - editor.snap) < 1e-9)?.[1] ?? ''}`);
        editor.emit('selection');
        drawn = '';
        return;
      }
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
