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
import type { Editor } from './editor';
import { DIR_VECTOR, ROW_WALL, WALL_SHAPES, type MapArc, type MapChain, type MapNote, type MapWall, type ObjectKind } from './notes';
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
 * arrow. Over a note: lit; a click picks it (Shift/Ctrl: adds, also behind the wall), a drag moves the
 * picked ones across the cells (Ctrl: along the track, in time; the wheel while dragging: a grid step
 * in time). A drag over an empty place: a box picking what's in it (Shift: adding). A short right click
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
/** The beats shown ahead of the cursor and behind it. */
let AHEAD = TRACK_M / METRES_PER_BEAT;
let BEHIND = BEHIND_M / METRES_PER_BEAT;
/** Where things count as gone through the wall (just past the notes at the cursor). */
const PASSED = NOTE / 2 + 0.02;
const rowY = (row: number) => LANE / 2 + row * LANE;
const colX = (col: number) => (col - 1.5) * LANE;

/** Where the camera looks at the track from (as ChroMapper's editor camera). */
export const TRACK_POSE = { position: [0, 2.6, 5.2] as [number, number, number], yaw: 0, pitch: -0.3 };

/** The arrow's turn (degrees, the game's): 0 points down. */
const ROLL: Record<number, number> = { 0: 180, 1: 0, 2: -90, 3: 90, 4: -135, 5: 135, 6: -45, 7: 45, 8: 0 };

type Hit = { kind: ObjectKind; id: string };
type AnyObject = MapObjectsItem;
type MapObjectsItem = { id: string; b: number; x: number; y: number; tb?: number; tx?: number; ty?: number };

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
    | { kind: 'place'; x: number; y: number; col: number; row: number }
    | { kind: 'pick'; x: number; y: number; hit: Hit; adding: boolean; moving: boolean; plane: Plane; grab: Vector3; origin: Map<string, AnyObject>; time: number; timeOnly: boolean }
    | { kind: 'box'; x: number; y: number; adding: boolean }
    | null = null;

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
    };
    const picked = editor.noteSelection;
    const z = (beat: number) => -beat * METRES_PER_BEAT;
    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const one = new Vector3(1, 1, 1);
    const position = new Vector3();
    const axis = new Vector3(0, 0, 1);
    const highlight = new Color(1, 0.88, 0.35);
    const lit = (color: Color, id: string) => {
      if (picked.has(id)) color.lerp(highlight, 0.6);
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
      quaternion.setFromAxisAngle(axis, (((ROLL[note.d] ?? 0) + note.a) * Math.PI) / 180);
      position.set(colX(note.x), rowY(note.y), z(note.b));
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
      position.set(colX(bomb.x), rowY(bomb.y), z(bomb.b));
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
      const mesh = child as Mesh;
      mesh.geometry.dispose();
      (mesh.material as Material).dispose();
    }
    const obstacle = this.rgb(colors.obstacle);
    for (const wall of objects.walls) {
      // (as ChroMapper draws them: lined up with the grid's rows — a crouch wall from the top row up)
      const bottom = Math.max(0, wall.y * LANE);
      const top = Math.max(bottom + 0.1, Math.min(wall.y + wall.h, 5.5) * LANE);
      const length = Math.max(0.02, wall.d * METRES_PER_BEAT);
      const geometry = new BoxGeometry(wall.w * LANE - 0.04, top - bottom, length);
      const on = picked.has(wall.id) || this.hovered === wall.id;
      const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: obstacle, transparent: true, opacity: on ? 0.4 : 0.2, depthWrite: false, clippingPlanes: this.trackClip }));
      mesh.position.set(colX(wall.x) + ((wall.w - 1) * LANE) / 2, (top + bottom) / 2, z(wall.b) - length / 2);
      mesh.userData = { kind: 'walls', id: wall.id };
      this.extras.add(mesh);
      const edges = new LineSegments(new EdgesGeometry(geometry), new LineBasicMaterial({ color: picked.has(wall.id) ? 0xffe27a : obstacle, clippingPlanes: this.trackClip }));
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
      const on = picked.has(arc.id) || this.hovered === arc.id;
      const color = this.rgb(arc.c === 0 ? colors.leftNote : colors.rightNote);
      const mesh = new Mesh(new TubeGeometry(curve, 24, on ? 0.04 : 0.025, 6), new MeshBasicMaterial({ color: picked.has(arc.id) ? 0xffe27a : color, transparent: true, opacity: 0.85, clippingPlanes: this.trackClip }));
      mesh.userData = { kind: 'arcs', id: arc.id };
      this.extras.add(mesh);
    }
    const outline: number[] = [];
    const box = new EdgesGeometry(new BoxGeometry(NOTE + 0.07, NOTE + 0.07, NOTE + 0.07));
    const corners = box.getAttribute('position');
    for (const { kind, note } of heads) {
      if (!picked.has(note.id) || kind !== 'notes') continue;
      for (let i = 0; i < corners.count; i++) outline.push(corners.getX(i) + colX(note.x), corners.getY(i) + rowY(note.y), corners.getZ(i) + z(note.b));
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
    this.updateGhost();
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

  /** The wall's cell under the mouse. */
  private cellAt(clientX: number, clientY: number): { col: number; row: number } | null {
    const point = this.meet(clientX, clientY, new Plane(new Vector3(0, 0, 1), 0));
    if (point === null) return null;
    const col = Math.floor((point.x + WIDTH / 2) / LANE);
    const row = Math.floor(point.y / LANE);
    if (col < 0 || col > 3 || row < 0 || row > 2) return null;
    return { col, row };
  }

  /** The object on the track under the mouse (null: none). */
  private objectAt(clientX: number, clientY: number): Hit | null {
    this.ray(clientX, clientY);
    this.root.updateMatrixWorld(true);
    const targets = [this.notes.solid, this.bombs.solid, this.links.solid, ...this.extras.children.filter((child) => child.userData.id !== undefined)];
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
    const glow = new Mesh(new PlaneGeometry(LANE - 0.04, LANE - 0.04), new MeshBasicMaterial({ color: taken ? 0xffe27a : 0x6aa6ff, transparent: true, opacity: 0.2, depthWrite: false, side: DoubleSide }));
    glow.position.set(colX(cell.col), rowY(cell.row), 0.001);
    this.ghost.add(glow);
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

  /** A short right click (the camera didn't fly): the object there deleted. */
  rightClick(clientX: number, clientY: number) {
    if (!this.active) return;
    const hit = this.objectAt(clientX, clientY) ?? this.cellObject(this.cellAt(clientX, clientY));
    if (hit === null) return;
    const editor = this.editor;
    editor.noteCheckpoint();
    editor.removeObjects(new Set([hit.id]));
    editor.notesChanged();
  }

  /** The selected objects' places when a move started. */
  private origins() {
    const origin = new Map<string, AnyObject>();
    for (const { item } of this.editor.selectedObjects()) origin.set(item.id, { ...(item as AnyObject) });
    return origin;
  }

  /** The selection moved from where it was: across cells and in time (one undo step for the drag). */
  private applyMove(drag: Extract<NoteTrack['drag'], { kind: 'pick' }>, cols: number, rows: number, beats: number) {
    const editor = this.editor;
    const picked = editor.selectedObjects();
    // (nothing goes off the grid or before the song)
    for (const { kind, item } of picked) {
      const o = drag.origin.get(item.id);
      if (o === undefined) continue;
      const width = kind === 'walls' ? (item as MapWall).w : 1;
      cols = Math.max(cols, -Math.min(o.x, o.tx ?? o.x));
      cols = Math.min(cols, 3 - Math.max(o.x + width - 1, o.tx ?? o.x));
      if (kind !== 'walls') {
        rows = Math.max(rows, -Math.min(o.y, o.ty ?? o.y));
        rows = Math.min(rows, 2 - Math.max(o.y, o.ty ?? o.y));
      } else rows = 0;
      beats = Math.max(beats, -o.b);
    }
    let changed = false;
    for (const { kind, item } of picked) {
      const o = drag.origin.get(item.id);
      if (o === undefined) continue;
      const next = { x: o.x + cols, y: kind === 'walls' ? o.y : o.y + rows, b: Math.round((o.b + beats) * 1e6) / 1e6 };
      if (next.x !== item.x || next.y !== item.y || next.b !== item.b) changed = true;
      item.x = next.x;
      item.y = next.y;
      item.b = next.b;
      const tail = item as AnyObject;
      if (o.tb !== undefined) tail.tb = Math.round((o.tb + beats) * 1e6) / 1e6;
      if (o.tx !== undefined) tail.tx = o.tx + cols;
      if (o.ty !== undefined) tail.ty = o.ty + rows;
    }
    if (changed) {
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
    const cols = Math.round((point.x - drag.grab.x) / LANE);
    const rows = Math.round((point.y - drag.grab.y) / LANE);
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
    for (const item of objects.notes) test(item.id, colX(item.x), rowY(item.y), item.b);
    for (const item of objects.bombs) test(item.id, colX(item.x), rowY(item.y), item.b);
    for (const item of objects.chains) test(item.id, colX(item.x), rowY(item.y), item.b);
    for (const item of objects.arcs) test(item.id, colX(item.x), rowY(item.y), item.b);
    for (const item of objects.walls) test(item.id, colX(item.x) + ((item.w - 1) * LANE) / 2, LANE, item.b + item.d / 2);
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
      // (Shift / Ctrl: what's under the mouse, even behind the wall — as in ChroMapper)
      const adding = event.shiftKey || event.ctrlKey || event.metaKey;
      const hit = cell !== null && !adding ? this.cellObject(cell) : this.objectAt(event.clientX, event.clientY);
      if (hit === null && cell !== null && !adding) {
        this.drag = { kind: 'place', x: event.clientX, y: event.clientY, col: cell.col, row: cell.row };
        return;
      }
      if (hit === null) {
        this.drag = { kind: 'box', x: event.clientX, y: event.clientY, adding };
        return;
      }
      // a note: picked (with Shift / Ctrl: added or taken off), and dragged on
      if (adding) editor.selectNotes([hit.id], 'toggle');
      else if (!editor.noteSelection.has(hit.id)) editor.selectNotes([hit.id]);
      const item = editor.objectById(hit.id)?.item as AnyObject | undefined;
      if (item === undefined || !editor.noteSelection.has(hit.id)) return;
      const z = -item.b * METRES_PER_BEAT + this.moving.position.z;
      const plane = new Plane(new Vector3(0, 0, 1), -z);
      const grab = this.meet(event.clientX, event.clientY, plane) ?? new Vector3(colX(item.x), rowY(item.y), z);
      editor.noteCheckpoint();
      this.drag = { kind: 'pick', x: event.clientX, y: event.clientY, hit, adding, moving: false, plane, grab, origin: this.origins(), time: 0, timeOnly: false };
    });
    window.addEventListener('mousemove', (event) => {
      const drag = this.drag;
      if (drag === null) return;
      this.lastMouse = { x: event.clientX, y: event.clientY };
      if (drag.kind === 'box') {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) this.showBox(drag.x, drag.y, event.clientX, event.clientY);
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
      if (drag.kind === 'pick') {
        if (drag.moving) editor.notesChanged(true);
        else {
          editor.noteUndoDiscard();
          // (a click on one of several picked: only it)
          if (!drag.adding && editor.noteSelection.size > 1) editor.selectNotes([drag.hit.id]);
        }
        return;
      }
      // a cell of the wall: what the tool is put in
      const beat = editor.snapBeat(editor.playhead());
      const dir = this.dragDirection(event.clientX - drag.x, event.clientY - drag.y);
      const tool = editor.noteTool;
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
        editor.addObjects([{ kind: 'notes', item: { id: newId('n'), b: beat, x: drag.col, y: drag.row, c: tool.kind === 'red' ? 0 : 1, d: dir ?? tool.direction, a: 0 } }], false);
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
