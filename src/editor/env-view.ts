import { BoxGeometry, BufferGeometry, EdgesGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Matrix4, Object3D, Raycaster, Vector2, Vector3 } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { EnvironmentData } from '../engine/renderer/environment/types';
import type { Editor } from './editor';
import { childrenOf, generatedRootOf, generatedRoots, localFromWorld, objectBox, rayBox, shown, shownBoxes, worldMatrix } from './env-scene';
import { tr } from './i18n';

/** 'all': the arrows and the rings together. */
export type GizmoMode = 'all' | 'translate' | 'rotate' | 'scale';

/**
 * The Environment side in the 3D view: a click picks the thing under the mouse (again on the same
 * spot: the one behind it; Ctrl / Shift adds), the picked ones are framed, and the first of them has
 * handles — arrows to move it and rings to turn it (Q: both at once; W, E: one of them), cubes to size
 * it (R). Let go, the change is written — the other picked ones changed by as much — and the
 * environment built anew with it.
 */
export class EnvView {
  private readonly root = new Group();
  private readonly frames = new Group();
  private readonly proxy = new Object3D();
  private readonly controls: TransformControls;
  /** The rings shown with the arrows in 'all'. */
  private readonly rings: TransformControls;
  private readonly raycaster = new Raycaster();
  private children: { data: EnvironmentData; map: Map<number, number[]> } | null = null;
  private framedKey = '';
  private down: { x: number; y: number } | null = null;
  private lastPick: { x: number; y: number; order: string[]; at: number } | null = null;
  private dragging: 'translate' | 'rotate' | 'scale' | null = null;
  mode: GizmoMode = 'all';
  snap = false;
  /** Called when something is picked in the view (the tree shows it). */
  onPick: ((key: string) => void) | null = null;
  onMode: (() => void) | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly canvas: HTMLCanvasElement,
  ) {
    const view = editor.preview.view;
    this.root.visible = false;
    this.controls = new TransformControls(view.viewCamera, canvas);
    this.rings = new TransformControls(view.viewCamera, canvas);
    for (const controls of [this.controls, this.rings]) {
      controls.attach(this.proxy);
      controls.setSpace('local');
      controls.addEventListener('objectChange', () => this.followProxy());
    }
    this.controls.setSize(0.9);
    this.rings.setSize(0.62);
    this.rings.setMode('rotate');
    this.root.add(this.frames, this.proxy, this.controls.getHelper(), this.rings.getHelper());
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
    const drag = (controls: TransformControls) => (event: unknown) => {
      const on = (event as { value: boolean }).value;
      if (on) this.dragging = controls.getMode();
      else {
        const mode = this.dragging;
        this.dragging = null;
        if (mode !== null) this.commit(mode);
      }
    };
    this.controls.addEventListener('dragging-changed', drag(this.controls));
    this.rings.addEventListener('dragging-changed', drag(this.rings));
    canvas.addEventListener('mousedown', (event) => {
      if (this.active() && event.button === 0) this.down = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('mouseup', (event) => {
      const down = this.down;
      this.down = null;
      if (!this.active() || event.button !== 0 || down === null) return;
      // (a drag — of a handle or across the view — is not a click)
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4 || this.dragging !== null || this.controls.axis !== null || (this.mode === 'all' && this.rings.axis !== null)) return;
      this.pick(event.clientX, event.clientY, event.ctrlKey || event.metaKey || event.shiftKey);
    });
    // Q / W / E / R: all, move, turn, size (only on this side; the lights' brush keys stay theirs elsewhere)
    window.addEventListener(
      'keydown',
      (event) => {
        if (!this.active() || event.ctrlKey || event.metaKey || event.altKey) return;
        const target = event.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || document.querySelector('.ce-shade') !== null) return;
        const mode: GizmoMode | null = event.code === 'KeyQ' ? 'all' : event.code === 'KeyW' ? 'translate' : event.code === 'KeyE' ? 'rotate' : event.code === 'KeyR' ? 'scale' : null;
        if (mode === null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.setMode(mode);
      },
      true,
    );
    this.setMode('all', false);
  }

  private active() {
    return this.editor.envMode && this.editor.project !== null;
  }

  setMode(mode: GizmoMode, say = true) {
    this.mode = mode;
    this.controls.setMode(mode === 'all' ? 'translate' : mode);
    this.onMode?.();
    if (say) this.editor.setStatus(tr(mode === 'all' ? 'Двигать и вращать (Q): стрелки — сдвиг по оси, кольца — поворот' : mode === 'translate' ? 'Двигать (W): тяните за стрелку — по оси, за квадрат — по плоскости' : mode === 'rotate' ? 'Вращать (E): тяните за кольцо' : 'Масштаб (R): тяните за кубик на оси, за центр — весь объект'));
  }

  /** The handles step: a tenth of a metre, 15°, a tenth of the size. */
  setSnap(on: boolean) {
    this.snap = on;
    for (const controls of [this.controls, this.rings]) {
      controls.setTranslationSnap(on ? 0.1 : null);
      controls.setRotationSnap(on ? (15 * Math.PI) / 180 : null);
      controls.setScaleSnap(on ? 0.1 : null);
    }
    this.onMode?.();
  }

  /** The environment as the 3D view has it now (with the map's and the scene's changes). */
  private data(): EnvironmentData | null {
    return this.editor.preview.environmentData();
  }

  private kids(data: EnvironmentData) {
    if (this.children?.data !== data) this.children = { data, map: childrenOf(data) };
    return this.children.map;
  }

  /** Where a picked thing is among the view's objects (null: not there — yet). */
  renderedIndex(key: string): number | null {
    const data = this.data();
    const source = this.editor.envSceneData;
    if (data === null || source === null) return null;
    if (key.startsWith('g:')) {
      const index = Number(key.slice(2));
      return data.objects[index] !== undefined && data.objects[index]!.name === source.objects[index]?.name ? index : null;
    }
    // (the scene's own objects are the last Chroma made, in their order)
    const objects = this.editor.sceneObjects();
    const order = objects.findIndex((object) => `o:${object.uid}` === key);
    const roots = generatedRoots(data, source.objects.length);
    const index = roots[roots.length - objects.length + order];
    return order < 0 || index === undefined || roots.length < objects.length ? null : index;
  }

  /** The key of the thing an object of the view belongs to (null: nothing that can be picked). */
  private keyOf(data: EnvironmentData, index: number): string | null {
    const source = this.editor.envSceneData;
    if (source === null) return null;
    const count = source.objects.length;
    if (index < count) return data.objects[index]?.name === source.objects[index]?.name ? `g:${String(index)}` : null;
    const root = generatedRootOf(data, count, index);
    if (root === null) return null;
    const objects = this.editor.sceneObjects();
    const roots = generatedRoots(data, count);
    const order = roots.indexOf(root) - (roots.length - objects.length);
    const object = objects[order];
    return order < 0 || object === undefined ? null : `o:${object.uid}`;
  }

  /** Before each frame: the frames round the picked things, the handles on the first of them. */
  private update() {
    if (!this.active()) return;
    const data = this.data();
    const selection = this.editor.envSelection;
    const camera = this.editor.preview.view.viewCamera;
    this.controls.camera = camera;
    this.rings.camera = camera;
    const first = selection[0] === undefined ? null : this.renderedIndex(selection[0]);
    const usable = data !== null && first !== null;
    this.controls.enabled = usable;
    this.controls.getHelper().visible = usable;
    this.rings.enabled = usable && this.mode === 'all';
    this.rings.getHelper().visible = usable && this.mode === 'all';
    if (data === null) return;
    const key = `${selection.join(',')}|${String(this.editor.version)}|${String(data.objects.length)}`;
    if ((key === this.framedKey && this.children?.data === data) || this.dragging !== null) return;
    this.framedKey = key;
    const kids = this.kids(data);
    this.clearFrames();
    selection.forEach((item, order) => {
      const index = this.renderedIndex(item);
      if (index === null) return;
      for (const { box, matrix } of shownBoxes(data, index, (at) => kids.get(at) ?? [])) this.frames.add(frame(box.min, box.max, matrix, order === 0 ? 0xffe27a : 0x6aa6ff));
    });
    if (usable) {
      worldMatrix(data, first).decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
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

  /** While a handle is dragged: the first thing's frame goes with it. */
  private followProxy() {
    const data = this.data();
    const first = this.editor.envSelection[0] === undefined ? null : this.renderedIndex(this.editor.envSelection[0]);
    if (data === null || first === null) return;
    this.clearFrames();
    this.proxy.updateMatrixWorld(true);
    const kids = this.kids(data);
    // (its own frame, or — a holder — its children's, carried along by how far it has gone)
    const delta = this.proxy.matrixWorld.clone().multiply(worldMatrix(data, first).invert());
    for (const { box, matrix } of shownBoxes(data, first, (at) => kids.get(at) ?? [])) this.frames.add(frame(box.min, box.max, delta.clone().multiply(matrix), 0xffe27a));
  }

  /** A handle let go: where the first thing now stands, written as its own place, turn or size — the
   *  other picked ones moved, turned or sized by as much. */
  private commit(mode: 'translate' | 'rotate' | 'scale') {
    const editor = this.editor;
    const data = this.data();
    const keys = editor.envSelection;
    const first = keys[0] === undefined ? null : this.renderedIndex(keys[0]);
    this.framedKey = '';
    if (data === null || first === null) return;
    const before = editor.sceneValues(keys[0]!);
    if (before === null || (before.object === undefined && (before.id === null || before.id === undefined))) {
      editor.setStatus(tr('У этого объекта нет id для Chroma: его нельзя изменить'));
      return;
    }
    this.proxy.updateMatrixWorld(true);
    const object = data.objects[first]!;
    const local = localFromWorld(this.proxy.matrixWorld, object.parent < 0 ? new Matrix4() : worldMatrix(data, object.parent));
    const part = mode === 'translate' ? 'position' : mode === 'rotate' ? 'rotation' : 'scale';
    const was = before[part];
    const now = local[part];
    const tidy = (value: number) => Math.round(value * 10000) / 10000;
    editor.applyScene(keys, (key, values) => {
      if (key === keys[0]) return { [part]: now };
      // (the others: by as much — sizes by as many times)
      const own = values[part];
      return { [part]: own.map((value, axis) => tidy(part === 'scale' ? (Math.abs(was[axis]!) < 1e-9 ? value : (value * now[axis]!) / was[axis]!) : value + now[axis]! - was[axis]!)) as [number, number, number] };
    });
  }

  /** A click: the nearest thing with a mesh under the mouse (the same spot again: the next behind). */
  private pick(clientX: number, clientY: number, adding: boolean) {
    const data = this.data();
    if (data === null) return;
    const rect = this.canvas.getBoundingClientRect();
    const camera = this.editor.preview.view.viewCamera;
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
    const { origin, direction } = this.raycaster.ray;
    const hits = new Map<string, number>();
    data.objects.forEach((object, index) => {
      if (object.mesh === undefined || object.rendererEnabled === false || !shown(data, index)) return;
      const key = this.keyOf(data, index);
      const box = key === null ? null : objectBox(data, index);
      if (key === null || box === null) return;
      const distance = rayBox(origin, direction, box, worldMatrix(data, index));
      if (distance !== null && distance < (hits.get(key) ?? Infinity)) hits.set(key, distance);
    });
    const order = [...hits].sort((a, b) => a[1] - b[1]).map(([key]) => key);
    if (order.length === 0) {
      if (!adding) this.editor.selectEnv([]);
      this.lastPick = null;
      return;
    }
    const last = this.lastPick;
    const again = last !== null && Math.hypot(last.x - clientX, last.y - clientY) < 4 && JSON.stringify(last.order) === JSON.stringify(order);
    const at = again ? (last.at + 1) % order.length : 0;
    this.lastPick = { x: clientX, y: clientY, order, at };
    const key = order[at]!;
    this.editor.selectEnv([key], adding ? 'toggle' : 'replace');
    this.onPick?.(key);
  }

  /** A place a few metres in front of the camera (Chroma's: z ahead) — where a new thing goes. */
  placeAhead(distance = 6): [number, number, number] {
    const camera = this.editor.preview.view.viewCamera;
    camera.updateMatrixWorld();
    const at = new Vector3();
    const way = new Vector3();
    camera.getWorldPosition(at);
    camera.getWorldDirection(way);
    at.addScaledVector(way, distance);
    const round = (value: number) => Math.round(value * 10) / 10;
    return [round(at.x), Math.max(0, round(at.y)), round(-at.z)];
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
