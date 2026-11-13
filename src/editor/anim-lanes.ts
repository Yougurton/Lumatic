import type { Editor } from './editor';
import { openCurveEditor, PART_COLOURS, PART_NAMES } from './curve-editor';
import { ALL_PARTS, animRuns, sortedKeys, type AnimKey, type AnimPart, type SceneAnim } from './env-anim';
import { tr } from './i18n';
import { showMenu } from './menu';
import type { LaneHost } from './notes-timeline';
import { EASINGS } from './rings';

const TITLE_H = 20;
const PART_H = 22;

interface Line {
  kind: 'title' | 'part';
  /** The picked thing it's of ("g:…", "o:…"). */
  key: string;
  name: string;
  part?: AnimPart;
  anim?: SceneAnim;
  top: number;
  height: number;
}

type Drag =
  | { kind: 'move'; grab: number; origin: Map<string, number>; moved: boolean; id: string; additive: boolean }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; additive: boolean };

/**
 * The scene's animation on the timeline (drawn in place of the lights' rows while the Scene side is
 * open): a block of lines for each animated or picked object — its name, then its place, turn and
 * size, the keys as diamonds on their beats, a bar between two keys where it moves.
 *
 * A click picks a key (and takes the song there), a drag moves the picked keys, a double click on a
 * line makes a key there, the right button: how it comes to the key (easing), delete.
 */
export class AnimLanes {
  private readonly editor: Editor;
  private drag: Drag | null = null;
  private scrollY = 0;

  constructor(private readonly host: LaneHost) {
    this.editor = host.editor;
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
        out.push({ kind: 'part', key, name, part, anim, top, height: PART_H });
        top += PART_H;
      }
      top += 6;
    };
    for (const anim of editor.sceneAnims()) {
      const key = editor.animKeyOf(anim);
      if (key !== null) block(key, anim);
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

  draw(ctx: CanvasRenderingContext2D) {
    const host = this.host;
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.total() - (host.lanesBottom - host.lanesTop)));
    ctx.fillStyle = '#15161b';
    ctx.fillRect(0, host.lanesTop, host.width, host.lanesBottom - host.lanesTop);
    const picked = new Set(this.editor.envSelection);
    for (const line of this.lines()) {
      if (line.top + line.height < host.lanesTop || line.top > host.lanesBottom) continue;
      ctx.fillStyle = line.kind === 'title' ? (picked.has(line.key) ? '#2b3550' : '#22242c') : '#1b1c22';
      ctx.fillRect(host.left, line.top, host.width - host.left, line.height - 1);
    }
  }

  drawObjects(ctx: CanvasRenderingContext2D) {
    const host = this.host;
    const editor = this.editor;
    const lines = this.lines();
    ctx.save();
    ctx.textBaseline = 'middle';
    if (lines.length === 0) {
      ctx.fillStyle = '#8a8d98';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(tr('Анимация: выберите объект и поставьте ключ — кнопкой «◆ Ключ» справа или двойным кликом по строке здесь'), host.left + 14, host.lanesTop + 26);
      ctx.restore();
      return;
    }
    for (const line of lines) {
      if (line.top + line.height < host.lanesTop || line.top > host.lanesBottom) continue;
      const middle = line.top + line.height / 2;
      if (line.kind === 'part') {
        const keys = sortedKeys(line.anim?.keys[line.part!]);
        const colour = PART_COLOURS[line.part!];
        // the bars: where it moves from a key to the next
        for (let at = 0; at + 1 < keys.length; at++) {
          const x0 = host.beatToX(keys[at]!.beat);
          const x1 = host.beatToX(keys[at + 1]!.beat);
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = colour;
          ctx.fillRect(x0, middle - 3, x1 - x0, 6);
          ctx.globalAlpha = 1;
          const easing = keys[at + 1]!.easing;
          if (easing !== undefined && easing !== 'easeLinear' && x1 - x0 > 90) {
            ctx.fillStyle = '#c9ccd6';
            ctx.font = '10px system-ui, sans-serif';
            ctx.fillText(tr(EASINGS.find(([id]) => id === easing)?.[1] ?? easing), x0 + 10, middle - 9 < line.top ? middle : middle);
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
        } else if (last !== undefined) {
          ctx.globalAlpha = 0.18;
          ctx.fillStyle = colour;
          ctx.fillRect(host.beatToX(last.beat), middle - 1, host.width, 2);
          ctx.globalAlpha = 1;
        }
        for (const key of keys) {
          const x = host.beatToX(key.beat);
          const chosen = editor.animSelection.has(key.id);
          ctx.beginPath();
          ctx.moveTo(x, middle - 7);
          ctx.lineTo(x + 7, middle);
          ctx.lineTo(x, middle + 7);
          ctx.lineTo(x - 7, middle);
          ctx.closePath();
          ctx.fillStyle = chosen ? '#ffe27a' : colour;
          ctx.fill();
          ctx.lineWidth = chosen ? 2 : 1;
          ctx.strokeStyle = chosen ? '#ffffff' : '#0d0e12';
          ctx.stroke();
        }
      }
      // the name: stays at the left whatever the song's place
      const text = line.kind === 'title' ? line.name : tr(PART_NAMES[line.part!]);
      ctx.font = line.kind === 'title' ? '600 12px system-ui, sans-serif' : '11px system-ui, sans-serif';
      const width = ctx.measureText(text).width + 14;
      ctx.fillStyle = line.kind === 'title' ? 'rgba(34,36,44,0.92)' : 'rgba(27,28,34,0.88)';
      ctx.fillRect(host.left, line.top, width + (line.kind === 'part' ? 10 : 0), line.height - 1);
      ctx.fillStyle = line.kind === 'title' ? '#e8eaf2' : PART_COLOURS[line.part!];
      ctx.fillText(text, host.left + (line.kind === 'part' ? 16 : 6), middle);
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

  private lineAt(y: number): Line | null {
    return this.lines().find((line) => y >= line.top && y < line.top + line.height) ?? null;
  }

  /** The key under the mouse, or the bar between two keys (the later of them). */
  private at(x: number, y: number): { line: Line; key: AnimKey | null; bar: AnimKey | null } | null {
    const line = this.lineAt(y);
    if (line === null) return null;
    if (line.kind !== 'part') return { line, key: null, bar: null };
    const keys = sortedKeys(line.anim?.keys[line.part!]);
    const key = keys.map((item) => ({ item, far: Math.abs(this.host.beatToX(item.beat) - x) })).filter((item) => item.far <= 8).sort((a, b) => a.far - b.far)[0]?.item ?? null;
    let bar: AnimKey | null = null;
    if (key === null) for (let at = 0; at + 1 < keys.length; at++) if (x > this.host.beatToX(keys[at]!.beat) && x < this.host.beatToX(keys[at + 1]!.beat)) bar = keys[at + 1]!;
    return { line, key, bar };
  }

  cursor(x: number, y: number) {
    const found = this.at(x, y);
    return found?.key != null ? 'grab' : found?.bar != null || found?.line.kind === 'title' ? 'pointer' : 'default';
  }

  mouseDown(event: MouseEvent, x: number, y: number) {
    if (event.button !== 0) return;
    const editor = this.editor;
    const found = this.at(x, y);
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    if (found === null) {
      this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, additive };
      return;
    }
    if (found.line.kind === 'title') {
      if (found.line.key.startsWith('m:')) editor.showMaterial(found.line.key.slice(2));
      else editor.selectEnv([found.line.key], additive ? 'toggle' : 'replace');
      return;
    }
    // (a double click between two keys: the curve)
    if (event.detail >= 2 && found.bar !== null) {
      openCurveEditor(editor, found.line.key, found.line.part!);
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
      if (!editor.envSelection.includes(found.line.key)) editor.selectEnv([found.line.key]);
      editor.addAnimKeys([found.line.key], [found.line.part!], beat);
      editor.seek(beat);
      return;
    }
    this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, additive };
  }

  mouseMove(x: number, y: number): boolean {
    const drag = this.drag;
    if (drag === null) return false;
    if (drag.kind === 'box') {
      drag.x1 = x;
      drag.y1 = y;
      this.host.redraw();
      return true;
    }
    const shift = this.editor.snapBeat(this.host.xToBeat(x)) - drag.grab;
    if (!drag.moved && Math.abs(shift) < 1e-6) return true;
    drag.moved = true;
    // (not before the song's start)
    const least = Math.min(...drag.origin.values());
    const by = Math.max(shift, -least);
    this.editor.changeAnimKeys(new Set(drag.origin.keys()), (key) => (key.beat = Math.round((drag.origin.get(key.id)! + by) * 10000) / 10000), 'anim:move');
    this.host.redraw();
    return true;
  }

  mouseUp(_event: MouseEvent) {
    const drag = this.drag;
    this.drag = null;
    if (drag === null) return;
    const editor = this.editor;
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
        if (key !== null && !editor.envSelection.includes(key)) editor.selectEnv([key]);
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

  /** The right button: on a key or a bar — how it comes there, delete; on a line — a key here. */
  contextMenu(x: number, y: number, clientX: number, clientY: number) {
    const editor = this.editor;
    const found = this.at(x, y);
    if (found === null || found.line.kind !== 'part') return;
    const key = found.key ?? found.bar;
    if (key === null) {
      const beat = Math.max(0, editor.snapBeat(this.host.xToBeat(x)));
      showMenu(clientX, clientY, [
        { label: '◆ Ключ здесь', action: () => editor.addAnimKeys([found.line.key], [found.line.part!], beat) },
        { label: 'Вставить ключи здесь', hint: 'Ctrl+V', action: () => {
          editor.seek(beat);
          editor.pasteAnimKeys();
        } },
      ]);
      return;
    }
    if (found.key !== null && !editor.animSelection.has(key.id)) editor.selectAnimKeys([key.id]);
    const ids = found.key !== null ? new Set(editor.animSelection) : new Set([key.id]);
    showMenu(clientX, clientY, [
      { label: '〰 Кривая…', hint: 'двойной клик по переходу', action: () => openCurveEditor(editor, found.line.key, found.line.part!) },
      ...(found.line.part !== 'rotation' && found.line.anim !== undefined ? [{ label: `${found.line.anim.spline?.[found.line.part!] === true ? '● ' : ''}${tr('Плавная кривая через ключи')}`, action: () => editor.setAnimSpline(found.line.anim!.target, found.line.part!, found.line.anim!.spline?.[found.line.part!] !== true) }] : []),
      null,
      { label: 'Как приходит к ключу', heading: true },
      ...EASINGS.map(([id, name]) => ({ label: `${(key.easing ?? 'easeLinear') === id ? '● ' : ''}${tr(name)}`, action: () => editor.changeAnimKeys(ids, (item) => (id === 'easeLinear' ? delete item.easing : (item.easing = id))) })),
      null,
      { label: 'Сколько раз подряд', heading: true },
      ...[1, 2, 4, 8, 16].map((runs) => ({ label: `${animRuns(found.line.anim, found.line.part!) === runs ? '● ' : ''}${runs === 1 ? tr('Один раз') : `↻ ×${String(runs)}`}`, action: () => found.line.anim !== undefined && editor.setAnimRuns(found.line.anim.target, found.line.part!, runs) })),
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
