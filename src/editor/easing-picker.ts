import { easingFromName, type EasingFunction } from '../engine/core/easing';
import { translate } from './i18n';

/**
 * A pick of an easing that shows what it does: the list's items each with a small curve, and while
 * the mouse is over one (or over the pick itself) a card by the cursor — the curve as on easings.net
 * with a dot running along it, and a ring beside it turning the same way.
 */

/** How a Chroma easing (by its name) goes from 0 to 1; '' — the game's own ring motion (a fast start,
 *  closing in slower and slower). */
export function easingCurve(name: string): EasingFunction {
  if (name === '') return (t) => (1 - Math.exp(-5 * t)) / (1 - Math.exp(-5));
  if (name === 'easeStep') return (t) => (t < 1 ? 0 : 1);
  return easingFromName(name);
}

/** A curve drawn in a box (x: time, y: the value; 0…1 between the lines, room for over- and undershoot). */
function drawCurve(ctx: CanvasRenderingContext2D, curve: EasingFunction, x: number, y: number, width: number, height: number, line: number) {
  const top = y + height * 0.2;
  const bottom = y + height * 0.8;
  const toY = (value: number) => bottom - value * (bottom - top);
  ctx.beginPath();
  for (let k = 0; k <= 60; k++) {
    const t = k / 60;
    const px = x + t * width;
    const py = toY(curve(t));
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.lineWidth = line;
  ctx.stroke();
  return toY;
}

function icon(curve: EasingFunction) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ep-icon';
  const ratio = window.devicePixelRatio || 1;
  canvas.width = 30 * ratio;
  canvas.height = 20 * ratio;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.strokeStyle = '#b78cff';
  drawCurve(ctx, curve, 2, 0, 26, 20, 1.5);
  return canvas;
}

/** The card by the cursor: the curve, a dot running along it, a ring turning with it. */
let card: { element: HTMLCanvasElement; key: string; frame: number } | null = null;

function showCard(name: string, label: string, curve: EasingFunction, clientX: number, clientY: number) {
  const width = 300;
  const height = 150;
  if (card === null || card.key !== name) {
    hideCard();
    const element = document.createElement('canvas');
    element.className = 'ep-card';
    const ratio = window.devicePixelRatio || 1;
    element.width = width * ratio;
    element.height = height * ratio;
    element.style.width = `${String(width)}px`;
    element.style.height = `${String(height)}px`;
    document.body.append(element);
    const started = performance.now();
    const ctx = element.getContext('2d')!;
    const draw = () => {
      if (card?.element !== element) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = '#16171d';
      ctx.fillRect(0, 0, width, height);
      // (1.4 s along the curve, then a moment's rest at its end)
      const cycle = ((performance.now() - started) / 1000) % 1.9;
      const t = Math.min(1, cycle / 1.4);
      const value = curve(t);
      // the graph
      const gx = 12;
      const gw = 160;
      const gy = 22;
      const gh = height - 30;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(gx + 0.5, gy + gh * 0.2 + 0.5, gw, gh * 0.6);
      ctx.strokeStyle = '#b78cff';
      const toY = drawCurve(ctx, curve, gx, gy, gw, gh, 2);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(gx + t * gw, toY(value), 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#d6d9e4';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(translate(label), 12, 15);
      // the ring, turned by the value (a quarter turn)
      const cx = gx + gw + 64;
      const cy = gy + gh / 2;
      const size = 34;
      ctx.save();
      ctx.translate(cx, cy);
      // (where it starts and where it ends, faint; a long ring so its turn shows)
      ctx.strokeStyle = 'rgba(183,140,255,0.22)';
      ctx.lineWidth = 2;
      ctx.strokeRect(-size, -size * 0.45, size * 2, size * 0.9);
      ctx.strokeRect(-size * 0.45, -size, size * 0.9, size * 2);
      ctx.rotate(-(value * Math.PI) / 2);
      ctx.strokeStyle = '#d7b8ff';
      ctx.lineWidth = 4;
      ctx.strokeRect(-size, -size * 0.45, size * 2, size * 0.9);
      ctx.restore();
      card.frame = requestAnimationFrame(draw);
    };
    card = { element, key: name, frame: requestAnimationFrame(draw) };
  }
  // by the cursor, kept on the screen
  const left = clientX + 18 + width > window.innerWidth ? clientX - width - 14 : clientX + 18;
  const top = Math.min(window.innerHeight - height - 6, Math.max(6, clientY - height / 2));
  card.element.style.left = `${String(Math.max(6, left))}px`;
  card.element.style.top = `${String(top)}px`;
}

function hideCard() {
  if (card === null) return;
  cancelAnimationFrame(card.frame);
  card.element.remove();
  card = null;
}

/** `curve`: how each option's value eases (Chroma names by default). */
export function easingPicker<T extends string>(options: [T, string][], current: T, change: (value: T) => void, curve: (value: T) => EasingFunction = easingCurve): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ep-wrap';
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'ep-pick';
  const label = options.find(([value]) => value === current)?.[1] ?? current;
  pick.append(icon(curve(current)), Object.assign(document.createElement('span'), { textContent: label }), Object.assign(document.createElement('span'), { className: 'ep-arrow', textContent: '▾' }));
  wrap.append(pick);
  const hover = (element: HTMLElement, value: T, text: string) => {
    element.addEventListener('mousemove', (event) => showCard(value, text, curve(value), event.clientX, event.clientY));
    element.addEventListener('mouseleave', hideCard);
  };
  hover(pick, current, label);
  let list: HTMLElement | null = null;
  const close = () => {
    list?.remove();
    list = null;
    hideCard();
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', escape, true);
  };
  const outside = (event: MouseEvent) => {
    if (list !== null && !list.contains(event.target as Node) && !pick.contains(event.target as Node)) close();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  };
  pick.addEventListener('click', () => {
    if (list !== null) {
      close();
      return;
    }
    hideCard();
    list = document.createElement('div');
    list.className = 'ep-list';
    for (const [value, text] of options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `ep-item${value === current ? ' active' : ''}`;
      item.append(icon(curve(value)), Object.assign(document.createElement('span'), { textContent: text }));
      hover(item, value, text);
      item.addEventListener('click', () => {
        close();
        if (value !== current) change(value);
      });
      list.append(item);
    }
    document.body.append(list);
    // under the pick (above it when there's no room), as wide as it at least
    const rect = pick.getBoundingClientRect();
    list.style.minWidth = `${String(rect.width)}px`;
    list.style.left = `${String(Math.min(rect.left, window.innerWidth - list.offsetWidth - 6))}px`;
    const below = window.innerHeight - rect.bottom;
    if (below >= list.offsetHeight + 6 || below >= rect.top) list.style.top = `${String(rect.bottom + 2)}px`;
    else list.style.top = `${String(Math.max(6, rect.top - list.offsetHeight - 2))}px`;
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('keydown', escape, true);
  });
  // (the pick taken off the page — the panel drawn again: nothing of it left behind)
  let shown = false;
  new MutationObserver((_, observer) => {
    if (wrap.isConnected) {
      shown = true;
      return;
    }
    if (!shown) return;
    if (list !== null) close();
    else hideCard();
    observer.disconnect();
  }).observe(document.body, { childList: true, subtree: true });
  return wrap;
}
