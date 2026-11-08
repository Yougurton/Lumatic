import type { Editor } from './editor';
import { scrubStrip } from './gls-editor';
import { gridSelect } from './grids';
import { ringSystemName } from './library';
import { DEFAULT_STEPS, newStepsBlock, stepPoses, type RingBlock, type StepTransition } from './rings';

/**
 * "Rings in steps", the simple way: from one angle to another in a few steps — how many, how often,
 * how fast each turn is, straight or as a spiral. The steps drawn as little rings; tried on the
 * timeline and in the 3D view as they change. `blockId`: a block made this way before (its settings
 * again); null: a new one at the cursor.
 */

/** How fast each turn is: its share of the time between steps. */
const SPEEDS: [string, number][] = [
  ['Мгновенно', 0],
  ['Рывком', 0.1],
  ['Быстро', 0.3],
  ['Плавно', 0.7],
];

let remembered: StepTransition = { ...DEFAULT_STEPS };

export function ringStepsDialog(editor: Editor, blockId: string | null, brush?: (block: RingBlock) => void) {
  if (editor.project === null || editor.ringInfo.length === 0) return;
  const old = blockId === null ? undefined : editor.ringBlockById(blockId);
  const values: StepTransition = { ...(old?.steps ?? remembered) };
  let system = old?.system || (editor.ringInfo.find((item) => editor.geometryRings.has(item.name))?.name ?? editor.ringInfo[0]!.name);
  const start = old?.start ?? editor.snapBeat(editor.playhead());
  const id = old?.id;
  let spiral = values.fromStep !== 0 || values.toStep !== 0;
  editor.startTrying();

  const shade = document.createElement('div');
  shade.className = 'ce-shade adjust-shade';
  const box = document.createElement('div');
  box.className = 'ce-dialog adjust-dialog steps-dialog';
  box.innerHTML = `
    <div class="ce-dialog-title">Кольца по шагам</div>
    <label data-id="system-row">Кольца <select data-id="system">${editor.ringInfo.map((item) => `<option value="${item.name}">${ringSystemName(item.name)} (${String(item.rings)})</option>`).join('')}</select></label>
    <div class="adjust-pair">
      <label>Угол от, ° <input type="number" data-id="fromAngle" step="5"></label>
      <label>до, ° <input type="number" data-id="toAngle" step="5"></label>
      <label>Шагов <input type="number" data-id="steps" min="1" max="32" step="1"></label>
    </div>
    <div class="steps-line"><span class="adjust-head">Шаг каждые, долей</span><span class="steps-buttons" data-id="every"></span></div>
    <div class="steps-line"><span class="adjust-head">Поворот</span><span class="steps-buttons" data-id="speed"></span></div>
    <label class="adjust-check"><input type="checkbox" data-id="spiral"> Спиралью (каждое кольцо повёрнуто дальше предыдущего)</label>
    <div class="adjust-pair" data-id="spiral-row">
      <label>Спираль от, ° <input type="number" data-id="fromStep" step="1"></label>
      <label>до, ° <input type="number" data-id="toStep" step="1"></label>
    </div>
    <canvas class="steps-picture" data-id="picture" width="400" height="74"></canvas>
    <div class="nm-dim" data-id="summary"></div>
    <div class="ce-dialog-buttons"><button type="button" data-id="fine" title="Открыть блок в редакторе поз: каждая поза отдельно, волны, раскладка по кольцам">Точнее…</button><span class="adjust-gap"></span><button type="button" data-id="cancel">Отмена</button><button type="button" class="primary" data-id="apply">${old === undefined ? (brush !== undefined ? 'Ставить мышью' : 'Поставить') : 'Готово'}</button></div>`;
  shade.append(box);
  document.body.append(shade);
  const el = <T extends HTMLElement>(name: string) => box.querySelector<T>(`[data-id="${name}"]`)!;
  el('system-row').hidden = editor.ringInfo.length < 2;
  // (the song moved along the block: the 3D view shows the rings at that moment)
  el('summary').before(scrubStrip(editor, () => current));
  el<HTMLSelectElement>('system').value = system;

  /** The block as the settings are. */
  const made = (): RingBlock => {
    const mode = editor.geometryRings.has(system) ? 'tracks' : (old?.mode ?? 'event');
    const block = newStepsBlock(system, mode, start, spiral ? values : { ...values, fromStep: 0, toStep: 0 });
    return { ...block, id: id ?? block.id, name: old?.name ?? block.name };
  };
  let current = made();

  const buttons = (place: string, options: [string, number][], get: () => number, set: (value: number) => void) => {
    const holder = el(place);
    const draw = () => {
      holder.replaceChildren(
        ...options.map(([label, value]) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.textContent = label;
          item.classList.toggle('active', Math.abs(get() - value) < 1e-6);
          item.addEventListener('click', () => {
            set(value);
            draw();
            update();
          });
          return item;
        }),
      );
    };
    draw();
  };
  const share = () => (values.every > 0 ? values.turn / values.every : 0.3);
  el('every').replaceChildren(
    gridSelect(values.every, (value) => {
      const part = share();
      values.every = value;
      values.turn = Math.round(value * part * 100000) / 100000;
      update();
    }, [2, 4, 8]),
  );
  buttons('speed', SPEEDS, () => SPEEDS.reduce((best, [, value]) => (Math.abs(value - share()) < Math.abs(best - share()) ? value : best), SPEEDS[0]![1]), (value) => (values.turn = Math.round(values.every * value * 1000) / 1000));

  for (const key of ['fromAngle', 'toAngle', 'steps', 'fromStep', 'toStep'] as const) {
    const input = el<HTMLInputElement>(key);
    input.value = String(values[key]);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      values[key] = key === 'steps' ? Math.max(1, Math.min(32, Math.round(value))) : value;
      update();
    });
  }
  const spiralCheck = el<HTMLInputElement>('spiral');
  spiralCheck.checked = spiral;
  spiralCheck.addEventListener('change', () => {
    spiral = spiralCheck.checked;
    if (spiral && values.fromStep === 0 && values.toStep === 0) {
      values.toStep = 15;
      el<HTMLInputElement>('toStep').value = '15';
    }
    update();
  });
  el<HTMLSelectElement>('system').addEventListener('change', () => {
    system = el<HTMLSelectElement>('system').value;
    update();
  });

  // ----- the steps drawn: each pose as a few rings seen from the platform
  const picture = el<HTMLCanvasElement>('picture');
  const draw = () => {
    const poses = stepPoses(spiral ? values : { ...values, fromStep: 0, toStep: 0 });
    const ctx = picture.getContext('2d')!;
    const size = picture.height;
    const gap = 6;
    const count = Math.min(poses.length, Math.floor((picture.width + gap) / (size + gap)));
    ctx.clearRect(0, 0, picture.width, picture.height);
    poses.slice(0, count).forEach((pose, index) => {
      const cx = index * (size + gap) + size / 2;
      const cy = size / 2;
      ctx.fillStyle = '#121318';
      ctx.fillRect(cx - size / 2, 0, size, size);
      for (let ring = 4; ring >= 0; ring--) {
        const half = (size / 2 - 4) * (1 - ring * 0.17);
        ctx.save();
        ctx.translate(cx, cy);
        // (plus: counter-clockwise as seen from the platform)
        ctx.rotate((-(pose.angle + (pose.shape === 'spiral' ? pose.step * ring : 0)) * Math.PI) / 180);
        ctx.strokeStyle = ring === 0 ? '#e0a0ff' : `rgba(200, 140, 255, ${String(0.85 - ring * 0.13)})`;
        ctx.lineWidth = ring === 0 ? 2 : 1.4;
        ctx.strokeRect(-half, -half, half * 2, half * 2);
        ctx.restore();
      }
      ctx.fillStyle = '#9aa0b4';
      ctx.font = '10px sans-serif';
      ctx.fillText(`${String(Math.round(pose.angle))}°`, cx - size / 2 + 3, size - 4);
    });
    if (count < poses.length) {
      ctx.fillStyle = '#9aa0b4';
      ctx.fillText(`+${String(poses.length - count)}`, picture.width - 22, size / 2);
    }
  };

  let timer = 0;
  const update = () => {
    draw();
    current = made();
    el('spiral-row').hidden = !spiral;
    const length = current.end - current.start;
    el('summary').textContent = `${String(current.poses.length)} поз · ${String(Math.round(length * 100) / 100)} долей, с доли ${String(Math.round(start * 1000) / 1000)}${current.mode === 'tracks' ? ' · каждое кольцо отдельно' : ' · событиями колец'}`;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => editor.tryRingBlock(current), 80);
  };

  const close = (keep: boolean) => {
    window.clearTimeout(timer);
    // (a brush: the settings taken, the block put with the mouse — not here at the cursor)
    const asBrush = keep && brush !== undefined && old === undefined;
    if (keep) {
      editor.tryRingBlock(current);
      remembered = { ...values };
    }
    editor.finishTrying(keep && !asBrush);
    shade.remove();
    window.removeEventListener('keydown', keys, true);
    if (asBrush) brush(current);
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(false);
    } else if (event.key === 'Enter') {
      event.stopPropagation();
      close(true);
    } else if ((event.ctrlKey || event.metaKey) && /^[zy]$/iu.test(event.key)) event.stopPropagation();
  };
  window.addEventListener('keydown', keys, true);
  el('cancel').addEventListener('click', () => close(false));
  el('apply').addEventListener('click', () => close(true));
  el('fine').addEventListener('click', () => {
    const block = current;
    close(true);
    editor.updateRingBlock(block.id, (item) => delete item.steps);
    editor.undoDiscard();
    editor.ringEditorHook?.(block.id);
  });
  update();
}
