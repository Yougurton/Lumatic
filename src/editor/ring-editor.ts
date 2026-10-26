import type { Editor } from './editor';
import { button, check, heading, labeled, numberInput, select, textInput, toggle } from './gls-editor';
import { ringSystemName } from './library';
import { newId } from './model';
import { dataFirstRing, EASINGS, EVENT_SHAPES, firstRingFromLog, isZoom, newPose, poseAngles, ringDelay, ringObjectNames, SHAPES, zoomPositions, type PoseShape, type RingBlock, type RingPose, type RingSystemInfo, type TurnWay, type ZoomSystemInfo } from './rings';

/**
 * The editor of a ring pose block. It sits where the timeline is, so the 3D view above shows what it
 * does: picking a pose puts the song where the rings have come to it, every change shows at once.
 *
 * Left: the block's poses on a lane (click: a new one, drag: move, Delete: remove). Middle: the
 * picked pose — its shape (an angle per ring), how the rings turn to it. Right: the rings seen down
 * the tunnel, and a bar per ring — dragged, it sets that ring's angle by hand (rings on their own
 * Chroma tracks only: ring events can't turn the rings one by one).
 *
 * A zoom block is edited the same way: each pose a spacing between the rings, the rings seen from the
 * side.
 */

const WAYS: [TurnWay, string][] = [
  ['short', 'Короче'],
  ['ccw', 'Против часовой'],
  ['cw', 'По часовой'],
];

export class RingEditor {
  private dock: HTMLElement | null = null;
  private blockId = '';
  private poseId: string | null = null;
  private laneDrag: { id: string; startX: number; moved: boolean; origin: number } | null = null;
  private barDrag: { angles: number[]; last: number | null } | null = null;
  private keyHandler = (event: KeyboardEvent) => this.onKey(event);
  private resizeHandler = () => this.place();
  private raf = 0;

  constructor(private readonly editor: Editor) {
    editor.ringEditorHook = (id) => this.open(id);
    editor.onChange((what) => {
      if (this.dock === null) return;
      if (this.block() === undefined) {
        this.close();
        return;
      }
      if (what === 'clips' || what === 'all') this.render();
    });
  }

  private block(): RingBlock | undefined {
    return this.editor.ringBlockById(this.blockId);
  }

  private pose(): RingPose | undefined {
    const block = this.block();
    return block?.poses.find((pose) => pose.id === this.poseId);
  }

  private system(block: RingBlock): RingSystemInfo | undefined {
    return this.editor.ringInfo.find((system) => system.name === block.system) ?? this.editor.ringInfo[0];
  }

  private zoomSystem(block: RingBlock): ZoomSystemInfo | undefined {
    return this.editor.zoomInfo.find((system) => system.name === block.system) ?? this.editor.zoomInfo[0];
  }

  /** How long the picked pose takes to be reached (after its own time). */
  private reached(block: RingBlock, pose: RingPose) {
    if (isZoom(block)) return pose.duration;
    const rings = this.system(block)?.rings ?? 1;
    return pose.duration + Math.max(ringDelay(pose, 0, rings), ringDelay(pose, rings - 1, rings));
  }

  open(id: string) {
    const block = this.editor.ringBlockById(id);
    if (block === undefined) return;
    this.close();
    this.blockId = id;
    this.poseId = block.poses[0]?.id ?? null;
    const dock = document.createElement('div');
    dock.className = 'gls-dialog ring-dock';
    document.body.append(dock);
    this.dock = dock;
    this.place();
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('keydown', this.keyHandler, true);
    this.render();
    this.showPose();
    const tick = () => {
      this.drawLanePlayhead();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  close() {
    if (this.dock === null) return;
    this.dock.remove();
    this.dock = null;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('keydown', this.keyHandler, true);
    this.editor.stopTrial();
  }

  /** Over the timeline (the 3D view stays in sight). */
  private place() {
    const dock = this.dock;
    const timeline = document.getElementById('timeline');
    if (dock === null || timeline === null) return;
    const rect = timeline.getBoundingClientRect();
    const height = Math.max(380, rect.height);
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
    if ((event.code === 'Delete' || event.code === 'Backspace') && this.poseId !== null) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.deletePose();
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.play();
      return;
    }
    event.stopImmediatePropagation();
  }

  /** One change to the block: an undo step, the view updated. */
  private change(patch: (block: RingBlock) => void) {
    this.editor.updateRingBlock(this.blockId, patch);
    this.showPose();
  }

  private changePose(patch: (pose: RingPose) => void) {
    const id = this.poseId;
    this.change((block) => {
      const pose = block.poses.find((item) => item.id === id);
      if (pose !== undefined) patch(pose);
    });
  }

  private play() {
    const block = this.block();
    if (block === undefined) return;
    if (this.editor.previewExtra !== null) this.editor.stopTrial();
    else this.editor.startTrial({ clips: [], raw: [], start: block.start, end: block.end });
    this.render();
  }

  /** The song put where the picked pose has been reached (the 3D view shows it). */
  private showPose() {
    const block = this.block();
    const pose = this.pose();
    if (block === undefined || pose === undefined || this.editor.previewExtra !== null || this.editor.isPlaying()) return;
    this.editor.seek(block.start + pose.beat + this.reached(block, pose) + 0.05);
  }

  // ----- rendering -------------------------------------------------------------------------------------

  private render() {
    const dock = this.dock;
    const block = this.block();
    if (dock === null || block === undefined) return;
    const scroll = [...dock.querySelectorAll<HTMLElement>('.gls-col')].map((col) => col.scrollTop);
    dock.replaceChildren(this.header(block));
    const body = document.createElement('div');
    body.className = 'gls-body ring-body';
    body.append(this.laneColumn(block), isZoom(block) ? this.zoomColumn(block) : this.poseColumn(block), isZoom(block) ? this.zoomView(block) : this.viewColumn(block));
    dock.append(body);
    [...dock.querySelectorAll<HTMLElement>('.gls-col')].forEach((col, index) => (col.scrollTop = scroll[index] ?? 0));
  }

  private header(block: RingBlock) {
    const head = document.createElement('div');
    head.className = 'gls-head';
    const title = document.createElement('span');
    title.className = 'gls-title';
    title.textContent = isZoom(block) ? 'Зум колец' : 'Позы колец';
    const name = textInput(block.name, (value) => this.change((item) => (item.name = value || item.name)));
    name.className = 'gls-name';
    const length = labeled('Длина, долей', numberInput(block.end - block.start, 0.25, (value) => this.change((item) => (item.end = item.start + Math.max(0.25, value)))));
    const play = button(this.editor.previewExtra !== null ? '■ Стоп' : '▶ Проиграть', 'Проиграть блок по кругу в окне просмотра (Пробел)', () => this.play());
    const done = button('Готово', 'Закрыть (Esc)', () => this.close());
    done.classList.add('primary');
    const spacer = document.createElement('span');
    spacer.className = 'gls-dim';
    if (isZoom(block)) {
      const zooms = this.editor.zoomInfo;
      const choices: [string, string][] = zooms.map((system) => [system.name, `${ringSystemName(system.name)} (${String(system.rings)})`]);
      if (zooms.length > 1) choices.unshift(['', 'Все системы колец']);
      const current = block.system === '' && zooms.length === 1 ? zooms[0]!.name : block.system;
      head.append(title, name, labeled('Кольца', select(choices, current, (value) => this.change((item) => (item.system = zooms.length === 1 ? '' : value)))), spacer, length, play, done);
      return head;
    }
    const systems = this.editor.ringInfo;
    const options: [string, string][] = systems.map((system) => [system.name, `${ringSystemName(system.name)} (${String(system.rings)})`]);
    if (block.mode === 'event' && systems.length > 1) options.unshift(['', 'Все системы колец']);
    const system = labeled('Кольца', select(options, block.system, (value) => this.change((item) => (item.system = value))));
    const mode = toggle<RingBlock['mode']>([['event', 'Событиями колец'], ['tracks', 'Каждое кольцо отдельно']], block.mode, (value) =>
      this.change((item) => {
        item.mode = value;
        if (value === 'tracks' && item.system === '') item.system = systems[0]?.name ?? '';
      }),
    );
    mode.title = 'Событиями колец — обычные события вращения (Chroma): кольца стоят спиралью. Каждое кольцо отдельно — у каждого кольца свой трек Chroma и AnimateTrack: любая форма';
    mode.style.marginBottom = '0';
    head.append(title, name, system, mode, spacer, length, play, done);
    return head;
  }

  private laneColumn(block: RingBlock) {
    const col = document.createElement('div');
    col.className = 'gls-col';
    col.append(heading('Позы'));
    const hint = document.createElement('div');
    hint.className = 'gls-note';
    hint.textContent = 'Клик по дорожке — новая поза, перетаскивание — сдвинуть, Delete — удалить. Выбранная поза видна в окне просмотра.';
    col.append(hint);
    const canvas = document.createElement('canvas');
    canvas.className = 'gls-lane ring-lane';
    col.append(canvas);
    requestAnimationFrame(() => this.drawLane(canvas, block));
    this.bindLane(canvas, block);
    const list = document.createElement('div');
    list.className = 'ring-list';
    [...block.poses].sort((a, b) => a.beat - b.beat).forEach((pose, index) => {
      const row = document.createElement('div');
      row.className = `gls-box${pose.id === this.poseId ? ' active' : ''}`;
      const label = document.createElement('div');
      label.className = 'gls-box-name';
      label.textContent = isZoom(block) ? `${String(index + 1)}. Расстояние ${String(round(pose.step))}` : `${String(index + 1)}. ${SHAPES.find(([shape]) => shape === shapeOf(pose, block))?.[1] ?? ''} · ${String(round(pose.angle))}°${pose.shape === 'spiral' ? ` +${String(round(pose.step))}°` : ''}`;
      const info = document.createElement('div');
      info.className = 'gls-dim';
      info.textContent = isZoom(block) ? `доля ${String(round(pose.beat))} · переход ${String(round(pose.duration))}` : `доля ${String(round(pose.beat))} · поворот ${String(round(pose.duration))}${pose.delay > 0 ? ` · волна ${String(round(pose.delay))}` : ''}`;
      row.append(label, info);
      row.addEventListener('click', () => {
        this.poseId = pose.id;
        this.render();
        this.showPose();
      });
      list.append(row);
    });
    col.append(list);
    if (!isZoom(block) && block.mode === 'tracks') col.append(this.gameRings());
    return col;
  }

  /** Where the game puts its rings for this player (Chroma finds each ring by its place there). */
  private gameRings() {
    const editor = this.editor;
    const box = document.createElement('div');
    box.className = 'ring-game';
    const fromData = dataFirstRing(editor.ringInfo);
    if (fromData === undefined) return box;
    box.append(heading('Кольца в игре'));
    box.append(note('Chroma находит каждое кольцо по его номеру в сцене игры — GameCore.[N]. Номер зависит от версии игры и модов: если в игре кольца не поворачиваются, укажите номер первого кольца (или возьмите его из лога игры) и сохраните карту ещё раз.'));
    const current = editor.gameFirstRing ?? fromData;
    box.append(labeled('Номер первого кольца', numberInput(current, 1, (value) => {
      editor.gameFirstRing = value === fromData ? null : Math.max(0, Math.round(value));
      this.render();
    })));
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.log,.txt';
    file.hidden = true;
    file.addEventListener('change', () => {
      const picked = file.files?.[0];
      if (picked === undefined) return;
      void picked.text().then((text) => {
        const found = firstRingFromLog(text, ringObjectNames(editor.ringInfo));
        if (found === undefined) {
          window.alert('В этом логе нет списка объектов окружения с кольцами. Включите в Beat Saber/UserData/Chroma.json "PrintEnvironmentEnhancementDebug": true и в Beat Saber/UserData/Beat Saber IPA.json "ShowDebug": true, сыграйте карту в этом окружении и выберите Beat Saber/Logs/_latest.log.');
          return;
        }
        editor.gameFirstRing = found === fromData ? null : found;
        window.alert(`Первое кольцо в игре: GameCore.[${String(found)}]. Сохраните карту, чтобы записать кольца с этим номером.`);
        this.render();
      });
    });
    const row = document.createElement('div');
    row.className = 'gls-swatches';
    row.append(
      button('Из лога игры…', 'Найти номер в логе Beat Saber (Logs/_latest.log) — нужен отладочный вывод Chroma', () => file.click()),
      button(`Как в данных (${String(fromData)})`, 'Номер из данных окружения', () => {
        editor.gameFirstRing = null;
        this.render();
      }, editor.gameFirstRing === null),
      file,
    );
    box.append(row);
    return box;
  }

  private poseColumn(block: RingBlock) {
    const col = document.createElement('div');
    col.className = 'gls-col';
    const pose = this.pose();
    if (pose === undefined) {
      col.append(heading('Поза'), Object.assign(document.createElement('div'), { className: 'gls-note', textContent: 'Выберите позу на дорожке или добавьте новую кликом.' }));
      return col;
    }
    const events = block.mode === 'event';
    col.append(heading('Поза'));
    col.append(labeled('Доля (от начала блока)', numberInput(pose.beat, this.editor.snap || 0.25, (value) => this.changePose((item) => (item.beat = Math.max(0, value))))));
    const shapes = SHAPES.filter(([shape]) => !events || EVENT_SHAPES.has(shape));
    col.append(toggle(shapes, shapeOf(pose, block), (value) => this.changePose((item) => {
      if (value === 'manual' && item.shape !== 'manual') item.manual = poseAngles(item, this.system(block)?.rings ?? 1, block.mode).map(round);
      item.shape = value;
    })));
    if (events && !EVENT_SHAPES.has(pose.shape)) col.append(note('События колец ставят кольца только спиралью — эта форма будет показана как спираль. Для любой формы включите «Каждое кольцо отдельно».'));
    const shape = shapeOf(pose, block);
    if (shape !== 'manual') {
      col.append(labeled(shape === 'wave' ? 'Средний угол, °' : 'Угол первого кольца, °', numberInput(pose.angle, 1, (value) => this.changePose((item) => (item.angle = value)))));
      const quick = document.createElement('div');
      quick.className = 'gls-swatches';
      for (const angle of [-90, -45, 0, 45, 90, 180]) quick.append(button(`${String(angle)}°`, `Угол ${String(angle)}°`, () => this.changePose((item) => (item.angle = angle))));
      col.append(quick);
    }
    if (shape === 'spiral') col.append(labeled('Шаг от кольца к кольцу, °', numberInput(pose.step, 1, (value) => this.changePose((item) => (item.step = value)))));
    if (shape === 'wave' || shape === 'alternate' || shape === 'random') col.append(labeled(shape === 'alternate' ? 'Каждое второе повёрнуто на, °' : 'Размах, °', numberInput(pose.step, 1, (value) => this.changePose((item) => (item.step = value)))));
    if (shape === 'wave') {
      col.append(labeled('Волн по кольцам', numberInput(pose.periods, 0.25, (value) => this.changePose((item) => (item.periods = value)))));
      col.append(labeled('Сдвиг волны, °', numberInput(pose.phase, 15, (value) => this.changePose((item) => (item.phase = value)))));
    }
    if (shape === 'random') col.append(button('🎲 Другой случай', 'Другие случайные углы', () => this.changePose((item) => (item.seed = Math.floor(Math.random() * 1e6)))));
    if (shape === 'manual') col.append(note('Углы колец задаются справа: тяните столбики (Shift — точнее, по 1°).'));
    col.append(note('Углы — как кольца видны с платформы: плюс — против часовой стрелки, минус — по часовой.'));

    col.append(heading('Поворот к позе'));
    col.append(toggle(WAYS, pose.way, (value) => this.changePose((item) => (item.way = value))));
    col.append(labeled('Целых оборотов сверху', numberInput(pose.loops, 1, (value) => this.changePose((item) => (item.loops = Math.max(0, Math.round(value)))))));
    col.append(labeled('Время поворота, долей (0 — сразу)', numberInput(pose.duration, 0.25, (value) => this.changePose((item) => (item.duration = Math.max(0, value))))));
    if (!events) col.append(labeled('Сглаживание', select(EASINGS, pose.easing, (value) => this.changePose((item) => (item.easing = value)))));
    else col.append(note('Событие колец доводит кольца плавно с торможением; время поворота задаёт его скорость.'));
    col.append(labeled('Волна по кольцам, долей (0 — все разом)', numberInput(pose.delay, 0.125, (value) => this.changePose((item) => (item.delay = Math.max(0, value))))));
    if (pose.delay > 0) col.append(check('От дальних к ближним', pose.reverse, (on) => this.changePose((item) => (item.reverse = on))));
    if (events && pose.reverse && pose.delay > 0) col.append(note('События колец ведут волну только от ближних колец к дальним.'));
    col.append(button('Удалить позу', 'Delete', () => this.deletePose(), block.poses.length <= 1));
    return col;
  }

  private viewColumn(block: RingBlock) {
    const col = document.createElement('div');
    col.className = 'gls-col ring-view';
    col.append(heading('Кольца'));
    const system = this.system(block);
    if (system === undefined) {
      col.append(note('В этом окружении нет вращающихся колец.'));
      return col;
    }
    const pose = this.pose();
    const views = document.createElement('div');
    views.className = 'ring-views';
    const sketch = document.createElement('canvas');
    sketch.className = 'ring-sketch';
    sketch.title = 'Кольца, как их видно с платформы: ближние крупнее (форма колец условная)';
    const bars = document.createElement('canvas');
    bars.className = 'ring-bars';
    bars.title = block.mode === 'tracks' ? 'Угол каждого кольца: тяните столбики (Shift — по 1°)' : 'Угол каждого кольца (вручную — только «Каждое кольцо отдельно»)';
    views.append(sketch, bars);
    col.append(views);
    if (block.mode === 'tracks') {
      col.append(note(`Каждое кольцо получает свой трек Chroma (environment) и поворачивается событиями AnimateTrack. Карта будет рекомендовать Chroma; без неё кольца двигаются только обычными событиями. Обычные события вращения колец добавляются поверх этих поз.`));
    } else {
      col.append(note('Поза ставится одним событием вращения колец; редактор сам считает, на сколько повернуть кольца от того места, где их оставили прежние события, — поэтому поза точная, что бы ни было до неё.'));
    }
    if (pose !== undefined) {
      requestAnimationFrame(() => {
        this.drawSketch(sketch, block, pose, system);
        this.drawBars(bars, block, pose, system);
      });
      this.bindBars(bars, block, system);
    }
    return col;
  }

  /** A zoom pose: the spacing, how long the rings take to get there. */
  private zoomColumn(block: RingBlock) {
    const col = document.createElement('div');
    col.className = 'gls-col';
    const pose = this.pose();
    const system = this.zoomSystem(block);
    if (pose === undefined) {
      col.append(heading('Поза'), note('Выберите позу на дорожке или добавьте новую кликом.'));
      return col;
    }
    col.append(heading('Поза'));
    col.append(labeled('Доля (от начала блока)', numberInput(pose.beat, this.editor.snap || 0.25, (value) => this.changePose((item) => (item.beat = Math.max(0, value))))));
    col.append(labeled('Расстояние между кольцами', numberInput(pose.step, 0.1, (value) => this.changePose((item) => (item.step = round(value))))));
    if (system !== undefined) {
      const quick = document.createElement('div');
      quick.className = 'gls-swatches';
      const presets: [string, string, number][] = [
        ['Сжать', 'Как сжимает обычное событие зума', system.position.minPositionStep],
        ['Как в начале', 'Расстояние, с которым кольца стоят в начале песни', system.initialStep],
        ['Растянуть', 'Как растягивает обычное событие зума', system.position.maxPositionStep],
        ['Вплотную', 'Все кольца в одном месте', 0],
      ];
      for (const [label, title, value] of presets) quick.append(button(label, `${title}: ${String(round(value))}`, () => this.changePose((item) => (item.step = round(value)))));
      quick.append(button('×½', 'Вдвое ближе', () => this.changePose((item) => (item.step = round(item.step / 2)))), button('×2', 'Вдвое дальше', () => this.changePose((item) => (item.step = round(item.step * 2)))));
      col.append(quick);
    }
    col.append(heading('Переход'));
    col.append(labeled('Время перехода, долей (0 — сразу)', numberInput(pose.duration, 0.25, (value) => this.changePose((item) => (item.duration = Math.max(0, value))))));
    col.append(note('Событие зума задаёт расстояние сразу, а не прибавляет его, — поза всегда точная. Кольца доезжают плавно, с торможением; время перехода задаёт скорость.'));
    col.append(button('Удалить позу', 'Delete', () => this.deletePose(), block.poses.length <= 1));
    return col;
  }

  /** The rings from the side: where each stands at the picked pose, faint — at the one before. */
  private zoomView(block: RingBlock) {
    const col = document.createElement('div');
    col.className = 'gls-col ring-view';
    col.append(heading('Кольца сбоку'));
    const system = this.zoomSystem(block);
    const pose = this.pose();
    if (system === undefined) {
      col.append(note('В этом окружении кольца не приближаются и не отдаляются.'));
      return col;
    }
    const canvas = document.createElement('canvas');
    canvas.className = 'ring-side';
    canvas.title = 'Кольца сбоку: слева — платформа, правее — дальше в тоннель';
    col.append(canvas);
    col.append(note('Слева — платформа. Яркие черты — где кольца встанут, бледные — где стояли на прошлой позе (или в начале песни).'));
    if (pose !== undefined) {
      const before = [...block.poses].filter((item) => item.beat < pose.beat).sort((a, b) => b.beat - a.beat)[0];
      requestAnimationFrame(() => this.drawSide(canvas, system, pose.step, before?.step ?? system.initialStep));
    }
    return col;
  }

  private drawSide(canvas: HTMLCanvasElement, system: ZoomSystemInfo, step: number, previous: number) {
    if (!canvas.isConnected || canvas.clientWidth === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    ctx.fillStyle = '#0c0d11';
    ctx.fillRect(0, 0, width, height);
    const now = zoomPositions(system, step);
    const then = zoomPositions(system, previous);
    const far = Math.max(1, ...now, ...then, ...zoomPositions(system, system.initialStep));
    const left = 30;
    const toX = (z: number) => left + (z / far) * (width - left - 16);
    // the scale
    ctx.font = '10px system-ui, sans-serif';
    const tick = far > 200 ? 50 : far > 80 ? 20 : far > 30 ? 10 : 5;
    for (let z = 0; z <= far; z += tick) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(toX(z), 16, 1, height - 30);
      ctx.fillStyle = '#7d8394';
      ctx.fillText(String(z), toX(z) + 2, height - 4);
    }
    ctx.fillStyle = '#c9cdd8';
    ctx.fillRect(8, height / 2 - 10, 10, 20);
    const draw = (positions: number[], style: string, size: number) => {
      ctx.fillStyle = style;
      positions.forEach((z, i) => {
        const h = (height - 40) * size * (1 - (i / Math.max(1, positions.length)) * 0.35);
        ctx.fillRect(toX(z) - 1, height / 2 - h / 2, 2, h);
      });
    };
    draw(then, 'rgba(127,212,255,0.25)', 0.8);
    draw(now, '#7fd4ff', 1);
    ctx.fillStyle = '#c9cdd8';
    ctx.fillText(`Расстояние ${String(round(step))} · кольца до ${String(round(Math.max(...now)))}`, left, 12);
  }

  private deletePose() {
    const id = this.poseId;
    const block = this.block();
    if (id === null || block === undefined || block.poses.length <= 1) return;
    this.poseId = null;
    this.change((item) => (item.poses = item.poses.filter((pose) => pose.id !== id)));
  }

  // ----- the lane --------------------------------------------------------------------------------------

  private laneGeometry(canvas: HTMLCanvasElement, block: RingBlock) {
    const width = canvas.clientWidth;
    const length = Math.max(0.25, block.end - block.start);
    const pad = 12;
    return { width, height: canvas.clientHeight, length, toX: (beat: number) => pad + (beat / length) * (width - pad * 2), toBeat: (x: number) => ((x - pad) / (width - pad * 2)) * length };
  }

  private laneCanvas: { canvas: HTMLCanvasElement; image: ImageData | null; block: RingBlock } | null = null;

  private drawLane(canvas: HTMLCanvasElement, block: RingBlock) {
    if (!canvas.isConnected || canvas.clientWidth === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const g = this.laneGeometry(canvas, block);
    ctx.fillStyle = '#101116';
    ctx.fillRect(0, 0, g.width, g.height);
    ctx.font = '10px system-ui, sans-serif';
    const snap = this.editor.snap > 0 ? this.editor.snap : 0.25;
    for (let beat = 0; beat <= g.length + 1e-6; beat += snap) {
      const whole = Math.abs(beat - Math.round(beat)) < 1e-6;
      ctx.fillStyle = whole ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.fillRect(Math.round(g.toX(beat)), 14, 1, g.height - 18);
      if (whole) {
        ctx.fillStyle = '#7d8394';
        ctx.fillText(String(Math.round(beat)), g.toX(beat) + 2, 10);
      }
    }
    const cy = g.height / 2 + 6;
    const widest = Math.max(1e-3, ...block.poses.map((pose) => Math.abs(pose.step)));
    for (const pose of [...block.poses].sort((a, b) => a.beat - b.beat)) {
      const x = g.toX(pose.beat);
      const span = this.reached(block, pose) * ((g.width - 24) / g.length);
      ctx.fillStyle = isZoom(block) ? 'rgba(120,210,255,0.25)' : 'rgba(183,140,255,0.25)';
      ctx.fillRect(x, cy - 2, span, 4);
      const selected = pose.id === this.poseId;
      if (isZoom(block)) {
        // (bars a pose's spacing apart)
        const gap = 2 + (Math.abs(pose.step) / widest) * 6;
        ctx.fillStyle = selected ? '#ffffff' : '#7fd4ff';
        for (let k = 0; k < 4; k++) ctx.fillRect(x - 1 + k * gap, cy - 9, selected ? 2 : 1.5, 18);
        ctx.fillStyle = '#c9cdd8';
        ctx.fillText(String(round(pose.step)), x + 4 * gap + 2, cy + 20);
        continue;
      }
      ctx.strokeStyle = selected ? '#ffffff' : '#b78cff';
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(x, cy, 10, 0, Math.PI * 2);
      ctx.stroke();
      const angle = (pose.angle * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.lineTo(x - Math.sin(angle) * 10, cy - Math.cos(angle) * 10);
      ctx.stroke();
      ctx.fillStyle = '#c9cdd8';
      ctx.fillText(`${String(round(pose.angle))}°`, x + 13, cy + 20);
    }
    this.laneCanvas = { canvas, image: ctx.getImageData(0, 0, canvas.width, canvas.height), block };
  }

  /** The cursor over the lane while the song moves. */
  private drawLanePlayhead() {
    const lane = this.laneCanvas;
    if (lane === null || lane.image === null || !lane.canvas.isConnected) return;
    const ctx = lane.canvas.getContext('2d')!;
    ctx.putImageData(lane.image, 0, 0);
    const g = this.laneGeometry(lane.canvas, lane.block);
    const x = g.toX(this.editor.playhead() - lane.block.start);
    if (x < 0 || x > lane.canvas.clientWidth) return;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#ff4d6d';
    ctx.fillRect(x, 0, 1.5, lane.canvas.clientHeight);
  }

  private bindLane(canvas: HTMLCanvasElement, block: RingBlock) {
    const local = (event: MouseEvent) => event.clientX - canvas.getBoundingClientRect().left;
    const snap = (beat: number) => {
      const step = this.editor.snap > 0 ? this.editor.snap : 0;
      return Math.max(0, step > 0 ? Math.round(beat / step) * step : beat);
    };
    const move = (event: MouseEvent) => {
      const drag = this.laneDrag;
      if (drag === null) return;
      const x = local(event);
      if (!drag.moved && Math.abs(x - drag.startX) < 4) return;
      drag.moved = true;
      const g = this.laneGeometry(canvas, block);
      const pose = block.poses.find((item) => item.id === drag.id);
      if (pose !== undefined) pose.beat = Math.min(g.length, snap(g.toBeat(x)));
      this.drawLane(canvas, block);
    };
    const up = () => {
      const drag = this.laneDrag;
      this.laneDrag = null;
      window.removeEventListener('mousemove', move);
      if (drag === null) return;
      if (!drag.moved) {
        this.render();
        this.showPose();
        return;
      }
      const pose = block.poses.find((item) => item.id === drag.id);
      const beat = pose?.beat ?? drag.origin;
      if (pose !== undefined) pose.beat = drag.origin;
      this.changePose((item) => (item.beat = beat));
    };
    canvas.addEventListener('mousedown', (event) => {
      const g = this.laneGeometry(canvas, block);
      const x = local(event);
      const hit = block.poses.map((pose) => ({ pose, d: Math.abs(g.toX(pose.beat) - x) })).filter((entry) => entry.d <= 11).sort((a, b) => a.d - b.d)[0];
      if (hit !== undefined) {
        this.poseId = hit.pose.id;
        this.laneDrag = { id: hit.pose.id, startX: x, moved: false, origin: hit.pose.beat };
        this.drawLane(canvas, block);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up, { once: true });
        return;
      }
      // a new pose here: like the one before it
      const beat = Math.min(g.length, snap(g.toBeat(x)));
      const before = [...block.poses].filter((pose) => pose.beat <= beat).sort((a, b) => b.beat - a.beat)[0];
      const pose = before === undefined ? newPose(beat, isZoom(block) ? { step: round(this.zoomSystem(block)?.initialStep ?? 2) } : {}) : { ...structuredClone(before), id: newId('p'), beat };
      this.poseId = pose.id;
      this.change((item) => item.poses.push(pose));
    });
  }

  // ----- the rings -------------------------------------------------------------------------------------

  /** The angles the picked pose gives the rings (as they will stand), or the bars being dragged. */
  private angles(block: RingBlock, pose: RingPose, system: RingSystemInfo) {
    return this.barDrag?.angles ?? poseAngles(pose, system.rings, block.mode);
  }

  private drawSketch(canvas: HTMLCanvasElement, block: RingBlock, pose: RingPose, system: RingSystemInfo) {
    if (!canvas.isConnected || canvas.clientWidth === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    ctx.fillStyle = '#0c0d11';
    ctx.fillRect(0, 0, width, height);
    const angles = this.angles(block, pose, system);
    const cx = width / 2;
    const cy = height / 2;
    const near = Math.min(width, height) * 0.46;
    // (far rings first: drawn small and dim, the near ones over them)
    for (let i = angles.length - 1; i >= 0; i--) {
      const size = near / (1 + i * 0.18);
      const light = 75 - (i / Math.max(1, angles.length - 1)) * 45;
      ctx.save();
      ctx.translate(cx, cy);
      // (a larger angle turns a ring counterclockwise as the player sees it)
      ctx.rotate(-((angles[i] ?? 0) * Math.PI) / 180);
      ctx.strokeStyle = `hsl(${String(285 - i * 3)} 70% ${String(light)}%)`;
      ctx.lineWidth = Math.max(1, 3.2 - i * 0.12);
      ctx.strokeRect(-size / 2, -size / 2, size, size);
      // a notch on the top edge: which way is up for this ring
      ctx.beginPath();
      ctx.moveTo(0, -size / 2);
      ctx.lineTo(0, -size / 2 + Math.max(3, size * 0.06));
      ctx.stroke();
      ctx.restore();
    }
  }

  private barGeometry(canvas: HTMLCanvasElement, angles: readonly number[]) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const top = 14;
    const bottom = height - 16;
    const extent = Math.max(180, ...angles.map((angle) => Math.ceil(Math.abs(angle) / 90) * 90));
    const toY = (angle: number) => top + ((extent - angle) / (2 * extent)) * (bottom - top);
    const toAngle = (y: number) => extent - ((y - top) / (bottom - top)) * 2 * extent;
    const slot = (width - 40) / Math.max(1, angles.length);
    return { width, height, top, bottom, extent, toY, toAngle, slot, left: 34, index: (x: number) => Math.floor((x - 34) / slot) };
  }

  private drawBars(canvas: HTMLCanvasElement, block: RingBlock, pose: RingPose, system: RingSystemInfo) {
    if (!canvas.isConnected || canvas.clientWidth === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const angles = this.angles(block, pose, system);
    const g = this.barGeometry(canvas, angles);
    ctx.fillStyle = '#0c0d11';
    ctx.fillRect(0, 0, g.width, g.height);
    ctx.font = '10px system-ui, sans-serif';
    for (let angle = -g.extent; angle <= g.extent; angle += 90) {
      const y = g.toY(angle);
      ctx.fillStyle = angle === 0 ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)';
      ctx.fillRect(g.left, Math.round(y), g.width - g.left - 4, 1);
      ctx.fillStyle = '#7d8394';
      ctx.fillText(`${String(angle)}°`, 2, y + 3);
    }
    const zero = g.toY(0);
    const editable = block.mode === 'tracks';
    angles.forEach((angle, i) => {
      const x = g.left + i * g.slot;
      const y = g.toY(angle);
      ctx.fillStyle = editable ? `hsl(${String(285 - i * 3)} 65% 62%)` : 'hsl(285 30% 50%)';
      ctx.fillRect(x + g.slot * 0.15, Math.min(y, zero), Math.max(1, g.slot * 0.7), Math.max(2, Math.abs(zero - y)));
      if (g.slot >= 16) {
        ctx.fillStyle = '#c9cdd8';
        ctx.fillText(String(i + 1), x + g.slot / 2 - 3, g.height - 4);
      }
    });
    ctx.fillStyle = '#c9cdd8';
    ctx.fillText(editable ? 'Углы колец (ближние слева) — тяните столбики' : 'Углы колец (ближние слева)', g.left, 10);
  }

  private bindBars(canvas: HTMLCanvasElement, block: RingBlock, system: RingSystemInfo) {
    if (block.mode !== 'tracks') return;
    const local = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const paint = (event: MouseEvent) => {
      const drag = this.barDrag;
      const pose = this.pose();
      if (drag === null || pose === undefined) return;
      const { x, y } = local(event);
      const g = this.barGeometry(canvas, drag.angles);
      const index = Math.max(0, Math.min(drag.angles.length - 1, g.index(x)));
      const raw = g.toAngle(y);
      const angle = event.shiftKey ? Math.round(raw) : Math.round(raw / 5) * 5;
      // (a quick drag across the bars sets every one it passes)
      const from = drag.last ?? index;
      for (let i = Math.min(from, index); i <= Math.max(from, index); i++) drag.angles[i] = angle;
      drag.last = index;
      this.drawBars(canvas, block, pose, system);
      const sketch = canvas.parentElement?.querySelector<HTMLCanvasElement>('.ring-sketch');
      if (sketch) this.drawSketch(sketch, block, pose, system);
    };
    const up = () => {
      window.removeEventListener('mousemove', paint);
      const drag = this.barDrag;
      this.barDrag = null;
      if (drag === null) return;
      const angles = drag.angles.map(round);
      this.changePose((item) => {
        item.shape = 'manual';
        item.manual = angles;
      });
    };
    canvas.addEventListener('mousedown', (event) => {
      const pose = this.pose();
      if (pose === undefined) return;
      // (starting from what the pose has now: its own shape's angles, not where the rings ended up)
      this.barDrag = { angles: poseAngles(pose, system.rings, 'tracks'), last: null };
      paint(event);
      window.addEventListener('mousemove', paint);
      window.addEventListener('mouseup', up, { once: true });
    });
  }
}

function shapeOf(pose: RingPose, block: RingBlock): PoseShape {
  return block.mode === 'event' && !EVENT_SHAPES.has(pose.shape) ? 'spiral' : pose.shape;
}

function note(text: string) {
  const element = document.createElement('div');
  element.className = 'gls-note';
  element.textContent = text;
  return element;
}

const round = (value: number) => Math.round(value * 100) / 100;
