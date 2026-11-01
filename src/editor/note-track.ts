import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CubicBezierCurve3,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Plane,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  ShapeGeometry,
  Shape,
  Sprite,
  SpriteMaterial,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
} from 'three';
import type { Editor } from './editor';
import { DIR_VECTOR, type MapArc, type MapChain, type MapNote, type MapWall, type ObjectKind } from './notes';
import { newId } from './model';
import { jumpOf } from './note-inspector';
import { settings } from './settings';

/**
 * The notes side's 3D track (as in ChroMapper): the notes stand still along a track going away from
 * the song cursor — a beat every metre and a half — and at the cursor stands the grid 4×3, the "wall"
 * notes are put on: the mouse over one of its cells shows the note there, a click puts it in (a drag
 * from it: its arrow that way). Notes on the track are picked with a click beside the wall, or
 * Shift/Ctrl+click anywhere (behind the wall too; more than one), the
 * middle button gives them the other colour, Alt+wheel turns them. The wheel moves the song cursor a
 * grid step, Ctrl+wheel makes the grid finer or coarser. A red line across the track: how far the
 * player sees ahead — the half jump: what's put in the same half of the grid before it is easily hidden
 * behind a note in the middle (a vision block). The environment and its lights go on around it.
 */

/** Metres a beat along the track. */
export const METRES_PER_BEAT = 1.6;
const LANE = 0.6;
const WIDTH = LANE * 4;
const NOTE = 0.5;
/** The beats shown ahead of the cursor and behind it. */
const AHEAD = 40;
const BEHIND = 1;
const rowY = (row: number) => LANE / 2 + row * LANE;
const colX = (col: number) => (col - 1.5) * LANE;

/** Where the camera looks at the track from (as ChroMapper's editor camera). */
export const TRACK_POSE = { position: [0, 2.6, 5.2] as [number, number, number], yaw: 0, pitch: -0.3 };

/** The arrow's turn (degrees, the game's): 0 points down. */
const ROLL: Record<number, number> = { 0: 180, 1: 0, 2: -90, 3: 90, 4: -135, 5: 135, 6: -45, 7: 45, 8: 0 };

type Hit = { kind: ObjectKind; id: string };

export class NoteTrack {
  private readonly root = new Group();
  /** Moves with the song cursor: its children sit at -beat × metres. */
  private readonly moving = new Group();
  private readonly wall = new Group();
  private readonly ghost = new Group();
  private readonly redLine: Mesh;
  private notes: InstancedMesh;
  private arrows: InstancedMesh;
  private dots: InstancedMesh;
  private bombs: InstancedMesh;
  private links: InstancedMesh;
  private noteIds: { kind: ObjectKind; id: string }[] = [];
  private bombIds: string[] = [];
  private linkIds: string[] = [];
  private readonly extras = new Group();
  private readonly beatLines = new Group();
  private readonly numbers: Sprite[] = [];
  private readonly numberTextures = new Map<number, CanvasTexture>();
  private builtKey = '';
  private linesKey = '';
  private numbersKey = '';
  private readonly clip: Plane[] = [new Plane(new Vector3(0, 0, 1), AHEAD * METRES_PER_BEAT), new Plane(new Vector3(0, 0, -1), BEHIND * METRES_PER_BEAT)];
  private readonly raycaster = new Raycaster();
  private hoverCell: { col: number; row: number } | null = null;
  private press: { x: number; y: number; col: number; row: number } | null = null;
  private wheelSum = 0;
  private active = false;

  constructor(
    private readonly editor: Editor,
    private readonly canvas: HTMLCanvasElement,
  ) {
    const view = editor.preview.view;
    const scene = view.overlayScene;
    scene.add(new AmbientLight(0xffffff, 1.6));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.6, 2, 3);
    scene.add(sun);
    scene.add(this.root);
    this.root.visible = false;
    this.root.add(this.moving, this.wall, this.ghost);
    this.moving.add(this.beatLines, this.extras);

    // the track's floor and its four lanes
    const floor = new Mesh(new PlaneGeometry(WIDTH + 0.3, (AHEAD + BEHIND) * METRES_PER_BEAT), new MeshBasicMaterial({ color: 0x2a2d36, transparent: true, opacity: 0.9, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.002, -((AHEAD - BEHIND) * METRES_PER_BEAT) / 2);
    this.root.add(floor);
    const lanes: number[] = [];
    for (let k = 0; k <= 4; k++) lanes.push(colX(k - 0.5), 0, BEHIND * METRES_PER_BEAT, colX(k - 0.5), 0, -AHEAD * METRES_PER_BEAT);
    this.root.add(this.lines(lanes, 0xd0d4de, 0.8));

    // the wall at the cursor: the grid 4×3 notes go on
    const pane = new Mesh(new PlaneGeometry(WIDTH, LANE * 3), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, side: DoubleSide, depthWrite: false }));
    pane.position.set(0, LANE * 1.5, 0);
    this.wall.add(pane);
    const grid: number[] = [];
    for (let k = 0; k <= 4; k++) grid.push(colX(k - 0.5), 0, 0, colX(k - 0.5), LANE * 3, 0);
    for (let k = 0; k <= 3; k++) grid.push(-WIDTH / 2, k * LANE, 0, WIDTH / 2, k * LANE, 0);
    this.wall.add(this.lines(grid, 0xffffff, 0.55));
    this.redLine = new Mesh(new PlaneGeometry(WIDTH + 0.6, 0.05), new MeshBasicMaterial({ color: 0xff3040, transparent: true, opacity: 0.9, depthWrite: false }));
    this.redLine.rotation.x = -Math.PI / 2;
    this.redLine.position.y = 0.004;
    this.root.add(this.redLine);

    this.notes = this.instanced(new BoxGeometry(NOTE, NOTE, NOTE), new MeshLambertMaterial({ clippingPlanes: this.clip }), 1);
    this.arrows = this.instanced(this.arrowGeometry(), new MeshBasicMaterial({ color: 0xffffff, clippingPlanes: this.clip }), 1);
    this.dots = this.instanced(new CircleGeometry(0.07, 16), new MeshBasicMaterial({ color: 0xffffff, clippingPlanes: this.clip }), 1);
    this.bombs = this.instanced(new IcosahedronGeometry(0.2, 0), new MeshLambertMaterial({ color: 0x3a3c44, clippingPlanes: this.clip }), 1);
    this.links = this.instanced(new BoxGeometry(NOTE, 0.12, NOTE), new MeshLambertMaterial({ clippingPlanes: this.clip }), 1);

    view.overlayUpdate = () => this.update();
    this.bind();
  }

  private lines(points: number[], color: number, opacity: number) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    return new LineSegments(geometry, new LineBasicMaterial({ color, transparent: true, opacity, clippingPlanes: this.clip }));
  }

  private instanced(geometry: BufferGeometry, material: Material, count: number) {
    const mesh = new InstancedMesh(geometry, material, Math.max(1, count));
    mesh.count = 0;
    mesh.frustumCulled = false;
    return mesh;
  }

  private arrowGeometry() {
    // (the game's chevron, pointing down, on the note's face)
    const shape = new Shape();
    shape.moveTo(-0.17, 0.06);
    shape.lineTo(0.17, 0.06);
    shape.lineTo(0, -0.1);
    shape.closePath();
    return new ShapeGeometry(shape);
  }

  /** The track shown (the notes side, its track view) or not. */
  setActive(on: boolean) {
    this.active = on;
    this.root.visible = on;
    this.canvas.style.cursor = on ? 'crosshair' : '';
    if (!on) this.hoverCell = null;
  }

  // ----- building --------------------------------------------------------------------------------------

  private rgb(color: readonly number[]) {
    return new Color(color[0] ?? 1, color[1] ?? 1, color[2] ?? 1);
  }

  /** The objects as meshes (again when they, the selection or the colours change). */
  private build() {
    const editor = this.editor;
    const colors = editor.preview.colors;
    const key = `${String(editor.noteVersion)}|${[...editor.noteSelection].join(',')}|${[...colors.leftNote, ...colors.rightNote, ...colors.obstacle].join(',')}`;
    if (key === this.builtKey) return;
    this.builtKey = key;
    const objects = editor.objects;
    const picked = editor.noteSelection;
    const z = (beat: number) => -beat * METRES_PER_BEAT;
    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const scale = new Vector3(1, 1, 1);
    const position = new Vector3();
    const axis = new Vector3(0, 0, 1);
    const highlight = new Color(1, 0.9, 0.45);

    // notes and chains' heads
    const heads: { kind: ObjectKind; note: Pick<MapNote, 'id' | 'b' | 'x' | 'y' | 'c' | 'd' | 'a'> }[] = [
      ...objects.notes.map((note) => ({ kind: 'notes' as ObjectKind, note })),
      ...objects.chains.map((chain) => ({ kind: 'chains' as ObjectKind, note: { id: chain.id, b: chain.b, x: chain.x, y: chain.y, c: chain.c, d: chain.d, a: 0 } })),
    ];
    const replace = (old: InstancedMesh, count: number) => {
      if (old.instanceMatrix.count >= count) return old;
      const next = new InstancedMesh(old.geometry, old.material, Math.max(16, Math.ceil(count * 1.5)));
      next.count = 0;
      next.frustumCulled = false;
      this.moving.remove(old);
      old.dispose();
      return next;
    };
    this.notes = replace(this.notes, heads.length);
    this.arrows = replace(this.arrows, heads.length);
    this.dots = replace(this.dots, heads.length);
    this.bombs = replace(this.bombs, objects.bombs.length);
    const linkCount = objects.chains.reduce((sum, chain) => sum + Math.max(1, chain.sc - 1), 0);
    this.links = replace(this.links, linkCount);
    for (const mesh of [this.notes, this.arrows, this.dots, this.bombs, this.links]) if (mesh.parent !== this.moving) this.moving.add(mesh);
    this.noteIds = [];
    let arrows = 0;
    let dots = 0;
    heads.forEach(({ kind, note }, index) => {
      quaternion.setFromAxisAngle(axis, (((ROLL[note.d] ?? 0) + note.a) * Math.PI) / 180);
      position.set(colX(note.x), rowY(note.y), z(note.b));
      matrix.compose(position, quaternion, scale);
      this.notes.setMatrixAt(index, matrix);
      const color = this.rgb(note.c === 0 ? colors.leftNote : colors.rightNote);
      if (picked.has(note.id)) color.lerp(highlight, 0.55);
      this.notes.setColorAt(index, color);
      this.noteIds.push({ kind, id: note.id });
      // (the face the player sees: towards the cursor)
      const face = new Vector3(0, 0, NOTE / 2 + 0.002).applyQuaternion(quaternion);
      matrix.compose(position.clone().add(face), quaternion, scale);
      if (note.d === 8) this.dots.setMatrixAt(dots++, matrix);
      else this.arrows.setMatrixAt(arrows++, matrix);
    });
    this.notes.count = heads.length;
    this.arrows.count = arrows;
    this.dots.count = dots;
    this.bombIds = [];
    objects.bombs.forEach((bomb, index) => {
      position.set(colX(bomb.x), rowY(bomb.y), z(bomb.b));
      matrix.compose(position, quaternion.identity(), picked.has(bomb.id) ? new Vector3(1.3, 1.3, 1.3) : scale);
      this.bombs.setMatrixAt(index, matrix);
      this.bombs.setColorAt(index, picked.has(bomb.id) ? highlight : new Color(0x3a3c44));
      this.bombIds.push(bomb.id);
    });
    this.bombs.count = objects.bombs.length;
    // chains' links: flat slices from the head to the tail
    this.linkIds = [];
    let link = 0;
    for (const chain of objects.chains) {
      const pieces = Math.max(1, chain.sc - 1);
      const color = this.rgb(chain.c === 0 ? colors.leftNote : colors.rightNote);
      if (picked.has(chain.id)) color.lerp(highlight, 0.55);
      for (let k = 1; k <= pieces; k++) {
        const t = (k / pieces) * Math.max(0.05, Math.min(1, chain.s));
        position.set(colX(chain.x + (chain.tx - chain.x) * t), rowY(chain.y + (chain.ty - chain.y) * t), z(chain.b + (chain.tb - chain.b) * t));
        matrix.compose(position, quaternion.setFromAxisAngle(axis, ((ROLL[chain.d] ?? 0) * Math.PI) / 180), scale);
        this.links.setMatrixAt(link, matrix);
        this.links.setColorAt(link, color);
        this.linkIds.push(chain.id);
        link++;
      }
    }
    this.links.count = link;
    for (const mesh of [this.notes, this.arrows, this.dots, this.bombs, this.links]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }

    // walls, arcs, the picked objects' outlines
    for (const child of [...this.extras.children]) {
      this.extras.remove(child);
      const mesh = child as Mesh;
      mesh.geometry.dispose();
      (mesh.material as Material).dispose();
    }
    const obstacle = this.rgb(colors.obstacle);
    for (const wall of objects.walls) {
      const bottom = Math.max(0, wall.y * LANE - 0.45);
      const top = Math.max(bottom + 0.1, (wall.y + wall.h) * LANE - 0.45);
      const length = Math.max(0.02, wall.d * METRES_PER_BEAT);
      const geometry = new BoxGeometry(wall.w * LANE - 0.04, top - bottom, length);
      const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: obstacle, transparent: true, opacity: picked.has(wall.id) ? 0.4 : 0.22, depthWrite: false, clippingPlanes: this.clip }));
      mesh.position.set(colX(wall.x) + ((wall.w - 1) * LANE) / 2, (top + bottom) / 2, z(wall.b) - length / 2);
      mesh.userData = { kind: 'walls', id: wall.id };
      this.extras.add(mesh);
      const edges = new LineSegments(new EdgesGeometry(geometry), new LineBasicMaterial({ color: picked.has(wall.id) ? 0xffe27a : obstacle, clippingPlanes: this.clip }));
      edges.position.copy(mesh.position);
      this.extras.add(edges);
    }
    for (const arc of objects.arcs) {
      const head = new Vector3(colX(arc.x), rowY(arc.y), z(arc.b));
      const tail = new Vector3(colX(arc.tx), rowY(arc.ty), z(arc.tb));
      const [hx, hy] = DIR_VECTOR[arc.d] ?? [0, 0];
      const [tx, ty] = DIR_VECTOR[arc.tc] ?? [0, 0];
      const reach = Math.max(0.6, head.distanceTo(tail) * 0.35);
      const curve = new CubicBezierCurve3(head, head.clone().add(new Vector3(hx * arc.mu * 0.8, hy * arc.mu * 0.8, -reach)), tail.clone().add(new Vector3(-tx * arc.tmu * 0.8, -ty * arc.tmu * 0.8, reach)), tail);
      const color = this.rgb(arc.c === 0 ? colors.leftNote : colors.rightNote);
      const mesh = new Mesh(new TubeGeometry(curve, 24, picked.has(arc.id) ? 0.04 : 0.025, 6), new MeshBasicMaterial({ color: picked.has(arc.id) ? 0xffe27a : color, transparent: true, opacity: 0.85, clippingPlanes: this.clip }));
      mesh.userData = { kind: 'arcs', id: arc.id };
      this.extras.add(mesh);
    }
    // (the picked notes and bombs: an outline each)
    const outline: number[] = [];
    const box = new EdgesGeometry(new BoxGeometry(NOTE + 0.08, NOTE + 0.08, NOTE + 0.08));
    const corners = box.getAttribute('position');
    for (const { kind, note } of heads) {
      if (!picked.has(note.id) || kind !== 'notes') continue;
      for (let i = 0; i < corners.count; i++) outline.push(corners.getX(i) + colX(note.x), corners.getY(i) + rowY(note.y), corners.getZ(i) + z(note.b));
    }
    if (outline.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(outline, 3));
      this.extras.add(new LineSegments(geometry, new LineBasicMaterial({ color: 0xffe27a, clippingPlanes: this.clip })));
    }
  }

  /** The lines across the track: bars bright, beats softer, the grid's steps faint. */
  private buildLines(cursor: number) {
    const editor = this.editor;
    const step = editor.snap > 0 ? editor.snap : 0.25;
    const from = Math.floor(cursor) - BEHIND - 1;
    const to = Math.ceil(cursor) + AHEAD + 1;
    const key = `${String(from)}|${String(step)}`;
    if (key === this.linesKey) return;
    this.linesKey = key;
    for (const child of [...this.beatLines.children]) {
      this.beatLines.remove(child);
      (child as LineSegments).geometry.dispose();
    }
    const bars: number[] = [];
    const beats: number[] = [];
    const steps: number[] = [];
    const half = WIDTH / 2;
    for (let beat = Math.max(0, from); beat <= to; beat += step) {
      const rounded = Math.round(beat * 1000) / 1000;
      const zz = -rounded * METRES_PER_BEAT;
      const target = Math.abs(rounded % 4) < 1e-6 ? bars : Math.abs(rounded - Math.round(rounded)) < 1e-6 ? beats : steps;
      target.push(-half, 0.001, zz, half, 0.001, zz);
      if (steps.length > 6000) break;
    }
    this.beatLines.add(this.lines(bars, 0xffffff, 0.75), this.lines(beats, 0xc0c4d0, 0.45), this.lines(steps, 0x8a90a0, 0.18));
  }

  /** The beats' numbers beside the track (a pool of sprites moved along). */
  private placeNumbers(cursor: number) {
    const first = Math.max(0, Math.floor(cursor - BEHIND));
    const key = String(first);
    if (key === this.numbersKey) return;
    this.numbersKey = key;
    const wanted = Math.ceil(AHEAD + BEHIND) + 2;
    while (this.numbers.length < wanted) {
      const sprite = new Sprite(new SpriteMaterial({ transparent: true, depthWrite: false }));
      sprite.scale.set(0.42, 0.21, 1);
      this.numbers.push(sprite);
      this.moving.add(sprite);
    }
    this.numbers.forEach((sprite, index) => {
      const beat = first + index;
      sprite.position.set(-WIDTH / 2 - 0.35, 0.12, -beat * METRES_PER_BEAT);
      (sprite.material as SpriteMaterial).map = this.numberTexture(beat);
      (sprite.material as SpriteMaterial).opacity = beat % 4 === 0 ? 1 : 0.6;
      (sprite.material as SpriteMaterial).needsUpdate = true;
    });
  }

  private numberTexture(beat: number) {
    let texture = this.numberTextures.get(beat);
    if (texture !== undefined) return texture;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.font = 'italic 700 44px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(beat), 120, 34);
    texture = new CanvasTexture(canvas);
    this.numberTextures.set(beat, texture);
    return texture;
  }

  /** Each frame, before the track is drawn. */
  private update() {
    if (!this.active) return;
    const editor = this.editor;
    const cursor = editor.isPlaying() ? editor.playhead() : editor.snapBeat(editor.playhead());
    this.build();
    this.buildLines(cursor);
    this.placeNumbers(cursor);
    this.moving.position.z = cursor * METRES_PER_BEAT;
    // (the clipping planes are in the world: the track's ends stay where they are)
    const info = editor.row?.infoDifficulty;
    const njs = info !== undefined && info.noteJumpSpeed > 0 ? info.noteJumpSpeed : 16;
    const half = jumpOf(editor.songBpm, njs, info?.noteStartBeatOffset ?? 0).half;
    this.redLine.position.z = -half * METRES_PER_BEAT;
    this.redLine.visible = settings().visionLine;
    this.updateGhost();
  }

  // ----- the mouse ---------------------------------------------------------------------------------------

  private ray(event: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const camera = this.editor.preview.view.viewCamera;
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, camera);
    return this.raycaster.ray;
  }

  /** The wall's cell under the mouse. */
  private cellAt(event: MouseEvent): { col: number; row: number } | null {
    const ray = this.ray(event);
    if (Math.abs(ray.direction.z) < 1e-6) return null;
    const t = -ray.origin.z / ray.direction.z;
    if (t <= 0) return null;
    const point = ray.origin.clone().add(ray.direction.clone().multiplyScalar(t));
    const col = Math.floor((point.x + WIDTH / 2) / LANE);
    const row = Math.floor(point.y / LANE);
    if (col < 0 || col > 3 || row < 0 || row > 2) return null;
    return { col, row };
  }

  /** The object on the track under the mouse (null: none). */
  private objectAt(event: MouseEvent): Hit | null {
    this.ray(event);
    this.root.updateMatrixWorld(true);
    const targets = [this.notes, this.bombs, this.links, ...this.extras.children.filter((child) => child.userData.id !== undefined)];
    const hits = this.raycaster.intersectObjects(targets, false).filter((hit) => {
      // (only what's on the shown stretch of the track)
      return hit.point.z <= BEHIND * METRES_PER_BEAT && hit.point.z >= -AHEAD * METRES_PER_BEAT;
    });
    for (const hit of hits) {
      if (hit.object === this.notes && hit.instanceId !== undefined) return this.noteIds[hit.instanceId] ?? null;
      if (hit.object === this.bombs && hit.instanceId !== undefined) return { kind: 'bombs', id: this.bombIds[hit.instanceId]! };
      if (hit.object === this.links && hit.instanceId !== undefined) return { kind: 'chains', id: this.linkIds[hit.instanceId]! };
      const data = hit.object.userData as { kind?: ObjectKind; id?: string };
      if (data.id !== undefined && data.kind !== undefined) return { kind: data.kind, id: data.id };
    }
    return null;
  }

  private dragDirection(dx: number, dy: number): number | null {
    if (Math.hypot(dx, dy) < 14) return null;
    const angle = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
    return [3, 5, 0, 4, 2, 6, 1, 7][Math.round(angle / 45) % 8]!;
  }

  private lastMouse: { x: number; y: number } | null = null;

  /** The note the wall would get where the mouse is (or the drag points). */
  private updateGhost() {
    for (const child of [...this.ghost.children]) {
      this.ghost.remove(child);
      (child as Mesh).geometry.dispose();
      ((child as Mesh).material as Material).dispose();
    }
    const cell = this.press ?? this.hoverCell;
    const editor = this.editor;
    if (cell === null || editor.isPlaying()) return;
    const tool = editor.noteTool;
    const beat = editor.snapBeat(editor.playhead());
    const taken = [...editor.objects.notes, ...editor.objects.bombs].some((item) => Math.abs(item.b - beat) < 1e-3 && item.x === cell.col && item.y === cell.row);
    // (the cell itself lit)
    const glow = new Mesh(new PlaneGeometry(LANE - 0.04, LANE - 0.04), new MeshBasicMaterial({ color: taken ? 0xffe27a : 0x6aa6ff, transparent: true, opacity: 0.18, depthWrite: false, side: DoubleSide }));
    glow.position.set(colX(cell.col), rowY(cell.row), 0.001);
    this.ghost.add(glow);
    if (taken || tool.kind === 'wall') return;
    const colors = editor.preview.colors;
    if (tool.kind === 'bomb') {
      const bomb = new Mesh(new IcosahedronGeometry(0.2, 0), new MeshLambertMaterial({ color: 0x5a5c66, transparent: true, opacity: 0.6 }));
      bomb.position.set(colX(cell.col), rowY(cell.row), 0);
      this.ghost.add(bomb);
      return;
    }
    const press = this.press;
    const direction = press !== null && this.lastMouse !== null ? (this.dragDirection(this.lastMouse.x - press.x, this.lastMouse.y - press.y) ?? tool.direction) : tool.direction;
    const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), ((ROLL[direction] ?? 0) * Math.PI) / 180);
    const cube = new Mesh(new BoxGeometry(NOTE, NOTE, NOTE), new MeshLambertMaterial({ color: this.rgb(tool.kind === 'red' ? colors.leftNote : colors.rightNote), transparent: true, opacity: 0.55 }));
    cube.position.set(colX(cell.col), rowY(cell.row), 0);
    cube.quaternion.copy(quaternion);
    this.ghost.add(cube);
    const mark = new Mesh(direction === 8 ? new CircleGeometry(0.07, 16) : this.arrowGeometry(), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    mark.position.copy(cube.position).add(new Vector3(0, 0, NOTE / 2 + 0.003).applyQuaternion(quaternion));
    mark.quaternion.copy(quaternion);
    this.ghost.add(mark);
  }

  private bind() {
    const canvas = this.canvas;
    canvas.addEventListener('mousemove', (event) => {
      if (!this.active) return;
      this.lastMouse = { x: event.clientX, y: event.clientY };
      if (event.buttons & 2) {
        this.hoverCell = null;
        return;
      }
      this.hoverCell = this.cellAt(event);
      canvas.style.cursor = this.hoverCell !== null ? 'crosshair' : this.objectAt(event) !== null ? 'pointer' : 'default';
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverCell = null;
    });
    canvas.addEventListener('mousedown', (event) => {
      if (!this.active || event.button === 2) return;
      const editor = this.editor;
      const cell = this.cellAt(event);
      if (event.button === 1) {
        event.preventDefault();
        const hit = this.objectAt(event) ?? this.cellObject(cell);
        if (hit !== null) editor.updateObjects([hit.id], (_kind, item) => {
          if ('c' in item) item.c = 1 - item.c;
        });
        return;
      }
      if (event.button !== 0) return;
      // (Shift / Ctrl: what's under the mouse picked, even behind the wall — as in ChroMapper)
      const adding = event.shiftKey || event.ctrlKey || event.metaKey;
      const onTrack = cell === null || adding ? this.objectAt(event) : null;
      if (cell !== null && !(adding && onTrack !== null)) {
        this.press = { x: event.clientX, y: event.clientY, col: cell.col, row: cell.row };
        return;
      }
      if (onTrack !== null) editor.selectNotes([onTrack.id], adding ? 'toggle' : 'replace');
      else if (!adding) editor.selectNotes([]);
    });
    window.addEventListener('mouseup', (event) => {
      const press = this.press;
      this.press = null;
      if (press === null || event.button !== 0) return;
      const editor = this.editor;
      const beat = editor.snapBeat(editor.playhead());
      const there = this.cellObject(press);
      const dir = this.dragDirection(event.clientX - press.x, event.clientY - press.y);
      if (there !== null) {
        // (a note there: a click picks it, a drag turns its arrow)
        if (dir !== null && there.kind === 'notes') editor.updateObjects([there.id], (_kind, item) => ((item as MapNote).d = dir));
        else editor.selectNotes([there.id], event.shiftKey || event.ctrlKey ? 'toggle' : 'replace');
        return;
      }
      const tool = editor.noteTool;
      editor.noteRow = press.row;
      if (tool.kind === 'wall') {
        const crouch = editor.wallKind === 'crouch';
        editor.addObjects([{ kind: 'walls', item: { id: newId('n'), b: beat, x: press.col, y: crouch ? 2 : 0, d: editor.snap || 1, w: 1, h: crouch ? 3 : 5 } }], false);
      } else if (tool.kind === 'bomb') editor.addObjects([{ kind: 'bombs', item: { id: newId('n'), b: beat, x: press.col, y: press.row } }], false);
      else {
        if (dir !== null) editor.noteTool = { ...tool, direction: dir };
        editor.addObjects([{ kind: 'notes', item: { id: newId('n'), b: beat, x: press.col, y: press.row, c: tool.kind === 'red' ? 0 : 1, d: dir ?? tool.direction, a: 0 } }], false);
      }
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.active || event.defaultPrevented) return;
        event.preventDefault();
        const editor = this.editor;
        if (event.altKey) {
          // Alt+wheel over a note: its arrow turned an eighth
          const hit = this.objectAt(event) ?? this.cellObject(this.cellAt(event));
          if (hit === null || hit.kind !== 'notes') return;
          const order = [0, 5, 3, 7, 1, 6, 2, 4];
          editor.updateObjects([hit.id], (_kind, item) => {
            const note = item as MapNote;
            if (note.d !== 8) note.d = order[(order.indexOf(note.d) + (event.deltaY > 0 ? 1 : -1) + 8) % 8]!;
          });
          return;
        }
        this.wheelSum += event.deltaY;
        if (Math.abs(this.wheelSum) < 40) return;
        const up = this.wheelSum < 0;
        this.wheelSum = 0;
        if (event.ctrlKey || event.metaKey) {
          // Ctrl+wheel: the grid finer / coarser (as ChroMapper's precision)
          editor.stepSnap?.(up);
          return;
        }
        const step = editor.snap || 0.25;
        editor.seek(Math.max(0, editor.snapBeat(editor.playhead()) + (up ? step : -step)));
      },
      { passive: false },
    );
  }

  /** The note or bomb at the cursor in a cell of the wall. */
  private cellObject(cell: { col: number; row: number } | null): Hit | null {
    if (cell === null) return null;
    const editor = this.editor;
    const beat = editor.snapBeat(editor.playhead());
    const same = (item: { b: number; x: number; y: number }) => Math.abs(item.b - beat) < 1e-3 && item.x === cell.col && item.y === cell.row;
    const note = editor.objects.notes.find(same);
    if (note !== undefined) return { kind: 'notes', id: note.id };
    const bomb = editor.objects.bombs.find(same);
    return bomb === undefined ? null : { kind: 'bombs', id: bomb.id };
  }
}

export type { MapArc, MapChain, MapWall };
