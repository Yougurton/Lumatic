import { tr } from './i18n';
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
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Plane,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Sprite,
  SpriteMaterial,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
} from 'three';
import { objectRightClick } from './object-menu';
import type { Editor } from './editor';
import { DIR_VECTOR, ROW_WALL, WALL_SHAPES, placeOf, setPlace, wallFootprint, type MapArc, type MapChain, type MapNote, type MapWall, type ObjectKind } from './notes';
import { newId } from './model';
import { jumpOf } from './note-inspector';
import { settings } from './settings';
import { arrowGeometry, bombGeometry, chainLinkGeometry, dotGeometry, noteBodyGeometry } from '../engine/renderer/object-geometry';

/**
 * The notes side's 3D track (as in ChroMapper): the notes — the game's own models — stand still along
 * a track going away from the song cursor, a beat every metre and a half; at the cursor stands the grid
 * 4×3, the "wall" notes are put on. What has gone through the wall is see-through.
 *
 * The mouse: over an empty cell — the note it would get; a click puts it in, a drag from it points its
 * arrow. Over a note: lit; a click picks it (a note unlike the tool's: makes it the tool's note; Ctrl:
 * adds, also behind the wall), a drag moves the picked ones across the cells (Ctrl: along the track,
 * in time; the wheel while dragging: a grid step in time). Shift + drag on the wall: a box of cells
 * reaching along the track as far as the wheel scrolls the song meanwhile (Shift + Ctrl: adding; a
 * Shift + click: the object there added). A drag over an empty place off the wall: a box on the
 * screen. Q: the free grid — a cell in quarters, the grid reaching past its edges, things put anywhere
 * (Noodle Extensions' coordinates; a wall from point to point, any size). A short right click
 * on a note deletes it (held, the right button flies the camera). Middle click: the other colour;
 * Alt+wheel: an arrow turned. The wheel moves the song cursor a grid step, Ctrl+wheel the grid. A red
 * line across the track: where the player's sight ends — the half jump.
 */

/** Metres a beat along the track (the settings' "track scale"). */
let METRES_PER_BEAT = 1.6;
/** How far the track goes ahead of the cursor and behind it (metres). */
const TRACK_M = 64;
const BEHIND_M = 2.4;
const LANE = 0.6;
const WIDTH = LANE * 4;
const NOTE = 0.5;
/** The notes (and bombs, chains' links) drawn this much of their size: room between them to see by. */
const NOTE_SCALE = 0.82;
/** The beats shown ahead of the cursor and behind it. */
let AHEAD = TRACK_M / METRES_PER_BEAT;
let BEHIND = BEHIND_M / METRES_PER_BEAT;
/** Where things count as gone through the wall (just past the notes at the cursor). */
const PASSED = NOTE / 2 + 0.02;
const rowY = (row: number) => LANE / 2 + row * LANE;
const colX = (col: number) => (col - 1.5) * LANE;
/** The free grid (Q): its step (a quarter of a cell) and how far it reaches — four cells either side,
 *  three rows up (edges, in cells from the grid's left and from the floor). */
const FINE = 0.25;
const FREE = { left: -4, right: 8, bottom: 0, top: 6 };
const snapFine = (value: number) => Math.round(value / FINE) * FINE;
/** A place on the grid (cells: column from the left, row from the bottom) — a point of the free grid. */
type Cell = { col: number; row: number };

/** Where the camera looks at the track from (as ChroMapper's editor camera). */
export const TRACK_POSE = { position: [0, 2.6, 5.2] as [number, number, number], yaw: 0, pitch: -0.3 };

/** The arrow's turn (degrees, the game's): 0 points down. */
const ROLL: Record<number, number> = { 0: 180, 1: 0, 2: -90, 3: 90, 4: -135, 5: 135, 6: -45, 7: 45, 8: 0 };

type Hit = { kind: ObjectKind; id: string };
type AnyObject = MapObjectsItem;
type MapObjectsItem = { id: string; b: number; x: number; y: number; tb?: number; tx?: number; ty?: number; customData?: Record<string, unknown> };

/** A mesh drawn twice: whole before the wall, see-through past it (they share their instances). */
class Pair {
  solid: InstancedMesh;
  faded: InstancedMesh;

  constructor(
    private readonly geometry: BufferGeometry,
    private readonly material: Material,
    private readonly fadedMaterial: Material,
    private readonly parent: Group,
  ) {
    this.solid = new InstancedMesh(geometry, material, 16);
    this.faded = new InstancedMesh(geometry, fadedMaterial, 16);
    this.share();
  }

  private share() {
    for (const mesh of [this.solid, this.faded]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.parent.add(mesh);
    }
    this.faded.instanceMatrix = this.solid.instanceMatrix;
  }

  /** Room for `count` instances (anew when there isn't). */
  reserve(count: number) {
    if (this.solid.instanceMatrix.count >= count) return;
    this.parent.remove(this.solid, this.faded);
    this.solid.dispose();
    const size = Math.max(16, Math.ceil(count * 1.5));
    this.solid = new InstancedMesh(this.geometry, this.material, size);
    this.faded = new InstancedMesh(this.geometry, this.fadedMaterial, size);
    this.share();
  }

  finish(count: number) {
    this.solid.count = count;
    this.faded.count = count;
    this.faded.instanceColor = this.solid.instanceColor;
    this.solid.instanceMatrix.needsUpdate = true;
    if (this.solid.instanceColor !== null) this.solid.instanceColor.needsUpdate = true;
    this.solid.computeBoundingSphere();
    this.faded.boundingSphere = this.solid.boundingSphere;
  }
}

export class NoteTrack {
  private readonly root = new Group();
  /** Moves with the song cursor: its children sit at -beat × metres. */
  private readonly moving = new Group();
  private readonly wall = new Group();
  private readonly ghost = new Group();
  private readonly redLine: Mesh;
  private readonly extras = new Group();
  private readonly beatLines = new Group();
  private readonly numbers: Sprite[] = [];
  private readonly numberTextures = new Map<number, CanvasTexture>();
  private readonly ahead = new Plane(new Vector3(0, 0, 1), AHEAD * METRES_PER_BEAT);
  private readonly behind = new Plane(new Vector3(0, 0, -1), BEHIND * METRES_PER_BEAT);
  private readonly solidClip = [this.ahead, new Plane(new Vector3(0, 0, -1), PASSED)];
  private readonly fadedClip = [this.behind, new Plane(new Vector3(0, 0, 1), -PASSED)];
  private readonly trackClip = [this.ahead, this.behind];
  private readonly notes: Pair;
  private readonly arrows: Pair;
  private readonly dots: Pair;
  private readonly bombs: Pair;
  private readonly links: Pair;
  private noteIds: Hit[] = [];
  private bombIds: string[] = [];
  private linkIds: string[] = [];
  private builtKey = '';
  private linesKey = '';
  private numbersKey = '';
  private readonly raycaster = new Raycaster();
  private hoverCell: { col: number; row: number } | null = null;
  private hovered: string | null = null;
  private wheelSum = 0;
  private active = false;
  private readonly box = document.createElement('div');
  private lastMouse: { x: number; y: number } | null = null;
  private drag:
    | { kind: 'place'; x: number; y: number; col: number; row: number; free: boolean; edge: { x: number; y: number } | null }
    | {
        kind: 'pick';
        x: number;
        y: number;
        hit: Hit;
        adding: boolean;
        moving: boolean;
        plane: Plane;
        grab: Vector3;
        origin: Map<string, AnyObject>;
        time: number;
        timeOnly: boolean;
        /** A click (no drag) on a note unlike the tool's makes it the tool's note; the selection before. */
        replace: boolean;
        before: string[];
      }
    | { kind: 'box'; x: number; y: number; adding: boolean }
    /** Shift + drag on the wall (as ChroMapper): a box of cells, along the track as far as the song is
     *  scrolled while dragging. */
    | { kind: 'volume'; x: number; y: number; cell: Cell; beat: number; free: boolean; hit: Hit | null; adding: boolean; moved: boolean }
    | null = null;
  /** The free grid's lines on the wall (shown with Q). */
  private readonly fineGrid = new Group();
  /** The box Shift + drag picks with. */
  private readonly volume = new Group();

  constructor(
    private readonly editor: Editor,
    private readonly canvas: HTMLCanvasElement,
  ) {
    const view = editor.preview.view;
    const scene = view.overlayScene;
    scene.add(new AmbientLight(0xffffff, 1.1));
    const sun = new DirectionalLight(0xffffff, 2.2);
    sun.position.set(0.8, 2.5, 3);
    scene.add(sun);
    const back = new DirectionalLight(0x9fb4ff, 0.8);
    back.position.set(-1.5, 1, -2);
    scene.add(back);
    scene.add(this.root);
    this.root.visible = false;
    this.root.add(this.moving, this.wall, this.ghost);
    this.moving.add(this.beatLines, this.extras);

    // the track's floor and its four lanes
    const floor = new Mesh(new PlaneGeometry(WIDTH + 0.3, (AHEAD + BEHIND) * METRES_PER_BEAT), new MeshBasicMaterial({ color: 0x2a2d36, transparent: true, opacity: 0.9, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.004, -((AHEAD - BEHIND) * METRES_PER_BEAT) / 2);
    floor.renderOrder = -2;
    this.root.add(floor);
    const lanes: number[][] = [];
    for (let k = 0; k <= 4; k++) lanes.push([colX(k - 0.5), BEHIND * METRES_PER_BEAT, colX(k - 0.5), -AHEAD * METRES_PER_BEAT]);
    this.root.add(this.floorStrips(lanes, k(lanes.length, (index) => (index === 0 || index === 4 ? 0.045 : index === 2 ? 0.035 : 0.022)), 0xe6e9f0, 0.85));

    // the wall at the cursor: the grid 4×3 notes go on
    const pane = new Mesh(new PlaneGeometry(WIDTH, LANE * 3), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, side: DoubleSide, depthWrite: false }));
    pane.position.set(0, LANE * 1.5, 0);
    this.wall.add(pane);
    const grid: number[][] = [];
    for (let col = 0; col <= 4; col++) grid.push([colX(col - 0.5), 0, colX(col - 0.5), LANE * 3]);
    for (let row = 0; row <= 3; row++) grid.push([-WIDTH / 2, row * LANE, WIDTH / 2, row * LANE]);
    this.wall.add(this.wallStrips(grid, 0.028, 0xffffff, 0.8));
    // (the free grid: quarters faint, whole cells brighter, reaching past the grid's edges)
    const fine: number[][] = [];
    const whole: number[][] = [];
    const ex = (edge: number) => edge * LANE - WIDTH / 2;
    for (let edge = FREE.left; edge <= FREE.right + 1e-9; edge += FINE) (Math.abs(edge - Math.round(edge)) < 1e-9 ? whole : fine).push([ex(edge), FREE.bottom * LANE, ex(edge), FREE.top * LANE]);
    for (let up = FREE.bottom; up <= FREE.top + 1e-9; up += FINE) (Math.abs(up - Math.round(up)) < 1e-9 ? whole : fine).push([ex(FREE.left), up * LANE, ex(FREE.right), up * LANE]);
    this.fineGrid.add(this.wallStrips(fine, 0.008, 0x8fd8ff, 0.35), this.wallStrips(whole, 0.016, 0x8fd8ff, 0.6));
    this.fineGrid.visible = false;
    this.wall.add(this.fineGrid);
    this.moving.add(this.volume);
    this.redLine = new Mesh(new PlaneGeometry(WIDTH + 0.6, 0.07), new MeshBasicMaterial({ color: 0xff3040, transparent: true, opacity: 0.95, depthWrite: false }));
    this.redLine.rotation.x = -Math.PI / 2;
    this.redLine.position.y = 0.006;
    this.root.add(this.redLine);

    // the game's notes, bombs and chain links (the faded copies past the wall)
    const solid = (material: MeshStandardMaterial | MeshBasicMaterial) => {
      material.clippingPlanes = this.solidClip;
      return material;
    };
    const faded = (material: MeshStandardMaterial | MeshBasicMaterial) => {
      material.clippingPlanes = this.fadedClip;
      material.transparent = true;
      material.opacity = 0.22;
      material.depthWrite = false;
      return material;
    };
    const body = () => new MeshStandardMaterial({ roughness: 0.32, metalness: 0.15 });
    this.notes = new Pair(noteBodyGeometry(), solid(body()), faded(body()), this.moving);
    this.arrows = new Pair(arrowGeometry(), solid(new MeshBasicMaterial({ color: 0xffffff })), faded(new MeshBasicMaterial({ color: 0xffffff })), this.moving);
    this.dots = new Pair(dotGeometry(), solid(new MeshBasicMaterial({ color: 0xffffff })), faded(new MeshBasicMaterial({ color: 0xffffff })), this.moving);
    const bomb = () => new MeshStandardMaterial({ roughness: 0.4, metalness: 0.5 });
    this.bombs = new Pair(bombGeometry(), solid(bomb()), faded(bomb()), this.moving);
    this.links = new Pair(chainLinkGeometry(), solid(body()), faded(body()), this.moving);

    this.box.className = 'track-box';
    this.box.hidden = true;
    canvas.parentElement?.append(this.box);

    view.overlayUpdate = () => this.update();
    this.bind();
  }

  /** Flat strips on the floor (x0, z0, x1, z1 each), `widths` across. */
  private floorStrips(segments: number[][], widths: number[], color: number, opacity: number, clip = this.trackClip) {
    const points: number[] = [];
    segments.forEach(([x0, z0, x1, z1], index) => {
      const w = (widths[index] ?? widths[0] ?? 0.02) / 2;
      const dx = x1! - x0!;
      const dz = z1! - z0!;
      const length = Math.hypot(dx, dz) || 1;
      const nx = (-dz / length) * w;
      const nz = (dx / length) * w;
      const y = 0.002;
      points.push(x0! + nx, y, z0! + nz, x1! + nx, y, z1! + nz, x1! - nx, y, z1! - nz, x0! + nx, y, z0! + nz, x1! - nx, y, z1! - nz, x0! - nx, y, z0! - nz);
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    const mesh = new Mesh(geometry, new MeshBasicMaterial({ color, transparent: true, opacity, side: DoubleSide, depthWrite: false, clippingPlanes: clip }));
    mesh.renderOrder = -1;
    return mesh;
  }

  /** Strips standing in the wall's plane (x0, y0, x1, y1 each). */
  private wallStrips(segments: number[][], width: number, color: number, opacity: number) {
    const points: number[] = [];
    const w = width / 2;
    for (const [x0, y0, x1, y1] of segments) {
      const dx = x1! - x0!;
      const dy = y1! - y0!;
      const length = Math.hypot(dx, dy) || 1;
      const nx = (-dy / length) * w;
      const ny = (dx / length) * w;
      points.push(x0! + nx, y0! + ny, 0, x1! + nx, y1! + ny, 0, x1! - nx, y1! - ny, 0, x0! + nx, y0! + ny, 0, x1! - nx, y1! - ny, 0, x0! - nx, y0! - ny, 0);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    return new Mesh(geometry, new MeshBasicMaterial({ color, transparent: true, opacity, side: DoubleSide, depthWrite: false }));
  }

  /** The track shown (the notes side, its track view) or not. */
  setActive(on: boolean) {
    this.active = on;
    this.root.visible = on;
    this.canvas.style.cursor = on ? 'crosshair' : '';
    if (!on) {
      this.hoverCell = null;
      this.hovered = null;
      this.drag = null;
      this.box.hidden = true;
    }
  }

  // ----- building --------------------------------------------------------------------------------------

  private rgb(color: readonly number[]) {
    return new Color(color[0] ?? 1, color[1] ?? 1, color[2] ?? 1);
  }

  /** The objects near the cursor as meshes (again when they, the selection, the hovered one, the
   *  colours change — or the cursor goes on to the next stretch of the song). */
  private build(cursor: number) {
    const editor = this.editor;
    const colors = editor.preview.colors;
    const stretch = Math.floor(cursor / 4);
    const key = `${String(stretch)}|${String(editor.noteVersion)}|${[...editor.noteSelection].join(',')}|${String(this.hovered)}|${[...colors.leftNote, ...colors.rightNote, ...colors.obstacle].join(',')}`;
    if (key === this.builtKey) return;
    this.builtKey = key;
    // (only what's on the track's shown stretch from here to the next build: the game's models are heavy)
    const from = stretch * 4 - BEHIND - 1;
    const to = stretch * 4 + 4 + AHEAD + 1;
    const near = (item: { b: number }) => item.b >= from && item.b <= to;
    const nearSpan = (item: { b: number; tb: number }) => item.tb >= from && item.b <= to;
    const all = editor.objects;
    const objects = {
      notes: all.notes.filter(near),
      bombs: all.bombs.filter(near),
      chains: all.chains.filter(nearSpan),
      arcs: all.arcs.filter(nearSpan),
      walls: all.walls.filter((wall) => wall.b + wall.d >= from && wall.b <= to),
      fakes: editor.fakeWalls.filter((wall) => wall.b + Math.max(0, wall.d) >= from && wall.b <= to),
    };
    const picked = editor.noteSelection;
    const z = (beat: number) => -beat * METRES_PER_BEAT;
    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const one = new Vector3(NOTE_SCALE, NOTE_SCALE, NOTE_SCALE);
    const position = new Vector3();
    const axis = new Vector3(0, 0, 1);
    // (picked: its own colour kept — a little lighter — and an outline round it; hovered: lighter)
    const lit = (color: Color, id: string) => {
      if (picked.has(id)) color.lerp(new Color(1, 1, 1), 0.15);
      else if (this.hovered === id) color.lerp(new Color(1, 1, 1), 0.35);
      return color;
    };

    // notes and chains' heads
    const heads: { kind: ObjectKind; note: Pick<MapNote, 'id' | 'b' | 'x' | 'y' | 'c' | 'd' | 'a'> }[] = [
      ...objects.notes.map((note) => ({ kind: 'notes' as ObjectKind, note })),
      ...objects.chains.map((chain) => ({ kind: 'chains' as ObjectKind, note: { id: chain.id, b: chain.b, x: chain.x, y: chain.y, c: chain.c, d: chain.d, a: 0 } })),
    ];
    this.notes.reserve(heads.length);
    this.arrows.reserve(heads.length);
    this.dots.reserve(heads.length);
    this.bombs.reserve(objects.bombs.length);
    const linkCount = objects.chains.reduce((sum, chain) => sum + Math.max(1, chain.sc - 1), 0);
    this.links.reserve(linkCount);
    this.noteIds = [];
    let arrows = 0;
    let dots = 0;
    heads.forEach(({ kind, note }, index) => {
      // (two notes of a colour at one time: lined up with each other, as the game turns them)
      const roll = kind === 'notes' ? (editor.noteRoll(note.id) ?? (ROLL[note.d] ?? 0) + note.a) : (ROLL[note.d] ?? 0) + note.a;
      quaternion.setFromAxisAngle(axis, (roll * Math.PI) / 180);
      // (placed freely — Noodle's coordinates: where they put it)
      const place = kind === 'notes' ? placeOf(note as MapNote) : note;
      position.set(colX(place.x), rowY(place.y), z(note.b));
      matrix.compose(position, quaternion, one);
      this.notes.solid.setMatrixAt(index, matrix);
      this.notes.solid.setColorAt(index, lit(this.rgb(note.c === 0 ? colors.leftNote : colors.rightNote), note.id));
      this.noteIds.push({ kind, id: note.id });
      if (note.d === 8) this.dots.solid.setMatrixAt(dots++, matrix);
      else this.arrows.solid.setMatrixAt(arrows++, matrix);
    });
    this.notes.finish(heads.length);
    this.arrows.finish(arrows);
    this.dots.finish(dots);
    this.bombIds = [];
    objects.bombs.forEach((bomb, index) => {
      const place = placeOf(bomb);
      position.set(colX(place.x), rowY(place.y), z(bomb.b));
      matrix.compose(position, quaternion.identity(), one);
      this.bombs.solid.setMatrixAt(index, matrix);
      this.bombs.solid.setColorAt(index, lit(new Color(0x2c2e36), bomb.id));
      this.bombIds.push(bomb.id);
    });
    this.bombs.finish(objects.bombs.length);
    // chains' links: slices from the head to the tail
    this.linkIds = [];
    let link = 0;
    for (const chain of objects.chains) {
      const pieces = Math.max(1, chain.sc - 1);
      for (let k = 1; k <= pieces; k++) {
        const t = (k / pieces) * Math.max(0.05, Math.min(1, chain.s));
        position.set(colX(chain.x + (chain.tx - chain.x) * t), rowY(chain.y + (chain.ty - chain.y) * t), z(chain.b + (chain.tb - chain.b) * t));
        matrix.compose(position, quaternion.setFromAxisAngle(axis, ((ROLL[chain.d] ?? 0) * Math.PI) / 180), one);
        this.links.solid.setMatrixAt(link, matrix);
        this.links.solid.setColorAt(link, lit(this.rgb(chain.c === 0 ? colors.leftNote : colors.rightNote), chain.id));
        this.linkIds.push(chain.id);
        link++;
      }
    }
    this.links.finish(link);

    // walls, arcs, the picked objects' outlines
    for (const child of [...this.extras.children]) {
      this.extras.remove(child);
      child.traverse((part) => {
        const mesh = part as Mesh;
        mesh.geometry?.dispose();
        (mesh.material as Material | undefined)?.dispose();
      });
    }
    const obstacle = this.rgb(colors.obstacle);
    const deg = Math.PI / 180;
    const drawWall = (wall: MapWall, fake: boolean) => {
      // (as ChroMapper draws them: lined up with the grid's rows — a crouch wall from the top row up;
      // Noodle's walls where their coordinates, size and turns put them, in their own colour)
      const shape = wallFootprint(wall);
      const bottom = shape.noodle ? shape.y * LANE : Math.max(0, shape.y * LANE);
      const top = shape.noodle ? bottom + Math.max(0.02, shape.h * LANE) : Math.max(bottom + 0.1, Math.min(shape.y + shape.h, 5.5) * LANE);
      const length = Math.max(0.02, shape.length !== undefined ? Math.abs(shape.length) * LANE : wall.d * METRES_PER_BEAT);
      const width = Math.max(0.02, shape.w * LANE - (shape.noodle ? 0 : 0.04));
      const geometry = new BoxGeometry(width, top - bottom, length);
      // (the wall hangs from its front face's bottom middle: turned about that point)
      geometry.translate(0, (top - bottom) / 2, -length / 2);
      const on = picked.has(wall.id) || this.hovered === wall.id;
      const tint = shape.color === undefined ? obstacle : new Color(Math.min(1, shape.color[0]), Math.min(1, shape.color[1]), Math.min(1, shape.color[2]));
      const holder = new Group();
      holder.position.set((shape.x - 2) * LANE + width / 2, bottom, z(wall.b));
      if (shape.local !== undefined) holder.rotation.set(shape.local[0] * deg, shape.local[1] * deg, shape.local[2] * deg, 'YXZ');
      const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: tint, transparent: true, opacity: fake ? 0.12 : on ? 0.4 : 0.2, depthWrite: false, clippingPlanes: this.trackClip }));
      if (!fake) mesh.userData = { kind: 'walls', id: wall.id };
      const edges = new LineSegments(new EdgesGeometry(geometry), new LineBasicMaterial({ color: picked.has(wall.id) ? 0xffe27a : tint, transparent: fake, opacity: fake ? 0.5 : 1, clippingPlanes: this.trackClip }));
      holder.add(mesh, edges);
      let placed: Group = holder;
      if (shape.world !== undefined && (shape.world[0] !== 0 || shape.world[1] !== 0 || shape.world[2] !== 0)) {
        // (turned about the player: here, the track's middle where the wall arrives)
        const pivot = new Group();
        pivot.position.set(0, 0, z(wall.b));
        holder.position.z -= z(wall.b);
        pivot.rotation.set(shape.world[0] * deg, shape.world[1] * deg, shape.world[2] * deg, 'YXZ');
        pivot.add(holder);
        placed = pivot;
      }
      this.extras.add(placed);
      placed.updateMatrixWorld(true);
    };
    for (const wall of objects.walls) drawWall(wall, false);
    for (const wall of objects.fakes) drawWall(wall, true);
    for (const arc of objects.arcs) {
      const head = new Vector3(colX(arc.x), rowY(arc.y), z(arc.b));
      const tail = new Vector3(colX(arc.tx), rowY(arc.ty), z(arc.tb));
      const [hx, hy] = DIR_VECTOR[arc.d] ?? [0, 0];
      const [tx, ty] = DIR_VECTOR[arc.tc] ?? [0, 0];
      const reach = Math.max(0.6, head.distanceTo(tail) * 0.35);
      const curve = new CubicBezierCurve3(head, head.clone().add(new Vector3(hx * arc.mu * 0.8, hy * arc.mu * 0.8, -reach)), tail.clone().add(new Vector3(-tx * arc.tmu * 0.8, -ty * arc.tmu * 0.8, reach)), tail);
      const on = picked.has(arc.id) || this.hovered === arc.id;
      const color = this.rgb(arc.c === 0 ? colors.leftNote : colors.rightNote);
      const mesh = new Mesh(new TubeGeometry(curve, 24, on ? 0.04 : 0.025, 6), new MeshBasicMaterial({ color: picked.has(arc.id) ? 0xffe27a : color, transparent: true, opacity: 0.85, clippingPlanes: this.trackClip }));
      mesh.userData = { kind: 'arcs', id: arc.id };
      this.extras.add(mesh);
    }
    const outline: number[] = [];
    // (two outlines a little apart: seen well whatever the note's colour)
    for (const grow of [0.06, 0.1]) {
      const size = NOTE * NOTE_SCALE + grow;
      const corners = new EdgesGeometry(new BoxGeometry(size, size, size)).getAttribute('position');
      for (const { kind, note } of heads) {
        if (!picked.has(note.id) || kind !== 'notes') continue;
        const place = placeOf(note as MapNote);
        for (let i = 0; i < corners.count; i++) outline.push(corners.getX(i) + colX(place.x), corners.getY(i) + rowY(place.y), corners.getZ(i) + z(note.b));
      }
    }
    if (outline.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(outline, 3));
      this.extras.add(new LineSegments(geometry, new LineBasicMaterial({ color: 0xffe27a, clippingPlanes: this.trackClip })));
    }
  }

  /** The strips across the track: bars bright and wide, beats softer, the grid's steps faint. */
  private buildLines(cursor: number) {
    const editor = this.editor;
    const step = editor.snap > 0 ? editor.snap : 0.25;
    const from = Math.floor(cursor - BEHIND) - 1;
    const to = Math.ceil(cursor) + AHEAD + 1;
    const key = `${String(from)}|${String(step)}`;
    if (key === this.linesKey) return;
    this.linesKey = key;
    for (const child of [...this.beatLines.children]) {
      this.beatLines.remove(child);
      (child as Mesh).geometry.dispose();
      ((child as Mesh).material as Material).dispose();
    }
    const half = WIDTH / 2;
    const bars: number[][] = [];
    const beats: number[][] = [];
    const steps: number[][] = [];
    for (let beat = Math.max(0, from); beat <= to; beat += step) {
      const rounded = Math.round(beat * 1000) / 1000;
      const zz = -rounded * METRES_PER_BEAT;
      const target = Math.abs(rounded % 4) < 1e-6 ? bars : Math.abs(rounded - Math.round(rounded)) < 1e-6 ? beats : steps;
      target.push([-half, zz, half, zz]);
      if (steps.length > 4000) break;
    }
    // (the beat numbers' callouts: from the track's edge out to the number)
    const callouts = [...bars, ...beats].map(([, zz]) => [-half - 0.02, zz!, -half - 0.42, zz!]);
    this.beatLines.add(
      this.floorStrips(bars, [0.06], 0xffffff, 0.95),
      this.floorStrips(beats, [0.035], 0xd6dae4, 0.75),
      this.floorStrips(steps, [0.018], 0xaab0c0, 0.4),
      this.floorStrips(callouts, [0.025], 0xd6dae4, 0.7),
    );
  }

  /** The beats' numbers beside the track, at the end of their callouts (a pool of sprites moved along). */
  private placeNumbers(cursor: number) {
    const first = Math.max(0, Math.floor(cursor - BEHIND));
    const key = String(first);
    if (key === this.numbersKey) return;
    this.numbersKey = key;
    const wanted = Math.ceil(AHEAD + BEHIND) + 2;
    while (this.numbers.length < wanted) {
      const sprite = new Sprite(new SpriteMaterial({ transparent: true, depthWrite: false }));
      sprite.center.set(1, 0.5);
      this.numbers.push(sprite);
      this.moving.add(sprite);
    }
    this.numbers.forEach((sprite, index) => {
      const beat = first + index;
      const bar = beat % 4 === 0;
      sprite.position.set(-WIDTH / 2 - 0.46, 0.14, -beat * METRES_PER_BEAT);
      sprite.scale.set(bar ? 0.56 : 0.4, bar ? 0.28 : 0.2, 1);
      (sprite.material as SpriteMaterial).map = this.numberTexture(beat);
      (sprite.material as SpriteMaterial).opacity = bar ? 1 : 0.7;
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
    ctx.font = 'italic 800 46px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(String(beat), 122, 34);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(beat), 122, 34);
    texture = new CanvasTexture(canvas);
    this.numberTextures.set(beat, texture);
    return texture;
  }

  /** Each frame, before the track is drawn. */
  private update() {
    if (!this.active) return;
    const editor = this.editor;
    const cursor = editor.isPlaying() ? editor.playhead() : editor.snapBeat(editor.playhead());
    const scale = Math.min(6, Math.max(0.3, settings().trackScale));
    if (scale !== METRES_PER_BEAT) {
      // (the track longer or shorter a beat: everything along it again)
      METRES_PER_BEAT = scale;
      AHEAD = TRACK_M / scale;
      BEHIND = BEHIND_M / scale;
      this.builtKey = '';
      this.linesKey = '';
      this.numbersKey = '';
    }
    this.build(cursor);
    this.buildLines(cursor);
    this.placeNumbers(cursor);
    this.moving.position.z = cursor * METRES_PER_BEAT;
    const info = editor.row?.infoDifficulty;
    const njs = info !== undefined && info.noteJumpSpeed > 0 ? info.noteJumpSpeed : 16;
    const half = jumpOf(editor.songBpm, njs, info?.noteStartBeatOffset ?? 0).half;
    this.redLine.position.z = -half * METRES_PER_BEAT;
    this.redLine.visible = settings().visionLine;
    this.fineGrid.visible = editor.precision;
    this.updateGhost();
    this.updateVolume();
  }

  /** The cells a Shift + drag box covers (edges, in cells) and its beats. */
  private volumeSpan(drag: Extract<NoteTrack['drag'], { kind: 'volume' }>) {
    const here = this.lastMouse === null ? null : this.cellAt(this.lastMouse.x, this.lastMouse.y, drag.free, true);
    const end = here ?? drag.cell;
    const half = drag.free ? FINE / 2 : 0.5;
    const beat = this.editor.snapBeat(this.editor.playhead());
    return {
      left: Math.min(drag.cell.col, end.col) + 0.5 - half,
      right: Math.max(drag.cell.col, end.col) + 0.5 + half,
      bottom: Math.min(drag.cell.row, end.row) + 0.5 - half,
      top: Math.max(drag.cell.row, end.row) + 0.5 + half,
      from: Math.min(drag.beat, beat),
      to: Math.max(drag.beat, beat),
    };
  }

  private volumeKey = '';

  /** The box being drawn with Shift + drag: see-through cyan, from the beat it started at to the cursor. */
  private updateVolume() {
    const drag = this.drag;
    const span = drag?.kind === 'volume' && drag.moved ? this.volumeSpan(drag) : null;
    const key = span === null ? '' : JSON.stringify(span);
    if (key === this.volumeKey) return;
    this.volumeKey = key;
    for (const child of [...this.volume.children]) {
      this.volume.remove(child);
      (child as Mesh).geometry.dispose();
      ((child as Mesh).material as Material).dispose();
    }
    if (span === null) return;
    const width = (span.right - span.left) * LANE;
    const height = (span.top - span.bottom) * LANE;
    const length = Math.max(0.06, (span.to - span.from) * METRES_PER_BEAT);
    const geometry = new BoxGeometry(width, height, length);
    const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: 0x22e6ff, transparent: true, opacity: 0.09, depthWrite: false, side: DoubleSide }));
    const edges = new LineSegments(new EdgesGeometry(geometry), new LineBasicMaterial({ color: 0x22e6ff }));
    for (const part of [mesh, edges]) {
      part.position.set(span.left * LANE - WIDTH / 2 + width / 2, span.bottom * LANE + height / 2, -((span.from + span.to) / 2) * METRES_PER_BEAT);
      this.volume.add(part);
    }
  }

  /** What's inside a Shift + drag box: notes, bombs, arcs' and chains' heads by their middles, walls
   *  reaching into it. */
  private inVolume(drag: Extract<NoteTrack['drag'], { kind: 'volume' }>) {
    const span = this.volumeSpan(drag);
    const objects = this.editor.objects;
    const inside: string[] = [];
    const when = (beat: number) => beat >= span.from - 1e-3 && beat <= span.to + 1e-3;
    const where = (x: number, y: number) => x + 0.5 >= span.left - 1e-3 && x + 0.5 <= span.right + 1e-3 && y + 0.5 >= span.bottom - 1e-3 && y + 0.5 <= span.top + 1e-3;
    for (const item of [...objects.notes, ...objects.bombs]) {
      const place = placeOf(item);
      if (when(item.b) && where(place.x, place.y)) inside.push(item.id);
    }
    for (const item of [...objects.arcs, ...objects.chains]) if (when(item.b) && where(item.x, item.y)) inside.push(item.id);
    for (const wall of objects.walls) {
      const shape = wallFootprint(wall);
      const top = shape.noodle ? shape.y + shape.h : Math.min(shape.y + shape.h, 3);
      const time = wall.b <= span.to + 1e-3 && wall.b + wall.d >= span.from - 1e-3;
      if (time && shape.x < span.right - 1e-3 && shape.x + shape.w > span.left + 1e-3 && shape.y < span.top - 1e-3 && top > span.bottom + 1e-3) inside.push(wall.id);
    }
    return inside;
  }

  // ----- the mouse ---------------------------------------------------------------------------------------

  private ndc(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    return new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  private ray(clientX: number, clientY: number) {
    const camera = this.editor.preview.view.viewCamera;
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), camera);
    return this.raycaster.ray;
  }

  /** Where a ray meets a plane (null: it doesn't, ahead). */
  private meet(clientX: number, clientY: number, plane: Plane) {
    const ray = this.ray(clientX, clientY);
    const point = new Vector3();
    return ray.intersectPlane(plane, point);
  }

  /** The wall's cell under the mouse — on the free grid (Q) its nearest point, a quarter of a cell
   *  apart, around the grid too. `clamped`: off the grid, its nearest cell (a box being drawn). */
  private cellAt(clientX: number, clientY: number, free = this.editor.precision, clamped = false): Cell | null {
    const point = this.meet(clientX, clientY, new Plane(new Vector3(0, 0, 1), 0));
    if (point === null) return null;
    const x = (point.x + WIDTH / 2) / LANE;
    const y = point.y / LANE;
    if (free) {
      const inside = x >= FREE.left && x <= FREE.right && y >= FREE.bottom - 0.5 && y <= FREE.top;
      if (!inside && !clamped) return null;
      return { col: Math.max(FREE.left + 0.5, Math.min(FREE.right - 0.5, snapFine(x - 0.5))), row: Math.max(FREE.bottom, Math.min(FREE.top - 0.5, snapFine(y - 0.5))) };
    }
    const col = Math.floor(x);
    const row = Math.floor(y);
    if (clamped) return { col: Math.max(0, Math.min(3, col)), row: Math.max(0, Math.min(2, row)) };
    if (col < 0 || col > 3 || row < 0 || row > 2) return null;
    return { col, row };
  }

  /** On the free grid: the point of its lines nearest the mouse (a wall's corner: edges, in cells). */
  private edgeAt(clientX: number, clientY: number) {
    const point = this.meet(clientX, clientY, new Plane(new Vector3(0, 0, 1), 0));
    if (point === null) return null;
    return { x: Math.max(FREE.left, Math.min(FREE.right, snapFine((point.x + WIDTH / 2) / LANE))), y: Math.max(FREE.bottom, Math.min(FREE.top, snapFine(point.y / LANE))) };
  }

  /** What on the track can be picked besides the instanced notes (walls and arcs, nested or not). */
  private pickable() {
    const out: import('three').Object3D[] = [];
    this.extras.traverse((part) => {
      if (part.userData.id !== undefined) out.push(part);
    });
    return out;
  }

  /** The object on the track under the mouse (null: none). */
  private objectAt(clientX: number, clientY: number): Hit | null {
    this.ray(clientX, clientY);
    this.root.updateMatrixWorld(true);
    const targets = [this.notes.solid, this.bombs.solid, this.links.solid, ...this.pickable()];
    const hits = this.raycaster.intersectObjects(targets, false).filter((hit) => hit.point.z <= BEHIND * METRES_PER_BEAT && hit.point.z >= -AHEAD * METRES_PER_BEAT);
    for (const hit of hits) {
      if (hit.object === this.notes.solid && hit.instanceId !== undefined) return this.noteIds[hit.instanceId] ?? null;
      if (hit.object === this.bombs.solid && hit.instanceId !== undefined) return { kind: 'bombs', id: this.bombIds[hit.instanceId]! };
      if (hit.object === this.links.solid && hit.instanceId !== undefined) return { kind: 'chains', id: this.linkIds[hit.instanceId]! };
      const data = hit.object.userData as { kind?: ObjectKind; id?: string };
      if (data.id !== undefined && data.kind !== undefined) return { kind: data.kind, id: data.id };
    }
    return null;
  }

  /** The note or bomb at the cursor in a cell of the wall. */
  private cellObject(cell: Cell | null): Hit | null {
    if (cell === null) return null;
    const editor = this.editor;
    const beat = editor.snapBeat(editor.playhead());
    const same = (item: MapNote | MapObjectsItem) => {
      if (Math.abs(item.b - beat) >= 1e-3) return false;
      const place = placeOf(item);
      return Math.abs(place.x - cell.col) < 1e-3 && Math.abs(place.y - cell.row) < 1e-3;
    };
    const note = editor.objects.notes.find(same);
    if (note !== undefined) return { kind: 'notes', id: note.id };
    const bomb = editor.objects.bombs.find(same);
    return bomb === undefined ? null : { kind: 'bombs', id: bomb.id };
  }

  private dragDirection(dx: number, dy: number): number | null {
    if (Math.hypot(dx, dy) < 14) return null;
    const angle = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
    return [3, 5, 0, 4, 2, 6, 1, 7][Math.round(angle / 45) % 8]!;
  }

  /** The note the wall would get where the mouse is (or the drag points). */
  private updateGhost() {
    for (const child of [...this.ghost.children]) {
      this.ghost.remove(child);
      (child as Mesh).geometry.dispose();
      ((child as Mesh).material as Material).dispose();
    }
    const drag = this.drag;
    const cell = drag?.kind === 'place' ? drag : drag === null ? this.hoverCell : null;
    const editor = this.editor;
    if (cell === null || editor.isPlaying()) return;
    const tool = editor.noteTool;
    const taken = this.cellObject(cell) !== null;
    const free = drag?.kind === 'place' ? drag.free : editor.precision;
    const size = free ? FINE * LANE : LANE - 0.04;
    const glow = new Mesh(new PlaneGeometry(size, size), new MeshBasicMaterial({ color: taken ? 0xffe27a : 0x6aa6ff, transparent: true, opacity: free ? 0.55 : 0.2, depthWrite: false, side: DoubleSide }));
    glow.position.set(colX(cell.col), rowY(cell.row), 0.001);
    this.ghost.add(glow);
    if (tool.kind === 'wall' && free) {
      // (the free grid: a wall from the point the drag started at to the one under the mouse, any size)
      const box = this.freeWallBox();
      if (box === null) return;
      const length = Math.max(0.1, (editor.snap || 1) * METRES_PER_BEAT);
      const mesh = new Mesh(new BoxGeometry(box.w * LANE, box.h * LANE, length), new MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.4, depthWrite: false }));
      mesh.position.set(box.x * LANE - WIDTH / 2 + (box.w * LANE) / 2, box.y * LANE + (box.h * LANE) / 2, -length / 2);
      this.ghost.add(mesh);
      return;
    }
    if (tool.kind === 'wall') {
      // (the wall the drag makes: from the cell it started in across to the one under the mouse, as
      // high as the row it started in says)
      const from = drag?.kind === 'place' ? drag.col : cell.col;
      const to = drag?.kind === 'place' && this.lastMouse !== null ? (this.cellAt(this.lastMouse.x, this.lastMouse.y)?.col ?? drag.col) : cell.col;
      const shape = WALL_SHAPES[ROW_WALL[cell.row] ?? 'full'];
      const left = Math.min(from, to);
      const wide = Math.abs(to - from) + 1;
      const length = Math.max(0.1, (this.editor.snap || 1) * METRES_PER_BEAT);
      const box = new Mesh(new BoxGeometry(wide * LANE - 0.04, (Math.min(shape.y + shape.h, 5.5) - shape.y) * LANE, length), new MeshBasicMaterial({ color: this.rgb(editor.preview.colors.obstacle), transparent: true, opacity: 0.35, depthWrite: false }));
      box.position.set(colX(left) + ((wide - 1) * LANE) / 2, ((shape.y + Math.min(shape.y + shape.h, 5.5)) / 2) * LANE, -length / 2);
      this.ghost.add(box);
      return;
    }
    if (taken) return;
    const colors = editor.preview.colors;
    if (tool.kind === 'bomb') {
      const bomb = new Mesh(bombGeometry(), new MeshStandardMaterial({ color: 0x5a5c66, transparent: true, opacity: 0.6 }));
      bomb.position.set(colX(cell.col), rowY(cell.row), 0);
      this.ghost.add(bomb);
      return;
    }
    const direction = drag?.kind === 'place' && this.lastMouse !== null ? (this.dragDirection(this.lastMouse.x - drag.x, this.lastMouse.y - drag.y) ?? tool.direction) : tool.direction;
    const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), ((ROLL[direction] ?? 0) * Math.PI) / 180);
    const cube = new Mesh(noteBodyGeometry(), new MeshStandardMaterial({ color: this.rgb(tool.kind === 'red' ? colors.leftNote : colors.rightNote), transparent: true, opacity: 0.55, roughness: 0.35 }));
    cube.position.set(colX(cell.col), rowY(cell.row), 0);
    cube.quaternion.copy(quaternion);
    this.ghost.add(cube);
    const mark = new Mesh(direction === 8 ? dotGeometry() : arrowGeometry(), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    mark.position.copy(cube.position);
    mark.quaternion.copy(quaternion);
    this.ghost.add(mark);
  }

  /** The wall a drag on the free grid makes (edges, in cells): from the point it started at to the one
   *  under the mouse; a click — a cell's size from there. */
  private freeWallBox(): { x: number; y: number; w: number; h: number } | null {
    const drag = this.drag;
    const mouse = this.lastMouse;
    if (mouse === null) return null;
    const here = this.edgeAt(mouse.x, mouse.y);
    if (here === null) return null;
    const start = drag?.kind === 'place' && drag.edge !== null ? drag.edge : here;
    const w = Math.abs(here.x - start.x);
    const h = Math.abs(here.y - start.y);
    // (not drawn out one way: a cell's size that way)
    return { x: Math.min(start.x, here.x), y: Math.min(start.y, here.y), w: w < FINE / 2 ? 1 : w, h: h < FINE / 2 ? 1 : h };
  }

  /** A short right click (the camera didn't fly): the object there deleted. */
  rightClick(clientX: number, clientY: number) {
    if (!this.active) return;
    const hit = this.objectAt(clientX, clientY) ?? this.cellObject(this.cellAt(clientX, clientY));
    if (hit === null) return;
    const found = this.editor.objectById(hit.id);
    if (found !== null) objectRightClick(this.editor, clientX, clientY, found);
  }

  /** The selected objects' places when a move started (copies: their custom data changes as they move). */
  private origins() {
    const origin = new Map<string, AnyObject>();
    for (const { item } of this.editor.selectedObjects()) origin.set(item.id, structuredClone(item) as AnyObject);
    return origin;
  }

  /** Whether a move goes in quarters of a cell, anywhere (the free grid; not with arcs or chains). */
  private moveFree() {
    return this.editor.precision && !this.editor.selectedObjects().some(({ kind }) => kind === 'arcs' || kind === 'chains');
  }

  /**
   * The selection moved from where it was: across cells and in time (one undo step for the drag). On
   * the grid nothing goes off it; placed freely (or on the free grid) things go anywhere on the free
   * grid's reach — Noodle Extensions' coordinates.
   */
  private applyMove(drag: Extract<NoteTrack['drag'], { kind: 'pick' }>, cols: number, rows: number, beats: number) {
    const editor = this.editor;
    const picked = editor.selectedObjects();
    const free = this.moveFree();
    const placed = (o: AnyObject) => placeOf(o as MapNote);
    for (const { kind, item } of picked) {
      const o = drag.origin.get(item.id);
      if (o === undefined) continue;
      beats = Math.max(beats, -o.b);
      const loose = free || placed(o).free || (kind === 'walls' && wallFootprint(o as unknown as MapWall).noodle);
      if (loose) {
        // (anywhere the free grid reaches)
        // (edges, in cells: a note's or bomb's box, a wall's own)
        const shape = kind === 'walls' ? wallFootprint(o as unknown as MapWall) : { x: placed(o).x, y: placed(o).y, w: 1, h: 1 };
        cols = Math.max(cols, FREE.left - shape.x);
        cols = Math.min(cols, FREE.right - shape.x - shape.w);
        if (kind !== 'walls' || free) {
          rows = Math.max(rows, FREE.bottom - shape.y);
          rows = Math.min(rows, FREE.top - shape.y - Math.min(shape.h, FREE.top - FREE.bottom));
        }
        continue;
      }
      const width = kind === 'walls' ? (item as MapWall).w : 1;
      cols = Math.max(cols, -Math.min(o.x, o.tx ?? o.x));
      cols = Math.min(cols, 3 - Math.max(o.x + width - 1, o.tx ?? o.x));
      if (kind !== 'walls') {
        rows = Math.max(rows, -Math.min(o.y, o.ty ?? o.y));
        rows = Math.min(rows, 2 - Math.max(o.y, o.ty ?? o.y));
      } else if (!free) rows = 0;
    }
    if (!free) {
      cols = Math.round(cols);
      rows = Math.round(rows);
    }
    const before = JSON.stringify(picked.map(({ item }) => item));
    for (const { kind, item } of picked) {
      const o = drag.origin.get(item.id);
      if (o === undefined) continue;
      item.b = Math.round((o.b + beats) * 1e6) / 1e6;
      if (kind === 'notes' || kind === 'bombs') {
        const from = placed(o);
        item.customData = o.customData === undefined ? undefined : structuredClone(o.customData);
        if (item.customData === undefined) delete item.customData;
        setPlace(item as MapNote, from.x + cols, from.y + rows);
        continue;
      }
      if (kind === 'walls') {
        const wall = item as MapWall;
        const shape = wallFootprint(o as unknown as MapWall);
        wall.customData = o.customData === undefined ? undefined : structuredClone(o.customData);
        if (wall.customData === undefined) delete wall.customData;
        const offGrid = Math.abs(cols - Math.round(cols)) > 1e-6 || Math.abs(rows) > 1e-6 || o.x + cols < 0 || o.x + cols + wall.w > 4;
        if (shape.noodle || (free && offGrid)) {
          // (Noodle's place and size: moved by the grid's quarters, its size kept)
          wall.x = Math.max(0, Math.min(3, Math.round(shape.x + cols)));
          wall.customData = { ...(wall.customData ?? {}), coordinates: [Math.round((shape.x + cols - 2) * 1e4) / 1e4, Math.round((shape.y + (free ? rows : 0)) * 1e4) / 1e4], size: [shape.w, shape.h] };
          delete wall.customData._position;
          delete wall.customData._scale;
        } else wall.x = o.x + cols;
        continue;
      }
      item.x = o.x + cols;
      item.y = o.y + rows;
      const tail = item as AnyObject;
      if (o.tb !== undefined) tail.tb = Math.round((o.tb + beats) * 1e6) / 1e6;
      if (o.tx !== undefined) tail.tx = o.tx + cols;
      if (o.ty !== undefined) tail.ty = o.ty + rows;
    }
    if (JSON.stringify(picked.map(({ item }) => item)) !== before) {
      drag.moving = true;
      editor.noteVersion++;
      editor.rebuildPreview();
      editor.emit('clips');
    }
  }

  private moveTo(clientX: number, clientY: number, timeOnly: boolean) {
    const drag = this.drag;
    if (drag?.kind !== 'pick') return;
    const editor = this.editor;
    if (timeOnly) {
      // (along the track: where the mouse meets the floor)
      const floor = this.meet(clientX, clientY, new Plane(new Vector3(0, 1, 0), 0));
      const start = this.meet(drag.x, drag.y, new Plane(new Vector3(0, 1, 0), 0));
      if (floor === null || start === null) return;
      const step = editor.snap || 0.25;
      const beats = Math.round(-(floor.z - start.z) / METRES_PER_BEAT / step) * step;
      this.applyMove(drag, 0, 0, beats + drag.time);
      return;
    }
    const point = this.meet(clientX, clientY, drag.plane);
    if (point === null) return;
    // (the free grid: by quarters of a cell)
    const step = this.moveFree() ? FINE : 1;
    const cols = Math.round((point.x - drag.grab.x) / LANE / step) * step;
    const rows = Math.round((point.y - drag.grab.y) / LANE / step) * step;
    this.applyMove(drag, cols, rows, drag.time);
  }

  private showBox(x0: number, y0: number, x1: number, y1: number) {
    const rect = this.canvas.getBoundingClientRect();
    const parent = this.canvas.parentElement!.getBoundingClientRect();
    this.box.hidden = false;
    this.box.style.left = `${String(Math.min(x0, x1) - parent.left)}px`;
    this.box.style.top = `${String(Math.min(y0, y1) - parent.top)}px`;
    this.box.style.width = `${String(Math.abs(x1 - x0))}px`;
    this.box.style.height = `${String(Math.abs(y1 - y0))}px`;
    void rect;
  }

  /** What's inside a box on the screen (its objects' middles). */
  private inBox(x0: number, y0: number, x1: number, y1: number) {
    const editor = this.editor;
    const camera = editor.preview.view.viewCamera;
    camera.updateMatrixWorld();
    const a = this.ndc(Math.min(x0, x1), Math.max(y0, y1));
    const b = this.ndc(Math.max(x0, x1), Math.min(y0, y1));
    const offset = this.moving.position.z;
    const inside = new Set<string>();
    const test = (id: string, x: number, y: number, beat: number) => {
      const zz = -beat * METRES_PER_BEAT + offset;
      if (zz > BEHIND * METRES_PER_BEAT || zz < -AHEAD * METRES_PER_BEAT) return;
      const point = new Vector3(x, y, zz).project(camera);
      if (point.z > 1) return;
      if (point.x >= a.x && point.x <= b.x && point.y >= a.y && point.y <= b.y) inside.add(id);
    };
    const objects = editor.objects;
    for (const item of [...objects.notes, ...objects.bombs]) {
      const place = placeOf(item);
      test(item.id, colX(place.x), rowY(place.y), item.b);
    }
    for (const item of objects.chains) test(item.id, colX(item.x), rowY(item.y), item.b);
    for (const item of objects.arcs) test(item.id, colX(item.x), rowY(item.y), item.b);
    for (const item of objects.walls) {
      const shape = wallFootprint(item);
      test(item.id, (shape.x - 2 + shape.w / 2) * LANE, (shape.y + Math.min(shape.h, 2) / 2) * LANE, item.b + item.d / 2);
    }
    return inside;
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
      if (this.drag !== null) return;
      this.hoverCell = this.cellAt(event.clientX, event.clientY);
      const hit = this.hoverCell === null || event.shiftKey || event.ctrlKey ? this.objectAt(event.clientX, event.clientY) : this.cellObject(this.hoverCell);
      this.hovered = hit?.id ?? null;
      canvas.style.cursor = hit !== null ? 'pointer' : this.hoverCell !== null ? 'crosshair' : 'default';
    });
    canvas.addEventListener('mouseleave', () => {
      if (this.drag === null) {
        this.hoverCell = null;
        this.hovered = null;
      }
    });
    canvas.addEventListener('mousedown', (event) => {
      if (!this.active || event.button === 2) return;
      const editor = this.editor;
      const cell = this.cellAt(event.clientX, event.clientY);
      if (event.button === 1) {
        event.preventDefault();
        const hit = this.objectAt(event.clientX, event.clientY) ?? this.cellObject(cell);
        if (hit !== null)
          editor.updateObjects([hit.id], (_kind, item) => {
            if ('c' in item) item.c = 1 - item.c;
          });
        return;
      }
      if (event.button !== 0) return;
      if (event.altKey) {
        // Alt+click on a note (a bomb) further along: brought to where the cursor is
        const far = this.objectAt(event.clientX, event.clientY);
        if (far === null || (far.kind !== 'notes' && far.kind !== 'bombs')) return;
        const beat = editor.snapBeat(editor.playhead());
        editor.updateObjects([far.id], (_kind, item) => {
          (item as { b: number }).b = beat;
        });
        editor.setStatus(tr('Нота перенесена на долю {0}', Math.round(beat * 1000) / 1000));
        return;
      }
      // (Shift / Ctrl: what's under the mouse, even behind the wall — as in ChroMapper)
      const adding = event.shiftKey || event.ctrlKey || event.metaKey;
      const hit = cell !== null && !adding ? this.cellObject(cell) : this.objectAt(event.clientX, event.clientY);
      if (event.shiftKey && cell !== null) {
        // Shift + drag on the wall: a box of cells, along the track as far as the song goes while
        // dragging (Shift + Ctrl: added to what's picked); a Shift + click: the object there added
        this.drag = { kind: 'volume', x: event.clientX, y: event.clientY, cell, beat: editor.snapBeat(editor.playhead()), free: editor.precision, hit, adding: event.ctrlKey || event.metaKey, moved: false };
        return;
      }
      // a note of another colour or direction than the tool's: a click (not a drag) makes it the tool's
      const tool = editor.noteTool;
      let replace = false;
      if (hit !== null && hit.kind === 'notes' && !adding && (tool.kind === 'red' || tool.kind === 'blue')) {
        const note = editor.objectById(hit.id)?.item as MapNote | undefined;
        const color = tool.kind === 'red' ? 0 : 1;
        const angle = tool.direction === 8 ? (tool.angle ?? 0) : 0;
        replace = note !== undefined && (note.d !== tool.direction || note.c !== color || (tool.direction === 8 && note.a !== angle));
      }
      if (hit === null && cell !== null && !adding) {
        const free = editor.precision;
        this.drag = { kind: 'place', x: event.clientX, y: event.clientY, col: cell.col, row: cell.row, free, edge: free ? this.edgeAt(event.clientX, event.clientY) : null };
        return;
      }
      if (hit === null) {
        this.drag = { kind: 'box', x: event.clientX, y: event.clientY, adding };
        return;
      }
      // a note: picked (with Shift / Ctrl: added or taken off), and dragged on
      const before = [...editor.noteSelection];
      if (adding) editor.selectNotes([hit.id], 'toggle');
      else if (!editor.noteSelection.has(hit.id)) editor.selectNotes([hit.id]);
      const item = editor.objectById(hit.id)?.item as AnyObject | undefined;
      if (item === undefined || !editor.noteSelection.has(hit.id)) return;
      const z = -item.b * METRES_PER_BEAT + this.moving.position.z;
      const plane = new Plane(new Vector3(0, 0, 1), -z);
      const grab = this.meet(event.clientX, event.clientY, plane) ?? new Vector3(colX(item.x), rowY(item.y), z);
      editor.noteCheckpoint();
      this.drag = { kind: 'pick', x: event.clientX, y: event.clientY, hit, adding, moving: false, plane, grab, origin: this.origins(), time: 0, timeOnly: false, replace, before };
    });
    window.addEventListener('mousemove', (event) => {
      const drag = this.drag;
      if (drag === null) return;
      this.lastMouse = { x: event.clientX, y: event.clientY };
      if (drag.kind === 'box') {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) this.showBox(drag.x, drag.y, event.clientX, event.clientY);
      } else if (drag.kind === 'volume') {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5) drag.moved = true;
      } else if (drag.kind === 'pick') {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5 && !drag.moving) return;
        this.moveTo(event.clientX, event.clientY, event.ctrlKey || event.metaKey);
      }
    });
    window.addEventListener('mouseup', (event) => {
      const drag = this.drag;
      if (drag === null || event.button !== 0) return;
      this.drag = null;
      this.box.hidden = true;
      const editor = this.editor;
      if (drag.kind === 'box') {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= 4) {
          if (!drag.adding) editor.selectNotes([]);
          return;
        }
        editor.selectNotes(this.inBox(drag.x, drag.y, event.clientX, event.clientY), drag.adding ? 'add' : 'replace');
        return;
      }
      if (drag.kind === 'volume') {
        this.updateVolume();
        if (!drag.moved) {
          // (a Shift + click: the object under the mouse added or taken off)
          if (drag.hit !== null) editor.selectNotes([drag.hit.id], 'toggle');
          return;
        }
        const inside = this.inVolume(drag);
        editor.selectNotes(inside, drag.adding ? 'add' : 'replace');
        editor.setStatus(tr('Выделено объектов: {0}', editor.noteSelection.size));
        return;
      }
      if (drag.kind === 'pick') {
        if (drag.moving) editor.notesChanged(true);
        else {
          editor.noteUndoDiscard();
          if (drag.replace) {
            // (a click on a note unlike the tool's: it becomes the tool's note, the selection as it was)
            editor.selectNotes(drag.before);
            const tool = editor.noteTool;
            const angle = tool.direction === 8 ? (tool.angle ?? 0) : 0;
            editor.updateObjects([drag.hit.id], (_kind, item) => {
              const target = item as MapNote;
              target.d = tool.direction;
              target.c = tool.kind === 'red' ? 0 : 1;
              target.a = angle;
            });
          }
          // (a click on one of several picked: only it)
          else if (!drag.adding && editor.noteSelection.size > 1) editor.selectNotes([drag.hit.id]);
        }
        return;
      }
      // a cell of the wall: what the tool is put in
      const beat = editor.snapBeat(editor.playhead());
      const dir = this.dragDirection(event.clientX - drag.x, event.clientY - drag.y);
      const tool = editor.noteTool;
      if (drag.free) {
        // the free grid: anywhere (Noodle Extensions' coordinates off the grid's cells)
        this.lastMouse = { x: event.clientX, y: event.clientY };
        if (tool.kind === 'wall') {
          this.drag = drag;
          const box = this.freeWallBox();
          this.drag = null;
          if (box === null) return;
          const tidy = (value: number) => Math.round(value * 1e4) / 1e4;
          const vanilla = Number.isInteger(box.x) && Number.isInteger(box.w) && box.x >= 0 && box.x + box.w <= 4 && box.y === 0 && box.h >= 5;
          const wall: MapWall = vanilla
            ? { id: newId('n'), b: beat, x: box.x, y: 0, h: 5, d: editor.snap || 1, w: box.w }
            : { id: newId('n'), b: beat, x: Math.max(0, Math.min(3, Math.round(box.x))), y: 0, h: 5, d: editor.snap || 1, w: Math.max(1, Math.round(box.w)), customData: { coordinates: [tidy(box.x - 2), tidy(box.y)], size: [tidy(box.w), tidy(box.h)] } };
          editor.addObjects([{ kind: 'walls', item: wall }], false);
          return;
        }
        const item = { id: newId('n'), b: beat, x: 0, y: 0 };
        setPlace(item, drag.col, drag.row);
        if (tool.kind === 'bomb') editor.addObjects([{ kind: 'bombs', item }], false);
        else {
          if (dir !== null) editor.noteTool = { ...tool, direction: dir };
          const direction = dir ?? tool.direction;
          editor.addObjects([{ kind: 'notes', item: { ...item, c: tool.kind === 'red' ? 0 : 1, d: direction, a: direction === 8 ? (tool.angle ?? 0) : 0 } }], false);
        }
        return;
      }
      editor.noteRow = drag.row;
      if (tool.kind === 'wall') {
        // (as wide as the drag went across the cells; as high as its row says; a grid step long — longer
        // on the timeline, its ends dragged)
        const to = this.cellAt(event.clientX, event.clientY)?.col ?? drag.col;
        const left = Math.min(drag.col, to);
        editor.addObjects([{ kind: 'walls', item: { id: newId('n'), b: beat, x: left, ...WALL_SHAPES[ROW_WALL[drag.row] ?? 'full'], d: editor.snap || 1, w: Math.abs(to - drag.col) + 1 } }], false);
      } else if (tool.kind === 'bomb') editor.addObjects([{ kind: 'bombs', item: { id: newId('n'), b: beat, x: drag.col, y: drag.row } }], false);
      else {
        if (dir !== null) editor.noteTool = { ...tool, direction: dir };
        const direction = dir ?? tool.direction;
        editor.addObjects([{ kind: 'notes', item: { id: newId('n'), b: beat, x: drag.col, y: drag.row, c: tool.kind === 'red' ? 0 : 1, d: direction, a: direction === 8 ? (tool.angle ?? 0) : 0 } }], false);
      }
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.active || event.defaultPrevented) return;
        event.preventDefault();
        const editor = this.editor;
        const drag = this.drag;
        if (drag?.kind === 'pick') {
          // the wheel while dragging: the picked ones a grid step on or back in time
          this.wheelSum += event.deltaY;
          if (Math.abs(this.wheelSum) < 40) return;
          drag.time += (this.wheelSum < 0 ? 1 : -1) * (editor.snap || 0.25);
          this.wheelSum = 0;
          this.moveTo(event.clientX, event.clientY, event.ctrlKey || event.metaKey);
          return;
        }
        if (event.altKey) {
          // Alt+wheel over a note: its arrow turned an eighth
          const hit = this.objectAt(event.clientX, event.clientY) ?? this.cellObject(this.cellAt(event.clientX, event.clientY));
          if (hit === null || hit.kind !== 'notes') return;
          const order = [0, 5, 3, 7, 1, 6, 2, 4];
          editor.updateObjects(
            [hit.id],
            (_kind, item) => {
              const note = item as MapNote;
              if (note.d !== 8) note.d = order[(order.indexOf(note.d) + (event.deltaY > 0 ? 1 : -1) + 8) % 8]!;
            },
            `turn:${hit.id}`,
          );
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
}

/** A list of `count` values from `make`. */
function k(count: number, make: (index: number) => number) {
  return Array.from({ length: count }, (_, index) => make(index));
}

export type { MapArc, MapChain, MapWall };
