import { BoxGeometry, BufferGeometry, EdgesGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Matrix4, Object3D, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { EnvironmentData } from '../engine/renderer/environment/types';
import type { Editor } from './editor';
import { localFromWorld, objectBox, rayBox, sceneTree, shown, shownBoxes, worldMatrix, type SceneNode } from './env-scene';
import { tr } from './i18n';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * The Environment side in the 3D view: a click picks the object under the mouse (again on the same
 * spot: the one behind it; Ctrl adds), the picked ones are framed, and the first of them has handles
 * to move (W), turn (E) and size (R) it — let go, the change is written and the environment built
 * anew with it.
 */
export class EnvView {
  private readonly root = new Group();
  private readonly frames = new Group();
  private readonly proxy = new Object3D();
  private readonly controls: TransformControls;
  private readonly raycaster = new Raycaster();
  private tree: { nodes: Map<number, SceneNode>; roots: number[] } = { nodes: new Map(), roots: [] };
  private treeFor: EnvironmentData | null = null;
  private framedKey = '';
  private down: { x: number; y: number } | null = null;
  private lastPick: { x: number; y: number; order: number[]; at: number } | null = null;
  private dragging = false;
  mode: GizmoMode = 'translate';
  /** Called when an object is picked in the view (the tree shows it). */
  onPick: ((index: number) => void) | null = null;
  onMode: (() => void) | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly canvas: HTMLCanvasElement,
  ) {
    const view = editor.preview.view;
    this.root.visible = false;
    this.controls = new TransformControls(view.viewCamera, canvas);
    this.controls.setSize(0.9);
    this.controls.attach(this.proxy);
    this.root.add(this.frames, this.proxy, this.controls.getHelper());
    view.overlayScene.add(this.root);
    // (the note track draws in the same overlay: both kept up before each frame)
    const before = view.overlayUpdate;
    view.overlayUpdate = () => {
      before?.();
      this.update();
    };
    // (the overlay is drawn — and kept up — only while something in it shows: switched with the side)
    editor.onChange(() => {
      this.root.visible = this.active();
    });
    this.controls.addEventListener('dragging-changed', (event) => {
      this.dragging = (event as unknown as { value: boolean }).value;
      if (!this.dragging) this.commit();
    });
    this.controls.addEventListener('objectChange', () => this.followProxy());
    canvas.addEventListener('mousedown', (event) => {
      if (this.active() && event.button === 0) this.down = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('mouseup', (event) => {
      const down = this.down;
      this.down = null;
      if (!this.active() || event.button !== 0 || down === null) return;
      // (a drag — of a handle or across the view — is not a click)
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4 || this.dragging || this.controls.axis !== null) return;
      this.pick(event.clientX, event.clientY, event.ctrlKey || event.metaKey || event.shiftKey);
    });
    // W / E / R: move, turn, size (only on this side; the lights' brush keys stay theirs elsewhere)
    window.addEventListener(
      'keydown',
      (event) => {
        if (!this.active() || event.ctrlKey || event.metaKey || event.altKey) return;
        const target = event.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || document.querySelector('.ce-shade') !== null) return;
        const mode: GizmoMode | null = event.code === 'KeyW' ? 'translate' : event.code === 'KeyE' ? 'rotate' : event.code === 'KeyR' ? 'scale' : null;
        if (mode === null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.setMode(mode);
      },
      true,
    );
  }

  private active() {
    return this.editor.envMode && this.editor.project !== null;
  }

  setMode(mode: GizmoMode) {
    this.mode = mode;
    this.controls.setMode(mode);
    // (sizes along the object's own axes; places and turns along the parent's — as they're written)
    this.controls.setSpace('local');
    this.onMode?.();
    this.editor.setStatus(tr(mode === 'translate' ? 'Двигать (W): тяните за стрелку — по оси, за квадрат — по плоскости' : mode === 'rotate' ? 'Вращать (E): тяните за кольцо' : 'Масштаб (R): тяните за кубик на оси, за центр — весь объект'));
  }

  /** The environment as the 3D view has it now (with the map's and the scene's changes). */
  private data(): EnvironmentData | null {
    return this.editor.preview.environmentData();
  }

  private nodes(data: EnvironmentData) {
    if (this.treeFor !== data) {
      this.treeFor = data;
      this.tree = sceneTree(data);
    }
    return this.tree;
  }

  /** Before each frame: the frames round the picked objects, the handles on the first of them. */
  private update() {
    if (!this.active()) return;
    const data = this.data();
    const selection = this.editor.envSelection;
    this.controls.camera = this.editor.preview.view.viewCamera;
    const first = selection[0];
    const usable = data !== null && first !== undefined && data.objects[first] !== undefined && this.editor.envSceneData?.objects[first]?.name === data.objects[first]!.name;
    this.controls.enabled = usable;
    this.controls.getHelper().visible = usable;
    if (data === null) return;
    const key = `${selection.join(',')}|${String(this.editor.version)}`;
    if (key === this.framedKey && this.treeFor === data) return;
    if (this.dragging) return;
    this.framedKey = key;
    const { nodes } = this.nodes(data);
    this.clearFrames();
    selection.forEach((index, order) => {
      const boxes = shownBoxes(data, index, (at) => nodes.get(at)?.children ?? []);
      for (const { box, matrix } of boxes) this.frames.add(frame(box.min, box.max, matrix, order === 0 ? 0xffe27a : 0x6aa6ff));
    });
    if (usable) {
      const matrix = worldMatrix(data, first);
      matrix.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
      this.proxy.updateMatrixWorld(true);
    }
  }

  private clearFrames() {
    for (const child of [...this.frames.children]) {
      this.frames.remove(child);
      (child as LineSegments).geometry.dispose();
      ((child as LineSegments).material as LineBasicMaterial).dispose();
    }
  }

  /** While a handle is dragged: the first object's frame goes with it. */
  private followProxy() {
    const data = this.data();
    const first = this.editor.envSelection[0];
    if (data === null || first === undefined) return;
    const box = objectBox(data, first);
    this.clearFrames();
    this.proxy.updateMatrixWorld(true);
    if (box !== null) this.frames.add(frame(box.min, box.max, this.proxy.matrixWorld, 0xffe27a));
    else {
      // (a holder: its children's frames carried along by how far it has gone)
      const { nodes } = this.nodes(data);
      const delta = this.proxy.matrixWorld.clone().multiply(worldMatrix(data, first).invert());
      for (const { box: part, matrix } of shownBoxes(data, first, (at) => nodes.get(at)?.children ?? [])) this.frames.add(frame(part.min, part.max, delta.clone().multiply(matrix), 0xffe27a));
    }
  }

  /** A handle let go: where the object now stands, written as its own place, turn or size. */
  private commit() {
    const editor = this.editor;
    const data = this.data();
    const source = editor.envSceneData;
    const first = editor.envSelection[0];
    if (data === null || source === null || first === undefined) return;
    const object = data.objects[first];
    const id = sceneTree(source).nodes.get(first)?.id ?? null;
    if (object === undefined || id === null) {
      editor.setStatus(tr('У этого объекта нет id для Chroma: его нельзя изменить'));
      this.framedKey = '';
      return;
    }
    this.proxy.updateMatrixWorld(true);
    const parent = object.parent < 0 ? new Matrix4() : worldMatrix(data, object.parent);
    const local = localFromWorld(this.proxy.matrixWorld, parent);
    const mode = this.mode;
    editor.changeScene([id], (edit) => {
      if (mode === 'translate') edit.position = local.position;
      else if (mode === 'rotate') edit.rotation = local.rotation;
      else edit.scale = local.scale;
    });
    this.framedKey = '';
  }

  /** A click: the nearest object with a mesh under the mouse (the same spot again: the next behind). */
  private pick(clientX: number, clientY: number, adding: boolean) {
    const data = this.data();
    if (data === null) return;
    const rect = this.canvas.getBoundingClientRect();
    const camera = this.editor.preview.view.viewCamera;
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
    const { origin, direction } = this.raycaster.ray;
    const hits: { index: number; distance: number }[] = [];
    const source = this.editor.envSceneData;
    for (const node of this.nodes(data).nodes.values()) {
      if (!node.mesh || !shown(data, node.index)) continue;
      // (only the game's own objects, as the tree lists them)
      if (source?.objects[node.index]?.name !== node.name) continue;
      const box = objectBox(data, node.index);
      if (box === null) continue;
      const distance = rayBox(origin, direction, box, worldMatrix(data, node.index));
      if (distance !== null) hits.push({ index: node.index, distance });
    }
    hits.sort((a, b) => a.distance - b.distance);
    if (hits.length === 0) {
      if (!adding) this.editor.selectEnv([]);
      this.lastPick = null;
      return;
    }
    const order = hits.map((hit) => hit.index);
    const last = this.lastPick;
    const again = last !== null && Math.hypot(last.x - clientX, last.y - clientY) < 4 && JSON.stringify(last.order) === JSON.stringify(order);
    const at = again ? (last.at + 1) % order.length : 0;
    this.lastPick = { x: clientX, y: clientY, order, at };
    const index = order[at]!;
    this.editor.selectEnv([index], adding ? 'toggle' : 'replace');
    this.onPick?.(index);
  }
}

const UNIT_EDGES = new EdgesGeometry(new BoxGeometry(1, 1, 1)).getAttribute('position');

/** A box's edges standing by `matrix`. */
function frame(min: readonly number[], max: readonly number[], matrix: Matrix4, color: number) {
  const points: number[] = [];
  const size = [Math.max(1e-3, max[0]! - min[0]!), Math.max(1e-3, max[1]! - min[1]!), Math.max(1e-3, max[2]! - min[2]!)];
  const middle = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
  const point = new Vector3();
  for (let i = 0; i < UNIT_EDGES.count; i++) {
    point.set(UNIT_EDGES.getX(i) * size[0]! + middle[0]!, UNIT_EDGES.getY(i) * size[1]! + middle[1]!, UNIT_EDGES.getZ(i) * size[2]! + middle[2]!).applyMatrix4(matrix);
    points.push(point.x, point.y, point.z);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  const lines = new LineSegments(geometry, new LineBasicMaterial({ color, depthTest: false, transparent: true }));
  lines.renderOrder = 10;
  lines.frustumCulled = false;
  return lines;
}

void Quaternion;
