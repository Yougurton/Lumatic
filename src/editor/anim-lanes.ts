import type { Editor } from './editor';
import { ALL_PARTS, animRuns, animValue, isPeriodic, MOTION_KINDS, PART_SIZE, sortedKeys, type AnimKey, type AnimPart, type MotionKind, type SceneAnim, type SceneMotion } from './env-anim';
import { tr } from './i18n';
import { showMenu } from './menu';
import type { LaneHost } from './notes-timeline';
import { EASINGS } from './rings';

/** How each part is called. */
export const PART_NAMES: Record<AnimPart, string> = {
  position: 'положение',
  rotation: 'поворот',
  scale: 'масштаб',
  color: 'цвет',
  attenuation: 'плотность',
  offset: 'смещение',
  startY: 'нижняя граница',
  height: 'высота перепада',
  alpha: 'яркость',
  bloom: 'свечение в тумане',
};
export const PART_COLOURS: Record<AnimPart, string> = {
  position: '#6aa6ff',
  rotation: '#ffb45a',
  scale: '#7fdc9a',
  color: '#e58cff',
  attenuation: '#9fb4c8',
  offset: '#9fb4c8',
  startY: '#9fb4c8',
  height: '#9fb4c8',
  alpha: '#ffe27a',
  bloom: '#ffd0a0',
};
export const MOTION_NAMES: Record<MotionKind, string> = {
  orbit: 'Орбита',
  swing: 'Качание',
  spin: 'Вращение',
  bob: 'Покачивание',
  pulse: 'Пульсация',
  follow: 'Следовать за игроком',
  depends: 'Зависит от игры',
};
const MOTION_COLOURS: Record<MotionKind, string> = { orbit: '#5e8de0', swing: '#e0a35e', spin: '#d9884a', bob: '#5ec0e0', pulse: '#6fcf8e', follow: '#c48ae8', depends: '#e07a9a' };
const AXIS_COLOURS = ['#ff6b6b', '#6be07a', '#6aa6ff', '#e8eaf2'];

const TITLE_H = 20;
const PART_H = 22;
const MOTION_H = 24;
/** Above the curves of an open line: the band its keys' diamonds are in. */
const BAND = 18;
const TWIST_W = 16;

interface Line {
  kind: 'title' | 'part' | 'motions';
  /** The picked thing it's of ("g:…", "o:…", "m:…", "f:fog", "p:player"). */
  key: string;
  name: string;
  part?: AnimPart;
  anim?: SceneAnim;
  top: number;
  height: number;
  /** A part's line opened: its curves shown. */
  open?: boolean;
}

type Drag =
  | { kind: 'move'; grab: number; origin: Map<string, number>; moved: boolean; id: string; additive: boolean }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: 'value'; id: string; axis: number; grab: number; beat0: number; moved: boolean; line: string }
  | { kind: 'resize'; row: string; y0: number; height0: number }
  | { kind: 'motion'; id: string; edge: 'start' | 'end' | 'body'; grab: number; start0: number; end0: number; moved: boolean };

/**
 * The scene's animation on the timeline (drawn in place of the lights' rows while the Scene side is
 * open): a block of lines for each animated or picked thing — its name, its parts (place, turn, size…)
 * with the keys as diamonds and a bar between two keys, and for an object a line of its ready motions.
 *
 * A part's line opens (▸ at its left): its curves — an axis a line, a dot a key, dragged up and down for
 * its value and to the sides for its beat (Shift: the value only); a click between two dots picks the
 * later key (its easing on the right); the line's lower edge makes it taller or lower.
 *
 * A click picks a key (and takes the song there), a drag moves the picked keys, a double click on a
 * line makes a key there, the right button: easing, smooth curve, repeats, delete. Motions: dragged,
 * stretched by their ends, the right button adds and removes them.
 */
export class AnimLanes {
  private readonly editor: Editor;
  private drag: Drag | null = null;
  private scrollY = 0;
  /** An open line's value range while a dot is dragged (kept: the dot stays under the mouse). */
  private frozen = new Map<string, { lo: number; hi: number }>();

  constructor(private readonly host: LaneHost) {
    this.editor = host.editor;
  }

  private rowId(key: string, part: AnimPart) {
    return `${key}|${part}`;
  }

  /** The lines, top to bottom: the animated things, then the picked ones without animation yet. */
  private lines(): Line[] {
    const editor = this.editor;
    const out: Line[] = [];
    const seen = new Set<string>();
    let top = this.host.lanesTop - this.scrollY + 2;
    const block = (key: string, anim: SceneAnim | undefined) => {
      if (seen.has(key)) return;
      seen.add(key);
      const name = editor.thingName(key);
      out.push({ kind: 'title', key, name, anim, top, height: TITLE_H });
      top += TITLE_H;
      // (a lamp's settings: only once they have keys, or the lamp is picked)
      const picked = editor.envSelection.includes(key);
      for (const part of editor.partsOfKey(key)) {
        if ((part === 'alpha' || part === 'bloom') && !picked && (anim?.keys[part] ?? []).length === 0) continue;
        const height = editor.curveRows.get(this.rowId(key, part));
        out.push({ kind: 'part', key, name, part, anim, top, height: height ?? PART_H, open: height !== undefined });
        top += height ?? PART_H;
      }
      // (an object's ready motions)
      if (key.startsWith('o:') || key.startsWith('g:')) {
        out.push({ kind: 'motions', key, name, anim, top, height: MOTION_H });
        top += MOTION_H;
      }
      top += 6;
    };
    for (const anim of editor.sceneAnims()) {
      const key = editor.animKeyOf(anim);
      if (key !== null) block(key, anim);
    }
    for (const motion of editor.sceneMotions()) {
      const key = editor.animKeyOf({ target: motion.target, keys: {} });
      if (key !== null) block(key, editor.animOf(key));
    }
    for (const key of editor.envSelection) if (editor.animTarget(key) !== null) block(key, editor.animOf(key));
    // (the material open on the right)
    if (editor.envMaterialOpen !== null) block(`m:${editor.envMaterialOpen}`, editor.animOf(`m:${editor.envMaterialOpen}`));
    return out;
  }

  private total() {
    const lines = this.lines();
    const last = lines[lines.length - 1];
    return last === undefined ? 0 : last.top + last.height + this.scrollY - this.host.lanesTop + 8;
  }

  /** An open line's curves: where its values go up and down (fitted to its keys and its curve). */
  private range(line: Line): { lo: number; hi: number } {
    const id = this.rowId(line.key, line.part!);
    const frozen = this.frozen.get(id);
    if (frozen !== undefined) return frozen;
    let lo = Infinity;
    let hi = -Infinity;
    const keys = sortedKeys(line.anim?.keys[line.part!]);
    for (const key of keys)
      for (const value of key.value) {
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    // (between the keys the curve can go further: an eased overshoot, a smooth curve)
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (first !== undefined && last !== undefined && last.beat > first.beat)
      for (let n = 0; n <= 80; n++)
        for (const value of animValue(line.anim, line.part!, first.beat + ((last.beat - first.beat) * n) / 80) ?? []) {
          lo = Math.min(lo, value);
          hi = Math.max(hi, value);
        }
    if (!Number.isFinite(lo)) {
      const now = this.editor.shownValue(line.key, line.part!) ?? [0];
      lo = Math.min(...now);
      hi = Math.max(...now);
    }
    if (hi - lo < 1e-6) [lo, hi] = [lo - 1, hi + 1];
    const pad = (hi - lo) * 0.12;
    return { lo: lo - pad, hi: hi + pad };
  }

  /** An open line's curve area (top, bottom). */
  private area(line: Line) {
    return { top: line.top + BAND, bottom: line.top + line.height - 6 };
  }

  private yOf(line: Line, value: number) {
    const range = this.range(line);
    const { top, bottom } = this.area(line);
    return top + (1 - (value - range.lo) / Math.max(1e-9, range.hi - range.lo)) * (bottom - top);
  }

  private valueOf(line: Line, y: number) {
    const range = this.range(line);
    const { top, bottom } = this.area(line);
    return range.lo + (1 - (y - top) / Math.max(1, bottom - top)) * (range.hi - range.lo);
  }

  /** Where the keys' diamonds are on a line. */
  private diamondY(line: Line) {
    return line.open === true ? line.top + BAND / 2 : line.top + line.height / 2;
  }

  draw(ctx: CanvasRenderingContext2D) {
    const host = this.host;
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.total() - (host.lanesBottom - host.lanesTop)));
    ctx.fillStyle = '#15161b';
    ctx.fillRect(0, host.lanesTop, host.width, host.lanesBottom - host.lanesTop);
    const picked = new Set(this.editor.envSelection);
    for (const line of this.lines()) {
      if (line.top + line.height < host.lanesTop || line.top > host.lanesBottom) continue;
      ctx.fillStyle = line.kind === 'title' ? (picked.has(line.key) ? '#2b3550' : '#22242c') : line.kind === 'motions' ? '#18191f' : line.open === true ? '#17181e' : '#1b1c22';
      ctx.fillRect(host.left, line.top, host.width - host.left, line.height - 1);
    }
  }

  drawObjects(ctx: CanvasRenderingContext2D) {
    const host = this.host;
    const lines = this.lines();
    ctx.save();
    ctx.textBaseline = 'middle';
    if (lines.length === 0) {
      ctx.fillStyle = '#8a8d98';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(tr('Анимация: выберите объект и поставьте ключ — кнопкой ◆ справа или двойным кликом по строке здесь'), host.left + 14, host.lanesTop + 26);
      ctx.restore();
      return;
    }
    for (const line of lines) {
      if (line.top + line.height < host.lanesTop || line.top > host.lanesBottom) continue;
      if (line.kind === 'part') this.drawPart(ctx, line);
      if (line.kind === 'motions') this.drawMotions(ctx, line);
      // the name: stays at the left whatever the song's place
      const middle = line.kind === 'part' && line.open === true ? line.top + BAND / 2 : line.top + line.height / 2;
      const text = line.kind === 'title' ? line.name : line.kind === 'motions' ? tr('движения') : tr(PART_NAMES[line.part!]);
      ctx.font = line.kind === 'title' ? '600 12px system-ui, sans-serif' : '11px system-ui, sans-serif';
      const width = ctx.measureText(text).width + 14;
      const indent = line.kind === 'title' ? 6 : TWIST_W + 6;
      ctx.fillStyle = line.kind === 'title' ? 'rgba(34,36,44,0.92)' : 'rgba(27,28,34,0.88)';
      ctx.fillRect(host.left, middle - 9, width + indent - 4, 18);
      if (line.kind === 'part') {
        ctx.fillStyle = '#8a8d98';
        ctx.fillText(line.open === true ? '▾' : '▸', host.left + 5, middle);
      }
      ctx.fillStyle = line.kind === 'title' ? '#e8eaf2' : line.kind === 'motions' ? '#a9adbb' : PART_COLOURS[line.part!];
      ctx.fillText(text, host.left + indent, middle);
    }
    const drag = this.drag;
    if (drag?.kind === 'box') {
      ctx.fillStyle = 'rgba(110,170,255,0.15)';
      ctx.strokeStyle = 'rgba(140,190,255,0.9)';
      const [x, y, w, h] = [Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0)];
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    }
    ctx.restore();
  }

  private drawPart(ctx: CanvasRenderingContext2D, line: Line) {
    const host = this.host;
    const editor = this.editor;
    const keys = sortedKeys(line.anim?.keys[line.part!]);
    const colour = PART_COLOURS[line.part!];
    const middle = this.diamondY(line);
    const open = line.open === true;
    // the bars: where it moves from a key to the next
    for (let at = 0; at + 1 < keys.length; at++) {
      const x0 = host.beatToX(keys[at]!.beat);
      const x1 = host.beatToX(keys[at + 1]!.beat);
      const picked = editor.animSelection.has(keys[at + 1]!.id) && open;
      ctx.globalAlpha = open ? (picked ? 0.14 : 0.06) : 0.35;
      ctx.fillStyle = picked ? '#ffe27a' : colour;
      if (open) ctx.fillRect(x0, this.area(line).top, x1 - x0, this.area(line).bottom - this.area(line).top);
      else ctx.fillRect(x0, middle - 3, x1 - x0, 6);
      ctx.globalAlpha = 1;
      const easing = keys[at + 1]!.easing;
      if (easing !== undefined && easing !== 'easeLinear' && x1 - x0 > 90) {
        ctx.fillStyle = '#c9ccd6';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(tr(EASINGS.find(([id]) => id === easing)?.[1] ?? easing), x0 + 10, middle);
      }
    }
    // after the last key: it stays so — or plays again, so many times
    const last = keys[keys.length - 1];
    const runs = animRuns(line.anim, line.part!);
    if (last !== undefined && runs > 1 && keys.length > 1) {
      const length = last.beat - keys[0]!.beat;
      const x0 = host.beatToX(last.beat);
      const x1 = host.beatToX(last.beat + length * (runs - 1));
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = colour;
      ctx.fillRect(x0, middle - 3, x1 - x0, 6);
      ctx.globalAlpha = 0.5;
      for (let run = 1; run < runs; run++) ctx.fillRect(host.beatToX(last.beat + length * run) - 1, middle - 6, 2, 12);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#c9ccd6';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`↻×${String(runs)}`, x0 + 10, middle);
    } else if (last !== undefined && !open) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = colour;
      ctx.fillRect(host.beatToX(last.beat), middle - 1, host.width, 2);
      ctx.globalAlpha = 1;
    }
    if (open) this.drawCurves(ctx, line, keys);
    // the keys: diamonds (on an open line: in the band over the curves)
    const size = open ? 5 : 7;
    for (const key of keys) {
      const x = host.beatToX(key.beat);
      const chosen = editor.animSelection.has(key.id);
      ctx.beginPath();
      ctx.moveTo(x, middle - size);
      ctx.lineTo(x + size, middle);
      ctx.lineTo(x, middle + size);
      ctx.lineTo(x - size, middle);
      ctx.closePath();
      ctx.fillStyle = chosen ? '#ffe27a' : colour;
      ctx.fill();
      ctx.lineWidth = chosen ? 2 : 1;
      ctx.strokeStyle = chosen ? '#ffffff' : '#0d0e12';
      ctx.stroke();
    }
    // (an open line's lower edge: grabbed to make it taller)
    if (open) {
      ctx.fillStyle = '#2a2c34';
      ctx.fillRect(host.left, line.top + line.height - 2, host.width - host.left, 2);
    }
  }

  /** An open line's curves: an axis a line, a dot a key on it; its values' range at the right. */
  private drawCurves(ctx: CanvasRenderingContext2D, line: Line, keys: AnimKey[]) {
    const host = this.host;
    const editor = this.editor;
    const part = line.part!;
    const size = PART_SIZE[part];
    const { top, bottom } = this.area(line);
    const range = this.range(line);
    // (a zero line, when it's in the range)
    if (range.lo < 0 && range.hi > 0) {
      ctx.fillStyle = '#2a2c34';
      ctx.fillRect(host.left, this.yOf(line, 0), host.width - host.left, 1);
    }
    const from = host.xToBeat(host.left);
    const to = host.xToBeat(host.width);
    const step = 3 / Math.max(1e-6, host.pxPerBeat);
    for (let axis = 0; axis < size; axis++) {
      ctx.strokeStyle = size === 1 ? PART_COLOURS[part] : AXIS_COLOURS[axis]!;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (let beat = Math.max(from, keys[0]?.beat ?? Infinity); beat <= to + step; beat += step) {
        const value = animValue(line.anim, part, beat);
        if (value === null) continue;
        const [x, y] = [host.beatToX(beat), this.yOf(line, value[axis]!)];
        if (!started) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        started = true;
      }
      ctx.stroke();
      for (const key of keys) {
        const chosen = editor.animSelection.has(key.id);
        ctx.beginPath();
        ctx.arc(host.beatToX(key.beat), this.yOf(line, key.value[axis]!), chosen ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = chosen ? '#ffe27a' : size === 1 ? PART_COLOURS[part] : AXIS_COLOURS[axis]!;
        ctx.fill();
        ctx.strokeStyle = '#0d0e12';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    // the range: its top and bottom values, and the axes' colours
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#6c7080';
    const round = (value: number) => String(Math.round(value * 100) / 100);
    ctx.fillText(round(range.hi), host.width - 44, top + 6);
    ctx.fillText(round(range.lo), host.width - 44, bottom - 6);
    if (size > 1) {
      const names = part === 'color' ? ['R', 'G', 'B', 'A'] : ['X', 'Y', 'Z'];
      names.forEach((name, axis) => {
        ctx.fillStyle = AXIS_COLOURS[axis]!;
        ctx.fillText(name, host.width - 44 + axis * 10, top + 18);
      });
    }
  }

  private drawMotions(ctx: CanvasRenderingContext2D, line: Line) {
    const host = this.host;
    const editor = this.editor;
    for (const motion of editor.motionsOf(line.key)) {
      const x0 = host.beatToX(motion.start);
      const x1 = host.beatToX(motion.end);
      const chosen = editor.motionSelection === motion.id;
      ctx.fillStyle = MOTION_COLOURS[motion.kind];
      ctx.globalAlpha = chosen ? 0.75 : 0.45;
      ctx.beginPath();
      ctx.roundRect(x0, line.top + 3, Math.max(4, x1 - x0), line.height - 7, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (chosen) {
        ctx.strokeStyle = '#ffe27a';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // (a periodic one: a tick a round)
      if (isPeriodic(motion) && motion.period > 0 && (motion.period * host.pxPerBeat) > 8) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        for (let beat = motion.start + motion.period; beat < motion.end - 1e-6; beat += motion.period) ctx.fillRect(host.beatToX(beat), line.top + 5, 1, line.height - 11);
      }
      if (x1 - x0 > 40) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, line.top, x1 - x0, line.height);
        ctx.clip();
        ctx.fillStyle = '#0d0e12';
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillText(tr(MOTION_NAMES[motion.kind]), Math.max(x0, host.left + 90) + 6, line.top + line.height / 2);
        ctx.restore();
      }
    }
  }

  private lineAt(y: number): Line | null {
    return this.lines().find((line) => y >= line.top && y < line.top + line.height) ?? null;
  }

  /** The key under the mouse (its diamond, or — an open line — its dot and axis), or the bar between
   *  two keys (the later of them). */
  private at(x: number, y: number): { line: Line; key: AnimKey | null; bar: AnimKey | null; axis: number | null } | null {
    const line = this.lineAt(y);
    if (line === null) return null;
    if (line.kind !== 'part') return { line, key: null, bar: null, axis: null };
    const keys = sortedKeys(line.anim?.keys[line.part!]);
    const band = line.open !== true || y < line.top + BAND;
    let key: AnimKey | null = null;
    let axis: number | null = null;
    if (band) key = keys.map((item) => ({ item, far: Math.abs(this.host.beatToX(item.beat) - x) })).filter((item) => item.far <= 8).sort((a, b) => a.far - b.far)[0]?.item ?? null;
    else {
      let best = Infinity;
      for (const item of keys)
        for (let k = 0; k < PART_SIZE[line.part!]; k++) {
          const far = Math.hypot(this.host.beatToX(item.beat) - x, this.yOf(line, item.value[k]!) - y);
          if (far <= 8 && far < best) [best, key, axis] = [far, item, k];
        }
    }
    let bar: AnimKey | null = null;
    if (key === null) for (let at = 0; at + 1 < keys.length; at++) if (x > this.host.beatToX(keys[at]!.beat) && x < this.host.beatToX(keys[at + 1]!.beat)) bar = keys[at + 1]!;
    return { line, key, bar, axis };
  }

  /** The motion block under the mouse, and which part of it (its ends: stretched). */
  private motionAt(line: Line, x: number): { motion: SceneMotion; edge: 'start' | 'end' | 'body' } | null {
    for (const motion of [...this.editor.motionsOf(line.key)].reverse()) {
      const [x0, x1] = [this.host.beatToX(motion.start), this.host.beatToX(motion.end)];
      if (x < x0 - 4 || x > x1 + 4) continue;
      return { motion, edge: Math.abs(x - x0) <= 5 ? 'start' : Math.abs(x - x1) <= 5 ? 'end' : 'body' };
    }
    return null;
  }

  /** On an open line's lower edge (it's grabbed to make the line taller). */
  private edgeAt(y: number): Line | null {
    return this.lines().find((line) => line.kind === 'part' && line.open === true && Math.abs(y - (line.top + line.height - 1)) <= 3) ?? null;
  }

  cursor(x: number, y: number) {
    if (this.edgeAt(y) !== null) return 'ns-resize';
    const line = this.lineAt(y);
    if (line?.kind === 'motions') {
      const found = this.motionAt(line, x);
      return found === null ? 'default' : found.edge === 'body' ? 'grab' : 'ew-resize';
    }
    if (line?.kind === 'part' && x < this.host.left + TWIST_W) return 'pointer';
    const found = this.at(x, y);
    return found?.key != null ? (found.axis !== null ? 'ns-resize' : 'grab') : found?.bar != null || found?.line.kind === 'title' ? 'pointer' : 'default';
  }

  mouseDown(event: MouseEvent, x: number, y: number) {
    if (event.button !== 0) return;
    const editor = this.editor;
    const edge = this.edgeAt(y);
    if (edge !== null) {
      const row = this.rowId(edge.key, edge.part!);
      this.drag = { kind: 'resize', row, y0: y, height0: edge.height };
      return;
    }
    const found = this.at(x, y);
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    if (found === null) {
      this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, additive };
      return;
    }
    const line = found.line;
    if (line.kind === 'title') {
      if (line.key.startsWith('m:')) editor.showMaterial(line.key.slice(2));
      else editor.selectEnv([line.key], additive ? 'toggle' : 'replace');
      return;
    }
    if (line.kind === 'motions') {
      const hit = this.motionAt(line, x);
      if (hit === null) {
        editor.selectMotion(null);
        if (event.detail >= 2) this.motionMenu(line, x, event.clientX, event.clientY);
        return;
      }
      if (!editor.envSelection.includes(line.key)) editor.selectEnv([line.key]);
      editor.selectMotion(hit.motion.id);
      this.drag = { kind: 'motion', id: hit.motion.id, edge: hit.edge, grab: editor.snapBeat(this.host.xToBeat(x)), start0: hit.motion.start, end0: hit.motion.end, moved: false };
      return;
    }
    // (the twist at the left: the line opened or closed)
    if (x < this.host.left + TWIST_W) {
      editor.toggleCurve(line.key, line.part!);
      return;
    }
    if (found.key !== null && found.axis !== null) {
      // (a dot on a curve: its value — and its beat — dragged)
      editor.selectAnimKeys([found.key.id]);
      this.frozen.set(this.rowId(line.key, line.part!), this.range(line));
      this.drag = { kind: 'value', id: found.key.id, axis: found.axis, grab: this.host.xToBeat(x), beat0: found.key.beat, moved: false, line: this.rowId(line.key, line.part!) };
      return;
    }
    if (found.key !== null) {
      if (!editor.animSelection.has(found.key.id)) editor.selectAnimKeys([found.key.id], additive ? 'add' : 'replace');
      const origin = new Map<string, number>();
      for (const anim of editor.sceneAnims()) for (const part of ALL_PARTS) for (const key of anim.keys[part] ?? []) if (editor.animSelection.has(key.id)) origin.set(key.id, key.beat);
      this.drag = { kind: 'move', grab: editor.snapBeat(this.host.xToBeat(x)), origin, moved: false, id: found.key.id, additive };
      return;
    }
    // (a double click on a line: a key there, with what the thing has at that beat)
    if (event.detail >= 2) {
      const beat = Math.max(0, editor.snapBeat(this.host.xToBeat(x)));
      if (!editor.envSelection.includes(line.key)) editor.selectEnv([line.key]);
      editor.addAnimKeys([line.key], [line.part!], beat);
      editor.seek(beat);
      return;
    }
    // (an open line, between two keys: that stretch — its later key — picked)
    if (line.open === true && found.bar !== null && y >= line.top + BAND) {
      editor.selectAnimKeys([found.bar.id]);
      return;
    }
    this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, additive };
  }

  /** Shift held while dragging (set by the timeline). */
  shift = false;

  mouseMove(x: number, y: number): boolean {
    const drag = this.drag;
    const shift = this.shift;
    if (drag === null) return false;
    const editor = this.editor;
    if (drag.kind === 'box') {
      drag.x1 = x;
      drag.y1 = y;
      this.host.redraw();
      return true;
    }
    if (drag.kind === 'resize') {
      const [key, part] = [drag.row.slice(0, drag.row.lastIndexOf('|')), drag.row.slice(drag.row.lastIndexOf('|') + 1) as AnimPart];
      editor.setCurveHeight(key, part, Math.max(50, Math.min(400, drag.height0 + y - drag.y0)));
      this.host.redraw();
      return true;
    }
    if (drag.kind === 'value') {
      const line = this.lines().find((item) => item.kind === 'part' && this.rowId(item.key, item.part!) === drag.line);
      if (line === undefined) return true;
      drag.moved = true;
      // (sideways: the beat, on the grid; up and down: the value — Shift: the value only)
      const beat = shift ? drag.beat0 : Math.max(0, editor.snapBeat(drag.beat0 + this.host.xToBeat(x) - drag.grab));
      const value = this.valueOf(line, y);
      const rounded = Math.round(value * (line.part === 'rotation' ? 10 : 1000)) / (line.part === 'rotation' ? 10 : 1000);
      editor.changeAnimKeys(new Set([drag.id]), (key) => {
        key.beat = beat;
        key.value[drag.axis] = rounded;
      }, 'curve:drag');
      this.host.redraw();
      return true;
    }
    if (drag.kind === 'motion') {
      const shiftBy = editor.snapBeat(this.host.xToBeat(x)) - drag.grab;
      if (!drag.moved && Math.abs(shiftBy) < 1e-6) return true;
      drag.moved = true;
      editor.changeMotion(drag.id, (motion) => {
        if (drag.edge !== 'end') motion.start = Math.max(0, Math.min(drag.edge === 'start' ? drag.end0 - 0.25 : Infinity, drag.start0 + shiftBy));
        if (drag.edge === 'end') motion.end = Math.max(drag.start0 + 0.25, drag.end0 + shiftBy);
        if (drag.edge === 'body') motion.end = motion.start + (drag.end0 - drag.start0);
      }, 'motion:drag');
      this.host.redraw();
      return true;
    }
    const shiftBy = editor.snapBeat(this.host.xToBeat(x)) - drag.grab;
    if (!drag.moved && Math.abs(shiftBy) < 1e-6) return true;
    drag.moved = true;
    // (not before the song's start)
    const least = Math.min(...drag.origin.values());
    const by = Math.max(shiftBy, -least);
    editor.changeAnimKeys(new Set(drag.origin.keys()), (key) => (key.beat = Math.round((drag.origin.get(key.id)! + by) * 10000) / 10000), 'anim:move');
    this.host.redraw();
    return true;
  }

  mouseUp(_event: MouseEvent) {
    const drag = this.drag;
    this.drag = null;
    if (drag === null) return;
    const editor = this.editor;
    if (drag.kind === 'value') {
      this.frozen.clear();
      if (!drag.moved) editor.seek(drag.beat0);
      this.host.redraw();
      return;
    }
    if (drag.kind === 'resize' || drag.kind === 'motion') return;
    if (drag.kind === 'move') {
      if (drag.moved) return;
      // (a click on a key: picked — alone, unless added — and the song taken to it)
      if (drag.additive) editor.selectAnimKeys([drag.id], 'add');
      else editor.selectAnimKeys([drag.id]);
      const beat = drag.origin.get(drag.id);
      if (beat !== undefined) editor.seek(beat);
      for (const anim of editor.sceneAnims()) {
        if (!ALL_PARTS.some((part) => (anim.keys[part] ?? []).some((key) => key.id === drag.id))) continue;
        const key = editor.animKeyOf(anim);
        if (key !== null && !key.startsWith('m:') && !editor.envSelection.includes(key)) editor.selectEnv([key]);
      }
      return;
    }
    const [x0, x1, y0, y1] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
    if (x1 - x0 < 4 && y1 - y0 < 4) {
      if (!drag.additive) editor.selectAnimKeys([]);
      this.host.redraw();
      return;
    }
    const ids: string[] = [];
    for (const line of this.lines()) {
      if (line.kind !== 'part' || line.top + line.height < y0 || line.top > y1) continue;
      for (const key of line.anim?.keys[line.part!] ?? []) {
        const x = this.host.beatToX(key.beat);
        if (x >= x0 && x <= x1) ids.push(key.id);
      }
    }
    editor.selectAnimKeys(ids, drag.additive ? 'add' : 'replace');
    this.host.redraw();
  }

  /** The motions line's menu: a ready motion from here. */
  private motionMenu(line: Line, x: number, clientX: number, clientY: number) {
    const editor = this.editor;
    const beat = Math.max(0, editor.snapBeat(this.host.xToBeat(x)));
    setTimeout(() =>
      showMenu(clientX, clientY, [
        { label: tr('＋ Движение отсюда'), heading: true },
        ...MOTION_KINDS.map((kind) => ({ label: tr(MOTION_NAMES[kind]), action: () => editor.addMotion(line.key, kind, beat) })),
      ]),
    );
  }

  /** The right button: on a key or a bar — easing, curve, repeats, delete; on a line — a key here; on
   *  the motions line — add, remove, make keys. */
  contextMenu(x: number, y: number, clientX: number, clientY: number) {
    const editor = this.editor;
    const line = this.lineAt(y);
    if (line?.kind === 'motions') {
      const hit = this.motionAt(line, x);
      if (hit === null) return this.motionMenu(line, x, clientX, clientY);
      editor.selectMotion(hit.motion.id);
      showMenu(clientX, clientY, [
        { label: tr(MOTION_NAMES[hit.motion.kind]), heading: true },
        ...(isPeriodic(hit.motion) ? [{ label: tr('Разобрать в ключи'), hint: tr('каждая четверть доли'), action: () => editor.bakeMotion(hit.motion.id) }] : []),
        { label: tr('🗑 Удалить движение'), hint: 'Delete', action: () => editor.removeMotion(hit.motion.id) },
      ]);
      return;
    }
    const found = this.at(x, y);
    if (found === null || found.line.kind !== 'part') return;
    const part = found.line.part!;
    const anim = found.line.anim;
    const key = found.key ?? found.bar;
    const curveItems = [
      { label: `${found.line.open === true ? '● ' : ''}${tr('〰 Кривые в строке')}`, hint: tr('▸ слева'), action: () => editor.toggleCurve(found.line.key, part) },
      ...(part !== 'rotation' && anim !== undefined ? [{ label: `${anim.spline?.[part] === true ? '● ' : ''}${tr('Плавная кривая через ключи')}`, action: () => editor.setAnimSpline(anim.target, part, anim.spline?.[part] !== true) }] : []),
    ];
    if (key === null) {
      const beat = Math.max(0, editor.snapBeat(this.host.xToBeat(x)));
      showMenu(clientX, clientY, [
        { label: '◆ Ключ здесь', action: () => editor.addAnimKeys([found.line.key], [part], beat) },
        { label: 'Вставить ключи здесь', hint: 'Ctrl+V', action: () => {
          editor.seek(beat);
          editor.pasteAnimKeys();
        } },
        null,
        ...curveItems,
      ]);
      return;
    }
    if (found.key !== null && !editor.animSelection.has(key.id)) editor.selectAnimKeys([key.id]);
    const ids = found.key !== null ? new Set(editor.animSelection) : new Set([key.id]);
    showMenu(clientX, clientY, [
      ...curveItems,
      null,
      { label: 'Как приходит к ключу', heading: true },
      ...EASINGS.map(([id, name]) => ({ label: `${(key.easing ?? 'easeLinear') === id ? '● ' : ''}${tr(name)}`, action: () => editor.changeAnimKeys(ids, (item) => (id === 'easeLinear' ? delete item.easing : (item.easing = id))) })),
      null,
      { label: 'Сколько раз подряд', heading: true },
      ...[1, 2, 4, 8, 16].map((runs) => ({ label: `${animRuns(anim, part) === runs ? '● ' : ''}${runs === 1 ? tr('Один раз') : `↻ ×${String(runs)}`}`, action: () => anim !== undefined && editor.setAnimRuns(anim.target, part, runs) })),
      null,
      ...(found.key !== null ? [{ label: '⧉ Копировать ключи', hint: 'Ctrl+C', action: () => void editor.copyAnimKeys() }] : []),
      ...(found.key !== null ? [{ label: '🗑 Удалить ключи', hint: 'Delete', action: () => editor.removeAnimKeys(ids) }] : []),
    ]);
  }

  wheel(event: WheelEvent, _x: number, _y: number): boolean {
    // (Shift + wheel: the lines up and down, when there are more than fit)
    if (!event.shiftKey) return false;
    this.scrollY = Math.max(0, this.scrollY + (event.deltaY !== 0 ? event.deltaY : event.deltaX));
    this.host.redraw();
    return true;
  }

  leave() {}
}
