import { BPM_EVENT_TYPE, type Editor } from './editor';
import { tr } from './i18n';
import { openColorPick, pickFromScreen } from './color-pick';
import { setGroupSync } from './presets';
import { otherEventName } from './names';
import { ringSystemName } from './library';
import { laserDialog } from './laser-dialog';
import { holdWhileTyping, labeled, select, toggle } from './gls-editor';
import { isLasers, isZoom, type RingBlock, type RingSpin } from './rings';
import { RingEditor } from './ring-editor';
import { beatDrumStep, gridSelect, numberDrum, wheelSlider } from './grids';
import { resolveRgb, shiftHue } from './bake';
import type { SoundMode } from './sound-effect';
import { KIND_NAMES, mixColor, waveLength, waveSteps, type Direction, type Effect, type EffectParams, type FireShape, type StrobePattern } from './effects';
import { findGroup, groupLights, type ClipColor, type EndMode, type LightClip, type RawEvent, type Rgb, type StartMode } from './model';

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

/** How each start and end looks: the light's brightness over time (up: brighter). */
const MODE_ICONS: Record<string, string> = {
  'start:on': 'M2 14H9V5H28',
  'start:flash': 'M2 14H9V1.5Q11 5 15 5H28',
  'start:fade': 'M2 14H9V1.5Q14 13 28 13.5',
  'start:fadeIn': 'M2 14L21 5H28',
  'end:off': 'M2 5H20V14H28',
  'end:fade': 'M2 5H9L28 14',
  'end:stay': 'M2 5H24M21 2L26 5L21 8',
};

function modeIcon(path: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 30 16');
  svg.setAttribute('class', 'mode-icon');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', path);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '1.8');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');
  const floor = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  floor.setAttribute('d', 'M2 15.2H28');
  floor.setAttribute('stroke', 'currentColor');
  floor.setAttribute('stroke-opacity', '0.25');
  svg.append(floor, line);
  return svg;
}

/** A colour's hue (degrees). */
function rgbHue([r, g, b]: Rgb) {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return 0;
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (hue * 60 + 360) % 360;
}

function toHex(rgb: Rgb) {
  return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}


export class Inspector {
  /** The settings of a pose picked on the timeline (the ring editor's, in this panel). */
  private readonly poses: RingEditor;

  constructor(private readonly editor: Editor, private readonly root: HTMLElement) {
    this.poses = new RingEditor(editor, false);
    editor.onChange((what) => {
      if (what !== 'time') this.render();
    });
    this.render();
  }

  /** The values shown: the first selected clip's (or the brush). */
  private current(): { clips: LightClip[]; source: Omit<LightClip, 'id' | 'type' | 'ids' | 'start' | 'end'> & { start?: number; end?: number } } {
    // (a GLS block's block picked: it)
    const gls = this.editor.glsInspect?.block;
    if (gls !== undefined) return { clips: [], source: { ...gls.source, layer: 0 } };
    const clips = this.editor.selectedClips();
    const first = clips[0];
    if (first !== undefined) return { clips, source: first };
    const brush = this.editor.brush;
    return { clips, source: { ...brush, color: brush.color, endColor: brush.endColor, hsv: brush.hsv } };
  }

  private apply(change: (target: { startMode: StartMode; fadeIn: number; endMode: EndMode; fadeOut?: number; color: ClipColor; endColor: ClipColor | null; layer: number; hsv?: boolean }) => void) {
    const gls = this.editor.glsInspect?.block;
    if (gls !== undefined) {
      gls.apply((target) => change(target as Parameters<typeof change>[0]));
      return;
    }
    if (this.editor.selection.size > 0 && this.editor.selectedClips().length > 0) this.editor.updateSelected((clip) => change(clip));
    else {
      change(this.editor.brush);
      this.render();
    }
  }

  /** Which tab the rings' events show: Lumatic's own settings, or Chroma's numbers as they are. */
  private ringTab: 'game' | 'lumatic' | 'chroma' | null = null;
  private ringTabFor = '';

  /**
   * A ring event picked (one of Lumatic's — a pose, a spin, the lasers' move — or the Chroma / game's
   * own on a ring row): its settings in two tabs — Lumatic's, and Chroma's numbers written straight
   * (rotation, step, prop, speed…), Lumatic changing nothing. False: nothing of the kind picked.
   */
  private renderRingEvent(root: HTMLElement): boolean {
    const editor = this.editor;
    const pick = editor.posePick;
    const pickedBlock = pick === null ? undefined : editor.ringBlockById(pick.blockId);
    const pose = pick === null ? undefined : pickedBlock?.poses.find((item) => item.id === pick.poseId);
    const one = editor.selection.size === 1 ? editor.selectedRingBlocks()[0] : undefined;
    const block = pose !== undefined ? pickedBlock : one;
    const raw = (editor.project?.raw ?? []).filter((event) => editor.selection.has(event.id));
    const rawRing = block === undefined && raw.length > 0 && raw.length === editor.selection.size && raw.every((event) => event.type === raw[0]!.type && (event.type === 8 || event.type === 9));
    if (block === undefined && !rawRing) {
      // (picked again later: its own tab first again)
      this.ringTabFor = '';
      return false;
    }
    // (the game's own event: no Chroma numbers in it)
    const plain = block === undefined && raw.every((event) => event.customData === undefined || Object.keys(event.customData).length === 0);
    // (lasers have no plain event of the rings' kind: Lumatic and Chroma only)
    const gameTab = block === undefined || !isLasers(block);
    // (a new thing picked: its own tab first — the game's for the game's, Lumatic's for Lumatic's,
    // Chroma's for Chroma's)
    const key = block?.id ?? raw.map((event) => event.id).join(',');
    if (key !== this.ringTabFor) {
      this.ringTabFor = key;
      this.ringTab = block !== undefined ? 'lumatic' : plain ? 'game' : 'chroma';
    }
    if (this.ringTab === 'game' && !gameTab) this.ringTab = 'lumatic';
    const tabs = document.createElement('div');
    tabs.className = 'lib-tabs ring-tabs';
    for (const [value, label, hint] of [
      ...(gameTab ? ([['game', 'Игра', 'Обычное событие Beat Saber, без модов']] as const) : []),
      ['lumatic', 'Lumatic', 'Настройки Lumatic: поза, переход, движение'],
      ['chroma', 'Chroma', 'Числа события Chroma как есть: поворот, шаг, prop, скорость'],
    ] as const) {
      const tab = document.createElement('button');
      tab.textContent = label;
      tab.title = hint;
      tab.classList.toggle('active', this.ringTab === value);
      tab.addEventListener('click', () => {
        this.ringTab = value;
        this.render();
      });
      tabs.append(tab);
    }
    root.append(tabs);
    if (this.ringTab === 'game') {
      if (plain) {
        root.append(Object.assign(document.createElement('h3'), { textContent: tr('Обычное событие Beat Saber') }));
        return true;
      }
      root.append(this.note(block !== undefined ? tr('Событие Lumatic станет одним обычным событием Beat Saber на доле {0}: поза и переход пропадут.', round3(block.start)) : tr('Числа Chroma у события пропадут — останется обычное событие Beat Saber.')));
      const make = document.createElement('button');
      make.textContent = tr('Сделать обычным событием игры');
      make.addEventListener('click', () => editor.toGameEvents(block !== undefined ? [block.id] : raw.map((event) => event.id)));
      root.append(make);
      return true;
    }
    if (this.ringTab === 'lumatic') {
      if (block === undefined) {
        // a Chroma (or the game's) event: made one of Lumatic's — a pose and its move
        root.append(this.note(tr('Это событие Chroma (или самой игры): его числа — на вкладке Chroma. Его можно сделать событием Lumatic — позой с переходом, которую настраивает Lumatic.')));
        const make = document.createElement('button');
        make.textContent = tr('Сделать событием Lumatic');
        make.addEventListener('click', () => editor.rawToRingEvent(raw.map((event) => event.id)));
        root.append(make);
        return true;
      }
      if (pose !== undefined) this.poses.renderInto(root, block.id, pose.id, () => this.render());
      else if (block.spin !== undefined) this.spinPanel(root, block);
      else if (isLasers(block)) {
        root.append(Object.assign(document.createElement('h3'), { textContent: block.name }));
        root.append(this.note(tr('Вращающиеся лазеры: доли {0}–{1}. Длина — сколько крутятся (или сколько шагов): тяните конец полосы на таймлайне.', round3(block.start), round3(block.end))));
        const open = document.createElement('button');
        open.textContent = tr('✳ Настроить лазеры…');
        open.addEventListener('click', () => laserDialog(editor, block.id));
        root.append(open);
      } else {
        root.append(Object.assign(document.createElement('h3'), { textContent: block.name }));
        root.append(this.note(tr('Группа колец ({0} поз): кликните позу в ней на таймлайне — её настройки здесь. Двойной клик по группе — её окно.', block.poses.length)));
      }
      return true;
    }
    // Chroma's numbers
    if (block === undefined) {
      this.renderRaw(raw);
      return true;
    }
    const made = editor.poseEvents().filter((event) => event.group === block.id);
    root.append(this.note(tr('Lumatic пишет из этого события {0} событий Chroma. Чтобы править их числа напрямую, сделайте их обычными событиями Chroma — настройки Lumatic у них пропадут.', made.length)));
    const first = made[0];
    if (first !== undefined) {
      const list = document.createElement('div');
      list.className = 'ins-note ring-numbers';
      list.textContent = made
        .slice(0, 6)
        .map((event) => `${String(round3(event.beat))}: ${Object.entries(event.customData ?? {}).map(([name, value]) => `${name} ${String(value)}`).join(', ')}`)
        .join('\n') + (made.length > 6 ? '\n…' : '');
      root.append(list);
    }
    const convert = document.createElement('button');
    convert.textContent = tr('Сделать событиями Chroma');
    convert.addEventListener('click', () => editor.ringBlockToRaw(block.id));
    root.append(convert);
    return true;
  }

  /** A spin block's settings: how fast the rings turn and twist (or how the zoom goes), how they
   *  speed up and slow down. */
  private spinPanel(root: HTMLElement, block: RingBlock) {
    const editor = this.editor;
    const spin = block.spin!;
    const zoom = isZoom(block);
    const change = (patch: (value: RingSpin) => void) => editor.updateRingBlock(block.id, (item) => item.spin !== undefined && patch(item.spin), false);
    const beats = beatDrumStep(editor.snap);
    const panel = document.createElement('div');
    panel.className = 'gls-side-panel pose-side';
    const title = document.createElement('div');
    title.className = 'gls-side-title';
    title.textContent = `${zoom ? 'Постоянный зум' : 'Постоянное вращение'} — ${tr('доли {0}–{1}', round3(block.start), round3(block.end))}`;
    panel.append(title);
    const col = document.createElement('div');
    col.className = 'gls-col';
    if (zoom) {
      col.append(toggle<RingSpin['zoom']>([['breathe', 'Туда-обратно'], ['drift', 'В одну сторону']], spin.zoom, (value) => change((item) => (item.zoom = value))));
      if (spin.zoom === 'drift') col.append(labeled('Расстояние меняется на, за долю', numberDrum(`spin-rate:${block.id}`, spin.rate, (value) => change((item) => (item.rate = value)), { step: 0.05, min: -5, max: 5, digits: 3 })));
      else {
        col.append(labeled('До расстояния (и обратно)', numberDrum(`spin-to:${block.id}`, spin.to, (value) => change((item) => (item.to = value)), { step: 0.1, min: -20, max: 40, digits: 2 })));
        col.append(labeled('Туда и обратно за, долей', numberDrum(`spin-period:${block.id}:${String(beats)}`, spin.period, (value) => change((item) => (item.period = Math.max(beats, value))), { step: beats, min: beats, max: 64, beats: true })));
      }
      col.append(note(spin.zoom === 'drift' ? 'Расстояние между кольцами всё время растёт (или уменьшается — с минусом) с начала блока до конца.' : 'Расстояние ходит от того, что было до блока, к заданному и обратно, пока блок не кончится.'));
    } else {
      col.append(labeled('Вращение, ° за долю (− — в другую сторону)', numberDrum(`spin-speed:${block.id}`, spin.speed, (value) => change((item) => (item.speed = value)), { step: 5, min: -1440, max: 1440, digits: 2 })));
      col.append(labeled('Закручивание: шаг спирали растёт на, ° за долю', numberDrum(`spin-twist:${block.id}`, spin.twist, (value) => change((item) => (item.twist = value)), { step: 0.5, min: -90, max: 90, digits: 2 })));
      const systems = editor.ringInfo;
      if (systems.length > 1) col.append(labeled('Кольца', select<string>(systems.map((system) => [system.name, `${ringSystemName(system.name)} (${String(system.rings)})`]), block.system, (value) => editor.updateRingBlock(block.id, (item) => (item.system = value), false))));
    }
    col.append(labeled('Разгон, долей (0 — сразу)', numberDrum(`spin-in:${block.id}:${String(beats)}`, spin.rampIn, (value) => change((item) => (item.rampIn = Math.max(0, value))), { step: beats, min: 0, max: 32, beats: true })));
    col.append(labeled('Торможение, долей (0 — сразу)', numberDrum(`spin-out:${block.id}:${String(beats)}`, spin.rampOut, (value) => change((item) => (item.rampOut = Math.max(0, value))), { step: beats, min: 0, max: 32, beats: true })));
    col.append(note('Длина блока — сколько кольца двигаются: тяните его край на таймлайне. В игре это цепочка коротких событий колец, ~20 в секунду.'));
    panel.append(col);
    root.append(panel);
  }

  /** Drawn again, staying scrolled where it was — not while one of its fields is typed in (see
   *  holdWhileTyping). */
  render() {
    if (holdWhileTyping(this.root, () => this.render())) return;
    const scroll = this.root.scrollTop;
    this.draw();
    this.root.scrollTop = scroll;
  }

  private draw() {
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
    // the GLS editor's own (a ring turn)
    const gls = this.editor.glsInspect;
    if (gls?.render !== undefined) {
      gls.render(root);
      return;
    }
    // the rings' events (a Lumatic event, a spin, the lasers' move, a Chroma one): two tabs
    if (this.renderRingEvent(root)) return;
    const effects = this.editor.selectedEffects();
    // (while a GLS block is edited with nothing of it picked: the brush its new blocks are drawn with)
    if (gls === null && effects.length > 0 && this.editor.selectedClips().length === 0) {
      this.renderEffects(effects);
      return;
    }
    const { clips, source } = this.current();
    const rawSelected = (this.editor.project?.raw ?? []).filter((event) => this.editor.selection.has(event.id));
    const title = document.createElement('h3');
    const block = gls?.block;
    title.textContent = block !== undefined ? 'Блок GLS' : clips.length > 0 ? (clips.length === 1 ? 'Событие света' : `Выбрано: ${String(clips.length)}`) : rawSelected.length > 0 ? 'Другие события' : 'Кисть (новые события)';
    root.append(title);
    if (block === undefined && clips.length === 0 && rawSelected.length > 0) {
      this.renderRaw(rawSelected as RawEvent[]);
      return;
    }

    root.append(this.section('Начало', this.buttons(START_MODES, source.startMode, (mode) => this.apply((target) => (target.startMode = mode)))));
    if (source.startMode === 'fadeIn') {
      root.append(this.numberField('Нарастание, долей', source.fadeIn, 0.0625, (value) => this.apply((target) => (target.fadeIn = Math.max(0.01, value)))));
    }
    root.append(this.section('Конец', this.buttons(END_MODES, source.endMode, (mode) => this.apply((target) => (target.endMode = mode)))));
    if (source.endMode === 'fade') root.append(this.numberField('Затухание, долей (0 — всё событие)', source.fadeOut ?? 0, 0.0625, (value) => this.apply((target) => {
      if (value > 0) target.fadeOut = value;
      else delete target.fadeOut;
    })));
    root.append(this.section('Цвет', this.colorPicker(source.color, (color) => this.apply((target) => (target.color = color)), source.start ?? this.editor.playhead())));
    const gradient = document.createElement('label');
    gradient.className = 'ins-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = source.endColor !== null;
    box.addEventListener('change', () => this.apply((target) => (target.endColor = box.checked ? { ...target.color, ref: target.color.ref === 'left' ? 'right' : 'left' } : null)));
    gradient.append(box, ' Градиент к концу');
    root.append(gradient);
    if (source.endColor !== null) {
      root.append(this.section('Цвет в конце', this.colorPicker(source.endColor, (color) => this.apply((target) => (target.endColor = color)), source.end ?? this.editor.playhead())));
      const hsv = document.createElement('label');
      hsv.className = 'ins-check';
      const hsvBox = document.createElement('input');
      hsvBox.type = 'checkbox';
      hsvBox.checked = source.hsv === true;
      hsvBox.addEventListener('change', () => this.apply((target) => (target.hsv = hsvBox.checked)));
      hsv.append(hsvBox, ' Через оттенки (HSV)');
      root.append(hsv);
    }
    if (block !== undefined) {
      // a GLS block's block: its strobe, where it is, and away with it
      const strobes: [string, string, string][] = [0, 1, 2, 4, 8, 16, 32].map((value) => [String(value), value === 0 ? 'Нет' : String(value), value === 0 ? 'Без строба' : `${String(value)} вспышек в долю`]);
      root.append(this.section('Строб', this.buttons(strobes, String(block.source.strobe), (value) => block.apply((target) => (target.strobe = Number(value))))));
      if (block.source.strobe > 0) {
        const source = block.source;
        root.append(this.drumField('Скважность, % (горит)', Math.round((source.strobeDuty ?? 0.5) * 100), 5, { min: 5 }, (value) => block.apply((target) => (target.strobeDuty = Math.min(95, Math.max(5, value)) / 100))));
        const withs: ['dark' | 'color' | 'dim', string, string][] = [
          ['dark', 'Темнота', 'Между вспышками свет гаснет'],
          ['color', 'Второй цвет', 'Между вспышками — второй цвет'],
          ['dim', 'Тусклее', 'Между вспышками тот же свет, но тусклее'],
        ];
        root.append(this.section('Чередуется с', this.buttons(withs, source.strobeWith ?? 'dark', (value) => block.apply((target) => {
          target.strobeWith = value;
          if (value === 'color' && target.strobeColor === undefined) target.strobeColor = { ...target.color, ref: target.color.ref === 'left' ? 'right' : 'left' };
        }))));
        if ((source.strobeWith ?? 'dark') === 'color') root.append(this.section('Второй цвет', this.colorPicker(source.strobeColor ?? source.color, (color) => block.apply((target) => (target.strobeColor = color)), source.start)));
        if (source.strobeWith === 'dim') root.append(this.drumField('Между вспышками, % яркости', Math.round((source.strobeDim ?? 0.3) * 100), 5, { min: 0 }, (value) => block.apply((target) => (target.strobeDim = Math.min(100, Math.max(0, value)) / 100))));
        const tip = document.createElement('div');
        tip.className = 'ins-note';
        tip.textContent = 'С градиентом к концу вспышки идут по нему: цвет и яркость меняются к концу блока.';
        root.append(tip);
      }
      root.append(
        this.numberField('Начало, доля блока', block.source.start, this.editor.snap || 0.25, (value) => block.apply((target) => (target.start = Math.max(0, Math.min(value, target.end - 1 / 64))))),
        this.numberField('Конец, доля блока', block.source.end, this.editor.snap || 0.25, (value) => block.apply((target) => (target.end = Math.max(value, target.start + 1 / 64)))),
      );
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '🗑 Удалить блок';
      remove.title = 'Delete';
      remove.addEventListener('click', () => block.remove());
      root.append(remove);
      return;
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
      note.textContent = 'Протяните по строке таймлайна, чтобы нарисовать событие. Shift — выделение рамкой, Alt — копия при перетаскивании, ПКМ по событию — меню (цвет, зеркало, группа, копия, удалить). Shift+протянуть по линейке — участок песни, B — метка. Колесо — по времени, Shift+колесо или колесо над названиями — по строкам, Alt+колесо — сетка, Ctrl+колесо — масштаб.';
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
    if (effects.some((item) => item.custom === true && item.kind !== 'group')) {
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

    // a group of events: nothing to set — its events are what they are
    if (effects.every((item) => item.kind === 'group')) {
      const note = document.createElement('div');
      note.className = 'ins-note';
      const clips = effects.reduce((sum, item) => sum + editor.effectChildren(item.id).length, 0);
      const raw = effects.reduce((sum, item) => sum + editor.effectRaw(item.id).length, 0);
      note.textContent = tr('Группа событий: {0} событий света{1}. «Войти» — править их по одному, «Разобрать» — снова отдельные события; тянется и двигается целиком, как эффект.', clips, raw > 0 ? ' ' + tr('и {0} других', raw) : '');
      root.append(note);
      // a copy of a map's preset: changed with its other copies — or let go of them
      if (effects.length === 1 && effect.preset !== undefined) {
        const preset = (editor.mapPresets() as { id: string; name: string }[]).find((item) => item.id === effect.preset);
        if (preset !== undefined) {
          const copies = editor.effects.filter((item) => item.preset === effect.preset && item.presetSync === true).length;
          const synced = effect.presetSync === true;
          const line = document.createElement('div');
          line.className = 'ins-note';
          line.textContent = synced ? tr('Копия пресета «{0}»: меняется вместе с остальными копиями ({1} всего).', preset.name, copies) : tr('Сделана из пресета «{0}», но меняется отдельно.', preset.name);
          const toggleSync = document.createElement('button');
          toggleSync.textContent = synced ? tr('Отвязать от пресета') : tr('Снова как пресет');
          toggleSync.title = synced ? tr('Эта копия будет меняться отдельно; её события останутся как есть') : tr('События станут как в пресете, и копия снова будет меняться вместе с остальными');
          toggleSync.addEventListener('click', () => setGroupSync(editor, effect, !synced));
          root.append(line, toggleSync);
        }
      }
      return;
    }

    if (effects.every((item) => item.kind === 'gls')) {
      root.append(this.drumField('Слой', effect.layer, 1, (value) => editor.updateEffects((item) => (item.layer = Math.max(0, Math.round(value))))));
      const boxes = effect.gls?.boxes ?? [];
      const note = document.createElement('div');
      note.className = 'ins-note';
      note.textContent = `Коробок: ${String(boxes.length)} (света ${String(boxes.filter((box) => box.kind === 'color').length)}, вращения ${String(boxes.filter((box) => box.kind === 'rotation').length)}). Событий света: ${String(editor.effectChildren(effect.id).length)}, событий колец: ${String(editor.effectRaw(effect.id).length)}.`;
      root.append(note);
      return;
    }
    // the colour(s)
    root.append(this.section('Цвет', this.colorPicker(p.color, (color) => change((params) => (params.color = color)), effect.start)));
    const secondLabel = effect.kind === 'strobe' ? ' Чередовать со вторым цветом' : effect.kind === 'twinkle' ? ' Случайные цвета до второго' : effect.kind === 'fire' ? ' Пламя колеблется до второго цвета' : effect.kind === 'sound' ? ' Второй цвет (громко или по элементам)' : ' Градиент по элементам';
    const second = this.check(secondLabel, p.color2 !== null, (on) => change((params) => (params.color2 = on ? { ...params.color, ref: params.color.ref === 'left' ? 'right' : 'left', rgb: undefined } : null)));
    root.append(second);
    if (p.color2 !== null) {
      root.append(this.section('Второй цвет', this.colorPicker(p.color2, (color) => change((params) => (params.color2 = color)), effect.start)));
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
      // (the next item after a set time: the effect as long as its passes take)
      const fit = (params: EffectParams, item: Effect) => {
        if ((params.spacing ?? 0) > 0) item.end = item.start + waveLength(params, waveSteps(editor.effectItemsOf(item).length, params.direction));
      };
      const wave = (patch: (params: EffectParams) => void) =>
        change((params, item) => {
          patch(params);
          fit(params, item);
        });
      root.append(this.section('Каждая вспышка длится, долей', gridSelect(p.pulse, (value) => wave((params) => (params.pulse = value)), [2, 4, 8])));
      root.append(this.section('Следующая лампа через, долей', gridSelect(p.spacing ?? 0, (value) => wave((params) => (params.spacing = value)), [2, 4], 'весь эффект')));
      root.append(this.drumField('Сколько раз пройти', p.repeats, 1, { min: 1 }, (value) => wave((params) => (params.repeats = Math.max(1, Math.round(value))))));
      if ((p.spacing ?? 0) > 0) root.append(this.note('Длина эффекта считается сама: (ламп − 1) × шаг + вспышка, на каждый проход. Растянете эффект на таймлайне — добавятся проходы.'));
    }
    if (effect.kind === 'fill') root.append(this.drumField('Время заполнения, долей', p.pulse, 0.25, (value) => change((params) => (params.pulse = Math.max(0, value)))));
    if (effect.kind === 'strobe' || effect.kind === 'twinkle') {
      root.append(this.section('Вспышка каждые, долей', gridSelect(p.rate, (value) => change((params) => (params.rate = value)), [2, 4])));
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
    if (effect.kind === 'fire') {
      const shapes: [FireShape, string, string][] = [
        ['rise', 'Разгорается', 'Медленно нарастает'],
        ['steady', 'Горит', 'Ровно, только дрожит'],
        ['fall', 'Догорает', 'Медленно затухает'],
      ];
      root.append(this.section('Огонёк', this.buttons(shapes, p.shape ?? 'steady', (value) => change((params) => (params.shape = value)))));
      if ((p.shape ?? 'steady') !== 'steady') root.append(this.slider(p.shape === 'rise' ? 'С какой яркости' : 'До какой яркости', p.floor ?? 0.15, 0, 1, 0.05, (value) => change((params) => (params.floor = value))));
      const wobbles: [string, string, string][] = [
        ['flame', 'Пламя', 'Дрожит вразнобой, как огонь'],
        ['vibrato', 'Вибрато', 'Качается ровно, как вибрато в музыке: тише и обратно, раз за разом'],
      ];
      const vibrato = p.wobble === 'vibrato';
      root.append(
        this.section(
          'Как дрожит',
          this.buttons(wobbles, vibrato ? 'vibrato' : 'flame', (value) =>
            change((params) => {
              params.wobble = value === 'vibrato' ? 'vibrato' : 'flame';
              // (a vibrato comes on and goes off as waves, unless that's been turned off)
              if (params.wobble === 'vibrato' && params.vibratoIn === undefined && params.vibratoOut === undefined) {
                params.vibratoIn = 1;
                params.vibratoOut = 1;
              }
            }),
          ),
        ),
      );
      root.append(this.slider(vibrato ? 'Глубина вибрато' : 'Дрожание', p.tremor ?? 0.3, 0, 1, 0.05, (value) => change((params) => (params.tremor = value))));
      root.append(this.section(vibrato ? 'Одно качание, долей' : 'Дрожит каждые, долей', gridSelect(p.rate, (value) => change((params) => (params.rate = value)), vibrato ? [2, 4] : [], null, vibrato ? 'vibrato' : 'flame')));
      if (vibrato) {
        // (each next lamp's dip later by this share of a sway: the dips run over the lamps as a ripple)
        const lag = this.slider('Сдвиг качания у соседних ламп', p.vibratoLag ?? 0, 0, 1, 0.05, (value) => change((params) => (params.vibratoLag = value)));
        lag.title = 'Насколько позже (в долях одного качания) качается каждая следующая лампа: 0 — все разом, 0,5 — соседние в противофазе';
        root.append(lag);
        root.append(this.drumField('Оттенок качается на, °', p.vibratoHue ?? 0, 5, (value) => change((params) => (params.vibratoHue = value))));
        // coming on and going off as waves, each a sway long (the effect made longer if they don't fit)
        const waveIn = (p.vibratoIn ?? 0) > 0;
        const waveOut = (p.vibratoOut ?? 0) > 0;
        root.append(this.check(' Вход волной', waveIn, (on) => change((params) => (params.vibratoIn = on ? 1 : 0))));
        root.append(this.check(' Выход волной', waveOut, (on) => change((params) => (params.vibratoOut = on ? 1 : 0))));
        if (waveIn || waveOut) {
          root.append(this.section('Направление волны', this.buttons(directions.filter(([key]) => key !== 'pingpong'), p.direction === 'pingpong' ? 'forward' : p.direction, (value) => change((params) => (params.direction = value)))));
          const coloured = p.vibratoWaveColor != null;
          root.append(this.check(' Волны своим цветом', coloured, (on) => change((params) => (params.vibratoWaveColor = on ? { ref: params.color.ref === 'left' ? 'right' : 'left', brightness: params.color.brightness } : null))));
          if (coloured) root.append(this.section('Цвет волн', this.colorPicker(p.vibratoWaveColor!, (color) => change((params) => (params.vibratoWaveColor = color)), effect.start)));
          // (whole phrases, each translated as it is)
          const parts = [tr('Вход и выход длятся по одному качанию.')];
          if (coloured) parts.push(tr('Лампы загораются цветом волн и за качание перекрашиваются в цвет эффекта; в конце за качание перекрашиваются обратно.'));
          if (waveOut) parts.push(p.endMode === 'fade' ? tr('После выхода — затухание за качание.') : tr('Чтобы после выхода было затухание, выберите «Конец вспышки: Затухание».'));
          root.append(this.note(parts.join(' ')));
        }
      }
      const together: [string, string, string][] = [
        ['each', 'Каждая сама', 'У каждой лампы (элемента) своё дрожание'],
        ['all', 'Все вместе', 'Все дрожат одинаково'],
      ];
      root.append(this.section('Лампы', this.buttons(together, p.pattern === 'all' ? 'all' : 'each', (value) => change((params) => (params.pattern = value === 'all' ? 'all' : 'alternate')))));
      if (!vibrato) {
        const reroll = document.createElement('button');
        reroll.textContent = '🎲 Другое дрожание';
        reroll.addEventListener('click', () => change((params) => (params.seed = Math.floor(Math.random() * 1e6))));
        root.append(reroll);
      }
    }
    if (effect.kind === 'sound') {
      // following the song: what it shows, how loud counts, which frequencies, how it settles
      const modes: [SoundMode, string, string][] = [
        ['eq', 'Эквалайзер', 'Первые лампы — низкие частоты, последние — высокие; яркость — их громкость'],
        ['meter', 'Индикатор', 'Чем громче, тем больше ламп горит'],
        ['level', 'По громкости', 'Все лампы — по громкости (с задержкой — волна)'],
      ];
      const mode = p.soundMode ?? 'eq';
      root.append(this.section('По звуку', this.buttons(modes, mode, (value) => change((params) => (params.soundMode = value)))));
      // (as a wave's: where the low frequencies, the meter's bottom, the first lamp are)
      const along = mode === 'eq' ? 'Направление частот (от низких к высоким)' : mode === 'meter' ? 'Откуда заполняется' : 'Направление задержки';
      root.append(this.section(along, this.buttons(directions.filter(([key]) => key !== 'pingpong'), p.direction === 'pingpong' ? 'forward' : p.direction, (value) => change((params) => (params.direction = value)))));
      if (p.color2 !== null) {
        const by: ['level' | 'item', string, string][] = [
          ['level', 'По громкости', 'Тихо — первый цвет, громко — второй'],
          ['item', 'По элементам', 'Первые лампы — первый цвет, последние — второй'],
        ];
        root.append(this.section('Второй цвет', this.buttons(by, p.soundColorBy ?? 'level', (value) => change((params) => (params.soundColorBy = value)))));
      }
      root.append(this.slider('Чувствительность', p.gain ?? 1, 0.25, 4, 0.05, (value) => change((params) => (params.gain = value))));
      root.append(this.drumField('Частоты от, Гц', p.lowHz ?? 40, 10, { min: 20 }, (value) => change((params) => (params.lowHz = Math.max(20, Math.min((params.highHz ?? 12000) - 10, value))))));
      root.append(this.drumField('Частоты до, Гц', p.highHz ?? 12000, 100, { min: 100 }, (value) => change((params) => (params.highHz = Math.max((params.lowHz ?? 40) + 10, Math.min(16000, value))))));
      root.append(this.section('Точка каждые, долей', gridSelect(p.soundStep ?? 1 / 8, (value) => change((params) => (params.soundStep = value)), [8, 16])));
      root.append(this.drumField('Затухает за, долей', p.release ?? 0.5, 0.125, { min: 0 }, (value) => change((params) => (params.release = Math.max(0, value)))));
      if (mode === 'level') root.append(this.drumField('Следующая лампа позже на, долей (волна)', p.soundDelay ?? 0, 1 / 16, { min: 0 }, (value) => change((params) => (params.soundDelay = Math.max(0, value)))));
      if (mode === 'meter') {
        const falling = (p.peakFall ?? 0) > 0;
        root.append(this.check(' Падающая верхняя лампа', falling, (on) => change((params) => (params.peakFall = on ? 2 : 0))));
        if (falling) {
          root.append(this.drumField('Падает до низа за, долей', p.peakFall ?? 2, 0.25, { min: 0.25 }, (value) => change((params) => (params.peakFall = Math.max(0.25, value)))));
          const own = p.peakColor != null;
          root.append(this.check(' Своим цветом', own, (on) => change((params) => (params.peakColor = on ? { ref: 'white', brightness: params.color.brightness } : null))));
          if (own) root.append(this.section('Цвет верхней лампы', this.colorPicker(p.peakColor!, (color) => change((params) => (params.peakColor = color)), effect.start)));
        }
      }
      root.append(this.note(this.editor.spectrogram === null ? tr('Песня ещё разбирается — эффект появится, как только будет готова её спектрограмма.') : tr('Громкость считается по самой песне: громкие места эффекта — полная яркость, тихие — темнота; чувствительность больше — ярче.')));
    }
    if (effect.kind === 'twinkle') {
      root.append(this.slider('Доля ламп за раз', p.density, 0.05, 1, 0.05, (value) => change((params) => (params.density = value))));
      const reroll = document.createElement('button');
      reroll.textContent = '🎲 Другой узор';
      reroll.addEventListener('click', () => change((params) => (params.seed = Math.floor(Math.random() * 1e6))));
      root.append(reroll);
    }
    root.append(this.section('Начало вспышки', this.buttons(START_MODES, p.startMode, (mode) => change((params) => (params.startMode = mode)))));
    if (p.startMode === 'fadeIn') root.append(this.drumField('Нарастание, долей', p.fadeIn, 0.0625, (value) => change((params) => (params.fadeIn = Math.max(0.01, value)))));
    root.append(this.section('Конец вспышки', this.buttons(END_MODES, p.endMode, (mode) => change((params) => (params.endMode = mode)))));
    if (p.endMode === 'fade') root.append(this.drumField('Затухание, долей (0 — вся вспышка)', p.fadeOut ?? 0, 0.0625, (value) => change((params) => (params.fadeOut = Math.max(0, value)))));
    root.append(this.hueControls(effect, (patch) => change((params) => patch(params))));
    if ((p.hueStep ?? 0) !== 0) {
      const by: [string, string, string][] = [
        ['item', 'По элементам', 'Каждый следующий элемент группы — дальше по кругу оттенков'],
        ['time', 'По времени', 'Каждая следующая вспышка во времени — дальше по кругу оттенков'],
      ];
      root.append(this.section('Следующий — это', this.buttons(by, p.hueBy ?? 'item', (value) => change((params) => (params.hueBy = value === 'time' ? 'time' : 'item')))));
    }
    root.append(this.drumField('Слой', effect.layer, 1, (value) => editor.updateEffects((item) => {
      item.layer = Math.max(0, Math.round(value));
      for (const clip of editor.effectChildren(item.id)) clip.layer = item.layer;
    })));
    if (effects.length === 1) {
      root.append(
        this.drumField('Начало, доля', effect.start, editor.snap || 0.25, (value) => editor.updateEffects((item) => {
          const shift = value - item.start;
          item.start += shift;
          item.end += shift;
          for (const clip of editor.effectChildren(item.id)) {
            clip.start += shift;
            clip.end += shift;
          }
        })),
        this.drumField('Длина, долей', effect.end - effect.start, editor.snap || 0.25, (value) => editor.updateEffects((item) => (item.end = item.start + Math.max(0.0625, value)))),
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

  /** The other events picked (ring turns, zoom, laser speed, …): their value and what Chroma adds to
   *  them, changed for all of them at once. */
  private renderRaw(events: RawEvent[]) {
    const editor = this.editor;
    const first = events[0]!;
    const ids = events.map((event) => event.id);
    const type = events.every((event) => event.type === first.type) ? first.type : null;
    const get = (key: string): unknown => first.customData?.[key] ?? first.customData?.[`_${key}`];
    const set = (key: string, value: unknown) =>
      editor.updateRaw(ids, (event) => {
        const data = { ...(event.customData ?? {}) };
        delete data[key];
        delete data[`_${key}`];
        if (value !== undefined) data[key] = value;
        if (Object.keys(data).length > 0) event.customData = data;
        else delete event.customData;
      });
    const setValue = (value: number) => editor.updateRaw(ids, (event) => (event.value = Math.max(0, Math.round(value))));
    const info = document.createElement('div');
    info.className = 'ins-note';
    info.textContent = `${type === null ? 'Разные события' : otherEventName(type)} · ${events.length === 1 ? `доля ${String(Math.round(first.beat * 1000) / 1000)}` : `событий: ${String(events.length)}`}`;
    this.root.append(info);
    const direction = (): 'random' | '0' | '1' => {
      const value = get('direction');
      return value === 0 ? '0' : value === 1 ? '1' : 'random';
    };
    const directions: ['random' | '0' | '1', string, string][] = [
      ['random', 'Случайно', 'Как в игре: в случайную сторону'],
      ['0', 'Сторона 0', 'Chroma direction 0'],
      ['1', 'Сторона 1', 'Chroma direction 1 — в обратную'],
    ];
    const pickDirection = (value: 'random' | '0' | '1') => set('direction', value === 'random' ? undefined : Number(value));
    const note = (text: string) => this.root.append(Object.assign(document.createElement('div'), { className: 'ins-note', textContent: text }));

    if (type === BPM_EVENT_TYPE) {
      // a tempo change: the BPM from here on
      this.root.append(this.numberField('BPM с этого места', first.floatValue, 1, (value) => editor.updateRaw(ids, (event) => (event.floatValue = Math.min(2000, Math.max(1, Math.round(value * 1000) / 1000))))));
      note(tr('Песня в начале — {0} BPM. Сетка, время и спектрограмма идут по новому темпу с этой доли; в файл пишется как bpmEvents (v3) или событие 100 (v2).', Math.round(editor.songBpm * 1000) / 1000));
      return;
    }
    if (type === 12 || type === 13) {
      // laser speed: how fast, which way, from where (Chroma: lockRotation, speed, direction)
      const speed = typeof get('speed') === 'number' ? (get('speed') as number) : typeof get('preciseSpeed') === 'number' ? (get('preciseSpeed') as number) : first.value;
      this.root.append(
        this.numberField('Скорость (0 — стоп)', speed, 0.25, (value) => {
          const next = Math.max(0, value);
          editor.updateRaw(ids, (event) => {
            event.value = next === 0 ? 0 : Math.max(1, Math.round(next));
            const data = { ...(event.customData ?? {}) };
            for (const key of ['speed', '_speed', 'preciseSpeed', '_preciseSpeed']) delete data[key];
            // (a speed between whole ones: Chroma's precise speed)
            if (next > 0 && Math.abs(next - Math.round(next)) > 1e-6) data.speed = Math.round(next * 1000) / 1000;
            if (Object.keys(data).length > 0) event.customData = data;
            else delete event.customData;
          });
        }),
      );
      const locked = get('lockRotation') === true || get('lockPosition') === true;
      if (first.value > 0) {
        this.root.append(this.section('Направление', this.buttons(directions, direction(), pickDirection)));
        this.root.append(
          this.section(
            'Откуда',
            this.buttons(
              [
                ['random', 'Случайно', 'Как в игре: каждый лазер с исходного положения плюс случайный угол'],
                ['lock', 'С того же места', 'lockRotation: лазеры продолжают оттуда, где стоят — после «вернуть в исходное» идут ровным рядом'],
              ],
              locked ? 'lock' : 'random',
              (value) => set('lockRotation', value === 'lock' ? true : undefined),
            ),
          ),
        );
      } else {
        this.root.append(
          this.section(
            'Остановка',
            this.buttons(
              [
                ['reset', 'В исходное', 'Лазеры возвращаются в исходное положение (ряд, как задумано окружением)'],
                ['lock', 'Замереть', 'lockRotation: лазеры останавливаются там, где стоят'],
              ],
              locked ? 'lock' : 'reset',
              (value) => set('lockRotation', value === 'lock' ? true : undefined),
            ),
          ),
        );
      }
      note('Нужен Chroma. Ровный ряд, крутящийся в одну сторону: событие «стоп → в исходное», затем скорость «с того же места» и выбранной стороной. Готовые повороты на угол и кручение рядом — «✳ Лазеры…».');
      const tool = document.createElement('button');
      tool.textContent = '✳ Лазеры…';
      tool.addEventListener('click', () => laserDialog(editor));
      this.root.append(tool);
    } else if (type === 8) {
      // ring turns
      const number = (key: string) => (typeof get(key) === 'number' ? (get(key) as number) : null);
      const field = (label: string, key: string, fallback: number, step: number) => this.numberField(label, number(key) ?? fallback, step, (value) => set(key, value));
      this.root.append(field('Поворот, °', 'rotation', 90, 5), field('Шаг между кольцами, °', 'step', 5, 1), field('Распространение (prop)', 'prop', 1, 0.5), field('Скорость', 'speed', 1, 0.25));
      this.root.append(this.section('Направление', this.buttons(directions, direction(), pickDirection)));
      const systems = editor.ringInfo;
      if (systems.length > 1) {
        const current = typeof get('nameFilter') === 'string' ? (get('nameFilter') as string) : '';
        this.root.append(
          this.section(
            'Какие кольца',
            this.buttons<string>([['', 'Все', 'Все системы колец'], ...systems.map((system): [string, string, string] => [system.name, ringSystemName(system.name), system.name])], current, (value) => set('nameFilter', value === '' ? undefined : value)),
          ),
        );
      }
      // (the game turns a ring towards its angle at its speed, and starts only `prop` rings on it each
      // 1/50 s: both at 50 — every ring there in one tick, a jump)
      const instant = document.createElement('button');
      instant.textContent = '⚡ Мгновенно';
      instant.title = 'Скорость и распространение 50: все кольца встают на место за один кадр игры';
      instant.addEventListener('click', () => {
        set('speed', 50);
        set('prop', 50);
      });
      this.root.append(instant);
      note('Пустые поля — как в игре по умолчанию. Нужен Chroma для своих значений. Кольца встают на место мгновенно, только если и скорость, и распространение — 50 и больше: при распространении 1 кольца начинают поворот по одному.');
    } else if (type === 9) {
      const number = (key: string) => (typeof get(key) === 'number' ? (get(key) as number) : null);
      this.root.append(this.numberField('Расстояние между кольцами (step)', number('step') ?? 0, 0.5, (value) => set('step', value)), this.numberField('Скорость', number('speed') ?? 1, 0.25, (value) => set('speed', value)));
      note('Зум колец: Chroma step — расстояние, к которому кольца съезжаются или разъезжаются.');
    } else {
      this.root.append(this.numberField('Значение', first.value, 1, setValue), this.numberField('Float', first.floatValue, 0.1, (value) => editor.updateRaw(ids, (event) => (event.floatValue = value))));
    }
    if (Object.keys(first.customData ?? {}).length > 0) {
      const clear = document.createElement('button');
      clear.textContent = 'Убрать данные Chroma';
      clear.title = 'Событие станет обычным, как в игре без модов';
      clear.addEventListener('click', () => editor.updateRaw(ids, (event) => delete event.customData));
      this.root.append(clear);
    }
  }

  private note(text: string) {
    const note = document.createElement('div');
    note.className = 'ins-note';
    note.textContent = text;
    return note;
  }

  /** The effect's hue: turned round the circle, each next one further — sliders over the hues
   *  themselves, and the colours the first items (or flashes) come out with, as they're dragged. */
  private hueControls(effect: Effect, change: (patch: (params: EffectParams) => void) => void) {
    const p = effect.params;
    const box = document.createElement('div');
    box.className = 'ins-section ins-hue';
    const name = Object.assign(document.createElement('div'), { className: 'ins-label', textContent: 'Оттенок' });
    const preview = document.createElement('div');
    preview.className = 'ins-hue-preview';
    const scheme = this.editor.scheme();
    const count = Math.max(2, Math.min(12, effect.kind === 'strobe' || effect.kind === 'twinkle' || p.hueBy === 'time' ? 8 : this.editor.effectItemsOf(effect).length));
    let shift = p.hueShift ?? 0;
    let step = p.hueStep ?? 0;
    const drawPreview = () => {
      preview.replaceChildren(
        ...Array.from({ length: count }, (_, k) => {
          const base = mixColor(p.color, p.color2, count <= 1 ? 0 : k / (count - 1), p.hsv, scheme);
          const rgb = shiftHue(resolveRgb(base, scheme), shift + step * (p.hueInvert === true ? count - 1 - k : k));
          const swatch = document.createElement('span');
          swatch.style.background = toHex(rgb);
          return swatch;
        }),
      );
    };
    const slider = (label: string, value: number, min: number, max: number, track: string, input: (value: number) => void, commit: (value: number) => void) => {
      const row = document.createElement('label');
      row.className = 'ins-hue-row';
      const range = Object.assign(document.createElement('input'), { type: 'range', min: String(min), max: String(max), step: '1', value: String(value) });
      range.style.background = track;
      const number = Object.assign(document.createElement('input'), { type: 'number', min: String(min * 2), max: String(max * 2), step: '5', value: String(value) });
      range.addEventListener('input', () => {
        number.value = range.value;
        input(Number(range.value));
        drawPreview();
      });
      range.addEventListener('change', () => commit(Number(range.value)));
      // (picked a moment ago: the wheel turns it too)
      wheelSlider(
        range,
        `hue:${label}`,
        (next) => {
          number.value = String(next);
          input(next);
          drawPreview();
        },
        commit,
        5,
      );
      number.addEventListener('change', () => {
        const next = Number(number.value);
        if (!Number.isFinite(next)) return;
        input(next);
        commit(next);
      });
      row.append(Object.assign(document.createElement('span'), { textContent: label }), range, number);
      return row;
    };
    // (the track: the hues the base colour goes through as the slider moves)
    const baseHue = rgbHue(resolveRgb(p.color, scheme));
    const hues = (from: number, to: number) => `linear-gradient(90deg, ${Array.from({ length: 13 }, (_, k) => `hsl(${String(baseHue + from + ((to - from) * k) / 12)} 85% 55%)`).join(', ')})`;
    box.append(
      name,
      slider('Сдвиг, °', shift, -180, 180, hues(-180, 180), (value) => (shift = value), (value) => change((params) => (params.hueShift = value))),
      slider('Каждому следующему, °', step, -60, 60, hues(-60, 60), (value) => (step = value), (value) => change((params) => (params.hueStep = value))),
      preview,
    );
    // (the base colour on the first item, or on the last)
    const invert = document.createElement('button');
    invert.type = 'button';
    invert.className = `ins-hue-invert${p.hueInvert === true ? ' active' : ''}`;
    invert.textContent = p.hueInvert === true ? '⇄ Исходный цвет — в конце' : '⇄ Исходный цвет — в начале';
    invert.title = 'Перевернуть сдвиг: исходный цвет у последнего элемента (вспышки), а не у первого';
    invert.addEventListener('click', () =>
      change((params) => {
        if (params.hueInvert === true) delete params.hueInvert;
        else params.hueInvert = true;
      }),
    );
    box.append(invert);
    drawPreview();
    return box;
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
    // (the starts and ends: drawn as the light goes, their names in the tooltip)
    const icons = options === (START_MODES as unknown) ? 'start' : options === (END_MODES as unknown) ? 'end' : null;
    for (const [value, label, title] of options) {
      const button = document.createElement('button');
      const icon = icons === null ? undefined : MODE_ICONS[`${icons}:${value}`];
      if (icon === undefined) {
        button.textContent = label;
        button.title = title;
      } else {
        button.classList.add('icon-button');
        button.append(modeIcon(icon));
        button.title = `${label} — ${title}`;
      }
      if (value === current) button.classList.add('active');
      button.addEventListener('click', () => pick(value));
      row.append(button);
    }
    return row;
  }

  /** The scheme's colours (the boost's when the boost is on at `at` — what the game shows then), a
   *  colour of its own, the brightness. */
  private colorPicker(color: ClipColor, change: (color: ClipColor) => void, at: number) {
    const wrap = document.createElement('div');
    wrap.className = 'ins-color';
    const colors = this.editor.preview.colors;
    const boosted = this.editor.boostAt(at);
    const refs: [ClipColor['ref'], string, Rgb][] = boosted
      ? [
          ['left', 'Левый (буст)', [...colors.environmentLeftBoost]],
          ['right', 'Правый (буст)', [...colors.environmentRightBoost]],
          ['white', 'Белый (буст)', [...colors.environmentWhiteBoost]],
        ]
      : [
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
    if (boosted) {
      const mark = document.createElement('span');
      mark.className = 'ins-boost';
      mark.textContent = '⚡ буст';
      mark.title = 'Здесь включён буст цветов: цвета схемы в игре — цвета буста (свой цвет Chroma буст не меняет)';
      wrap.append(mark);
    }
    // a colour of one's own: the editor's own pick (square, hues, pipette, the map's palette)
    const shown: Rgb = color.ref === 'custom' ? (color.rgb ?? [1, 1, 1]) : (refs.find(([ref]) => ref === color.ref)?.[2] ?? [1, 1, 1]);
    const custom = document.createElement('button');
    custom.type = 'button';
    custom.title = 'Свой цвет (Chroma): квадрат, оттенки, пипетка, палитра карты';
    custom.className = `ins-custom${color.ref === 'custom' ? ' active' : ''}`;
    custom.style.background = color.ref === 'custom' ? toHex(shown) : 'conic-gradient(#f44, #fd4, #4f6, #4df, #46f, #f4d, #f44)';
    const pickOptions = {
      palette: () => this.editor.palette(),
      setPalette: (colors: Rgb[]) => this.editor.setPalette(colors),
    };
    custom.addEventListener('click', () => openColorPick(custom, shown, { ...pickOptions, apply: (rgb) => change({ ...color, ref: 'custom', rgb }) }));
    wrap.append(custom);
    const dropper = document.createElement('button');
    dropper.type = 'button';
    dropper.className = 'ins-dropper';
    dropper.textContent = '💧';
    dropper.title = 'Пипетка: цвет с любого места экрана (Esc — отмена)';
    dropper.addEventListener('click', () => {
      void pickFromScreen().then((rgb) => {
        if (rgb !== null) change({ ...color, ref: 'custom', rgb });
      });
    });
    wrap.append(dropper);
    // the map's palette: a click puts the colour on; ＋ keeps this one in it
    const palette = document.createElement('div');
    palette.className = 'ins-palette';
    for (const rgb of this.editor.palette()) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `ins-chip${color.ref === 'custom' && toHex(color.rgb ?? [1, 1, 1]) === toHex(rgb) ? ' active' : ''}`;
      chip.style.background = toHex(rgb);
      chip.title = `${toHex(rgb).toUpperCase()} — из палитры карты. ПКМ — убрать`;
      chip.addEventListener('click', () => change({ ...color, ref: 'custom', rgb: [...rgb] }));
      chip.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.editor.setPalette(this.editor.palette().filter((item) => item !== rgb));
      });
      palette.append(chip);
    }
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'ins-chip ins-keep';
    keep.textContent = '＋';
    keep.title = 'Сохранить этот цвет в палитру карты';
    keep.addEventListener('click', () => {
      const list = this.editor.palette();
      if (!list.some((item) => toHex(item) === toHex(shown))) this.editor.setPalette([...list, [...shown]]);
    });
    palette.append(keep);
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
    box.append(wrap, palette, line);
    return box;
  }

  /** A number on a drum (a number can be typed in too): `step` apart, from `min` (0). */
  private drumField(label: string, value: number, step: number, options: { min?: number } | ((value: number) => void), change?: (value: number) => void) {
    const then = typeof options === 'function' ? options : change!;
    const min = typeof options === 'function' ? 0 : (options.min ?? 0);
    const wrap = document.createElement('div');
    wrap.className = 'ins-drum';
    wrap.append(Object.assign(document.createElement('span'), { textContent: label }), numberDrum(label, value, then, { step: step > 0 ? step : 0.25, min, digits: 4, beats: step < 1 }));
    return wrap;
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

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function note(text: string) {
  return Object.assign(document.createElement('div'), { className: 'gls-note', textContent: text });
}
