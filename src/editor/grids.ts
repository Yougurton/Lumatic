/** The grids beats are put on: halves down to 1/64, then the triplets (and none at all). */
export const GRIDS: [number, string][] = [
  [1, '1'],
  [0.5, '1/2'],
  [0.25, '1/4'],
  [0.125, '1/8'],
  [0.0625, '1/16'],
  [0.03125, '1/32'],
  [0.015625, '1/64'],
  [1 / 3, '1/3'],
  [1 / 6, '1/6'],
  [1 / 12, '1/12'],
  [1 / 24, '1/24'],
  [1 / 48, '1/48'],
  [0, 'без сетки'],
];

/** The next grid finer or coarser — among the halves, or among the triplets when it is one. */
export function nextGrid(current: number, finer: boolean): number {
  const triplet = current > 0 && Math.abs(Math.log2(current) - Math.round(Math.log2(current))) > 1e-6;
  const family = GRIDS.map(([value]) => value).filter((value) => value > 0 && (Math.abs(Math.log2(value) - Math.round(Math.log2(value))) > 1e-6) === triplet);
  const at = family.findIndex((value) => Math.abs(value - current) < 1e-9);
  return family[Math.min(family.length - 1, Math.max(0, (at < 0 ? family.indexOf(0.25) : at) + (finer ? 1 : -1)))]!;
}

// ----- what the wheel turns: a drum or a slider picked a moment ago -------------------------------------

/** The control picked last (its key) and until when the wheel still turns it: 5 s after it was last
 *  touched — and through its panel being drawn again (the new one has the same key). A click anywhere
 *  else lets it go. */
let active: { key: string; until: number } | null = null;
const ACTIVE_MS = 5000;
const activeListeners = new Set<() => void>();

export function markActive(key: string) {
  active = { key, until: performance.now() + ACTIVE_MS };
  for (const listener of activeListeners) listener();
}

export function isActive(key: string) {
  return active !== null && active.key === key && performance.now() < active.until;
}

window.addEventListener(
  'mousedown',
  (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-wheel-key]') : null;
    if (active !== null && target?.dataset.wheelKey !== active.key) {
      active = null;
      for (const listener of activeListeners) listener();
    }
  },
  true,
);
window.setInterval(() => {
  if (active !== null && performance.now() >= active.until) {
    active = null;
    for (const listener of activeListeners) listener();
  }
}, 250);

/** `element` shown as picked while it's the active one (the class `wheel-active`). */
function showActive(element: HTMLElement, key: string) {
  const update = () => {
    if (!element.isConnected) {
      activeListeners.delete(update);
      return;
    }
    element.classList.toggle('wheel-active', isActive(key));
  };
  activeListeners.add(update);
  requestAnimationFrame(update);
}

/**
 * The wheel over a range slider while it's the active one (5 s after it was last touched): a step per
 * notch — `input` as it goes, `commit` once the wheel rests.
 */
export function wheelSlider(range: HTMLInputElement, key: string, input: (value: number) => void, commit: (value: number) => void, notch = Number(range.step) || 1) {
  range.dataset.wheelKey = key;
  showActive(range, key);
  let timer = 0;
  range.addEventListener('pointerdown', () => markActive(key));
  range.addEventListener('input', () => markActive(key));
  range.addEventListener(
    'wheel',
    (event) => {
      if (!isActive(key)) return;
      event.preventDefault();
      const step = notch;
      const next = Math.min(Number(range.max), Math.max(Number(range.min), Number(range.value) + ((event.deltaY !== 0 ? event.deltaY : event.deltaX) > 0 ? -step : step)));
      range.value = String(next);
      markActive(key);
      input(next);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => commit(next), 400);
    },
    { passive: false },
  );
}

// ----- drums --------------------------------------------------------------------------------------------

/** A drum's typed-in number: its keys are its own — taken before any window's (the ring and GLS
 *  editors', the hotkeys) can, Enter and Escape finishing it. (Set up first, as the module loads:
 *  window listeners run in the order they were added.) */
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.classList.contains('drum-input')) return;
      event.stopImmediatePropagation();
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault();
      target.dispatchEvent(new CustomEvent('drum-finish', { detail: event.key === 'Enter' }));
    },
    true,
  );
}

/** The step of a drum of beats: the grid's (no grid: quarters); other values typed in. */
export function beatDrumStep(grid: number) {
  return grid > 0 ? Math.max(1 / 64, grid) : 1 / 4;
}

/**
 * A grid step to pick (beats): a horizontal drum with the steps on its rim, largest to smallest
 * (triplets among them) — `longer`: steps of several beats too; `none`: a first choice that is no step
 * at all (0). `name`: what it is (tells it from other drums on the panel).
 */
export function gridSelect(value: number, change: (value: number) => void, longer: number[] = [], none: string | null = null, name = ''): HTMLElement {
  const options: [number, string][] = [
    ...(none === null ? [] : [[0, none] as [number, string]]),
    ...[...[...longer].map((beats): [number, string] => [beats, String(beats)]), ...GRIDS.filter(([beats]) => beats > 0)].sort((a, b) => b[0] - a[0]),
  ];
  // (a value none of them has — made before — is shown as it is, in its place)
  if (!options.some(([beats]) => Math.abs(beats - value) < 1e-6)) {
    options.push([value, String(Math.round(value * 10000) / 10000)]);
    options.sort((a, b) => (a[0] === 0 ? -1 : b[0] === 0 ? 1 : b[0] - a[0]));
  }
  return drum({
    key: `grid:${name}:${options.map(([, label]) => label).join('|')}`,
    count: options.length,
    label: (index) => options[index]![1],
    initial: options.findIndex(([beats]) => Math.abs(beats - value) < 1e-6),
    change: (index) => change(options[index]![0]),
    typed: (text) => {
      const beats = parseNumber(text);
      if (beats !== null && beats >= 0) change(beats);
    },
  });
}

/**
 * A number to pick on a drum: `value` and its neighbours `step` apart on the rim (from `min`, up to
 * `max`); a number can be typed in too (a double click, or digits while it's picked).
 */
/** Beats as people write them: 3/4, 1 1/2, 0.3 (a fraction when it is one of the grid's) —
 *  `denominator`: in that many parts of a beat, not reduced (eighths: 2/8, 4/8, 1 6/8). */
export function beatsLabel(beats: number, denominator?: number) {
  if (denominator !== undefined && denominator > 1) {
    const parts = Math.round(beats * denominator);
    if (Math.abs(beats * denominator - parts) < 1e-6) {
      const whole = Math.floor(parts / denominator);
      const rest = parts - whole * denominator;
      if (rest === 0) return String(whole);
      return `${whole > 0 ? `${String(whole)} ` : ''}${String(rest)}/${String(denominator)}`;
    }
  }
  const whole = Math.floor(beats + 1e-9);
  const rest = beats - whole;
  if (rest < 1e-6) return String(whole);
  for (const denominator of [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]) {
    const numerator = Math.round(rest * denominator);
    if (Math.abs(rest * denominator - numerator) < 1e-6) return `${whole > 0 ? `${String(whole)} ` : ''}${String(numerator)}/${String(denominator)}`;
  }
  return String(Math.round(beats * 1000) / 1000).replace('.', ',');
}

export function numberDrum(name: string, value: number, change: (value: number) => void, options: { step: number; min?: number; max?: number; digits?: number; beats?: boolean } = { step: 1 }): HTMLElement {
  const step = options.step;
  const min = options.min ?? 0;
  const max = options.max ?? Math.max(value, min) + step * 400;
  // (beats: kept exact enough to be shown as the fractions they are — 15/16, not 0,938)
  const digits = options.digits ?? (options.beats === true ? 9 : 3);
  const count = Math.max(1, Math.floor((max - min) / step + 1e-6) + 1);
  const valueAt = (index: number) => Math.round((min + index * step) * 10 ** digits) / 10 ** digits;
  // (beats in the grid's parts, not reduced: a step of 1/8 — 2/8, 4/8…)
  const parts = Math.round(1 / step);
  const denominator = options.beats === true && step < 1 && Math.abs(1 / step - parts) < 1e-6 ? parts : undefined;
  const format = (number: number) => (options.beats === true ? beatsLabel(number, denominator) : String(Math.round(number * 10 ** digits) / 10 ** digits).replace('.', ','));
  // (a value off the steps: shown as it is, where it falls)
  const offStep = Math.abs((value - min) / step - Math.round((value - min) / step)) > 1e-6;
  const initial = Math.max(0, Math.min(count - 1, Math.round((value - min) / step)));
  return drum({
    key: `number:${name}`,
    count,
    label: (index) => (offStep && index === initial ? format(value) : format(valueAt(index))),
    initial,
    change: (index) => change(valueAt(index)),
    typed: (text) => {
      const number = parseNumber(text);
      if (number !== null) change(Math.min(options.max ?? Infinity, Math.max(min, number)));
    },
  });
}

/** A number typed in: 0.75, 0,75, 3/4, 1 1/2. */
function parseNumber(text: string): number | null {
  const match = /^\s*(?:(\d+)\s+)?(\d+(?:[.,]\d+)?)\s*(?:\/\s*(\d+(?:[.,]\d+)?))?\s*$/u.exec(text);
  if (match === null) {
    const plain = Number(text.replace(',', '.'));
    return Number.isFinite(plain) ? plain : null;
  }
  const whole = match[1] === undefined ? 0 : Number(match[1]);
  const value = Number(match[2]!.replace(',', '.')) / (match[3] === undefined ? 1 : Number(match[3].replace(',', '.')));
  return Number.isFinite(value) ? whole + value : null;
}

interface DrumSpec {
  /** Tells it from the other drums: drawn again, the one with the same key stays the picked one. */
  key: string;
  count: number;
  label: (index: number) => string;
  initial: number;
  /** The index picked, once the drum stands still. */
  change: (index: number) => void;
  /** A number typed in (none: it can't be). */
  typed?: (text: string) => void;
}

/** A horizontal drum: labels on its rim (only the ones in sight made), the middle one picked. Turned by
 *  dragging (a swipe spins it on), by the wheel while it's picked (5 s after it was last touched), by
 *  the arrow keys; a click on a label brings it to the middle; a double click (or digits) types a
 *  number in. */
export function drum(spec: DrumSpec): HTMLElement {
  const { key, count } = spec;
  const root = document.createElement('div');
  root.className = 'drum';
  root.tabIndex = 0;
  root.dataset.wheelKey = key;
  root.setAttribute('role', 'slider');
  root.title = spec.typed === undefined ? 'Тяните или крутите колесом (кликните — и колесо 5 с крутит барабан); ← → — на шаг' : 'Тяните или крутите колесом (кликните — и колесо 5 с крутит барабан); ← → — на шаг; двойной клик или цифры — вписать число';
  const rim = document.createElement('div');
  rim.className = 'drum-rim';
  const window_ = document.createElement('div');
  window_.className = 'drum-window';
  root.append(rim, window_);
  showActive(root, key);

  // the angle from one label to the next (radians): wide enough that the middle one's neighbours clear it
  let STEP = 0.46;
  const last = count - 1;
  let pos = Math.max(0, Math.min(last, spec.initial));
  let target = pos;
  let committed = Math.round(pos);
  let frame = 0;
  let settleTimer = 0;
  const radius = () => Math.max(40, root.clientWidth * 0.46);
  const shown = new Map<number, HTMLSpanElement>();

  const layout = () => {
    const width = root.clientWidth;
    const r = radius();
    const middle = shown.get(Math.round(pos));
    if (middle !== undefined && middle.offsetWidth > 0) STEP = Math.min(0.95, Math.max(0.46, Math.asin(Math.min(0.97, (middle.offsetWidth * 0.62 + 22) / r))));
    const reach = Math.ceil(Math.PI / 2 / STEP);
    const centre = Math.round(pos);
    // (the labels in sight made, the others taken away: a long rim stays light)
    for (const [index, item] of shown) {
      if (Math.abs(index - pos) > reach + 1) {
        item.remove();
        shown.delete(index);
      }
    }
    for (let index = Math.max(0, centre - reach - 1); index <= Math.min(last, centre + reach + 1); index++) {
      let item = shown.get(index);
      if (item === undefined) {
        item = document.createElement('span');
        item.className = 'drum-item';
        item.textContent = spec.label(index);
        rim.append(item);
        shown.set(index, item);
      }
      const angle = (index - pos) * STEP;
      if (Math.abs(angle) >= Math.PI / 2 - 0.05) {
        item.style.visibility = 'hidden';
        continue;
      }
      const c = Math.cos(angle);
      item.style.visibility = '';
      item.style.transform = `translate(${String(width / 2 + r * Math.sin(angle))}px, -50%) translateX(-50%) scale(${String(0.55 + 0.45 * c)}, ${String(0.75 + 0.25 * c)})`;
      item.style.opacity = String(Math.max(0, c ** 3));
      item.classList.toggle('current', centre === index);
    }
    root.setAttribute('aria-valuetext', spec.label(centre));
    // (the window as wide as the label in it)
    const current = shown.get(centre);
    if (current !== undefined) window_.style.width = `${String(Math.max(54, current.offsetWidth + 18))}px`;
  };
  const commit = () => {
    const index = Math.round(target);
    if (index === committed) return;
    committed = index;
    spec.change(index);
  };
  const animate = () => {
    frame = 0;
    pos += (target - pos) * 0.35;
    if (Math.abs(target - pos) < 0.01) pos = target;
    layout();
    if (pos !== target) frame = requestAnimationFrame(animate);
    else {
      // (picked once it stands still a moment: a few wheel notches are one change)
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(commit, 160);
    }
  };
  const go = (next: number) => {
    target = Math.max(0, Math.min(last, Math.round(next)));
    markActive(key);
    window.clearTimeout(settleTimer);
    if (frame === 0) frame = requestAnimationFrame(animate);
  };

  // typing a number in: a field over the window
  const type = (first = '') => {
    if (spec.typed === undefined || root.querySelector('input') !== null) return;
    const input = document.createElement('input');
    input.className = 'drum-input';
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = first === '' ? spec.label(Math.round(pos)) : first;
    root.append(input);
    input.focus();
    if (first === '') input.select();
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const text = input.value;
      input.remove();
      if (keep && text.trim() !== '') spec.typed!(text);
    };
    input.addEventListener('drum-finish', (event) => finish((event as CustomEvent<boolean>).detail));
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
  };

  root.addEventListener(
    'wheel',
    (event) => {
      if (document.activeElement !== root && !isActive(key)) return;
      event.preventDefault();
      go(target + ((event.deltaY !== 0 ? event.deltaY : event.deltaX) > 0 ? 1 : -1));
    },
    { passive: false },
  );
  root.addEventListener('keydown', (event) => {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (event.key in steps) go(target + steps[event.key]!);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(last);
    else if (event.key === 'Enter') type();
    else if (/^[\d.,/]$/u.test(event.key) && spec.typed !== undefined) type(event.key);
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  root.addEventListener('dblclick', () => type());
  root.addEventListener('pointerdown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    root.focus();
    markActive(key);
    root.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startPos = pos;
    let moved = false;
    let lastX = startX;
    let lastTime = performance.now();
    let velocity = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    const move = (next: PointerEvent) => {
      const dx = next.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const now = performance.now();
      velocity = (next.clientX - lastX) / Math.max(1, now - lastTime);
      lastX = next.clientX;
      lastTime = now;
      // (dragged left: the labels further along come to the middle)
      pos = Math.max(-0.4, Math.min(last + 0.4, startPos - dx / (radius() * STEP)));
      target = pos;
      layout();
    };
    const up = (next: PointerEvent) => {
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', up);
      if (moved) {
        // a swipe spins it on a little
        go(pos - (velocity * 140) / (radius() * STEP));
        return;
      }
      // a click on a label: that one to the middle
      const rect = root.getBoundingClientRect();
      const offset = Math.max(-0.99, Math.min(0.99, (next.clientX - rect.left - rect.width / 2) / radius()));
      const steps = Math.round(Math.asin(offset) / STEP);
      if (steps !== 0) go(pos + steps);
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
  });
  requestAnimationFrame(() => {
    layout();
    // (drawn again while it was the picked one: it has the keys again)
    if (isActive(key) && root.isConnected && (document.activeElement === document.body || document.activeElement === null)) root.focus({ preventScroll: true });
  });
  new ResizeObserver(() => layout()).observe(root);
  return root;
}

/** Ogg Vorbis qualities offered: the setting and about how many kbit/s it is for a stereo song. */
export const OGG_QUALITIES: [number, string][] = [
  [3, '3 · ~112 кбит/с'],
  [4, '4 · ~128 кбит/с'],
  [5, '5 · ~160 кбит/с'],
  [6, '6 · ~192 кбит/с'],
  [7, '7 · ~224 кбит/с'],
  [8, '8 · ~256 кбит/с'],
  [9, '9 · ~320 кбит/с'],
  [10, '10 · ~500 кбит/с'],
];

/** A slider for the Ogg quality (with about how many kbit/s it is). */
export function oggQualitySlider(value: number, change: (value: number) => void) {
  const wrap = document.createElement('span');
  wrap.className = 'ogg-slider';
  const input = Object.assign(document.createElement('input'), { type: 'range', min: '3', max: '10', step: '1', value: String(Math.min(10, Math.max(3, Math.round(value)))) });
  const shown = Object.assign(document.createElement('span'), { className: 'ins-value' });
  const label = () => (shown.textContent = OGG_QUALITIES.find(([quality]) => quality === Number(input.value))?.[1] ?? input.value);
  label();
  input.addEventListener('input', label);
  input.addEventListener('change', () => change(Number(input.value)));
  wrap.append(input, shown);
  return wrap;
}
