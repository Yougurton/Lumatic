import type { Editor } from './editor';
import { scrubStrip } from './gls-editor';
import { gridSelect } from './grids';
import { DEFAULT_LASER_MOVE, laserEvents, type LaserMove } from './lasers';
import { laserBlockMove, newLaserBlock, type RingBlock } from './rings';

/**
 * "Lasers": the rotating lasers spinning in a row one way, or turning by a set angle in steps — a
 * block on the lasers' row whose laser speed events (Chroma's data, see lasers.ts) are made from these
 * settings; changed again with a double click, made longer or shorter by its edge. Tried on the
 * timeline and in the 3D view as the settings change; one undo step. `blockId`: the block to change;
 * null: a new one at the cursor.
 */

let remembered: LaserMove = { ...DEFAULT_LASER_MOVE };

/** The settings last used (a new block drawn on the row starts with them). */
export const lastLaserMove = (): LaserMove => ({ ...remembered });

export function laserDialog(editor: Editor, blockId: string | null = null) {
  if (editor.project === null) return;
  const old = blockId === null ? undefined : editor.ringBlockById(blockId);
  const move: LaserMove = old?.lasers !== undefined ? laserBlockMove(old) : { ...remembered };
  const start = old?.start ?? editor.snapBeat(editor.playhead());
  editor.startTrying();

  const shade = document.createElement('div');
  shade.className = 'ce-shade adjust-shade';
  const box = document.createElement('div');
  box.className = 'ce-dialog adjust-dialog steps-dialog';
  box.innerHTML = `
    <div class="ce-dialog-title">Лазеры</div>
    <div class="steps-line"><span class="adjust-head">Какие</span><span class="steps-buttons" data-id="sides"></span></div>
    <div class="steps-line"><span class="adjust-head">Что делают</span><span class="steps-buttons" data-id="mode"></span></div>
    <div class="steps-line"><span class="adjust-head">Сторона</span><span class="steps-buttons" data-id="direction"></span></div>
    <div data-id="spin" class="laser-part">
      <div class="adjust-pair">
        <label>Скорость <input type="number" data-id="speed" min="0.05" step="0.25"></label>
        <label>Длится, долей <input type="number" data-id="length" min="0.0625" step="1"></label>
      </div>
      <div class="steps-line"><span class="adjust-head">Откуда</span><span class="steps-buttons" data-id="from"></span></div>
      <div class="steps-line"><span class="adjust-head">В конце</span><span class="steps-buttons" data-id="end"></span></div>
    </div>
    <div data-id="steps" class="laser-part">
      <div class="adjust-pair">
        <label>Угол за шаг, ° <input type="number" data-id="angle" step="5"></label>
        <label>Шагов <input type="number" data-id="count" min="1" max="64" step="1"></label>
      </div>
      <div class="steps-line"><span class="adjust-head">Шаг каждые, долей</span><span class="steps-buttons" data-id="every"></span></div>
      <div class="steps-line"><span class="adjust-head">Поворот</span><span class="steps-buttons" data-id="turn"></span></div>
      <label class="adjust-check"><input type="checkbox" data-id="fromRow"> Сначала выстроить в ряд (исходное положение окружения)</label>
      <div class="steps-line"><span class="adjust-head">В конце</span><span class="steps-buttons" data-id="stepsEnd"></span></div>
    </div>
    <div data-id="sway" class="laser-part">
      <div class="adjust-pair">
        <label>Качаются на, ° в каждую сторону <input type="number" data-id="swayAngle" min="1" step="5"></label>
        <label>Длится, долей <input type="number" data-id="swayLength" min="0.25" step="1"></label>
      </div>
      <div class="steps-line"><span class="adjust-head">Туда и обратно за, долей</span><span class="steps-buttons" data-id="swayEvery"></span></div>
      <label class="adjust-check"><input type="checkbox" data-id="swayRow"> Сначала выстроить в ряд (исходное положение окружения)</label>
      <div class="steps-line"><span class="adjust-head">В конце</span><span class="steps-buttons" data-id="swayEnd"></span></div>
    </div>
    <canvas class="steps-picture" data-id="picture" width="400" height="64"></canvas>
    <div class="nm-dim" data-id="summary"></div>
    <div class="ce-dialog-buttons"><span class="nm-dim">Нужен Chroma</span><span class="adjust-gap"></span><button type="button" data-id="cancel">Отмена</button><button type="button" class="primary" data-id="apply">${old === undefined ? 'Поставить' : 'Готово'}</button></div>`;
  shade.append(box);
  document.body.append(shade);
  const el = <T extends HTMLElement>(name: string) => box.querySelector<T>(`[data-id="${name}"]`)!;

  const buttons = <T,>(place: string, options: [string, T, string?][], get: () => T, set: (value: T) => void) => {
    const holder = el(place);
    const draw = () =>
      holder.replaceChildren(
        ...options.map(([label, value, title]) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.textContent = label;
          if (title !== undefined) item.title = title;
          item.classList.toggle('active', get() === value);
          item.addEventListener('click', () => {
            set(value);
            draw();
            update();
          });
          return item;
        }),
      );
    draw();
    return draw;
  };
  buttons<LaserMove['sides']>('sides', [['Левые', 'left'], ['Правые', 'right'], ['Обе', 'both']], () => move.sides, (value) => (move.sides = value));
  buttons<LaserMove['mode']>(
    'mode',
    [
      ['Повороты по шагам', 'steps', 'На угол за шаг: лазеры поворачиваются и замирают'],
      ['Крутятся', 'spin', 'Непрерывно, с выбранной скоростью'],
      ['Качаются', 'sway', 'Вибрато: ровно качаются туда и обратно на заданный угол'],
    ],
    () => move.mode,
    (value) => (move.mode = value),
  );
  buttons<LaserMove['end']>('swayEnd', [['Замирают', 'freeze'], ['В исходное', 'reset']], () => (move.end === 'reset' ? 'reset' : 'freeze'), (value) => (move.end = value));
  el('swayEvery').replaceChildren(
    gridSelect(move.every, (value) => {
      move.every = value;
      update();
    }, [2, 4, 8], null, 'sway'),
  );
  buttons<LaserMove['direction']>('direction', [['0', 0, 'Левые в одну сторону, правые — в другую (зеркально)'], ['1', 1, 'Наоборот'], ['Случайно', 'random', 'Как в игре']], () => move.direction, (value) => (move.direction = value));
  buttons<LaserMove['from']>('from', [['Из ряда', 'row', 'Сначала в исходное положение окружения, затем все вместе — ровным рядом'], ['С места', 'place', 'Оттуда, где стоят'], ['Случайно', 'random', 'Как в игре: случайный угол у каждого']], () => move.from, (value) => (move.from = value));
  buttons<LaserMove['end']>('end', [['Крутятся дальше', 'keep'], ['Замирают', 'freeze'], ['В исходное', 'reset']], () => move.end, (value) => (move.end = value));
  buttons<LaserMove['end']>('stepsEnd', [['Замирают', 'freeze'], ['В исходное', 'reset']], () => (move.end === 'reset' ? 'reset' : 'freeze'), (value) => (move.end = value));
  el('every').replaceChildren(
    gridSelect(move.every, (value) => {
      const share = move.every > 0 ? move.turn / move.every : 0.25;
      move.every = value;
      move.turn = Math.round(value * share * 100000) / 100000;
      update();
    }, [2, 4, 8]),
  );
  const turnShare = () => (move.every > 0 ? move.turn / move.every : 0.25);
  const SHARES: [string, number][] = [['Рывком', 0.1], ['Быстро', 0.3], ['Плавно', 0.7], ['Весь шаг', 1]];
  buttons<number>('turn', SHARES.map(([label, value]) => [label, value]), () => SHARES.reduce((best, [, value]) => (Math.abs(value - turnShare()) < Math.abs(best - turnShare()) ? value : best), 0.3), (value) => (move.turn = Math.round(move.every * value * 1000) / 1000));

  const numbers: [string, keyof LaserMove][] = [['speed', 'speed'], ['length', 'length'], ['angle', 'angle'], ['count', 'steps'], ['swayAngle', 'angle'], ['swayLength', 'length']];
  for (const [id, key] of numbers) {
    const input = el<HTMLInputElement>(id);
    input.value = String(move[key]);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      (move as unknown as Record<string, number>)[key] = value;
      update();
    });
  }
  for (const id of ['fromRow', 'swayRow']) {
    const box = el<HTMLInputElement>(id);
    box.checked = move.fromRow;
    box.addEventListener('change', () => {
      move.fromRow = box.checked;
      update();
    });
  }

  let block: RingBlock = newLaserBlock(start, move);
  el('summary').before(scrubStrip(editor, () => block));

  // the steps drawn: four lasers side by side at each step's angle (as the right ones turn)
  const picture = el<HTMLCanvasElement>('picture');
  const draw = () => {
    const ctx = picture.getContext('2d')!;
    const size = picture.height;
    ctx.clearRect(0, 0, picture.width, size);
    const sign = move.direction === 1 ? -1 : 1;
    const angles =
      move.mode === 'steps'
        ? Array.from({ length: Math.min(Math.max(1, Math.round(move.steps)), 32) + 1 }, (_, k) => k * move.angle * sign)
        : move.mode === 'sway'
          ? [0, 1, 0, -1, 0].map((k) => k * Math.abs(move.angle) * sign)
          : [0, 30 * sign, 60 * sign];
    const gap = 6;
    const count = Math.min(angles.length, Math.floor((picture.width + gap) / (size + gap)));
    angles.slice(0, count).forEach((angle, index) => {
      const x0 = index * (size + gap);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, size, size);
      ctx.clip();
      ctx.fillStyle = '#121318';
      ctx.fillRect(x0, 0, size, size);
      for (let laser = 0; laser < 4; laser++) {
        const cx = x0 + size * (0.2 + laser * 0.2);
        ctx.save();
        ctx.translate(cx, size * 0.85);
        ctx.rotate((-angle * Math.PI) / 180);
        ctx.strokeStyle = index === 0 ? '#ff7070' : 'rgba(255,110,110,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -size * 0.7);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = '#9aa0b4';
      ctx.font = '10px sans-serif';
      ctx.fillText(move.mode !== 'spin' ? `${String(Math.round(angle))}°` : index === 0 ? 'ряд' : '…', x0 + 3, 11);
      ctx.restore();
    });
  };

  let timer = 0;
  const update = () => {
    el('spin').hidden = move.mode !== 'spin';
    el('steps').hidden = move.mode !== 'steps';
    el('sway').hidden = move.mode !== 'sway';
    // (the two fields of the same setting show the same value)
    for (const [id, key] of numbers) {
      const input = el<HTMLInputElement>(id);
      if (document.activeElement !== input) input.value = String(move[key]);
    }
    draw();
    const made = newLaserBlock(start, move);
    block = { ...made, id: old?.id ?? block.id, name: made.name };
    const count = laserEvents(laserBlockMove(block), start, (beat) => editor.beatToSeconds(beat)).length;
    el('summary').textContent = `${String(count)} событий скорости лазеров · доли ${String(Math.round(start * 1000) / 1000)}–${String(Math.round(block.end * 1000) / 1000)} · длину блока можно менять мышью`;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => editor.tryRingBlock(block), 80);
  };

  const close = (keep: boolean) => {
    window.clearTimeout(timer);
    if (keep) {
      editor.tryRingBlock(block);
      remembered = { ...move };
      editor.setStatus('Лазеры: блок на строке «Лазеры» — двойной клик, чтобы изменить');
    }
    editor.finishTrying(keep);
    shade.remove();
    window.removeEventListener('keydown', keys, true);
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
  update();
}
