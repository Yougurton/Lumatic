import type { EnvironmentData } from '../engine/renderer/environment/types';
import type { Editor } from './editor';
import { localOf, sceneTree, type SceneNode } from './env-scene';
import { sceneCommand, type SceneEdit } from './environment-mods';
import { numberDrum } from './grids';
import { tr } from './i18n';

/**
 * The Environment side's panels. Left: the scene — the game's environment as a tree of its objects
 * (search, the changed ones only; a click picks, Ctrl adds; the eye hides an object in the game).
 * Right: the picked object — where it stands, how it's turned and sized (its own values, drums), hide,
 * back as it was, and how the change is written into the map.
 */
export class EnvPanel {
  private data: EnvironmentData | null = null;
  private dataFor = '';
  private tree: { nodes: Map<number, SceneNode>; roots: number[] } = { nodes: new Map(), roots: [] };
  private readonly open = new Set<number>();
  private search = '';
  private changedOnly = false;
  private readonly list = document.createElement('div');
  private readonly count = document.createElement('div');
  private shownKey = '';

  constructor(
    private readonly editor: Editor,
    private readonly sceneRoot: HTMLElement,
    private readonly inspectorRoot: HTMLElement,
  ) {
    sceneRoot.classList.add('env-scene');
    const head = document.createElement('div');
    head.className = 'env-head';
    const search = Object.assign(document.createElement('input'), { type: 'search', placeholder: 'Поиск по имени объекта' });
    search.addEventListener('input', () => {
      this.search = search.value.trim().toLowerCase();
      this.renderTree();
    });
    const changed = document.createElement('label');
    changed.className = 'adjust-check';
    changed.title = 'Показать только объекты, которые вы изменили или скрыли';
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
    box.addEventListener('change', () => {
      this.changedOnly = box.checked;
      this.renderTree();
    });
    changed.append(box, ' Только изменённые');
    head.append(search, changed);
    this.list.className = 'env-tree';
    this.count.className = 'nm-dim env-count';
    sceneRoot.append(head, this.list, this.count);
    editor.onChange(() => void this.refresh());
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
        this.tree = sceneTree(data);
        this.open.clear();
        // (the top holders opened: what's inside the environment shows at once)
        for (const root of this.tree.roots) this.open.add(root);
        editor.envSceneData = data;
      } catch (error) {
        console.error(error);
        this.list.replaceChildren(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr('Не удалось загрузить окружение') }));
        return;
      }
      this.shownKey = '';
    }
    const key = `${JSON.stringify(editor.envSelection)}|${JSON.stringify(editor.sceneEdits())}|${this.search}|${String(this.changedOnly)}|${[...this.open].join(',')}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.renderTree();
    this.renderInspector();
  }

  /** The tree's nodes for the picked objects opened down to them (picked in the 3D view). */
  reveal(index: number) {
    for (let at = this.tree.nodes.get(index)?.parent ?? -1; at >= 0; at = this.tree.nodes.get(at)?.parent ?? -1) this.open.add(at);
    this.shownKey = '';
    void this.refresh().then(() => this.list.querySelector('.env-node.picked')?.scrollIntoView({ block: 'nearest' }));
  }

  private editOf(node: SceneNode): SceneEdit | undefined {
    return node.id === null ? undefined : this.editor.sceneEdits().find((edit) => edit.id === node.id);
  }

  private renderTree() {
    const editor = this.editor;
    const { nodes, roots } = this.tree;
    const rows: HTMLElement[] = [];
    const edited = new Set(editor.sceneEdits().map((edit) => edit.id));
    const picked = new Set(editor.envSelection);
    const row = (node: SceneNode, depth: number, flat: boolean) => {
      const edit = this.editOf(node);
      const line = document.createElement('div');
      line.className = 'env-node';
      line.classList.toggle('picked', picked.has(node.index));
      line.classList.toggle('hidden-object', edit?.hidden === true);
      line.classList.toggle('no-id', node.id === null);
      line.style.paddingLeft = `${String(4 + depth * 12)}px`;
      const twist = document.createElement('span');
      twist.className = 'env-twist';
      twist.textContent = flat || node.children.length === 0 ? '' : this.open.has(node.index) ? '▾' : '▸';
      twist.addEventListener('click', (event) => {
        event.stopPropagation();
        if (this.open.has(node.index)) this.open.delete(node.index);
        else this.open.add(node.index);
        this.shownKey = '';
        this.renderTree();
      });
      const name = Object.assign(document.createElement('span'), { className: 'env-name', textContent: node.name });
      name.title = node.id ?? tr('У объекта нет id для Chroma: его нельзя изменить');
      const marks = Object.assign(document.createElement('span'), { className: 'env-marks', textContent: `${edit !== undefined && (edit.position !== undefined || edit.rotation !== undefined || edit.scale !== undefined) ? '✎' : ''}${node.below > 0 && !flat ? ` ${String(node.below)}` : ''}` });
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'env-eye';
      eye.textContent = edit?.hidden === true ? '◌' : '👁';
      eye.title = edit?.hidden === true ? 'Скрыт в игре. Показать' : 'Скрыть объект в игре';
      eye.disabled = node.id === null;
      eye.addEventListener('click', (event) => {
        event.stopPropagation();
        if (node.id !== null) editor.changeScene([node.id], (item) => (item.hidden = item.hidden === true ? undefined : true));
      });
      line.append(twist, name, marks, eye);
      line.addEventListener('click', (event) => editor.selectEnv([node.index], event.ctrlKey || event.metaKey || event.shiftKey ? 'toggle' : 'replace'));
      rows.push(line);
    };
    const filtered = this.search !== '' || this.changedOnly;
    if (filtered) {
      // (a flat list of what fits: at most 300 lines)
      for (const node of nodes.values()) {
        if (this.search !== '' && !node.name.toLowerCase().includes(this.search)) continue;
        if (this.changedOnly && (node.id === null || !edited.has(node.id))) continue;
        row(node, 0, true);
        if (rows.length >= 300) break;
      }
    } else {
      const walk = (index: number, depth: number) => {
        const node = nodes.get(index);
        if (node === undefined) return;
        row(node, depth, false);
        if (this.open.has(index)) for (const child of node.children) walk(child, depth + 1);
      };
      for (const root of roots) walk(root, 0);
    }
    if (rows.length === 0) rows.push(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr(filtered ? 'Ничего не найдено' : 'В окружении нет объектов') }));
    this.list.replaceChildren(...rows);
    this.count.textContent = tr('Объектов: {0} · изменено: {1}', nodes.size, editor.sceneEdits().length);
  }

  private renderInspector() {
    const editor = this.editor;
    const root = this.inspectorRoot;
    root.replaceChildren();
    const data = this.data;
    const picked = editor.envSelection.map((index) => this.tree.nodes.get(index)).filter((node): node is SceneNode => node !== undefined);
    const first = picked[0];
    if (data === null || first === undefined) {
      root.append(Object.assign(document.createElement('div'), { className: 'ins-note', textContent: tr('Выберите объект: кликните по нему в 3D-окне или в списке слева. Ctrl — добавить к выбранным.') }));
      return;
    }
    root.append(Object.assign(document.createElement('h3'), { textContent: picked.length === 1 ? first.name : tr('Выбрано объектов: {0}', picked.length) }));
    const ids = picked.map((node) => node.id).filter((id): id is string => id !== null);
    if (first.id === null) {
      root.append(Object.assign(document.createElement('div'), { className: 'ins-note', textContent: tr('У этого объекта нет id для Chroma — изменить можно только объект выше или ниже по дереву.') }));
      return;
    }
    const edit = this.editOf(first);
    const own = localOf(data, first.index)!;
    const now = { position: edit?.position ?? own.position, rotation: edit?.rotation ?? own.rotation, scale: edit?.scale ?? own.scale };
    const axes = ['X', 'Y', 'Z'];
    const line = (label: string, key: 'position' | 'rotation' | 'scale', step: number, min: number, max: number, hint: string) => {
      const section = document.createElement('div');
      section.className = 'env-row';
      const title = Object.assign(document.createElement('div'), { className: 'env-row-title', textContent: label, title: hint });
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'env-back';
      back.textContent = '↺';
      back.title = 'Вернуть как в игре';
      back.disabled = edit?.[key] === undefined;
      back.addEventListener('click', () => editor.changeScene([first.id!], (item) => delete item[key]));
      title.append(back);
      const drums = document.createElement('div');
      drums.className = 'env-drums';
      now[key].forEach((value, axis) => {
        const cell = document.createElement('label');
        cell.append(
          Object.assign(document.createElement('span'), { textContent: axes[axis]! }),
          numberDrum(`env:${first.id!}:${key}:${String(axis)}`, value, (next) => editor.changeScene([first.id!], (item) => {
            const values = [...(item[key] ?? own[key])] as [number, number, number];
            values[axis] = next;
            // (back where the game has it: no change kept for it)
            if (values.every((entry, k) => Math.abs(entry - own[key][k]!) < 1e-6)) delete item[key];
            else item[key] = values;
          }, `env:${key}:${String(axis)}`), { step, min, max, digits: 4 }),
        );
        drums.append(cell);
      });
      section.append(title, drums);
      root.append(section);
    };
    line('Положение, м', 'position', 0.1, -500, 500, 'Своё положение объекта относительно родителя, в метрах: X — вправо, Y — вверх, Z — вперёд');
    line('Поворот, °', 'rotation', 1, -360, 360, 'Свой поворот объекта вокруг осей X, Y, Z, в градусах');
    line('Масштаб', 'scale', 0.05, 0, 200, 'Размер объекта по осям (1 — как в игре)');
    const buttons = document.createElement('div');
    buttons.className = 'ins-buttons';
    const hide = document.createElement('button');
    hide.type = 'button';
    const hidden = edit?.hidden === true;
    hide.textContent = hidden ? '👁 Показать' : '◌ Скрыть';
    hide.title = 'Скрыть выбранные объекты в игре (вместе со всем, что внутри них)';
    hide.addEventListener('click', () => editor.changeScene(ids, (item) => (item.hidden = hidden ? undefined : true)));
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '↺ Вернуть как было';
    reset.title = 'Убрать все изменения выбранных объектов';
    reset.disabled = !picked.some((node) => this.editOf(node) !== undefined);
    reset.addEventListener('click', () =>
      editor.changeScene(ids, (item) => {
        delete item.hidden;
        delete item.position;
        delete item.rotation;
        delete item.scale;
      }),
    );
    buttons.append(hide, reset);
    root.append(buttons);
    if (picked.length > 1) root.append(Object.assign(document.createElement('div'), { className: 'ins-note', textContent: tr('Положение, поворот и масштаб меняются у первого выбранного; «Скрыть» и «Вернуть» — у всех.') }));
    // how it's written into the map
    const written = document.createElement('details');
    written.className = 'env-written';
    written.append(Object.assign(document.createElement('summary'), { textContent: tr('Как это записано в карту') }));
    const command = edit === undefined ? null : sceneCommand(edit);
    const code = document.createElement('pre');
    code.textContent = command === null ? tr('Объект не изменён — в карту ничего не пишется.\nid: {0}', first.id) : JSON.stringify(command, null, 2);
    written.append(code);
    root.append(written);
  }
}
