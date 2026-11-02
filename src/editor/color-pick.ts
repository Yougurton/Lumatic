import type { Rgb } from './model';

/**
 * A colour of one's own picked in a window of the editor's (the system's colour dialog, with its
 * magnifier taking the cursor's place, isn't used): a square of saturation and brightness, a strip of
 * hues, the hex code; a pipette that takes a colour off anywhere on the screen (a magnifier beside the
 * cursor); the map's palette — the colour kept in it, a kept one put on with a click (a right click
 * takes it out), another map's palette brought in.
 */

export interface ColorPickOptions {
  /** The map's palette as it is now. */
  palette: () => Rgb[];
  setPalette: (colors: Rgb[]) => void;
  /** The colour picked (put on). */
  apply: (rgb: Rgb) => void;
}

export function toHex(rgb: Rgb) {
  return `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function fromHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/iu.exec(hex.trim());
  if (match === null) return null;
  const text = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join('') : match[1]!;
  return [0, 2, 4].map((k) => parseInt(text.slice(k, k + 2), 16) / 255) as Rgb;
}

function toHsv([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function fromHsv(h: number, s: number, v: number): Rgb {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** A colour off anywhere on the screen (the desktop app: its own magnifier beside the cursor; a
 *  browser: its own pipette, where it has one). Null: given up / can't. */
export async function pickFromScreen(): Promise<Rgb | null> {
  const native = window.chroeditorNative;
  if (native?.pickScreenColor !== undefined) {
    const picked = await native.pickScreenColor();
    return picked === null ? null : (picked.map((v) => v / 255) as Rgb);
  }
  const Dropper = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (Dropper === undefined) return null;
  try {
    return fromHex((await new Dropper().open()).sRGBHex);
  } catch {
    return null;
  }
}

/** Another map's palette brought into this one's (the colours not in it yet added). */
export async function importPalette(current: readonly Rgb[]): Promise<{ colors: Rgb[]; added: number; name: string } | null> {
  const native = window.chroeditorNative;
  if (native?.paletteFromMap === undefined) return null;
  const found = await native.paletteFromMap();
  if (found === null) return null;
  const colors = [...current];
  let added = 0;
  for (const raw of found.colors) {
    const rgb = raw.slice(0, 3).map((v) => Math.min(1, Math.max(0, v))) as Rgb;
    if (colors.some((item) => toHex(item) === toHex(rgb))) continue;
    colors.push(rgb);
    added++;
  }
  return { colors, added, name: found.name };
}

let openPopup: { element: HTMLElement; close: () => void } | null = null;

/** The pick, by `anchor` (one at a time: opened again, the one before closes). */
export function openColorPick(anchor: HTMLElement, start: Rgb, options: ColorPickOptions) {
  openPopup?.close();
  let [hue, sat, val] = toHsv(start);
  const box = document.createElement('div');
  box.className = 'cp-box';
  box.innerHTML = `
    <canvas class="cp-sv" width="240" height="150"></canvas>
    <canvas class="cp-hue" width="240" height="14"></canvas>
    <div class="cp-row"><span class="cp-preview"></span><input class="cp-hex" spellcheck="false"><button type="button" class="cp-drop" title="Пипетка: цвет с любого места экрана (Esc — отмена)">💧 Пипетка</button></div>
    <div class="cp-title"><span>Палитра карты</span><button type="button" class="cp-add" title="Сохранить этот цвет в палитру карты">＋ В палитру</button></div>
    <div class="cp-palette"></div>
    <div class="cp-foot"><button type="button" class="cp-import" title="Добавить цвета палитры другой карты">Импорт из карты…</button><button type="button" class="cp-close">Готово</button></div>`;
  document.body.append(box);
  const sv = box.querySelector<HTMLCanvasElement>('.cp-sv')!;
  const hueBar = box.querySelector<HTMLCanvasElement>('.cp-hue')!;
  const preview = box.querySelector<HTMLElement>('.cp-preview')!;
  const hex = box.querySelector<HTMLInputElement>('.cp-hex')!;
  const paletteRow = box.querySelector<HTMLElement>('.cp-palette')!;
  const current = () => fromHsv(hue, sat, val);
  const draw = () => {
    const ctx = sv.getContext('2d')!;
    const base = fromHsv(hue, 1, 1);
    ctx.fillStyle = toHex(base);
    ctx.fillRect(0, 0, sv.width, sv.height);
    const white = ctx.createLinearGradient(0, 0, sv.width, 0);
    white.addColorStop(0, '#fff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, sv.width, sv.height);
    const black = ctx.createLinearGradient(0, 0, 0, sv.height);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000');
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, sv.width, sv.height);
    ctx.strokeStyle = val > 0.5 ? '#000' : '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sat * sv.width, (1 - val) * sv.height, 6, 0, Math.PI * 2);
    ctx.stroke();
    const hctx = hueBar.getContext('2d')!;
    const strip = hctx.createLinearGradient(0, 0, hueBar.width, 0);
    for (let k = 0; k <= 6; k++) strip.addColorStop(k / 6, toHex(fromHsv((k * 60) % 360, 1, 1)));
    hctx.fillStyle = strip;
    hctx.fillRect(0, 0, hueBar.width, hueBar.height);
    hctx.fillStyle = '#fff';
    hctx.fillRect((hue / 360) * hueBar.width - 1.5, 0, 3, hueBar.height);
    preview.style.background = toHex(current());
    if (document.activeElement !== hex) hex.value = toHex(current()).toUpperCase();
  };
  const set = (rgb: Rgb, apply = true) => {
    const [h, s, v] = toHsv(rgb);
    // (a grey keeps the hue it had)
    if (s > 1e-6 && v > 1e-6) hue = h;
    sat = s;
    val = v;
    draw();
    if (apply) options.apply(rgb);
  };
  const drawPalette = () => {
    paletteRow.replaceChildren();
    const list = options.palette();
    if (list.length === 0) paletteRow.append(Object.assign(document.createElement('span'), { className: 'cp-empty', textContent: 'Пока пусто: «＋ В палитру» сохранит цвет в эту карту' }));
    list.forEach((rgb, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cp-chip';
      chip.style.background = toHex(rgb);
      chip.title = `${toHex(rgb).toUpperCase()} — клик: поставить, ПКМ: убрать из палитры`;
      chip.addEventListener('click', () => set(rgb));
      chip.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        options.setPalette(options.palette().filter((_, k) => k !== index));
        drawPalette();
      });
      paletteRow.append(chip);
    });
  };
  // dragging in the square or along the hues: shown as it goes, put on when let go
  const drag = (canvas: HTMLCanvasElement, at: (x: number, y: number) => void) => {
    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      const place = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        at(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)));
        draw();
      };
      place(event);
      const move = (e: PointerEvent) => place(e);
      const up = () => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        options.apply(current());
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
    });
  };
  drag(sv, (x, y) => {
    sat = x;
    val = 1 - y;
  });
  drag(hueBar, (x) => (hue = Math.min(359.9, x * 360)));
  hex.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      const rgb = fromHex(hex.value);
      if (rgb !== null) set(rgb);
      hex.blur();
    } else if (event.key === 'Escape') close();
  });
  hex.addEventListener('change', () => {
    const rgb = fromHex(hex.value);
    if (rgb !== null) set(rgb);
  });
  box.querySelector('.cp-drop')!.addEventListener('click', () => {
    void pickFromScreen().then((rgb) => {
      if (rgb !== null) set(rgb);
    });
  });
  box.querySelector('.cp-add')!.addEventListener('click', () => {
    const rgb = current();
    const list = options.palette();
    if (!list.some((item) => toHex(item) === toHex(rgb))) options.setPalette([...list, rgb]);
    drawPalette();
  });
  const importButton = box.querySelector<HTMLButtonElement>('.cp-import')!;
  importButton.hidden = window.chroeditorNative?.paletteFromMap === undefined;
  importButton.addEventListener('click', () => {
    void importPalette(options.palette()).then((result) => {
      if (result === null) return;
      options.setPalette(result.colors);
      drawPalette();
      importButton.textContent = result.added > 0 ? `Добавлено цветов: ${String(result.added)}` : 'Новых цветов там нет';
    });
  });
  box.querySelector('.cp-close')!.addEventListener('click', () => close());
  // by the anchor, kept on the screen
  const rect = anchor.getBoundingClientRect();
  const width = box.offsetWidth;
  const height = box.offsetHeight;
  box.style.left = `${String(Math.max(6, Math.min(window.innerWidth - width - 6, rect.right - width)))}px`;
  box.style.top = `${String(rect.bottom + height + 6 < window.innerHeight ? rect.bottom + 4 : Math.max(6, rect.top - height - 4))}px`;
  const outside = (event: MouseEvent) => {
    if (!box.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !box.isConnected) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  };
  function close() {
    box.remove();
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', escape, true);
    if (openPopup?.element === box) openPopup = null;
  }
  setTimeout(() => window.addEventListener('mousedown', outside, true));
  window.addEventListener('keydown', escape, true);
  openPopup = { element: box, close };
  draw();
  drawPalette();
}
