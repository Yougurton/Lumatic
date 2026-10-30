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

/** The drum focused last (its options): drawn again, a drum with the same options takes the focus back
 *  — the wheel goes on turning it. */
let focusedDrum: string | null = null;

/**
 * A grid step to pick (beats): a horizontal drum with the steps on its rim, largest to smallest
 * (triplets among them) — `longer`: steps of several beats too; `none`: a first choice that is no step
 * at all (0). The one in the middle is the one picked. Turned by dragging (a swipe spins it on), by the
 * wheel while it has the focus, by the arrow keys; a click on a step brings it to the middle.
 */
export function gridSelect(value: number, change: (value: number) => void, longer: number[] = [], none: string | null = null): HTMLElement {
  const options: [number, string][] = [
    ...(none === null ? [] : [[0, none] as [number, string]]),
    ...[...[...longer].map((beats): [number, string] => [beats, String(beats)]), ...GRIDS.filter(([beats]) => beats > 0)].sort((a, b) => b[0] - a[0]),
  ];
  // (a value none of them has — made before — is shown as it is, in its place)
  if (!options.some(([beats]) => Math.abs(beats - value) < 1e-6)) {
    options.push([value, String(Math.round(value * 10000) / 10000)]);
    options.sort((a, b) => (a[0] === 0 ? -1 : b[0] === 0 ? 1 : b[0] - a[0]));
  }
  return drum(options, options.findIndex(([beats]) => Math.abs(beats - value) < 1e-6), (index) => change(options[index]![0]));
}

/** A horizontal drum of `options` ([value, label]); `change` gets the index picked once it settles. */
export function drum(options: [number, string][], initial: number, change: (index: number) => void): HTMLElement {
  const key = options.map(([, label]) => label).join('|');
  const root = document.createElement('div');
  root.className = 'drum';
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.title = 'Тяните или крутите колесом (кликните, чтобы колесо крутило барабан); ← → — на шаг';
  const rim = document.createElement('div');
  rim.className = 'drum-rim';
  const items = options.map(([, label]) => {
    const item = document.createElement('span');
    item.className = 'drum-item';
    item.textContent = label;
    rim.append(item);
    return item;
  });
  const window_ = document.createElement('div');
  window_.className = 'drum-window';
  root.append(rim, window_);

  const STEP = 0.46; // the angle from one step to the next (radians)
  let pos = Math.max(0, initial);
  let target = pos;
  let committed = Math.round(pos);
  let frame = 0;
  let settleTimer = 0;
  const last = options.length - 1;
  const radius = () => Math.max(40, root.clientWidth * 0.46);

  const layout = () => {
    const width = root.clientWidth;
    const r = radius();
    items.forEach((item, index) => {
      const angle = (index - pos) * STEP;
      if (Math.abs(angle) >= Math.PI / 2 - 0.05) {
        item.style.visibility = 'hidden';
        return;
      }
      const c = Math.cos(angle);
      item.style.visibility = '';
      item.style.transform = `translate(${String(width / 2 + r * Math.sin(angle))}px, -50%) translateX(-50%) scale(${String(0.55 + 0.45 * c)}, ${String(0.75 + 0.25 * c)})`;
      item.style.opacity = String(Math.max(0, c ** 3));
      item.classList.toggle('current', Math.round(pos) === index);
    });
    root.setAttribute('aria-valuetext', options[Math.round(pos)]?.[1] ?? '');
    // (the window as wide as the step in it)
    const current = items[Math.max(0, Math.min(last, Math.round(pos)))];
    if (current !== undefined) window_.style.width = `${String(Math.max(54, current.offsetWidth + 18))}px`;
  };
  const commit = () => {
    const index = Math.round(target);
    if (index === committed) return;
    committed = index;
    change(index);
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
    window.clearTimeout(settleTimer);
    if (frame === 0) frame = requestAnimationFrame(animate);
  };

  root.addEventListener(
    'wheel',
    (event) => {
      if (document.activeElement !== root) return;
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
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  root.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    root.focus();
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
      // (dragged left: the steps further along come to the middle)
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
      // a click on a step: that one to the middle
      const rect = root.getBoundingClientRect();
      const offset = Math.max(-0.99, Math.min(0.99, (next.clientX - rect.left - rect.width / 2) / radius()));
      go(pos + Math.asin(offset) / STEP);
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
  });
  root.addEventListener('focus', () => (focusedDrum = key));
  root.addEventListener('blur', () => {
    // (left by the user — not taken away by the panel being drawn again)
    if (root.isConnected) focusedDrum = null;
  });
  requestAnimationFrame(() => {
    layout();
    if (focusedDrum === key && root.isConnected && document.activeElement === document.body) root.focus({ preventScroll: true });
  });
  new ResizeObserver(() => layout()).observe(root);
  return root;
}
