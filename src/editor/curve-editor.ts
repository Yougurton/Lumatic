import type { Editor } from './editor';
import { animRuns, animValue, partSpan, PART_SIZE, sortedKeys, type AnimKey, type AnimPart } from './env-anim';
import { tr } from './i18n';
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
const AXIS_COLOURS = ['#ff6b6b', '#6be07a', '#6aa6ff', '#e8eaf2'];
const axisNames = (part: AnimPart) => (part === 'color' ? ['R', 'G', 'B', 'A'] : PART_SIZE[part] === 1 ? [''] : ['X', 'Y', 'Z']);

/**
 * A part's curve: how its value goes over the song, one line an axis, a dot a key. A dot is dragged up
 * and down (its value on that axis) and to the sides (its beat — all its axes); a click between two dots
 * picks that stretch (its easing below). Below: the easing, a smooth curve through the keys, how many
 * times it plays.
 */
export function openCurveEditor(editor: Editor, thing: string, part: AnimPart) {
  const shade = document.createElement('div');
  shade.className = 'ce-shade';
  const box = document.createElement('div');
  box.className = 'ce-dialog curve-dialog';
  const title = Object.assign(document.createElement('div'), { className: 'ce-dialog-title' });
  const canvas = document.createElement('canvas');
  canvas.className = 'curve-canvas';
  const tools = document.createElement('div');
  tools.className = 'curve-tools';
  const hint = Object.assign(document.createElement('div'), { className: 'nm-dim curve-hint', textContent: tr('Точку тяните вверх-вниз — значение по этой оси, вбок — доля ключа. Клик между точками выбирает переход. Колесо — масштаб по высоте.') });
  const buttons = Object.assign(document.createElement('div'), { className: 'ce-dialog-buttons' });
  const done = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: tr('Готово') });
  buttons.append(done);
  box.append(title, canvas, tools, hint, buttons);
  shade.append(box);
  document.body.append(shade);
  const ctx = canvas.getContext('2d')!;
  const width = 760;
  const height = 300;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${String(width)}px`;
  canvas.style.height = `${String(height)}px`;
  const pad = { left: 46, right: 14, top: 12, bottom: 24 };
  const size = PART_SIZE[part];
  const names = axisNames(part);
  let picked: string | null = [...editor.animSelection][0] ?? null;
  let range: { lo: number; hi: number } | null = null;
  let zoom = 1;
  let drag: { id: string; axis: number; grabBeat: number; beat0: number; value0: number; moved: boolean } | null = null;

  const anim = () => editor.animOf(thing);
  const keys = (): AnimKey[] => sortedKeys(anim()?.keys[part]);
  const span = () => {
    const found = partSpan(anim(), part);
    const from = found?.from ?? editor.playhead();
    const to = found === null ? from : found.from + Math.max(found.length, 0);
    const extra = Math.max(1, (to - from) * 0.06);
    return { from: from - extra, to: to + extra };
  };
  const fitRange = () => {
    let lo = Infinity;
    let hi = -Infinity;
    const { from, to } = span();
    for (let n = 0; n <= 120; n++) {
      const value = animValue(anim(), part, from + ((to - from) * n) / 120);
      if (value !== null) for (const item of value) {
        lo = Math.min(lo, item);
        hi = Math.max(hi, item);
      }
    }
    for (const key of keys()) for (const item of key.value) {
      lo = Math.min(lo, item);
      hi = Math.max(hi, item);
    }
    if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
    if (hi - lo < 1e-6) [lo, hi] = [lo - 1, hi + 1];
    const middle = (lo + hi) / 2;
    const half = ((hi - lo) / 2) * 1.15 * zoom;
    range = { lo: middle - half, hi: middle + half };
  };
  const xOf = (beat: number) => {
    const { from, to } = span();
    return pad.left + ((beat - from) / Math.max(1e-6, to - from)) * (width - pad.left - pad.right);
  };
  const beatOf = (x: number) => {
    const { from, to } = span();
    return from + ((x - pad.left) / (width - pad.left - pad.right)) * (to - from);
  };
  const yOf = (value: number) => pad.top + (1 - (value - range!.lo) / Math.max(1e-9, range!.hi - range!.lo)) * (height - pad.top - pad.bottom);
  const valueOf = (y: number) => range!.lo + (1 - (y - pad.top) / (height - pad.top - pad.bottom)) * (range!.hi - range!.lo);

  const draw = () => {
    if (range === null) fitRange();
    title.textContent = `${editor.thingName(thing)} — ${tr(PART_NAMES[part])}`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#15161b';
    ctx.fillRect(0, 0, width, height);
    const { from, to } = span();
    // the beats, the values
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const step = Math.max(0.25, 2 ** Math.ceil(Math.log2((to - from) / 12)));
    for (let beat = Math.ceil(from / step) * step; beat <= to; beat += step) {
      const x = xOf(beat);
      ctx.fillStyle = Math.abs(beat - Math.round(beat)) < 1e-6 ? '#2a2c34' : '#1f2027';
      ctx.fillRect(x, pad.top, 1, height - pad.top - pad.bottom);
      ctx.fillStyle = '#6c7080';
      ctx.fillText(String(Math.round(beat * 100) / 100), x - 8, height - 10);
    }
    for (let n = 0; n <= 4; n++) {
      const value = range!.lo + ((range!.hi - range!.lo) * n) / 4;
      const y = yOf(value);
      ctx.fillStyle = '#23252d';
      ctx.fillRect(pad.left, y, width - pad.left - pad.right, 1);
      ctx.fillStyle = '#6c7080';
      ctx.fillText(String(Math.round(value * 100) / 100), 4, y);
    }
    // the playhead
    const head = xOf(editor.playhead());
    if (head >= pad.left && head <= width - pad.right) {
      ctx.fillStyle = 'rgba(255,90,90,0.7)';
      ctx.fillRect(head, pad.top, 1, height - pad.top - pad.bottom);
    }
    const list = keys();
    // the picked stretch
    const at = list.findIndex((key) => key.id === picked);
    if (at > 0) {
      ctx.fillStyle = 'rgba(255,226,122,0.08)';
      ctx.fillRect(xOf(list[at - 1]!.beat), pad.top, xOf(list[at]!.beat) - xOf(list[at - 1]!.beat), height - pad.top - pad.bottom);
    }
    // the curves
    for (let axis = 0; axis < size; axis++) {
      ctx.strokeStyle = size === 1 ? PART_COLOURS[part] : AXIS_COLOURS[axis]!;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (let n = 0; n <= 300; n++) {
        const beat = from + ((to - from) * n) / 300;
        const value = animValue(anim(), part, beat);
        if (value === null) continue;
        const [x, y] = [xOf(beat), yOf(value[axis]!)];
        if (!started) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        started = true;
      }
      ctx.stroke();
      for (const key of list) {
        const [x, y] = [xOf(key.beat), yOf(key.value[axis]!)];
        ctx.beginPath();
        ctx.arc(x, y, key.id === picked ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = key.id === picked ? '#ffe27a' : size === 1 ? PART_COLOURS[part] : AXIS_COLOURS[axis]!;
        ctx.fill();
        ctx.strokeStyle = '#0d0e12';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    // the axes' names
    names.forEach((name, axis) => {
      if (name === '') return;
      ctx.fillStyle = AXIS_COLOURS[axis]!;
      ctx.fillText(name, width - pad.right - 10 * (names.length - axis), pad.top + 6);
    });
    renderTools();
  };

  /** The dot under the mouse (its key and axis). */
  const dotAt = (x: number, y: number) => {
    let best: { key: AnimKey; axis: number; far: number } | null = null;
    for (const key of keys())
      for (let axis = 0; axis < size; axis++) {
        const far = Math.hypot(xOf(key.beat) - x, yOf(key.value[axis]!) - y);
        if (far <= 8 && (best === null || far < best.far)) best = { key, axis, far };
      }
    return best;
  };

  const renderTools = () => {
    tools.replaceChildren();
    const list = keys();
    const key = list.find((item) => item.id === picked) ?? null;
    const first = list[0]?.id === picked;
    const easing = document.createElement('select');
    for (const [id, name] of EASINGS) easing.append(Object.assign(document.createElement('option'), { value: id, textContent: tr(name) }));
    easing.value = key?.easing ?? 'easeLinear';
    easing.disabled = key === null || first || (thing === 'p:player' && !editor.playerRisky());
    easing.title = tr('Как значение приходит к выбранному ключу от предыдущего');
    easing.addEventListener('change', () => key !== null && editor.changeAnimKeys(new Set([key.id]), (item) => (easing.value === 'easeLinear' ? delete item.easing : (item.easing = easing.value))));
    const label = (text: string, ...controls: HTMLElement[]) => {
      const item = document.createElement('label');
      item.className = 'curve-tool';
      item.append(Object.assign(document.createElement('span'), { textContent: text }), ...controls);
      tools.append(item);
    };
    label(tr('Переход'), easing);
    const target = editor.animTarget(thing);
    if (part !== 'rotation' && target !== null) {
      const spline = Object.assign(document.createElement('input'), { type: 'checkbox', checked: anim()?.spline?.[part] === true });
      spline.title = tr('Через ключи — плавной кривой, а не прямыми от одного к другому');
      spline.addEventListener('change', () => editor.setAnimSpline(target, part, spline.checked));
      label(tr('Плавная кривая'), spline);
    }
    if (target !== null) {
      const runs = Object.assign(document.createElement('input'), { type: 'number', min: '1', max: '999', step: '1', value: String(animRuns(anim(), part)) });
      runs.title = tr('Сколько раз подряд проигрываются ключи этого свойства (1 — один раз)');
      runs.addEventListener('change', () => editor.setAnimRuns(target, part, Number(runs.value) || 1));
      label(tr('Повторить, раз'), runs);
    }
    if (key !== null) {
      for (let axis = 0; axis < size; axis++) {
        const input = Object.assign(document.createElement('input'), { type: 'number', step: part === 'rotation' ? '1' : '0.05', value: String(key.value[axis]) });
        input.className = 'curve-number';
        input.addEventListener('change', () => editor.changeAnimKeys(new Set([key.id]), (item) => (item.value[axis] = Number(input.value) || 0)));
        label(names[axis] === '' ? tr('Значение') : names[axis]!, input);
      }
    }
  };

  canvas.addEventListener('mousedown', (event) => {
    const rect = canvas.getBoundingClientRect();
    const [x, y] = [event.clientX - rect.left, event.clientY - rect.top];
    const dot = dotAt(x, y);
    if (dot !== null) {
      picked = dot.key.id;
      editor.selectAnimKeys([dot.key.id]);
      drag = { id: dot.key.id, axis: dot.axis, grabBeat: beatOf(x), beat0: dot.key.beat, value0: dot.key.value[dot.axis]!, moved: false };
      return;
    }
    // (between two dots: that stretch — its later key — picked)
    const beat = beatOf(x);
    const after = keys().find((key) => key.beat > beat);
    picked = after?.id ?? null;
    if (after !== undefined) editor.selectAnimKeys([after.id]);
    else draw();
  });
  const move = (event: MouseEvent) => {
    if (drag === null) {
      const rect = canvas.getBoundingClientRect();
      canvas.style.cursor = dotAt(event.clientX - rect.left, event.clientY - rect.top) !== null ? 'grab' : 'pointer';
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const [x, y] = [event.clientX - rect.left, event.clientY - rect.top];
    const d = drag;
    d.moved = true;
    // (sideways: the beat, on the grid; up and down: the value — Shift: the value only)
    const beat = event.shiftKey ? d.beat0 : Math.max(0, editor.snapBeat(d.beat0 + beatOf(x) - d.grabBeat));
    const value = Math.round(valueOf(y) * (part === 'rotation' ? 1 : 1000)) / (part === 'rotation' ? 1 : 1000);
    editor.changeAnimKeys(new Set([d.id]), (key) => {
      key.beat = beat;
      key.value[d.axis] = value;
    }, 'curve:drag');
  };
  const up = () => {
    if (drag !== null && drag.moved) range = null;
    drag = null;
    draw();
  };
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoom = Math.min(20, Math.max(0.05, zoom * (event.deltaY > 0 ? 1.15 : 1 / 1.15)));
    range = null;
    draw();
  }, { passive: false });
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  const stop = editor.onChange(() => {
    // (the values change while dragging: the scale stays, so the dot stays under the mouse)
    if (drag === null) range = null;
    draw();
  });
  const close = () => {
    stop();
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    window.removeEventListener('keydown', keys_, true);
    shade.remove();
  };
  const keys_ = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      close();
    }
  };
  window.addEventListener('keydown', keys_, true);
  done.addEventListener('click', close);
  shade.addEventListener('mousedown', (event) => {
    if (event.target === shade) close();
  });
  draw();
}
