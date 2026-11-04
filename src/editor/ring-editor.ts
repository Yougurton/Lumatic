import type { Editor } from './editor';
import { actionFor, comboOf } from './hotkeys';
import { button, check, holdWhileTyping, scrubStrip, shareStripView, speedControl, type StripLane, heading, labeled, numberInput, select, textInput, toggle } from './gls-editor';
import { easingPicker } from './easing-picker';
import { beatDrumStep, numberDrum } from './grids';
import { fillRingShape, ringSystemName } from './library';
import { newId } from './model';
import { absolutePose, dataFirstRing, poseBefore, MOTIONS, EVENT_SHAPES, firstRingFromLog, isTurn, isZoom, newPose, newRingBlock, newZoomBlock, poseAngles, ringDelay, poseBase, ringObjectNames, SHAPES, zoomPositions, type PoseShape, type RingBlock, type RingPose, type RingSystemInfo, type TurnWay, type ZoomSystemInfo } from './rings';

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

const WAYS: [TurnWay, string, string][] = [
  // (a short arc: the shorter way round; three quarters of a circle, an arrow on its end)
  ['short', 'Короче — в ту сторону, где ближе', '<path d="M6 15a7 7 0 0 1 12 0"/><path d="M3 12l3 3 3-3"/><path d="M15 12l3 3 3-3"/>'],
  ['ccw', 'Против часовой стрелки', '<path d="M17 6.5A7.5 7.5 0 1 0 19.5 12"/><path d="M12.5 3.5l4.5 3-3.5 4"/>'],
  ['cw', 'По часовой стрелке', '<path d="M7 6.5A7.5 7.5 0 1 1 4.5 12"/><path d="M11.5 3.5L7 6.5l3.5 4"/>'],
];

/** Which way round the rings turn: three icon buttons. */
function wayIcons(current: TurnWay, change: (value: TurnWay) => void) {
  const row = document.createElement('div');
  row.className = 'ins-buttons gls-toggle way-icons';
  for (const [value, title, path] of WAYS) {
    const element = button('', title, () => change(value));
    element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    if (value === current) element.classList.add('active');
    row.append(element);
  }
  return row;
}

export class RingEditor {
  private dock: HTMLElement | null = null;
  private blockId = '';
  private poseId: string | null = null;
  private keyHandler = (event: KeyboardEvent) => this.onKey(event);
  private resizeHandler = () => this.place();

  constructor(private readonly editor: Editor) {
    editor.ringEditorHook = (id) => this.open(id);
    editor.onChange((what) => {
      if (this.dock === null) return;
      if (this.block() === undefined) {
        this.close();
        return;
      }
      // (the grid changed: the drums of beats step by it)
      if (what === 'clips' || what === 'all' || what === 'grid') this.render();
    });
  }

  private block(): RingBlock | undefined {
    return this.editor.ringBlockById(this.blockId);
  }

  private pose(): RingPose | undefined {
    const block = this.block();
    return block?.poses.find((pose) => pose.id === this.poseId);
  }

  /** The pose the rings' pictures show: the picked one, else the last one the song has reached in
   *  the block (else its first). */
  private shownPose(block: RingBlock): RingPose | undefined {
    const picked = this.pose();
    if (picked !== undefined) return picked;
    const at = this.editor.playhead() - block.start;
    const sorted = [...block.poses].sort((a, b) => a.beat - b.beat);
    return [...sorted].reverse().find((pose) => pose.beat <= at + 1e-6) ?? sorted[0];
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
  }

  close() {
    if (this.dock === null) return;
    this.dock.remove();
    this.dock = null;
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
    event.stopImmediatePropagation();
  }

  /** One change to the block: an undo step, the view updated. */
  /** `fit`: made longer if its poses then run past its end (not when its length is what's set). */
  private change(patch: (block: RingBlock) => void, fit = true) {
    this.editor.updateRingBlock(
      this.blockId,
      (block) => {
        patch(block);
        // (changed by hand: no longer the steps or the glitch it was made from)
        delete block.steps;
        delete block.glitch;
      },
      fit,
    );
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
    if (holdWhileTyping(dock, () => this.render())) return;
    const scroll = [...dock.querySelectorAll<HTMLElement>('.gls-col')].map((col) => col.scrollTop);
    // (a drum being turned with the keys or the wheel keeps the focus in its new self)
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && dock.contains(active) ? active.dataset.wheelKey : undefined;
    dock.replaceChildren(this.header(block), scrubStrip(this.editor, () => this.block() ?? null, this.stripLane(), false));
    const body = document.createElement('div');
    body.className = 'gls-body ring-body';
    if (isZoom(block)) body.append(this.laneColumn(block), this.zoomColumn(block), this.zoomView(block));
    else {
      body.classList.add('ring-turn');
      body.append(this.laneColumn(block), this.poseColumn(block), this.turnColumn(block), this.viewColumn(block));
    }
    dock.append(body);
    [...dock.querySelectorAll<HTMLElement>('.gls-col')].forEach((col, index) => (col.scrollTop = scroll[index] ?? 0));
    if (focused !== undefined) dock.querySelector<HTMLElement>(`[data-wheel-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  /** The block of the other kind (poses ↔ zoom) where this one is: the one over it most — or a new one
   *  at its place and length. */
  private switchKind(block: RingBlock) {
    const zoom = !isZoom(block);
    const overlap = (other: RingBlock) => Math.min(block.end, other.end) - Math.max(block.start, other.start);
    const found = this.editor.ringBlocks
      .filter((other) => other !== block && (zoom ? isZoom(other) : isTurn(other)) && overlap(other) > 1e-6)
      .sort((a, b) => overlap(b) - overlap(a))[0];
    // (the strip zoomed as it was)
    if (found !== undefined) {
      shareStripView(block, found.id);
      this.open(found.id);
      return;
    }
    const zooms = this.editor.zoomInfo;
    const made = zoom ? newZoomBlock(zooms[0], block.start, block.end, zooms.length > 1 ? (zooms[0]?.name ?? '') : '') : newRingBlock(this.editor.ringInfo[0]?.name ?? '', 'event', block.start, block.end);
    this.editor.addRingBlock(made);
    shareStripView(block, made.id);
    this.open(made.id);
  }

  private header(block: RingBlock) {
    const head = document.createElement('div');
    head.className = 'gls-head';
    const title = document.createElement('span');
    title.className = 'gls-title';
    title.textContent = isZoom(block) ? 'Зум колец' : 'Позы колец';
    const name = textInput(block.name, (value) => this.change((item) => (item.name = value || item.name)));
    name.className = 'gls-name';
    const length = labeled('Длина, долей', numberInput(block.end - block.start, 0.25, (value) => this.change((item) => (item.end = item.start + Math.max(0.25, value)), false)));
    const play = button(this.editor.previewExtra !== null ? '■ Стоп' : '▶ Проиграть', 'Проиграть блок по кругу в окне просмотра (Пробел)', () => this.play());
    const done = button('Готово', 'Закрыть (Esc)', () => this.close());
    done.classList.add('primary');
    const spacer = document.createElement('span');
    spacer.className = 'gls-dim';
    // over to the other kind of block at the same place (the zoom of these poses, or the other way)
    const other = button(isZoom(block) ? '⇄ Позы колец' : '⇄ Зум колец', isZoom(block) ? 'К позам колец в этом же месте (нет — будут созданы)' : 'К зуму колец в этом же месте (нет — будет создан)', () => this.switchKind(block));
    if (isZoom(block)) {
      const zooms = this.editor.zoomInfo;
      const choices: [string, string][] = zooms.map((system) => [system.name, `${ringSystemName(system.name)} (${String(system.rings)})`]);
      if (zooms.length > 1) choices.unshift(['', 'Все системы колец']);
      const current = block.system === '' && zooms.length === 1 ? zooms[0]!.name : block.system;
      head.append(title, other, name, labeled('Кольца', select(choices, current, (value) => this.change((item) => (item.system = zooms.length === 1 ? '' : value)))), speedControl(this.editor), spacer, length, play, done);
      return head;
    }
    const systems = this.editor.ringInfo;
    const options: [string, string][] = systems.map((system) => [system.name, `${ringSystemName(system.name)} (${String(system.rings)})`]);
    if (systems.length > 1) options.unshift(['', 'Все системы колец']);
    const system = labeled('Кольца', select(options, block.system, (value) => this.change((item) => (item.system = value))));
    head.append(title, other, name, system, speedControl(this.editor), spacer, length, play, done);
    return head;
  }

  private laneColumn(block: RingBlock) {
    const col = document.createElement('div');
    col.className = 'gls-col';
    col.append(heading('Позы'));
    const hint = document.createElement('div');
    hint.className = 'gls-note';
    hint.textContent = 'Позы — на полосе с песней сверху: клик по нижней дорожке в блоке — новая поза, перетаскивание — сдвинуть, Delete — удалить. Ctrl+колесо или −/+ — масштаб, Shift+колесо — вдоль песни. Выбранная поза видна в окне просмотра.';
    col.append(hint);
    const list = document.createElement('div');
    list.className = 'ring-list';
    [...block.poses].sort((a, b) => a.beat - b.beat).forEach((pose, index) => {
      const row = document.createElement('div');
      row.className = `gls-box${pose.id === this.poseId ? ' active' : ''}`;
      const label = document.createElement('div');
      label.className = 'gls-box-name';
      label.textContent = isZoom(block) ? `${String(index + 1)}. Расстояние ${String(round(pose.step))}` : `${String(index + 1)}. ${SHAPES.find(([shape]) => shape === shapeOf(pose, block))?.[1] ?? ''} · ${pose.relative === true && pose.shape !== 'manual' ? `${pose.angle >= 0 ? '+' : '−'}${String(Math.abs(round(pose.angle)))}° от прошлой` : `${String(round(pose.angle))}°`}${pose.shape === 'spiral' ? (pose.relativeStep === true ? ` · шаг ${pose.step >= 0 ? '+' : '−'}${String(Math.abs(round(pose.step)))}° от прошлой` : ` +${String(round(pose.step))}°`) : ''}`;
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
    if (!isZoom(block) && this.editor.geometryRings.has(block.system)) {
      col.append(
        note(
          block.mode === 'tracks'
            ? 'Эти кольца построены из геометрии Chroma (Окружение → Детали и кольца): у каждого свой трек, позы работают у всех игроков и в любой версии игры.'
            : 'Эти кольца построены из геометрии Chroma: события вращения их не поворачивают — включите «Каждое кольцо отдельно».',
        ),
      );
    } else if (!isZoom(block) && block.mode === 'tracks') col.append(this.gameRings());
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

  /** Where a pose is in its block: a drum of quarters (sixths on a triplet grid). */
  private beatDrum(block: RingBlock, pose: RingPose) {
    const step = beatDrumStep(this.editor.snap);
    return numberDrum(`ring-beat:${pose.id}:${String(step)}`, pose.beat, (value) => this.changePose((item) => (item.beat = Math.max(0, value))), { step, min: 0, max: block.end - block.start + 16, beats: true });
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
    col.append(labeled('Доля (от начала блока)', this.beatDrum(block, pose)));
    // (ring events set the rings out evenly or as a spiral: those two)
    const shapes = SHAPES.filter(([shape]) => EVENT_SHAPES.has(shape));
    col.append(toggle(shapes, shapeOf(pose, block), (value) => this.changePose((item) => {
      if (value === 'manual' && item.shape !== 'manual') {
        // (by hand: each ring's own angle, where it ends up)
        item.manual = poseAngles(absolutePose(item, poseBefore(this.editor.ringBlocks, block, item)), this.system(block)?.rings ?? 1, block.mode).map(round);
        delete item.relative;
        delete item.relativeStep;
      }
      item.shape = value;
    })));
    const shape = shapeOf(pose, block);
    if (shape !== 'manual') {
      const relative = pose.relative === true;
      // (switching keeps where the rings end up: the angle becomes the turn there, or the other way)
      col.append(
        check('От прошлой позы (+ / −)', relative, (on) => {
          const base = poseBase(this.editor.ringBlocks, block, pose);
          this.changePose((item) => {
            item.angle = round(on ? item.angle - base : base + item.angle);
            if (on) item.relative = true;
            else delete item.relative;
          });
        }),
      );
      const label = relative ? (shape === 'wave' ? 'Средний угол: повернуть на, °' : 'Повернуть первое кольцо на, °') : shape === 'wave' ? 'Средний угол, °' : 'Угол первого кольца, °';
      // (a drum: 5° a notch — an exact angle typed in)
      col.append(labeled(label, numberDrum(`ring-angle:${pose.id}`, pose.angle, (value) => this.changePose((item) => (item.angle = value)), { step: 5, min: -720, max: 720, digits: 2 })));
      if (relative) {
        const base = poseBase(this.editor.ringBlocks, block, pose);
        col.append(note(`До неё первое кольцо стоит на ${String(round(base))}°, после — на ${String(round(base + pose.angle))}°.`));
      }
    }
    if (shape === 'spiral') {
      const relativeStep = pose.relativeStep === true;
      // (switching keeps the step the rings end up with: the step becomes what's added, or the other way)
      col.append(
        check('Шаг — от прошлой позы (+ / −)', relativeStep, (on) => {
          const before = poseBefore(this.editor.ringBlocks, block, pose).step;
          this.changePose((item) => {
            item.step = round(on ? item.step - before : before + item.step);
            if (on) item.relativeStep = true;
            else delete item.relativeStep;
          });
        }),
      );
      col.append(labeled(relativeStep ? 'Прибавить к шагу, °' : 'Шаг от кольца к кольцу, °', numberDrum(`ring-step:${pose.id}`, pose.step, (value) => this.changePose((item) => (item.step = value)), { step: 1, min: -360, max: 360, digits: 2 })));
      if (relativeStep) {
        const before = poseBefore(this.editor.ringBlocks, block, pose).step;
        col.append(note(`Шаг до неё — ${String(round(before))}°, после — ${String(round(before + pose.step))}°.`));
      }
    }
    if (shape === 'wave' || shape === 'alternate' || shape === 'random') col.append(labeled(shape === 'alternate' ? 'Каждое второе повёрнуто на, °' : 'Размах, °', numberDrum(`ring-swing:${pose.id}`, pose.step, (value) => this.changePose((item) => (item.step = value)), { step: 1, min: -360, max: 360, digits: 2 })));
    if (shape === 'wave') {
      col.append(labeled('Волн по кольцам', numberDrum(`ring-periods:${pose.id}`, pose.periods, (value) => this.changePose((item) => (item.periods = value)), { step: 0.25, min: -8, max: 8, digits: 3 })));
      col.append(labeled('Сдвиг волны, °', numberDrum(`ring-phase:${pose.id}`, pose.phase, (value) => this.changePose((item) => (item.phase = value)), { step: 5, min: -360, max: 360, digits: 2 })));
    }
    if (shape === 'random') col.append(button('🎲 Другой случай', 'Другие случайные углы', () => this.changePose((item) => (item.seed = Math.floor(Math.random() * 1e6)))));
    col.append(button('Удалить позу', 'Delete', () => this.deletePose(), block.poses.length <= 1));
    return col;
  }

  /** How the rings turn to the picked pose: which way, how long, the wave over them, the motion. */
  private turnColumn(block: RingBlock) {
    const col = document.createElement('div');
    col.className = 'gls-col';
    col.append(heading('Поворот к позе'));
    const pose = this.pose();
    if (pose === undefined) return col;
    col.append(wayIcons(pose.way, (value) => this.changePose((item) => (item.way = value))));
    col.append(labeled('Целых оборотов сверху', numberDrum(`ring-loops:${pose.id}`, pose.loops, (value) => this.changePose((item) => (item.loops = Math.max(0, Math.round(value)))), { step: 1, min: 0, max: 32 })));
    col.append(labeled('Время поворота, долей (0 — сразу)', numberDrum(`ring-duration:${pose.id}:${String(beatDrumStep(this.editor.snap))}`, pose.duration, (value) => this.changePose((item) => (item.duration = Math.max(0, value))), { step: beatDrumStep(this.editor.snap), min: 0, max: 64, beats: true })));
    col.append(labeled('Волна по кольцам, долей (0 — все разом)', numberDrum(`ring-delay:${pose.id}:${String(beatDrumStep(this.editor.snap))}`, pose.delay, (value) => this.changePose((item) => (item.delay = Math.max(0, value))), { step: beatDrumStep(this.editor.snap), min: 0, max: 8, beats: true })));
    if (pose.delay > 0) col.append(note('Волна идёт от ближних колец к дальним.'));
    // (the game's own closing in, or an easing made of short ring events)
    col.append(this.motionPick(pose));
    void block;
    return col;
  }

  /** How a pose's move goes: the game's own (one event: fastest at once, slower every tick of the
   *  game's — jerky when quick), or along an easing (events leading the rings smoothly). */
  private motionPick(pose: RingPose) {
    const wrap = document.createElement('div');
    wrap.append(
      labeled(
        'Движение',
        easingPicker(MOTIONS(), pose.eventEasing ?? '', (value) =>
          this.changePose((item) => {
            if (value === '') delete item.eventEasing;
            else item.eventEasing = value;
          }),
        ),
      ),
    );
    const block = this.block();
    if (block !== undefined && block.poses.length > 1 && block.poses.some((item) => (item.eventEasing ?? '') !== (pose.eventEasing ?? '')))
      wrap.append(
        button('Так же у всех поз блока', 'Поставить это движение всем позам этого блока', () =>
          this.change((item) => {
            for (const each of item.poses) {
              if ((pose.eventEasing ?? '') === '') delete each.eventEasing;
              else each.eventEasing = pose.eventEasing;
            }
          }),
        ),
      );
    if ((pose.eventEasing ?? '') === '' && pose.duration > 0) wrap.append(note('Короткие быстрые переходы «как в игре» в игре выглядят рывками: игра двигает кольца ~30 раз в секунду, каждый раз заметно медленнее. Плавнее всего — «Разгон и торможение» или «Мягко (синус)».'));
    return wrap;
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
    const pose = this.shownPose(block);
    const views = document.createElement('div');
    views.className = 'ring-views';
    const sketch = document.createElement('canvas');
    sketch.className = 'ring-sketch';
    sketch.title = 'Кольца, как их видно с платформы: ближние крупнее (форма колец условная)';
    views.append(sketch);
    col.append(views);
    if (pose !== undefined) {
      // (drawn whenever its size changes — at first it may not have one yet; something going wrong
      // in the drawing: logged, the rings drawn plainly instead of nothing)
      redrawOnResize(sketch, () => {
        try {
          this.drawSketch(sketch, block, pose, system);
        } catch (error) {
          console.error('[lumatic] ring sketch failed', error);
          this.drawSketch(sketch, block, pose, system, true);
        }
      });
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
    col.append(labeled('Доля (от начала блока)', this.beatDrum(block, pose)));
    // (spacings a tenth apart; the game's own ones — squeezed, at the start, stretched — among them)
    col.append(labeled('Расстояние между кольцами', numberDrum(`zoom-step:${pose.id}`, pose.step, (value) => this.changePose((item) => (item.step = round(value))), { step: 0.1, min: -20, max: 40, digits: 2 })));
    if (system !== undefined) col.append(note(`В игре: сжато — ${String(round(system.position.minPositionStep))}, в начале — ${String(round(system.initialStep))}, растянуто — ${String(round(system.position.maxPositionStep))}.`));
    col.append(heading('Переход'));
    col.append(labeled('Время перехода, долей (0 — сразу)', numberDrum(`zoom-duration:${pose.id}:${String(beatDrumStep(this.editor.snap))}`, pose.duration, (value) => this.changePose((item) => (item.duration = Math.max(0, value))), { step: beatDrumStep(this.editor.snap), min: 0, max: 64, beats: true })));
    col.append(this.motionPick(pose));
    col.append(note('Событие зума задаёт расстояние сразу, а не прибавляет его, — поза всегда точная.'));
    col.append(button('Удалить позу', 'Delete', () => this.deletePose(), block.poses.length <= 1));
    return col;
  }

  /** The rings from the side: where each stands at the picked pose, faint — at the one before. */
  private zoomView(block: RingBlock) {
    const col = document.createElement('div');
    col.className = 'gls-col ring-view';
    col.append(heading('Кольца сбоку'));
    const system = this.zoomSystem(block);
    const pose = this.shownPose(block);
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
      redrawOnResize(canvas, () => this.drawSide(canvas, system, pose.step, before?.step ?? system.initialStep));
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

  /** The poses on the strip of the song above: drawn on the song's own beats, picked, moved and made
   *  there. */
  private stripLane(): StripLane {
    const snap = (beat: number) => {
      const step = this.editor.snap > 0 ? this.editor.snap : 0;
      return Math.max(0, step > 0 ? Math.round(beat / step) * step : beat);
    };
    return {
      height: 56,
      key: () => {
        const block = this.block();
        return block === undefined ? '' : `${JSON.stringify(block.poses)} ${String(this.poseId)} ${String(block.start)} ${String(block.end)}`;
      },
      draw: (ctx, x, top, height) => {
        const block = this.block();
        if (block !== undefined) this.drawPoses(ctx, block, x, top, height);
      },
      press: (beat, at, place) => {
        const block = this.block();
        if (block === undefined) return null;
        // (a pose is picked where it's drawn: the angle's circle; the zoom's bars, reaching right)
        const widest = Math.max(1e-3, ...block.poses.map((pose) => Math.abs(pose.step)));
        const reach = (pose: RingPose) => (isZoom(block) ? 3 * (2 + (Math.abs(pose.step) / widest) * 6) + 6 : 11);
        const hit = block.poses
          .map((pose) => {
            const px = place(block.start + pose.beat);
            return { pose, d: at < px ? px - at : Math.max(0, at - px - reach(pose) + 11) };
          })
          .filter((entry) => entry.d <= 11)
          .sort((a, b) => a.d - b.d)[0];
        if (hit !== undefined) {
          // picked; dragged — moved (one undo step when let go)
          const id = hit.pose.id;
          const origin = hit.pose.beat;
          this.poseId = id;
          let moved = false;
          return {
            move: (next, x) => {
              if (!moved && Math.abs(x - at) < 4) return;
              moved = true;
              const pose = this.block()?.poses.find((item) => item.id === id);
              // (past the block's end too: it grows to take it)
              if (pose !== undefined) pose.beat = snap(next - block.start);
            },
            up: () => {
              if (!moved) {
                this.render();
                this.showPose();
                return;
              }
              const pose = this.block()?.poses.find((item) => item.id === id);
              const to = pose?.beat ?? origin;
              if (pose !== undefined) pose.beat = origin;
              this.changePose((item) => (item.beat = to));
              this.render();
            },
          };
        }
        // before the block: the song's cursor goes there, as on the strip above (past its end: a pose
        // there, the block made long enough for it)
        if (beat < block.start - 1e-6) return null;
        // a new pose here: like the one before it
        const local = snap(beat - block.start);
        const before = [...block.poses].filter((pose) => pose.beat <= local).sort((a, b) => b.beat - a.beat)[0];
        const pose = before === undefined ? newPose(local, isZoom(block) ? { step: round(this.zoomSystem(block)?.initialStep ?? 2) } : {}) : { ...structuredClone(before), id: newId('p'), beat: local };
        this.poseId = pose.id;
        this.change((item) => item.poses.push(pose));
        this.render();
        return { move: () => undefined, up: () => undefined };
      },
    };
  }

  /** The block's poses on the strip's lane: each at its beat, its turn's time after it, its angle. */
  private drawPoses(ctx: CanvasRenderingContext2D, block: RingBlock, x: (beat: number) => number, top: number, height: number) {
    const cy = top + height / 2 - 4;
    const widest = Math.max(1e-3, ...block.poses.map((pose) => Math.abs(pose.step)));
    ctx.font = '10px system-ui, sans-serif';
    for (const pose of [...block.poses].sort((a, b) => a.beat - b.beat)) {
      const px = x(block.start + pose.beat);
      const span = x(block.start + pose.beat + this.reached(block, pose)) - px;
      ctx.fillStyle = isZoom(block) ? 'rgba(120,210,255,0.25)' : 'rgba(183,140,255,0.25)';
      ctx.fillRect(px, cy - 2, Math.max(0, span), 4);
      const selected = pose.id === this.poseId;
      if (isZoom(block)) {
        // (bars a pose's spacing apart)
        const gap = 2 + (Math.abs(pose.step) / widest) * 6;
        ctx.fillStyle = selected ? '#ffffff' : '#7fd4ff';
        for (let k = 0; k < 4; k++) ctx.fillRect(px - 1 + k * gap, cy - 9, selected ? 2 : 1.5, 18);
        ctx.fillStyle = '#c9cdd8';
        ctx.fillText(String(round(pose.step)), px + 4 * gap + 2, cy + 20);
        continue;
      }
      ctx.fillStyle = '#0f1014';
      ctx.strokeStyle = selected ? '#ffffff' : '#b78cff';
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(px, cy, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const relative = pose.relative === true && pose.shape !== 'manual';
      const angle = ((relative ? poseBase(this.editor.ringBlocks, block, pose) + pose.angle : pose.angle) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(px, cy);
      ctx.lineTo(px - Math.sin(angle) * 10, cy - Math.cos(angle) * 10);
      ctx.stroke();
      ctx.fillStyle = '#c9cdd8';
      ctx.fillText(relative ? `${pose.angle >= 0 ? '+' : '−'}${String(Math.abs(round(pose.angle)))}°` : `${String(round(pose.angle))}°`, px - 8, cy + 23);
    }
  }

  // ----- the rings -------------------------------------------------------------------------------------

  /** The angles the picked pose gives the rings (as they will stand), or the bars being dragged. */
  private angles(block: RingBlock, pose: RingPose, system: RingSystemInfo) {
    return poseAngles(absolutePose(pose, poseBefore(this.editor.ringBlocks, block, pose)), system.rings, block.mode);
  }

  /** `plain`: squares at the pose's angles, nothing more (the fallback when drawing failed). */
  private drawSketch(canvas: HTMLCanvasElement, block: RingBlock, pose: RingPose, system: RingSystemInfo, plain = false) {
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
    let angles: readonly number[];
    try {
      angles = this.angles(block, pose, system);
    } catch {
      angles = Array.from({ length: system.rings }, () => 0);
    }
    const cx = width / 2;
    const cy = height / 2;
    const near = Math.min(width, height) * 0.46;
    // (the environment's own ring shape — squares when it has none to show)
    const index = plain ? -1 : this.editor.preview.ringSystems().findIndex((item) => item.name === system.name);
    const shape = index < 0 ? null : this.editor.preview.ringOutline(index);
    // (far rings first: drawn small and dim, the near ones over them)
    for (let i = angles.length - 1; i >= 0; i--) {
      const size = near / (1 + i * 0.18);
      const light = 75 - (i / Math.max(1, angles.length - 1)) * 45;
      ctx.save();
      ctx.translate(cx, cy);
      // (a larger angle turns a ring counterclockwise as the player sees it)
      const angle = angles[i] ?? 0;
      ctx.rotate(-((Number.isFinite(angle) ? angle : 0) * Math.PI) / 180);
      ctx.strokeStyle = `hsl(${String(285 - i * 3)} 70% ${String(light)}%)`;
      ctx.lineWidth = Math.max(1, 3.2 - i * 0.12);
      if (shape !== null) {
        ctx.fillStyle = ctx.strokeStyle;
        fillRingShape(ctx, shape, size / 2);
        ctx.restore();
        continue;
      }
      ctx.strokeRect(-size / 2, -size / 2, size, size);
      // a notch on the top edge: which way is up for this ring
      ctx.beginPath();
      ctx.moveTo(0, -size / 2);
      ctx.lineTo(0, -size / 2 + Math.max(3, size * 0.06));
      ctx.stroke();
      ctx.restore();
    }
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

/** A canvas drawn now (next frame) and again whenever its size changes, until it leaves the page. */
function redrawOnResize(canvas: HTMLCanvasElement, draw: () => void) {
  requestAnimationFrame(draw);
  let size = '';
  const observer = new ResizeObserver(() => {
    if (!canvas.isConnected) {
      observer.disconnect();
      return;
    }
    const now = `${String(canvas.clientWidth)}x${String(canvas.clientHeight)}`;
    if (now === size || canvas.clientWidth === 0) return;
    size = now;
    draw();
  });
  observer.observe(canvas);
}
