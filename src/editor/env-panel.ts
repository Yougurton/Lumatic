import type { EnvironmentData } from '../engine/renderer/environment/types';
import type { Editor } from './editor';
import type { SceneNode } from './env-scene';
import { MOTION_NAMES } from './anim-lanes';
import { checkScene } from './env-checks';
import { exportEnvironmentDialog, galleryDialog, importEnvironmentFile, settingsDialog } from './env-share';
import { ANIM_PARTS, ALL_PARTS, animRuns, hasKeys, isPeriodic, MOTION_KINDS, type AnimPart, type SceneMotion } from './env-anim';
import { EASINGS } from './rings';
import { ARRAY_KINDS, arrayCount, defaultArray, mirrored, type ArrayKind, type SceneArray } from './env-array';
import { copyName, expandObjects, isLightShader, modsFragment, materialCommand, objectCommand, sceneCommand, SHADERS, SHAPES, type SceneMaterial, type SceneObject, type Shader, type Shape } from './environment-mods';
import { numberDrum } from './grids';
import { tr } from './i18n';
import { showMenu } from './menu';
import { newId } from './model';
import { classicGroupName } from './names';

export const SHAPE_NAMES: Record<Shape, string> = { Cube: 'Куб', Sphere: 'Сфера', Cylinder: 'Цилиндр', Capsule: 'Капсула', Plane: 'Плоскость', Quad: 'Квадрат', Triangle: 'Треугольник' };
const SHADER_NAMES: Record<Shader, string> = {
  Standard: 'Обычный',
  Glowing: 'Светящийся',
  OpaqueLight: 'Лампа (непрозрачная)',
  TransparentLight: 'Лампа (прозрачная)',
  BaseWater: 'Вода',
  BTSPillar: 'Колонна BTS',
  BillieWater: 'Вода Billie',
  WaterfallMirror: 'Зеркало-водопад',
  InterscopeConcrete: 'Бетон',
  InterscopeCar: 'Машина',
};

const ARRAY_NAMES: Record<ArrayKind, string> = { row: 'Ряд', circle: 'По кругу', grid: 'Сетка', line: 'Вдоль линии', scatter: 'Россыпь' };
/** How a material's kind looks on its tile (a rough picture of it). */
const SHADER_LOOK: Record<Shader, string> = {
  Standard: 'linear-gradient(135deg, #8a8d96, #3c3f47)',
  Glowing: 'radial-gradient(circle at 50% 45%, #ffffff, #9fd0ff 55%, #2b4a6b)',
  OpaqueLight: 'linear-gradient(90deg, #15171c 30%, #ffe9a8 42%, #fff 50%, #ffe9a8 58%, #15171c 70%)',
  TransparentLight: 'linear-gradient(90deg, transparent 30%, rgba(160,220,255,0.75) 50%, transparent 70%), repeating-conic-gradient(#22252c 0 25%, #2d3038 0 50%) 0 0 / 10px 10px',
  BaseWater: 'linear-gradient(180deg, #0c2a44, #1f6f9c 60%, #7fd0e8)',
  BTSPillar: 'linear-gradient(90deg, #2a1838, #b06ad0 50%, #2a1838)',
  BillieWater: 'linear-gradient(180deg, #10201c, #2f6f5c 60%, #9fe0c0)',
  WaterfallMirror: 'linear-gradient(160deg, #dfe8f0, #6f8090 45%, #e8f0f8 55%, #50606c)',
  InterscopeConcrete: 'repeating-linear-gradient(45deg, #6c6a66 0 4px, #605e5a 4px 8px)',
  InterscopeCar: 'linear-gradient(160deg, #c02030, #50080f 60%, #ff8090)',
};

/** The player's colours a material can take. */
const PLAYER_COLORS: [string, string][] = [
  ['', 'нет — свой цвет'],
  ['baseNote0Color', 'левые ноты'],
  ['baseNote1Color', 'правые ноты'],
  ['baseSaberAColor', 'левая сабля'],
  ['baseSaberBColor', 'правая сабля'],
  ['baseObstaclesColor', 'стены'],
  ['baseEnvironmentColor0', 'левый свет'],
  ['baseEnvironmentColor1', 'правый свет'],
  ['baseEnvironmentColorW', 'белый свет'],
];

const hex = (color: readonly number[]) => `#${color.slice(0, 3).map((value) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (value: string): [number, number, number] => [1, 3, 5].map((at) => Math.round((Number.parseInt(value.slice(at, at + 2), 16) / 255) * 1000) / 1000) as [number, number, number];
/** A name without its number among its like: "Light (4)" → "Light". */
const baseName = (name: string) => name.replace(/ \(\d+\)$/u, '');

/**
 * The Environment side's panels. Left: the scene — the objects added (copies, shapes), the materials,
 * and the game's environment as a tree (search, the changed ones only; a click picks, Ctrl adds or
 * takes off, Shift picks all from the last one to this; the eye hides an object in the game). Right:
 * what's picked — where it stands, how it's turned and sized (drums: every picked one changed by as
 * much), its shape, material and lamp, a material's look — and how it's written into the map.
 */
export class EnvPanel {
  private data: EnvironmentData | null = null;
  private dataFor = '';
  private readonly open = new Set<number>();
  private search = '';
  private changedOnly = false;
  private readonly list = document.createElement('div');
  private readonly count = document.createElement('div');
  /** The scene's check: what's wrong with it. */
  private readonly checks = document.createElement('details');
  private shownKey = '';
  /** What the right panel was drawn for (the same again: it stays scrolled where it was). */
  private inspectorShows = '';
  /** The keys of the tree's lines as shown, top to bottom (Shift picks a stretch of them). */
  private order: string[] = [];
  /** The line a Shift + click's stretch starts from (the last one clicked plainly). */
  private anchor: string | null = null;
  /** The material being looked at on the right (null: the picked objects are). */
  private material: string | null = null;
  private inspectorTab: 'object' | 'animation' | 'more' = 'object';
  /** "By a rule" among the like ones: every which, from which, to which (0: the last). */
  private rule = { every: 2, from: 1, to: 0 };
  /** Makes a shape in front of the camera (set by main: it knows the view). */
  placeAhead: () => [number, number, number] = () => [0, 1.5, 6];

  constructor(
    private readonly editor: Editor,
    sceneRoot: HTMLElement,
    private readonly inspectorRoot: HTMLElement,
  ) {
    sceneRoot.classList.add('env-scene');
    const head = document.createElement('div');
    head.className = 'env-head';
    const search = Object.assign(document.createElement('input'), { type: 'search', placeholder: 'Поиск по имени объекта' });
    search.addEventListener('input', () => {
      this.search = search.value.trim().toLowerCase();
      this.render();
    });
    const changed = document.createElement('label');
    changed.className = 'adjust-check';
    changed.title = 'Показать только объекты, которые вы изменили или скрыли';
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
    box.addEventListener('change', () => {
      this.changedOnly = box.checked;
      this.render();
    });
    changed.append(box, ' Только изменённые');
    const take = Object.assign(document.createElement('button'), { type: 'button', textContent: '☰ Окружение ▾', title: 'Записи карты, файлы окружения Chroma, галерея сцен, рекомендованные настройки' });
    take.addEventListener('click', () => {
      const rect = take.getBoundingClientRect();
      setTimeout(() =>
        showMenu(rect.left, rect.bottom + 2, [
          { label: '⤓ Взять записи карты', hint: 'сделанные не в Lumatic', action: () => void editor.importMapEnvironment() },
          null,
          { label: '⤒ Сохранить как окружение Chroma…', hint: '.dat для UserData/Chroma/Environments', action: () => void exportEnvironmentDialog(editor) },
          { label: '⤓ Загрузить окружение Chroma…', hint: 'из файла .dat', action: () => importEnvironmentFile(editor) },
          { label: '🖼 Галерея сцен…', hint: 'сохранить и применить к другим картам', action: () => galleryDialog(editor) },
          null,
          { label: '⚙ Рекомендованные настройки…', hint: 'Settings Setter, Info.dat', action: () => void settingsDialog(editor) },
        ]),
      );
    });
    head.append(search, changed, take);
    this.list.className = 'env-tree';
    this.count.className = 'nm-dim env-count';
    this.checks.className = 'env-checks';
    sceneRoot.append(head, this.list, this.checks);
    editor.onChange(() => void this.refresh());
  }

  private render() {
    this.shownKey = '';
    void this.refresh();
  }

  /** The environment as the game has it (before the map's changes), loaded when the side is opened or
   *  the map's environment is another. */
  private async refresh() {
    const editor = this.editor;
    if (!editor.envMode || editor.project === null) return;
    const id = editor.row?.environmentId ?? 'DefaultEnvironment';
    if (id !== this.dataFor) {
      this.dataFor = id;
      this.data = null;
      this.list.replaceChildren(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr('Загружаю окружение…') }));
      try {
        const data = await editor.environmentSource(id);
        if (this.dataFor !== id) return;
        this.data = data;
        editor.envSceneData = data;
        this.open.clear();
        // (the top holders opened: what's inside the environment shows at once)
        for (const root of editor.envTree()?.roots ?? []) this.open.add(root);
      } catch (error) {
        console.error(error);
        this.list.replaceChildren(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr('Не удалось загрузить окружение') }));
        return;
      }
      this.shownKey = '';
    }
    if (this.material !== null && editor.sceneMaterials()[this.material] === undefined) this.material = null;
    document.body.classList.toggle('env-has-selection', editor.envSelection.length > 0 || this.material !== null);
    editor.envMaterialOpen = this.material;
    // (an animated thing picked: its numbers follow the song — when it stands still)
    const moving = !editor.isPlaying() && [...editor.envSelection, ...(this.material === null ? [] : [`m:${this.material}`])].some((item) => editor.animOf(item) !== undefined || editor.linkParentOf(item) !== null || editor.motionsOf(item).length > 0) ? editor.playhead().toFixed(3) : '';
    const key = `${moving}|${String(editor.motionSelection)}|${[...editor.curveRows.keys()].join(',')}|${String(editor.linkPicking)}|${[...editor.animSelection].join(',')}|${JSON.stringify(editor.envSelection)}|${JSON.stringify(editor.project.environmentMods ?? {})}|${this.search}|${String(this.changedOnly)}|${[...this.open].join(',')}|${String(this.material)}|${JSON.stringify([...editor.lightsByType.keys()])}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    // (drawn anew: left scrolled where they were)
    const scrolled = [this.list, this.inspectorRoot].map((item) => item.scrollTop);
    const shows = `${JSON.stringify(this.editor.envSelection)}|${String(this.material)}`;
    this.renderTree();
    this.renderInspector();
    this.list.scrollTop = scrolled[0]!;
    if (shows === this.inspectorShows) this.inspectorRoot.scrollTop = scrolled[1]!;
    this.inspectorShows = shows;
  }

  /** Opens a material on the right. */
  openMaterial(name: string) {
    this.material = name;
    this.render();
  }

  /** The tree opened down to a picked thing (picked in the 3D view) and scrolled to it. */
  reveal(key: string) {
    this.material = null;
    this.anchor = key;
    const nodes = this.editor.envTree()?.nodes;
    if (key.startsWith('g:') && nodes !== undefined) for (let at = nodes.get(Number(key.slice(2)))?.parent ?? -1; at >= 0; at = nodes.get(at)?.parent ?? -1) this.open.add(at);
    this.shownKey = '';
    void this.refresh().then(() => this.list.querySelector('.env-node.picked')?.scrollIntoView({ block: 'nearest' }));
  }

  /** A click on a line: picked alone; Ctrl: added or taken off; Shift: all from the last one to it. */
  private click(key: string, event: MouseEvent) {
    const editor = this.editor;
    // (the parent being picked: this one)
    if (editor.linkPicking !== null) {
      editor.setLinkParent(editor.linkPicking, key);
      return;
    }
    this.material = null;
    if (event.shiftKey && this.anchor !== null && this.order.includes(this.anchor) && this.order.includes(key)) {
      const [a, b] = [this.order.indexOf(this.anchor), this.order.indexOf(key)];
      const stretch = this.order.slice(Math.min(a, b), Math.max(a, b) + 1);
      // (the one clicked first stays the first: the handles are on it)
      const ordered = a <= b ? stretch : [...stretch].reverse();
      editor.selectEnv(ordered, event.ctrlKey || event.metaKey ? 'add' : 'replace');
      return;
    }
    this.anchor = key;
    editor.selectEnv([key], event.ctrlKey || event.metaKey ? 'toggle' : 'replace');
  }

  private editOf(node: SceneNode) {
    return node.id === null ? undefined : this.editor.sceneEdits().find((edit) => edit.id === node.id);
  }

  private renderTree() {
    const editor = this.editor;
    const tree = editor.envTree();
    const rows: HTMLElement[] = [];
    const order: string[] = [];
    const picked = new Set(editor.envSelection);
    const heading = (text: string, extra?: HTMLElement) => {
      const line = Object.assign(document.createElement('div'), { className: 'env-section', textContent: text });
      if (extra !== undefined) line.append(extra);
      rows.push(line);
    };
    const eyeButton = (hidden: boolean, enabled: boolean, toggle: () => void) => {
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'env-eye';
      eye.textContent = hidden ? '◌' : '👁';
      eye.title = hidden ? 'Скрыт в игре. Показать' : 'Скрыть объект в игре';
      eye.disabled = !enabled;
      eye.addEventListener('click', (event) => {
        event.stopPropagation();
        toggle();
      });
      return eye;
    };
    const lockButton = (locked: boolean, toggle: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'env-eye';
      button.textContent = locked ? '🔒' : '🔓';
      button.title = locked ? 'Запрещён выбор в 3D. Разблокировать' : 'Запретить выбор в 3D (в дереве выбирать можно)';
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggle();
      });
      return button;
    };
    const fits = (name: string) => this.search === '' || name.toLowerCase().includes(this.search);

    // the added objects
    const objects = editor.sceneObjects().filter((object) => fits(object.name));
    if (objects.length > 0) {
      heading(tr('Мои объекты'));
      for (const object of objects) {
        const key = `o:${object.uid}`;
        const line = document.createElement('div');
        line.className = 'env-node';
        line.classList.toggle('picked', picked.has(key) && this.material === null);
        line.classList.toggle('hidden-object', object.hidden === true);
        const material = object.material === undefined ? undefined : editor.sceneMaterials()[object.material];
        const mark = Object.assign(document.createElement('span'), { className: 'env-twist', textContent: object.kind === 'copy' ? '⧉' : material !== undefined && isLightShader(material.shader) ? '💡' : '◼' });
        const name = Object.assign(document.createElement('span'), { className: 'env-name', textContent: object.name });
        const many = Object.assign(document.createElement('span'), { className: 'env-marks', textContent: `${this.motionMarks(key)}${object.array === undefined ? '' : ` ${tr(ARRAY_NAMES[object.array.kind])} ×${String(arrayCount(object.array))}`}` });
        line.append(mark, name, many, eyeButton(object.hidden === true, true, () => editor.applyScene([key], (_key, now) => ({ hidden: !now.hidden }))), lockButton(object.locked === true, () => editor.applyScene([key], (_key, now) => ({ locked: now.locked !== true }))));
        line.addEventListener('click', (event) => this.click(key, event));
        line.addEventListener('contextmenu', (event) => this.menu(event, key));
        rows.push(line);
        order.push(key);
      }
    }
    // the materials
    const materials = Object.entries(editor.sceneMaterials());
    if (materials.length > 0 && this.search === '' && !this.changedOnly) {
      heading(tr('Материалы'));
      for (const [name, material] of materials) {
        const line = document.createElement('div');
        line.className = 'env-node';
        line.classList.toggle('picked', this.material === name);
        const swatch = Object.assign(document.createElement('span'), { className: 'env-swatch' });
        swatch.style.background = hex(material.color);
        const used = editor.sceneObjects().filter((object) => object.material === name).length;
        line.append(swatch, Object.assign(document.createElement('span'), { className: 'env-name', textContent: name }), Object.assign(document.createElement('span'), { className: 'env-marks', textContent: `${tr(SHADER_NAMES[material.shader])} · ${String(used)}` }));
        line.addEventListener('click', () => {
          this.material = name;
          this.render();
        });
        rows.push(line);
      }
    }
    // the fog, the player
    if (this.search === '' && !this.changedOnly) {
      heading(tr('Особые'));
      for (const [key, icon, text] of [['f:fog', '🌫', 'Туман'], ['p:player', '🧍', 'Игрок']] as const) {
        const line = document.createElement('div');
        line.className = 'env-node';
        line.classList.toggle('picked', picked.has(key) && this.material === null);
        line.append(Object.assign(document.createElement('span'), { className: 'env-twist', textContent: icon }), Object.assign(document.createElement('span'), { className: 'env-name', textContent: tr(text) }), Object.assign(document.createElement('span'), { className: 'env-marks', textContent: this.motionMarks(key) }));
        line.addEventListener('click', (event) => {
          if (editor.linkPicking !== null) return editor.setLinkParent(editor.linkPicking, key);
          this.material = null;
          this.anchor = null;
          editor.selectEnv([key], event.ctrlKey || event.metaKey ? 'toggle' : 'replace');
        });
        rows.push(line);
      }
    }
    // the game's environment
    heading(tr('Окружение игры'));
    if (tree !== null) {
      const edited = new Set(editor.sceneEdits().map((edit) => edit.id));
      const row = (node: SceneNode, depth: number, flat: boolean) => {
        const key = `g:${String(node.index)}`;
        const edit = this.editOf(node);
        const line = document.createElement('div');
        line.className = 'env-node';
        line.classList.toggle('picked', picked.has(key) && this.material === null);
        line.classList.toggle('hidden-object', edit?.hidden === true);
        line.classList.toggle('no-id', node.id === null);
        line.style.paddingLeft = `${String(4 + depth * 12)}px`;
        const twist = document.createElement('span');
        twist.className = 'env-twist';
        twist.textContent = flat || node.children.length === 0 ? '' : this.open.has(node.index) ? '▾' : '▸';
        twist.addEventListener('click', (event) => {
          event.stopPropagation();
          // (one of several picked: all of them opened or closed together)
          const opening = !this.open.has(node.index);
          const together = picked.has(key) ? editor.envSelection.filter((item) => item.startsWith('g:')).map((item) => Number(item.slice(2))) : [node.index];
          for (const index of together) {
            if (opening) this.open.add(index);
            else this.open.delete(index);
          }
          this.render();
        });
        const name = Object.assign(document.createElement('span'), { className: 'env-name', textContent: node.name });
        name.title = node.id ?? tr('У объекта нет id для Chroma: его нельзя изменить');
        const changedMark = edit !== undefined && (edit.position !== undefined || edit.rotation !== undefined || edit.scale !== undefined);
        const marks = Object.assign(document.createElement('span'), { className: 'env-marks', textContent: `${this.motionMarks(key)}${changedMark ? '✎' : ''}${node.below > 0 && !flat ? ` ${String(node.below)}` : ''}` });
        line.append(twist, name, marks, eyeButton(edit?.hidden === true, node.id !== null, () => editor.applyScene([key], (_key, now) => ({ hidden: !now.hidden }))), lockButton(edit?.locked === true, () => editor.applyScene([key], (_key, now) => ({ locked: now.locked !== true }))));
        line.addEventListener('click', (event) => this.click(key, event));
        line.addEventListener('contextmenu', (event) => this.menu(event, key));
        rows.push(line);
        order.push(key);
      };
      const before = rows.length;
      if (this.search !== '' || this.changedOnly) {
        // (a flat list of what fits: at most 300 lines)
        for (const node of tree.nodes.values()) {
          if (!fits(node.name) || (this.changedOnly && (node.id === null || !edited.has(node.id)))) continue;
          row(node, 0, true);
          if (rows.length - before >= 300) break;
        }
      } else {
        const walk = (index: number, depth: number) => {
          const node = tree.nodes.get(index);
          if (node === undefined) return;
          row(node, depth, false);
          if (this.open.has(index)) for (const child of node.children) walk(child, depth + 1);
        };
        for (const root of tree.roots) walk(root, 0);
      }
      if (rows.length === before) rows.push(Object.assign(document.createElement('div'), { className: 'nm-dim env-empty', textContent: tr('Ничего не найдено') }));
    }
    this.order = order;
    this.list.replaceChildren(...rows);
    this.renderChecks();
  }

  /** The load (coloured: fine, a lot, heavy for Quest) and the check's findings (a click: the thing). */
  private renderChecks() {
    const editor = this.editor;
    const mods = editor.project?.environmentMods ?? {};
    const tree = editor.envTree();
    const knownIds = new Set([...(tree?.nodes.values() ?? [])].flatMap((node) => (node.id === null ? [] : [node.id])));
    let events = 0;
    try {
      events = modsFragment(mods, editor.envSceneData).customEvents.length;
    } catch {
      events = 0;
    }
    const difficulty = editor.row?.difficulty;
    const environmentEntries = difficulty === undefined ? undefined : (difficulty.chromaEnvironment?.enhancements as unknown as readonly Record<string, unknown>[] | undefined);
    const { issues, load } = checkScene({ mods, knownIds, gameLights: editor.lightsByType, events, environmentEntries });
    this.count.replaceChildren();
    this.count.title = tr('Нагрузка сцены: зелёный — нормально, жёлтый — много, красный — тяжело для Quest');
    const shortNames = ['O', 'M', 'L', 'E'];
    load.forEach((item, at) => {
      if (at > 0) this.count.append(' · ');
      this.count.append(Object.assign(document.createElement('span'), { className: `env-load ${item.level}`, textContent: `${shortNames[at] ?? '?'} ${String(item.value)}` }));
    });
    const open = this.checks.open;
    this.checks.replaceChildren();
    this.checks.hidden = false;
    const worst = issues.some((issue) => issue.level === 'error') ? 'error' : issues.some((issue) => issue.level === 'warn') ? 'warn' : 'info';
    const summary = document.createElement('summary');
    summary.className = worst;
    if (issues.length > 0) summary.append(Object.assign(document.createElement('span'), { textContent: tr('{0} {1} · ', worst === 'error' ? '⛔' : worst === 'warn' ? '⚠' : 'ℹ', issues.length) }));
    summary.append(this.count);
    this.checks.append(summary);
    this.checks.open = open;
    for (const issue of issues) {
      const line = Object.assign(document.createElement('div'), { className: `env-issue ${issue.level}`, textContent: tr(issue.text, ...issue.args) });
      const keys = issue.targets.map((target) => editor.animKeyOf({ target, keys: {} })).filter((key): key is string => key !== null);
      if (keys.length > 0) {
        line.classList.add('link');
        line.addEventListener('click', () => {
          const material = keys.find((key) => key.startsWith('m:'));
          if (material !== undefined) this.openMaterial(material.slice(2));
          else {
            editor.selectEnv(keys);
            this.reveal(keys[0]!);
          }
        });
      }
      this.checks.append(line);
    }
  }

  /** ◆: animated; ⛓: hung on another. */
  private motionMarks(key: string): string {
    const editor = this.editor;
    return `${editor.animOf(key) !== undefined && hasKeys(editor.animOf(key)) ? '◆' : ''}${editor.linkParentOf(key) !== null ? '⛓' : ''}`;
  }

  /** A part's key button: hollow — no keys; blue — animated; yellow — a key on this beat (a click
   *  takes it away). */
  private keyButton(keys: readonly string[], part: AnimPart): HTMLElement {
    const editor = this.editor;
    const here = editor.snapBeat(editor.playhead());
    const all = editor.animOf(keys[0]!)?.keys[part] ?? [];
    const at = all.find((key) => Math.abs(key.beat - here) < 1e-3);
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon env-key', textContent: all.length === 0 ? '◇' : '◆' });
    button.classList.toggle('keyed', all.length > 0);
    button.classList.toggle('here', at !== undefined);
    button.title = at !== undefined ? tr('На этой доле стоит ключ. Нажмите, чтобы убрать его') : all.length > 0 ? tr('Ключей: {0}. Нажмите, чтобы поставить ключ на текущей доле', all.length) : tr('Поставить ключ анимации на текущей доле (K — ключ того, что меняют ручки)');
    button.addEventListener('click', () => (at !== undefined ? editor.removeAnimKeys(new Set([at.id])) : editor.addAnimKeys(keys, [part])));
    button.addEventListener('dblclick', (event) => {
      event.preventDefault();
      editor.toggleCurve(keys[0]!, part, true);
    });
    return button;
  }

  /** A line of one number with its key: the fog's, a lamp's settings. */
  private valueLine(root: HTMLElement, label: string, hint: string, keys: readonly string[], part: AnimPart, options: { step: number; min: number; max: number; digits: number }) {
    const editor = this.editor;
    const value = editor.shownValue(keys[0]!, part)?.[0] ?? 0;
    const row = document.createElement('div');
    row.className = 'env-line env-line-one';
    const name = Object.assign(document.createElement('span'), { className: 'env-line-name', textContent: tr(label) });
    name.title = tr(hint);
    const drum = numberDrum(`env:${keys[0]!}:${part}`, value, (next) => editor.setPart(keys, part, (_key, now) => [Math.round((now[0]! + next - value) * 100000) / 100000], `env:${part}`), options);
    row.append(name, drum, this.keyButton(keys, part));
    root.append(row);
  }

  /** The fog: its four numbers, a few ready ones, back as the environment has it. */
  private renderFog(root: HTMLElement) {
    const editor = this.editor;
    const head = document.createElement('div');
    head.className = 'env-headline';
    head.append(Object.assign(document.createElement('h3'), { textContent: tr('Туман') }));
    const back = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: '↺', title: tr('Туман как в окружении (ключи остаются)') });
    back.disabled = editor.project?.environmentMods?.fog === undefined;
    back.addEventListener('click', () => editor.resetFog());
    head.append(back);
    root.append(head);
    this.valueLine(root, 'Плотность', 'Насколько густой туман (attenuation). Шкала логарифмическая: маленькие изменения заметны сильно', ['f:fog'], 'attenuation', { step: 0.0005, min: 0, max: 1, digits: 4 });
    this.valueLine(root, 'Смещение', 'Сдвиг начала тумана (offset)', ['f:fog'], 'offset', { step: 1, min: -1000, max: 1000, digits: 2 });
    this.valueLine(root, 'Нижняя граница', 'С какой высоты начинается переход тумана, м (startY)', ['f:fog'], 'startY', { step: 1, min: -1000, max: 1000, digits: 2 });
    this.valueLine(root, 'Высота перепада', 'На какой высоте над нижней границей туман сходит на нет, м (height)', ['f:fog'], 'height', { step: 0.5, min: 0, max: 1000, digits: 2 });
    const presets = document.createElement('div');
    presets.className = 'ins-buttons';
    const preset = (text: string, values: Partial<Record<'attenuation' | 'offset' | 'startY' | 'height', number>>) => {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: tr(text) });
      button.addEventListener('click', () => {
        for (const [part, value] of Object.entries(values)) editor.setPart(['f:fog'], part as AnimPart, () => [value], 'fog:preset');
      });
      presets.append(button);
    };
    preset('Чисто', { attenuation: 0.0001, offset: 0, startY: -300, height: 10 });
    preset('Лёгкая дымка', { attenuation: 0.004, offset: 0, startY: -300, height: 10 });
    preset('Густой', { attenuation: 0.03, offset: 0, startY: -300, height: 10 });
    preset('Низкий туман', { attenuation: 0.02, offset: 0, startY: -1, height: 3 });
    root.append(presets);
    root.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr('Туман — один на окружение. В окне просмотра он показан приближённо, проверьте в игре.') }));
  }

  /** The player: where it stands (keys only), its turn when the risk is taken. */
  private renderPlayer(root: HTMLElement) {
    const editor = this.editor;
    root.append(Object.assign(document.createElement('h3'), { textContent: tr('Игрок') }));
    root.append(Object.assign(document.createElement('div'), { className: 'ins-note env-warning', textContent: tr('Движение игрока легко вызывает укачивание в VR. Двигайте редко, медленно и равномерно. Платформа и ноты едут вместе с игроком.') }));
    const risky = editor.playerRisky();
    const now = editor.sceneShown('p:player');
    if (now === null) return;
    const line = (label: string, part: 'position' | 'rotation', step: number) => {
      const row = document.createElement('div');
      row.className = 'env-line';
      row.append(Object.assign(document.createElement('span'), { className: 'env-line-name', textContent: tr(label) }));
      const drums = document.createElement('div');
      drums.className = 'env-drums';
      now[part].forEach((value, axis) => {
        const cell = document.createElement('label');
        cell.append(Object.assign(document.createElement('span'), { textContent: ['X', 'Y', 'Z'][axis]! }), numberDrum(`env:player:${part}:${String(axis)}`, value, (next) => editor.applyScene(['p:player'], (_key, values) => {
          const list = [...values[part]] as [number, number, number];
          list[axis] = Math.round((list[axis]! + next - value) * 10000) / 10000;
          return { [part]: list };
        }, `env:player:${part}`), { step, min: -1000, max: 1000, digits: 3 }));
        drums.append(cell);
      });
      row.append(drums, this.keyButton(['p:player'], part), document.createElement('span'));
      root.append(row);
    };
    line('Положение', 'position', 0.1);
    if (risky) line('Поворот', 'rotation', 1);
    this.renderKeys(root);
    const check = document.createElement('label');
    check.className = 'adjust-check';
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: risky });
    box.addEventListener('change', () => {
      if (box.checked && !window.confirm(tr('Повороты и неравномерное движение игрока почти всегда вызывают укачивание. Включить их?'))) {
        box.checked = false;
        return;
      }
      editor.setPlayerRisky(box.checked);
    });
    check.title = tr('Без галочки: только равномерное движение, без поворотов и плавности');
    check.append(box, ` ${tr('Я понимаю риск: повороты и плавность')}`);
    root.append(check);
    if (editor.animOf('p:player') !== undefined) {
      const clear = Object.assign(document.createElement('button'), { type: 'button', textContent: tr('✕ Убрать анимацию') });
      clear.addEventListener('click', () => editor.clearAnims(['p:player']));
      root.append(clear);
    }
  }

  /** The game's objects like this one: its neighbours of the same name (without their numbers). */
  private alike(key: string): string[] {
    const tree = this.editor.envTree();
    const node = tree?.nodes.get(Number(key.slice(2)));
    if (tree === null || tree === undefined || node === undefined) return [key];
    const siblings = tree.nodes.get(node.parent)?.children ?? tree.roots;
    return siblings.filter((index) => baseName(tree.nodes.get(index)!.name) === baseName(node.name)).map((index) => `g:${String(index)}`);
  }

  /** A copy of each picked thing, a little aside (the copies picked). */
  copy(keys: readonly string[] = this.editor.envSelection) {
    const editor = this.editor;
    const made: SceneObject[] = [];
    for (const key of keys) {
      const now = editor.sceneValues(key);
      if (now === null || now.object?.ghost === true) continue;
      const aside: [number, number, number] = [Math.round((now.position[0] + 1) * 1000) / 1000, now.position[1], now.position[2]];
      if (now.object !== undefined) made.push({ ...structuredClone({ ...now.object, arrayLights: undefined }), uid: newId('o'), name: copyName(now.object.name, [...editor.sceneObjects(), ...made].map((item) => item.name)), position: aside, ...(now.object.light === undefined ? {} : { light: { type: now.object.light.type, id: editor.freeLightId(now.object.light.type, made.flatMap((item) => (item.light?.type === now.object!.light!.type ? [item.light.id] : []))) } }) });
      else if (now.id !== null && now.id !== undefined) made.push({ uid: newId('o'), name: copyName(editor.envTree()?.nodes.get(Number(key.slice(2)))?.name ?? '', [...editor.sceneObjects(), ...made].map((item) => item.name)), kind: 'copy', source: now.id, position: aside, rotation: [...now.rotation], scale: [...now.scale] });
    }
    if (made.length === 0) editor.setStatus(tr('Копировать можно объекты с id для Chroma и свои объекты'));
    else editor.addSceneObjects(made);
  }

  /** A copy of each picked thing on the other side (left to right). */
  mirror(keys: readonly string[] = this.editor.envSelection) {
    const editor = this.editor;
    const made: SceneObject[] = [];
    for (const key of keys) {
      const now = editor.sceneValues(key);
      if (now === null || now.object?.ghost === true) continue;
      const placing = mirrored(now);
      if (now.object !== undefined) {
        const { array: _array, arrayLights: _lights, ...rest } = structuredClone(now.object);
        made.push({ ...rest, ...placing, uid: newId('o'), name: copyName(now.object.name, [...editor.sceneObjects(), ...made].map((item) => item.name)), ...(rest.light === undefined ? {} : { light: { type: rest.light.type, id: editor.freeLightId(rest.light.type, made.flatMap((item) => (item.light?.type === rest.light!.type ? [item.light.id] : []))) } }) });
      } else if (now.id !== null && now.id !== undefined) made.push({ uid: newId('o'), name: copyName(editor.envTree()?.nodes.get(Number(key.slice(2)))?.name ?? '', [...editor.sceneObjects(), ...made].map((item) => item.name)), kind: 'copy', source: now.id, ...placing });
    }
    if (made.length === 0) editor.setStatus(tr('Копировать можно объекты с id для Chroma и свои объекты'));
    else editor.addSceneObjects(made);
  }

  /** Deletes the picked added objects; the game's ones are hidden. */
  remove(keys: readonly string[] = this.editor.envSelection) {
    const editor = this.editor;
    const own = keys.filter((key) => key.startsWith('o:')).map((key) => key.slice(2));
    const game = keys.filter((key) => key.startsWith('g:'));
    if (game.length > 0) editor.applyScene(game, () => ({ hidden: true }));
    if (own.length > 0) editor.removeSceneObjects(own);
  }

  private menu(event: MouseEvent, key: string) {
    event.preventDefault();
    const editor = this.editor;
    if (!editor.envSelection.includes(key)) editor.selectEnv([key]);
    const keys = editor.envSelection;
    const game = key.startsWith('g:');
    setTimeout(() =>
      showMenu(event.clientX, event.clientY, [
        { label: tr('Выбрано: {0}', keys.length), heading: true },
        { label: '⧉ Копия', hint: 'Ctrl+D', action: () => this.copy() },
        { label: '⇋ Зеркальная копия', hint: 'слева направо', action: () => this.mirror() },
        { label: 'Размножить', heading: true },
        ...ARRAY_KINDS.map((kind) => ({ label: ARRAY_NAMES[kind], action: () => editor.setArray(keys, (base) => defaultArray(kind, base)) })),
        ...(game
          ? [
              { label: 'Выбрать все такие же', hint: 'соседи с тем же именем', action: () => editor.selectEnv(this.alike(key)) },
              { label: 'Выбрать каждый второй из таких же', action: () => editor.selectEnv(this.alike(key).filter((_item, at) => at % 2 === 0)) },
              { label: 'Выбрать каждый третий из таких же', action: () => editor.selectEnv(this.alike(key).filter((_item, at) => at % 3 === 0)) },
            ]
          : []),
        null,
        { label: '◌ Скрыть / показать', action: () => editor.applyScene(keys, (_key, now) => ({ hidden: !now.hidden })) },
        game ? { label: '↺ Вернуть как было', action: () => editor.applyScene(keys, () => 'reset') } : { label: '🗑 Удалить', hint: 'Delete', action: () => this.remove() },
      ]),
    );
  }

  // ----- adding ------------------------------------------------------------------------------------------

  /** A new shape in front of the camera; `lamp`: made of a light material, with a light ID of its own. */
  addShape(shape: Shape, lamp: boolean) {
    const editor = this.editor;
    const materials = editor.sceneMaterials();
    const wanted = (material: SceneMaterial) => isLightShader(material.shader) === lamp;
    // (the material picked last of the right kind — or a first one made)
    const lastUsed = [...editor.sceneObjects()].reverse().find((object) => object.material !== undefined && materials[object.material] !== undefined && wanted(materials[object.material]!))?.material;
    let name = lastUsed ?? Object.keys(materials).find((item) => wanted(materials[item]!));
    let added: Record<string, SceneMaterial> | undefined;
    if (name === undefined) {
      name = tr(lamp ? 'Лампа' : 'Материал');
      for (let n = 2; materials[name] !== undefined; n++) name = `${tr(lamp ? 'Лампа' : 'Материал')} ${String(n)}`;
      added = { [name]: lamp ? { shader: 'OpaqueLight', color: [1, 1, 1, 1] } : { shader: 'Standard', color: [0.6, 0.6, 0.65, 1] } };
    }
    const count = editor.sceneObjects().filter((object) => object.shape === shape).length + 1;
    const type = 0;
    // (not into another new thing standing there: a metre aside for each)
    const place = this.placeAhead();
    while (editor.sceneObjects().some((object) => object.kind === 'shape' && Math.hypot(object.position[0] - place[0], object.position[1] - place[1], object.position[2] - place[2]) < 0.3)) place[0] = Math.round((place[0] + 1) * 10) / 10;
    editor.addSceneObjects(
      [{ uid: newId('o'), name: `${tr(SHAPE_NAMES[shape])} ${String(count)}`, kind: 'shape', shape, material: name, position: place, rotation: [0, 0, 0], scale: lamp ? [0.2, 3, 0.2] : [1, 1, 1], ...(lamp ? { light: { type, id: editor.freeLightId(type) } } : {}) }],
      added,
    );
    this.material = null;
  }

  // ----- the right panel ---------------------------------------------------------------------------------

  private section(title: string) {
    return Object.assign(document.createElement('div'), { className: 'env-row-title', textContent: title });
  }

  private renderInspector() {
    const root = this.inspectorRoot;
    root.replaceChildren();
    const first = this.editor.envSelection[0];
    if (this.material !== null) this.renderMaterial(root, this.material);
    else if (first === 'f:fog') this.renderFog(root);
    else if (first === 'p:player') this.renderPlayer(root);
    else this.renderObjects(root);
  }

  /** The sections open on the right (they stay as they were left). */
  private readonly folds = new Set<string>();
  private readonly arrayShown = new Set<string>();

  /** A section that opens and closes: its title, a word of what's in it; its inside is returned. */
  private fold(root: HTMLElement, id: string, title: string, about = ''): HTMLElement {
    const box = document.createElement('details');
    box.className = 'env-fold';
    box.open = this.folds.has(id);
    const summary = document.createElement('summary');
    summary.append(Object.assign(document.createElement('span'), { textContent: title }), Object.assign(document.createElement('em'), { textContent: about }));
    box.addEventListener('toggle', () => {
      if (box.open) this.folds.add(id);
      else this.folds.delete(id);
    });
    const body = document.createElement('div');
    body.className = 'env-fold-body';
    box.append(summary, body);
    root.append(box);
    return body;
  }

  private renderObjects(root: HTMLElement) {
    const editor = this.editor;
    const keys = editor.envSelection.filter((key) => editor.sceneValues(key) !== null);
    const first = keys[0];
    const now = first === undefined ? null : editor.sceneShown(first);
    if (first === undefined || now === null) {
      root.append(Object.assign(document.createElement('div'), { className: 'ins-note', textContent: tr('Выберите объект: кликните по нему в 3D-окне или в списке слева. Ctrl — добавить к выбранным, Shift — выбрать всё от прошлого до этого. Новый объект — кнопками «＋ Объект» и «＋ Свет» над 3D-окном.') }));
      return;
    }
    const object = now.object;
    const node = object === undefined ? editor.envTree()?.nodes.get(Number(first.slice(2))) : undefined;
    const able = keys.filter((key) => editor.animTarget(key) !== null);
    const anim = editor.animOf(first);

    // the name, and what can be done with the picked — small buttons beside it
    const head = document.createElement('div');
    head.className = 'env-headline';
    if (object !== undefined && keys.length === 1) {
      const name = Object.assign(document.createElement('input'), { type: 'text', value: object.name, className: 'env-name-input' });
      name.addEventListener('change', () => editor.changeObjects([object.uid], (item) => (item.name = name.value.trim() || item.name)));
      head.append(name);
    } else {
      const title = Object.assign(document.createElement('h3'), { textContent: keys.length === 1 ? (node?.name ?? '') : tr('Выбрано объектов: {0}', keys.length) });
      title.title = keys.length === 1 ? (now.id ?? '') : tr('Выбрано несколько: барабаны и ручки в 3D меняют все выбранные на одну и ту же величину (числа показаны для первого).');
      head.append(title);
    }
    const icon = (text: string, title: string, run: (event: MouseEvent) => void) => {
      const item = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: text, title });
      item.addEventListener('click', run);
      head.append(item);
    };
    const game = keys.filter((key) => key.startsWith('g:'));
    const own = keys.filter((key) => key.startsWith('o:'));
    icon(now.hidden ? '◌' : '👁', 'Скрыть выбранные объекты в игре (вместе со всем, что внутри них)', () => editor.applyScene(keys, () => ({ hidden: !now.hidden })));
    icon('⧉', 'Ещё один такой же объект рядом (Ctrl+D)', () => this.copy(keys));
    icon('⇋', 'Копия на другой стороне: слева направо', () => this.mirror(keys));
    if (game.length > 0) icon('↺', 'Убрать все изменения выбранных объектов игры', () => editor.applyScene(keys, () => 'reset'));
    if (own.length > 0) icon('🗑', 'Удалить выбранные свои объекты (Delete)', () => this.remove(own));
    icon('⋯', 'Ещё', (event) => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      setTimeout(() =>
        showMenu(rect.left, rect.bottom + 2, [
          ...(game.length === 1 && keys.length === 1 ? [{ label: 'Выбрать все такие же', hint: 'соседи с тем же именем', action: () => editor.selectEnv(this.alike(first)) }] : []),
          { label: '◆ Ключ всего сразу', hint: 'положение, поворот, масштаб', disabled: able.length === 0, action: () => editor.addAnimKeys(able, ANIM_PARTS) },
          { label: '✕ Убрать анимацию', hint: 'все ключи выбранных', disabled: !able.some((key) => editor.animOf(key) !== undefined), action: () => editor.clearAnims(able) },
          ...(able.length > 0 && !first.startsWith('p:') ? [null, { label: tr('＋ Движение с текущей доли'), heading: true }, ...MOTION_KINDS.map((kind) => ({ label: tr(MOTION_NAMES[kind]), action: () => editor.addMotion(able[0]!, kind) }))] : []),
        ]),
      );
    });
    root.append(head);
    if (object === undefined && (now.id === null || now.id === undefined)) {
      root.append(Object.assign(document.createElement('div'), { className: 'ins-note', textContent: tr('У этого объекта нет id для Chroma — изменить можно только объект выше или ниже по дереву.') }));
      return;
    }

    const tabs = document.createElement('div');
    tabs.className = 'env-inspector-tabs';
    for (const [id, label] of [['object', 'Объект'], ['animation', 'Анимация'], ['more', 'Размножение']] as const) {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: tr(label), className: this.inspectorTab === id ? 'active' : '' });
      button.addEventListener('click', () => {
        this.inspectorTab = id;
        this.render();
      });
      tabs.append(button);
    }
    root.append(tabs);
    if (this.inspectorTab === 'animation') {
      this.renderKeys(root);
      const motion = editor.motionsOf(first).find((item) => item.id === editor.motionSelection);
      if (motion !== undefined) this.renderMotion(root, motion);
      return;
    }
    if (this.inspectorTab === 'more') {
      const array = object?.array;
      if (array !== undefined && !this.arrayShown.has(object!.uid)) {
        this.arrayShown.add(object!.uid);
        this.folds.add('array');
      }
      this.renderArray(this.fold(root, 'array', tr('Размножение'), array === undefined ? '' : `${tr(ARRAY_NAMES[array.kind])} ×${String(arrayCount(array))}`), keys, object);
      if (first.startsWith('g:') && keys.length === 1) this.renderRule(root, first);
      const written = this.fold(root, 'written', tr('Как это записано в карту'));
      const commands = keys.flatMap((key) => {
        const values = editor.sceneValues(key);
        if (values === null) return [];
        if (values.object !== undefined) return expandObjects([values.object]).slice(0, 4).map((item) => objectCommand(item, editor.sceneMaterials()));
        const edit = editor.sceneEdits().find((item) => item.id === values.id);
        return [edit === undefined ? null : sceneCommand(edit)];
      }).filter((command) => command !== null);
      const code = document.createElement('pre');
      code.className = 'env-code';
      code.textContent = commands.length === 0 ? tr('Объект не изменён — в карту ничего не пишется.\nid: {0}', now.id ?? '') : commands.map((command) => JSON.stringify(command, null, 2)).join(',\n');
      written.append(code);
      return;
    }

    // where it stands: a line a part — its three numbers, its key, back as the game has it
    const ownShapes = new Set(editor.sceneObjects().filter((item) => item.kind === 'shape').map((item) => `o:${item.uid}`));
    if (keys.every((key) => !ownShapes.has(key))) {
      const space = now.space ?? 'local';
      const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'env-space', textContent: space === 'world' ? 'В мире' : 'Свои оси' });
      toggle.title = space === 'world' ? 'Положение и поворот в мире (position / rotation). Нажмите, чтобы перейти к осям родителя' : 'Положение и поворот относительно игрового родителя (localPosition / localRotation). Нажмите, чтобы перейти в мир';
      toggle.addEventListener('click', () => editor.setSceneSpace(keys, space === 'world' ? 'local' : 'world'));
      root.append(toggle);
    }
    const axes = ['X', 'Y', 'Z'];
    const here = editor.snapBeat(editor.playhead());
    const line = (label: string, part: 'position' | 'rotation' | 'scale', step: number, min: number, max: number, hint: string) => {
      const row = document.createElement('div');
      row.className = 'env-line';
      const name = Object.assign(document.createElement('span'), { className: 'env-line-name', textContent: label });
      name.title = hint;
      const drums = document.createElement('div');
      drums.className = 'env-drums';
      now[part].forEach((value, axis) => {
        const cell = document.createElement('label');
        cell.append(
          Object.assign(document.createElement('span'), { textContent: axes[axis]! }),
          numberDrum(`env:${first}:${part}:${String(axis)}`, value, (next) =>
            // (every picked one changed by as much as the first)
            editor.applyScene(keys, (_key, values) => {
              const list = [...values[part]] as [number, number, number];
              list[axis] = Math.round((list[axis]! + next - value) * 10000) / 10000;
              return { [part]: list };
            }, `env:${part}:${String(axis)}`), { step, min, max, digits: 4 }),
        );
        drums.append(cell);
      });
      row.append(name, drums);
      if (able.length > 0) row.append(this.keyButton(able, part));
      if (now.own !== undefined) {
        const back = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: '↺', title: 'Вернуть как в игре' });
        back.disabled = now[part].every((value, k) => Math.abs(value - now.own![part][k]!) < 1e-6);
        back.addEventListener('click', () => editor.applyScene(keys, (_key, values) => (values.own === undefined ? {} : { [part]: values.own[part] })));
        row.append(back);
      }
      root.append(row);
    };
    const world = object?.kind === 'shape';
    if (object?.ghost === true) root.append(Object.assign(document.createElement('div'), { className: 'ins-note', textContent: tr('Размноженный объект игры: первый в ряду — сам объект игры ({0}). Чтобы сдвинуть всё, двигайте его; здесь — число и шаг копий.', object.source ?? '') }));
    else {
      line('Положение', 'position', 0.1, -500, 500, world ? 'Положение в мире, в метрах: X — вправо, Y — вверх, Z — вперёд' : 'Своё положение объекта относительно родителя, в метрах: X — вправо, Y — вверх, Z — вперёд');
      line('Поворот', 'rotation', 1, -360, 360, 'Поворот объекта вокруг осей X, Y, Z, в градусах');
      line('Масштаб', 'scale', 0.05, 0, 200, 'Размер объекта по осям (1 — как в игре; у фигуры — метры)');
    }
    // a lamp: how bright its colour is, how much it glows in the fog
    const lamps = able.filter((key) => editor.isTube(key));
    if (lamps.length > 0 && lamps.length === able.length) {
      this.valueLine(root, 'Яркость', 'Множитель яркости цвета лампы (colorAlphaMultiplier, 1 — как есть)', lamps, 'alpha', { step: 0.05, min: 0, max: 20, digits: 2 });
      this.valueLine(root, 'Свечение', 'Множитель свечения лампы в тумане (bloomFogIntensityMultiplier, 1 — как есть)', lamps, 'bloom', { step: 0.05, min: 0, max: 20, digits: 2 });
    }
    this.renderLink(root, able);
    if (object?.kind === 'shape') this.renderShape(root, object, keys);
  }

  /** A ready motion's settings: when, and what it does. */
  private renderMotion(root: HTMLElement, motion: SceneMotion) {
    const editor = this.editor;
    const box = document.createElement('div');
    box.className = 'env-motion';
    const head = document.createElement('div');
    head.className = 'env-headline';
    head.append(Object.assign(document.createElement('h3'), { textContent: `▶ ${tr(MOTION_NAMES[motion.kind])}` }));
    if (isPeriodic(motion)) {
      const bake = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: '◆', title: tr('Разобрать в ключи: движение станет обычными ключами (каждая четверть доли)') });
      bake.addEventListener('click', () => editor.bakeMotion(motion.id));
      head.append(bake);
    }
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: '🗑', title: tr('Удалить движение (Delete)') });
    remove.addEventListener('click', () => editor.removeMotion(motion.id));
    head.append(remove);
    box.append(head);
    const set = (patch: (item: SceneMotion) => void, merge: string) => editor.changeMotion(motion.id, patch, `motion:${motion.id}:${merge}`);
    const row = (label: string, hint: string, ...controls: HTMLElement[]) => {
      const line = document.createElement('div');
      line.className = 'env-line env-line-wide';
      const name = Object.assign(document.createElement('span'), { className: 'env-line-name', textContent: tr(label) });
      name.title = tr(hint);
      const pair = document.createElement('div');
      pair.className = 'env-pair';
      pair.append(...controls);
      line.append(name, pair);
      box.append(line);
    };
    const drum = (name: string, value: number, put: (item: SceneMotion, next: number) => void, options: { step: number; min: number; max: number; digits: number }) => numberDrum(`motion:${motion.id}:${name}`, value, (next) => set((item) => put(item, next), name), options);
    const choice = (options: [string, string][], value: string, put: (item: SceneMotion, next: string) => void) => {
      const select = document.createElement('select');
      for (const [id, text] of options) select.append(Object.assign(document.createElement('option'), { value: id, textContent: tr(text) }));
      select.value = value;
      select.addEventListener('change', () => set((item) => put(item, select.value), 'choice'));
      return select;
    };
    const check = (text: string, value: boolean, put: (item: SceneMotion, next: boolean) => void) => {
      const label = document.createElement('label');
      label.className = 'adjust-check';
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: value });
      input.addEventListener('change', () => set((item) => put(item, input.checked), 'check'));
      label.append(input, ` ${tr(text)}`);
      return label;
    };
    const axes: [string, string][] = [['0', 'X'], ['1', 'Y'], ['2', 'Z']];
    row('Доли', 'С какой доли и сколько долей длится движение', drum('start', motion.start, (item, next) => (item.start = Math.max(0, next), item.end = item.start + (motion.end - motion.start)), { step: 0.25, min: 0, max: 100000, digits: 3 }), drum('length', motion.end - motion.start, (item, next) => (item.end = item.start + Math.max(0.25, next)), { step: 0.25, min: 0.25, max: 10000, digits: 3 }));
    const axis = (label: string, all = false) => row(label, 'Ось движения', choice(all ? [...axes, ['3', 'все']] : axes, String(motion.axis), (item, next) => (item.axis = Number(next))));
    const period = (hint: string) => row('Период, доли', hint, drum('period', motion.period, (item, next) => (item.period = Math.max(0.0625, next)), { step: 0.25, min: 0.0625, max: 1000, digits: 3 }));
    const reverse = () => box.append(check('В другую сторону', motion.reverse === true, (item, next) => (item.reverse = next || undefined)));
    if (motion.kind === 'orbit') {
      axis('Вокруг оси');
      row('Радиус, м', 'Как далеко центр круга от объекта (объект начинает с того места, где стоит)', drum('size', motion.size, (item, next) => (item.size = next), { step: 0.25, min: 0, max: 500, digits: 2 }));
      period('За сколько долей полный круг');
      reverse();
    } else if (motion.kind === 'swing') {
      axis('Вокруг оси');
      row('Угол, °', 'Насколько качается в каждую сторону', drum('size', motion.size, (item, next) => (item.size = next), { step: 5, min: 0, max: 360, digits: 1 }));
      period('За сколько долей туда и обратно');
      reverse();
    } else if (motion.kind === 'spin') {
      axis('Вокруг оси');
      period('За сколько долей полный оборот');
      reverse();
    } else if (motion.kind === 'bob') {
      axis('Вдоль оси');
      row('Размах, м', 'Насколько поднимается и опускается', drum('size', motion.size, (item, next) => (item.size = next), { step: 0.1, min: 0, max: 100, digits: 2 }));
      period('За сколько долей вверх и вниз');
      reverse();
    } else if (motion.kind === 'pulse') {
      axis('По оси', true);
      row('Рост, ×', 'Насколько больше становится в самой большой точке (0,3 — на 30 %)', drum('size', motion.size, (item, next) => (item.size = next), { step: 0.05, min: 0, max: 20, digits: 2 }));
      period('За сколько долей вырасти и вернуться');
    } else if (motion.kind === 'follow') {
      row('За кем', 'Чьё положение повторяет объект', choice([['head', 'голова'], ['left', 'левая рука'], ['right', 'правая рука']], motion.source ?? 'head', (item, next) => (item.source = next)));
      row('Плавность', 'Насколько плавно догоняет (меньше — плавнее, 0 — без сглаживания)', drum('smooth', motion.smooth ?? 0, (item, next) => (item.smooth = Math.max(0, next)), { step: 1, min: 0, max: 100, digits: 1 }));
      row('Сдвиг, м', 'Где объект относительно головы или руки (оси мира: X — вправо, Y — вверх, Z — вперёд)', ...[0, 1, 2].map((k) => drum(`offset${String(k)}`, motion.offset?.[k] ?? 0, (item, next) => {
        const offset = [...(item.offset ?? [0, 0, 0])];
        offset[k] = next;
        item.offset = offset;
      }, { step: 0.1, min: -100, max: 100, digits: 2 })));
      box.append(check('И поворачиваться так же', motion.turn === true, (item, next) => (item.turn = next || undefined)));
    } else {
      row('От чего', 'Какое значение игры двигает объект', choice([['energy', 'энергия (0–1)'], ['score', 'процент очков (0–1)'], ['combo', 'комбо (÷100)'], ['progress', 'ход песни (0–1)']], motion.source ?? 'energy', (item, next) => (item.source = next)));
      row('Что меняется', 'Какое свойство объекта зависит от значения', choice([['scale', 'масштаб'], ['position', 'положение'], ['rotation', 'поворот']], motion.part ?? 'scale', (item, next) => {
        item.part = next as SceneMotion['part'];
        if (next !== 'scale' && item.axis >= 3) item.axis = 1;
      }));
      axis('По оси', (motion.part ?? 'scale') === 'scale');
      row('Сколько', (motion.part ?? 'scale') === 'scale' ? 'Во сколько раз больше при значении 1' : (motion.part ?? 'scale') === 'position' ? 'На сколько метров сдвинется при значении 1' : 'На сколько градусов повернётся при значении 1', drum('size', motion.size, (item, next) => (item.size = next), { step: 0.1, min: -1000, max: 1000, digits: 2 }));
    }
    box.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr(isPeriodic(motion) ? 'Движение складывается с ключами объекта.' : 'Пока идёт блок, он заменяет ключи этого свойства. Голова, руки и значения игры в окне просмотра показаны условно — проверьте в игре.') }));
    root.append(box);
  }

  /** What the picked hang on: its name (a click picks it), 📌 pick another, ✕ unhook. */
  private renderLink(root: HTMLElement, keys: readonly string[]) {
    const editor = this.editor;
    const able = keys.filter((key) => key.startsWith('o:') || key.startsWith('g:'));
    if (able.length === 0) return;
    const parent = editor.linkParentOf(able[0]!);
    const children = editor.linkChildrenOf(able[0]!);
    const row = document.createElement('div');
    row.className = 'env-line env-line-wide';
    const name = Object.assign(document.createElement('span'), { className: 'env-line-name', textContent: tr('Родитель') });
    name.title = tr('К чему привязан объект: он движется вместе с ним (нужен Noodle Extensions)');
    const pair = document.createElement('div');
    pair.className = 'env-pair';
    const shown = Object.assign(document.createElement('button'), { type: 'button', className: 'env-link-name', textContent: parent === null ? tr('нет') : editor.thingName(parent) });
    shown.disabled = parent === null;
    shown.title = tr('Выбрать родителя');
    shown.addEventListener('click', () => parent !== null && editor.selectEnv([parent]));
    const pick = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: '📌' });
    pick.classList.toggle('active', editor.linkPicking !== null);
    pick.title = tr('Привязать к другому объекту: нажмите, затем кликните по родителю в 3D-окне или в списке');
    pick.addEventListener('click', () => (editor.linkPicking !== null ? ((editor.linkPicking = null), editor.emit('selection')) : editor.startLinkPick(able)));
    pair.append(shown, pick);
    if (parent !== null) {
      const off = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: '✕', title: tr('Отвязать') });
      off.addEventListener('click', () => editor.setLinkParent(able, null));
      pair.append(off);
    }
    row.append(name, pair);
    root.append(row);
    if (children.length > 0) {
      const list = Object.assign(document.createElement('div'), { className: 'nm-dim env-link-children', textContent: tr('Привязаны к нему: {0}', children.map((key) => editor.thingName(key)).join(', ')) });
      root.append(list);
    }
  }

  /** "By a rule": of the like ones — every N-th, from one to another. */
  private renderRule(root: HTMLElement, key: string) {
    const editor = this.editor;
    const like = this.alike(key);
    if (like.length < 3) return;
    const rule = this.rule;
    const body = this.fold(root, 'rule', tr('Выбрать по правилу'), tr('таких же: {0}', like.length));
    const row = document.createElement('div');
    row.className = 'env-line env-line-free';
    const drums = document.createElement('div');
    drums.className = 'env-drums';
    const cell = (label: string, name: 'every' | 'from' | 'to', min: number, hint: string) => {
      const item = document.createElement('label');
      item.title = hint;
      item.append(Object.assign(document.createElement('span'), { textContent: label }), numberDrum(`env:rule:${name}`, rule[name], (next) => (rule[name] = Math.max(min, Math.round(next))), { step: 1, min, max: like.length, digits: 0 }));
      drums.append(item);
    };
    cell('каждый', 'every', 1, 'Каждый какой по счёту: 1 — все подряд, 2 — через один');
    cell('с', 'from', 1, 'С какого по счёту начать');
    cell('по', 'to', 0, 'На каком закончить (0 — до последнего)');
    const pick = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Выбрать' });
    pick.addEventListener('click', () => {
      const to = rule.to === 0 ? like.length : rule.to;
      editor.selectEnv(like.filter((_item, at) => at + 1 >= rule.from && at + 1 <= to && (at + 1 - rule.from) % rule.every === 0));
    });
    row.append(drums, pick);
    body.append(row);
  }

  /** The keys picked on the timeline: how it comes to them, their beat, how many times the part plays. */
  private renderKeys(root: HTMLElement) {
    const editor = this.editor;
    const picked = editor.sceneAnims().flatMap((anim) => ALL_PARTS.flatMap((part) => (anim.keys[part] ?? []).filter((key) => editor.animSelection.has(key.id)).map((key) => ({ key, part, anim }))));
    const one = picked[0];
    if (one === undefined) return;
    const row = document.createElement('div');
    row.className = 'env-line env-line-keys';
    const name = Object.assign(document.createElement('span'), { className: 'env-line-name', textContent: picked.length === 1 ? tr('◆ Ключ') : tr('◆ Ключей: {0}', picked.length) });
    const controls = document.createElement('div');
    controls.className = 'env-pair';
    const easing = document.createElement('select');
    for (const [id, title] of EASINGS) easing.append(Object.assign(document.createElement('option'), { value: id, textContent: title }));
    easing.value = one.key.easing ?? 'easeLinear';
    easing.title = 'Как объект приходит к этому ключу от предыдущего';
    // (the player: even moves only, unless the risk is taken)
    easing.disabled = picked.some((item) => item.anim.target === 'player') && !editor.playerRisky();
    easing.addEventListener('change', () => editor.changeAnimKeys(new Set(picked.map((item) => item.key.id)), (key) => (easing.value === 'easeLinear' ? delete key.easing : (key.easing = easing.value))));
    controls.append(easing);
    if (picked.length === 1) {
      const beat = document.createElement('label');
      beat.className = 'env-mini';
      beat.title = 'Доля ключа';
      beat.append(Object.assign(document.createElement('span'), { textContent: tr('доля') }), numberDrum(`env:key:${one.key.id}`, one.key.beat, (next) => editor.changeAnimKeys(new Set([one.key.id]), (key) => (key.beat = Math.max(0, next)), 'anim:beat'), { step: 0.25, min: 0, max: 100000, digits: 3 }));
      controls.append(beat);
    }
    const runs = document.createElement('label');
    runs.className = 'env-mini';
    runs.title = 'Сколько раз подряд проигрываются ключи этого свойства (1 — один раз)';
    runs.append(Object.assign(document.createElement('span'), { textContent: '↻' }), numberDrum(`env:runs:${one.anim.target}:${one.part}`, animRuns(one.anim, one.part), (next) => editor.setAnimRuns(one.anim.target, one.part, next), { step: 1, min: 1, max: 64, digits: 0 }));
    controls.append(runs);
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: '🗑', title: 'Удалить выбранные ключи (Delete)' });
    remove.addEventListener('click', () => editor.removeAnimKeys(new Set(picked.map((item) => item.key.id))));
    // (the curves: opened in the part's line on the timeline; the smooth curve through the keys)
    const thing = editor.animKeyOf(one.anim);
    const curve = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: '〰', title: tr('Кривые этого свойства — в его строке на таймлайне') });
    curve.disabled = thing === null;
    curve.classList.toggle('active', thing !== null && editor.curveRows.has(`${thing}|${one.part}`));
    curve.addEventListener('click', () => thing !== null && editor.toggleCurve(thing, one.part));
    controls.append(curve);
    if (one.part !== 'rotation') {
      const smooth = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: '∿', title: tr('Плавная кривая через ключи') });
      smooth.classList.toggle('active', one.anim.spline?.[one.part] === true);
      smooth.addEventListener('click', () => editor.setAnimSpline(one.anim.target, one.part, one.anim.spline?.[one.part] !== true));
      controls.append(smooth);
    }
    row.append(name, controls, remove);
    root.append(row);
  }


  /** Many of the picked: none, or a row, a round, a grid, a line, a scatter — and its numbers. */
  private renderArray(root: HTMLElement, keys: readonly string[], object: SceneObject | undefined) {
    const editor = this.editor;
    const array = object?.array;
    const box = document.createElement('div');
    box.className = 'env-row';
    const kind = document.createElement('select');
    kind.append(Object.assign(document.createElement('option'), { value: '', textContent: 'Нет — один объект' }));
    for (const item of ARRAY_KINDS) kind.append(Object.assign(document.createElement('option'), { value: item, textContent: ARRAY_NAMES[item] }));
    kind.value = array?.kind ?? '';
    kind.title = 'Много таких же объектов: рядом, по кругу, сеткой, вдоль линии или россыпью. Число и шаг можно менять потом';
    kind.addEventListener('change', () => editor.setArray(keys, kind.value === '' ? null : (base) => defaultArray(kind.value as ArrayKind, base)));
    box.append(kind);
    root.append(box);
    if (object === undefined || array === undefined) return;
    const uid = object.uid;
    const set = (patch: (next: SceneArray) => void, merge: string) =>
      editor.changeObjects([uid], (item) => {
        if (item.array !== undefined) patch(item.array);
      }, `env:array:${merge}`);
    const field = (label: string, hint: string, ...controls: HTMLElement[]) => {
      const line = document.createElement('label');
      line.className = 'env-field';
      line.title = hint;
      const pair = document.createElement('span');
      pair.className = 'env-pair';
      pair.append(...controls);
      line.append(Object.assign(document.createElement('span'), { textContent: label }), pair);
      root.append(line);
    };
    const one = (name: string, value: number, put: (next: SceneArray, value: number) => void, options: { step: number; min: number; max: number; digits: number }) => numberDrum(`env:array:${uid}:${name}`, value, (next) => set((item) => put(item, next), name), options);
    const three = (name: string, values: readonly number[], put: (next: SceneArray, axis: number, value: number) => void, options: { step: number; min: number; max: number; digits: number }) => values.map((value, axis) => one(`${name}:${String(axis)}`, value, (item, next) => put(item, axis, next), options));
    const count = { step: 1, min: 1, max: 500, digits: 0 };
    const metres = { step: 0.5, min: -500, max: 500, digits: 2 };
    const degrees = { step: 5, min: -360, max: 360, digits: 1 };
    if (array.kind === 'row') {
      field('Сколько всего', 'Сколько объектов в ряду, считая первый', one('count', array.count, (item, next) => item.kind === 'row' && (item.count = Math.round(next)), count));
      field('Шаг, м (X Y Z)', 'На сколько каждый следующий сдвинут от предыдущего', ...three('step', array.step, (item, axis, next) => item.kind === 'row' && (item.step[axis] = next), metres));
      field('Доворот, ° (X Y Z)', 'На сколько каждый следующий повёрнут относительно предыдущего', ...three('turn', array.turn, (item, axis, next) => item.kind === 'row' && (item.turn[axis] = next), degrees));
      field('Рост размера', 'Во сколько раз каждый следующий больше предыдущего (1 — одинаковые)', one('grow', array.grow, (item, next) => item.kind === 'row' && (item.grow = next), { step: 0.05, min: 0.1, max: 3, digits: 2 }));
    } else if (array.kind === 'circle') {
      field('Сколько всего', 'Сколько объектов по кругу, считая первый', one('count', array.count, (item, next) => item.kind === 'circle' && (item.count = Math.round(next)), count));
      const axis = document.createElement('select');
      ['X', 'Y', 'Z'].forEach((name, at) => axis.append(Object.assign(document.createElement('option'), { value: String(at), textContent: name })));
      axis.value = String(array.axis);
      axis.addEventListener('change', () => set((item) => item.kind === 'circle' && (item.axis = Number(axis.value) as 0 | 1 | 2), 'axis'));
      field('Вокруг оси', 'Ось, вокруг которой идёт круг: Y — по горизонтали вокруг столба, Z — колесом лицом к игроку', axis);
      field('Центр, м (X Y Z)', 'Точка, вокруг которой стоят объекты; радиус — расстояние от первого объекта до неё', ...three('centre', array.centre, (item, at, next) => item.kind === 'circle' && (item.centre[at] = next), metres));
      field('Дуга, °', '360 — полный круг; меньше — часть круга от первого объекта', one('angle', array.angle, (item, next) => item.kind === 'circle' && (item.angle = next), { step: 15, min: -360, max: 360, digits: 1 }));
      const face = Object.assign(document.createElement('input'), { type: 'checkbox', checked: array.face });
      face.addEventListener('change', () => set((item) => item.kind === 'circle' && (item.face = face.checked), 'face'));
      field('Поворачивать с кругом', 'Каждый объект повёрнут так же, как сдвинут по кругу (все смотрят на центр одинаково)', face);
    } else if (array.kind === 'grid') {
      field('Сколько (X Y Z)', 'Сколько объектов вправо, вверх и вперёд', ...three('counts', array.counts, (item, at, next) => item.kind === 'grid' && (item.counts[at] = Math.round(next)), { step: 1, min: 1, max: 100, digits: 0 }));
      field('Шаг, м (X Y Z)', 'Расстояние между соседними по каждой оси', ...three('steps', array.steps, (item, at, next) => item.kind === 'grid' && (item.steps[at] = next), metres));
    } else if (array.kind === 'line') {
      field('Сколько всего', 'Сколько объектов вдоль линии, считая первый', one('count', array.count, (item, next) => item.kind === 'line' && (item.count = Math.max(2, Math.round(next))), { ...count, min: 2 }));
      field('Конец, м (X Y Z)', 'Где стоит последний объект — считая от первого', ...three('end', array.end, (item, at, next) => item.kind === 'line' && (item.end[at] = next), metres));
      field('Изгиб, м (X Y Z)', 'Куда и насколько выгнута середина линии (0 0 0 — прямая)', ...three('bend', array.bend, (item, at, next) => item.kind === 'line' && (item.bend[at] = next), metres));
    } else {
      field('Сколько всего', 'Сколько объектов в россыпи, считая первый', one('count', array.count, (item, next) => item.kind === 'scatter' && (item.count = Math.round(next)), count));
      field('Объём, м (X Y Z)', 'Размер области вокруг первого объекта, в которой разбросаны остальные', ...three('size', array.size, (item, at, next) => item.kind === 'scatter' && (item.size[at] = Math.max(0, next)), { ...metres, min: 0 }));
      field('Разброс поворота, °', 'Насколько сильно случайно повёрнут каждый (0 — все как первый)', one('turn', array.turn, (item, next) => item.kind === 'scatter' && (item.turn = next), { step: 15, min: 0, max: 180, digits: 0 }));
      field('Размер от / до', 'Случайный размер каждого — во сколько раз от первого', one('sizeFrom', array.sizeFrom, (item, next) => item.kind === 'scatter' && (item.sizeFrom = next), { step: 0.1, min: 0.05, max: 10, digits: 2 }), one('sizeTo', array.sizeTo, (item, next) => item.kind === 'scatter' && (item.sizeTo = next), { step: 0.1, min: 0.05, max: 10, digits: 2 }));
      const again = Object.assign(document.createElement('button'), { type: 'button', textContent: '🎲 Другая', title: 'Разбросать по-другому (тот же номер — та же россыпь)' });
      again.addEventListener('click', () => set((item) => item.kind === 'scatter' && (item.seed = item.seed + 1), 'seed'));
      field('Россыпь №', 'Номер случайной россыпи: один и тот же номер всегда даёт одно и то же', one('seed', array.seed, (item, next) => item.kind === 'scatter' && (item.seed = Math.round(next)), { step: 1, min: 1, max: 9999, digits: 0 }), again);
    }
    const apart = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Сделать отдельными', title: 'Каждая копия станет обычным объектом: их можно будет двигать по одной, но число и шаг больше не поменять' });
    apart.addEventListener('click', () => editor.detachArrays([uid]));
    root.append(apart);
  }

  /** A shape's own settings: what it is, what it's made of, its lamp. */
  private renderShape(root: HTMLElement, object: SceneObject, keys: readonly string[]) {
    const editor = this.editor;
    const uids = keys.filter((key) => key.startsWith('o:')).map((key) => key.slice(2));
    const shapes = editor.sceneObjects().filter((item) => uids.includes(item.uid) && item.kind === 'shape');
    const shapeUids = shapes.map((item) => item.uid);
    const materials = editor.sceneMaterials();
    const row = (label: string, ...controls: HTMLElement[]) => {
      const line = document.createElement('div');
      line.className = 'env-line env-line-wide';
      const pair = document.createElement('div');
      pair.className = 'env-pair';
      pair.append(...controls);
      line.append(Object.assign(document.createElement('span'), { className: 'env-line-name', textContent: label }), pair);
      root.append(line);
    };
    const shape = document.createElement('select');
    for (const item of SHAPES) shape.append(Object.assign(document.createElement('option'), { value: item, textContent: SHAPE_NAMES[item] }));
    shape.value = object.shape ?? 'Cube';
    shape.addEventListener('change', () => editor.changeObjects(shapeUids, (item) => (item.shape = shape.value as Shape)));
    shape.title = 'Фигура';

    const material = document.createElement('select');
    for (const name of Object.keys(materials)) material.append(Object.assign(document.createElement('option'), { value: name, textContent: name }));
    material.append(Object.assign(document.createElement('option'), { value: '+', textContent: '＋ Новый материал…' }));
    material.value = object.material ?? '';
    material.addEventListener('change', () => {
      if (material.value !== '+') {
        const next = materials[material.value];
        editor.changeObjects(shapeUids, (item) => {
          item.material = material.value;
          // (a lamp's material: a light ID of its own; another: none)
          if (next !== undefined && isLightShader(next.shader)) item.light ??= { type: 0, id: editor.freeLightId(0, shapes.flatMap((other) => (other.light?.type === 0 ? [other.light.id] : []))) };
          else delete item.light;
        });
        return;
      }
      let name = tr('Материал');
      for (let n = 2; materials[name] !== undefined; n++) name = `${tr('Материал')} ${String(n)}`;
      const base = object.material === undefined ? undefined : materials[object.material];
      editor.setSceneMaterial(name, base === undefined ? { shader: 'Standard', color: [0.6, 0.6, 0.65, 1] } : structuredClone(base));
      editor.changeObjects(shapeUids, (item) => (item.material = name), 'env:new-material');
      this.material = name;
      this.render();
    });
    material.title = 'Материал';
    const edit = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: '✎', title: 'Вид и цвет материала (меняется у всех объектов из него)' });
    edit.addEventListener('click', () => {
      this.material = object.material ?? null;
      this.render();
    });
    const own = Object.assign(document.createElement('button'), { type: 'button', className: 'env-icon', textContent: '⧉', title: 'Сделать материал своим: создать его копию только для выбранных объектов, не меняя остальные' });
    own.disabled = object.material === undefined;
    own.addEventListener('click', () => {
      const name = editor.makeMaterialOwn(shapeUids);
      if (name !== null) this.material = name;
      this.render();
    });
    row('Фигура', shape, material, edit, own);

    const collision = document.createElement('label');
    collision.className = 'adjust-check';
    const collisionBox = Object.assign(document.createElement('input'), { type: 'checkbox', checked: object.collision === true });
    collisionBox.addEventListener('change', () => editor.changeObjects(shapeUids, (item) => {
      if (collisionBox.checked) item.collision = true;
      else delete item.collision;
    }));
    collision.append(collisionBox, ' Осколки отскакивают (collision)');
    root.append(collision);

    const made = object.material === undefined ? undefined : materials[object.material];
    if (made === undefined || !isLightShader(made.shader)) return;
    // a lamp: which lights' events drive it, and its light ID
    const light = object.light ?? { type: 0, id: 0 };
    const types = [...new Set([0, 1, 2, 3, 4, ...editor.lightsByType.keys()])].sort((a, b) => a - b);
    const type = document.createElement('select');
    for (const item of types) type.append(Object.assign(document.createElement('option'), { value: String(item), textContent: `${tr(classicGroupName(item))} (${String(item)})` }));
    type.value = String(light.type);
    type.title = 'Какой группой событий света управляется лампа (тип события)';
    type.addEventListener('change', () => {
      const next = Number(type.value);
      const taken: number[] = [];
      editor.changeObjects(shapeUids, (item) => {
        const id = editor.freeLightId(next, taken);
        taken.push(id);
        item.light = { type: next, id };
      });
    });
    const id = document.createElement('label');
    id.className = 'env-mini';
    id.title = 'Номер лампы (light ID)';
    if (shapes.length === 1) id.append(Object.assign(document.createElement('span'), { textContent: 'ID' }), numberDrum(`env:${object.uid}:light`, light.id, (next) => editor.changeObjects([object.uid], (item) => (item.light = { type: light.type, id: Math.max(0, Math.round(next)) }), 'env:light-id'), { step: 1, min: 0, max: 5000, digits: 0 }));
    const group = Object.assign(document.createElement('button'), { type: 'button', textContent: '💡 В группу', title: 'Выбранные лампы — отдельной строкой на вкладке «Свет»: на неё ставятся события и эффекты' });
    group.addEventListener('click', () => {
      const lamps = shapes.filter((item) => item.light !== undefined);
      if (lamps.length === 0) return;
      const all = expandObjects(lamps);
      editor.addGroup(lamps.length === 1 ? lamps[0]!.name : tr('Лампы сцены ({0})', all.length), all.map((item) => ({ kind: 'light' as const, type: item.light!.type, id: item.light!.id })));
      editor.setStatus(tr('Группа света создана: она появилась строкой на вкладке «Свет»'));
    });
    row('Свет', type, ...(shapes.length === 1 ? [id] : []), group);
  }

  /** A material: its name, look and colour (all the shapes made of it change with it). */
  private renderMaterial(root: HTMLElement, name: string) {
    const editor = this.editor;
    const material = editor.sceneMaterials()[name];
    if (material === undefined) return;
    const users = editor.sceneObjects().filter((object) => object.material === name);
    root.append(Object.assign(document.createElement('h3'), { textContent: tr('Материал') }));
    const row = (label: string, control: HTMLElement) => {
      const line = document.createElement('label');
      line.className = 'env-field';
      line.append(Object.assign(document.createElement('span'), { textContent: label }), control);
      root.append(line);
    };
    const title = Object.assign(document.createElement('input'), { type: 'text', value: name });
    title.addEventListener('change', () => {
      const next = title.value.trim();
      if (next === '' || next === name || editor.sceneMaterials()[next] !== undefined) {
        title.value = name;
        return;
      }
      this.material = next;
      editor.setSceneMaterial(name, material, next);
    });
    row('Название', title);
    const pickShader = (next: Shader) => {
      editor.setSceneMaterial(name, { ...material, shader: next });
      // (a lamp now, or not any more: the shapes made of it get their light IDs, or lose them)
      const taken: number[] = [];
      editor.changeObjects(users.map((object) => object.uid), (item) => {
        if (!isLightShader(next)) delete item.light;
        else if (item.light === undefined) {
          const id = editor.freeLightId(0, taken);
          taken.push(id);
          item.light = { type: 0, id };
        }
      }, 'env:shader');
    };
    root.append(this.section(tr('Вид')));
    const tiles = document.createElement('div');
    tiles.className = 'env-tiles';
    for (const item of SHADERS) {
      const tile = Object.assign(document.createElement('button'), { type: 'button', className: 'env-tile', title: SHADER_NAMES[item] });
      tile.classList.toggle('active', item === material.shader);
      const look = document.createElement('span');
      look.style.background = SHADER_LOOK[item];
      tile.append(look, Object.assign(document.createElement('em'), { textContent: SHADER_NAMES[item] }));
      tile.addEventListener('click', () => pickShader(item));
      tiles.append(tile);
    }
    root.append(tiles);
    // (its colour as it is at the playhead — animated: a change is a key there)
    const thing = `m:${name}`;
    const shownColor = editor.shownValue(thing, 'color') ?? [...material.color];
    const color = Object.assign(document.createElement('input'), { type: 'color', value: hex(shownColor) });
    color.addEventListener('input', () => editor.setPart([thing], 'color', (_key, now) => [...fromHex(color.value), now[3] ?? 1], `env:color:${name}`));
    const colorPair = document.createElement('span');
    colorPair.className = 'env-pair';
    colorPair.append(color, this.keyButton([thing], 'color'));
    row('Цвет', colorPair);
    const player = document.createElement('select');
    for (const [id, text] of PLAYER_COLORS) player.append(Object.assign(document.createElement('option'), { value: id, textContent: tr(text) }));
    player.value = material.playerColor ?? '';
    player.title = tr('Красить как вещи игрока: цвет берётся из его цветовой схемы (свой цвет выше — до начала песни и в редакторах без схемы)');
    player.addEventListener('change', () => {
      const { playerColor: _old, ...rest } = material;
      editor.setSceneMaterial(name, player.value === '' ? rest : { ...rest, playerColor: player.value });
    });
    row('Как у игрока', player);
    row(isLightShader(material.shader) ? 'Яркость (альфа)' : 'Альфа', numberDrum(`env:alpha:${name}`, shownColor[3] ?? 1, (next) => editor.setPart([thing], 'color', (_key, now) => [now[0]!, now[1]!, now[2]!, next], `env:alpha:${name}`), { step: 0.05, min: 0, max: 5, digits: 2 }));
    this.renderKeys(root);
    if (isLightShader(material.shader)) root.append(Object.assign(document.createElement('div'), { className: 'ins-note', textContent: tr('Лампа: объектом из этого материала управляют события света. «Прозрачная» не видна, пока не горит. Цвет в игре задают события; здесь — только вид в редакторе до первого события.') }));
    else if (material.shader !== 'Standard' && material.shader !== 'Glowing') root.append(Object.assign(document.createElement('div'), { className: 'ins-note', textContent: tr('В окне просмотра этот вид показан приближённо — проверьте его в игре.') }));
    // more: a track for its colour, the shader's keywords
    const more = document.createElement('details');
    more.className = 'env-written';
    more.open = material.track !== undefined || material.keywords !== undefined;
    more.append(Object.assign(document.createElement('summary'), { textContent: tr('Дополнительно') }));
    const tracked = document.createElement('label');
    tracked.className = 'adjust-check';
    tracked.title = 'Материал получает дорожку (track): по ней его цвет можно менять событиями анимации';
    const trackBox = Object.assign(document.createElement('input'), { type: 'checkbox', checked: material.track !== undefined });
    trackBox.addEventListener('change', () => {
      const { track: _track, ...rest } = material;
      editor.setSceneMaterial(name, trackBox.checked ? { ...rest, track: `lumatic_material_${name.replace(/[^\p{L}\p{N}]+/gu, '_')}` } : rest);
    });
    tracked.append(trackBox, ' Цвет можно анимировать');
    more.append(tracked);
    if (material.track !== undefined) more.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr('Дорожка: {0}', material.track) }));
    const words = Object.assign(document.createElement('input'), { type: 'text', value: (material.keywords ?? []).join(', '), placeholder: 'как у шейдера по умолчанию' });
    words.title = 'Ключевые слова шейдера через запятую — вместо его собственных. Для тех, кто знает шейдеры игры; пусто — как по умолчанию';
    words.addEventListener('change', () => {
      const list = words.value.split(',').map((item) => item.trim()).filter((item) => item !== '');
      const { keywords: _keywords, ...rest } = material;
      editor.setSceneMaterial(name, list.length === 0 ? rest : { ...rest, keywords: list });
    });
    const wordsLine = document.createElement('label');
    wordsLine.className = 'env-field';
    wordsLine.append(Object.assign(document.createElement('span'), { textContent: 'Ключевые слова' }), words);
    more.append(wordsLine);
    root.append(more);
    root.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr('Объектов из этого материала: {0}', users.length) }));
    const buttons = document.createElement('div');
    buttons.className = 'ins-buttons';
    const pick = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Выбрать объекты' });
    pick.disabled = users.length === 0;
    pick.addEventListener('click', () => {
      this.material = null;
      editor.selectEnv(users.map((object) => `o:${object.uid}`));
    });
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '🗑 Удалить', title: 'Удалить материал (можно, пока из него нет объектов)' });
    remove.disabled = users.length > 0;
    remove.addEventListener('click', () => {
      this.material = null;
      editor.setSceneMaterial(name, null);
    });
    buttons.append(pick, remove);
    root.append(buttons);
    const written = document.createElement('details');
    written.className = 'env-written';
    written.append(Object.assign(document.createElement('summary'), { textContent: tr('Как это записано в карту') }));
    written.append(Object.assign(document.createElement('pre'), { textContent: JSON.stringify({ [name]: materialCommand(material) }, null, 2) }));
    root.append(written);
  }
}
