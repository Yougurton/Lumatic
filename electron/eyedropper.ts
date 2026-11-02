import { BrowserWindow, desktopCapturer, screen } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A colour picked anywhere on the screen: the screen under the mouse taken as it is, shown over
 * everything in a window of its own (the cursor stays a cursor), a magnifier beside it showing the
 * pixels round its tip; a click takes the colour there, Escape or a right click gives up.
 */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;cursor:crosshair;background:#000}
#shot{position:fixed;inset:0;width:100%;height:100%;image-rendering:pixelated}
#loupe{position:fixed;width:154px;height:184px;pointer-events:none;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.6)}
</style></head><body><canvas id="shot"></canvas><canvas id="loupe" width="308" height="368"></canvas><script>
const img = new Image();
const shot = document.getElementById('shot');
const loupe = document.getElementById('loupe');
const lctx = loupe.getContext('2d');
let data = null, iw = 0, ih = 0;
img.onload = () => {
  iw = img.naturalWidth; ih = img.naturalHeight;
  shot.width = iw; shot.height = ih;
  const ctx = shot.getContext('2d');
  ctx.drawImage(img, 0, 0);
  data = ctx.getImageData(0, 0, iw, ih).data;
  document.title = 'ready';
};
img.src = 'data:image/png;base64,__SHOT__';
const at = (x, y) => {
  const px = Math.min(iw - 1, Math.max(0, Math.floor(x * iw / innerWidth)));
  const py = Math.min(ih - 1, Math.max(0, Math.floor(y * ih / innerHeight)));
  const k = (py * iw + px) * 4;
  return [data[k], data[k + 1], data[k + 2], px, py];
};
const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
addEventListener('mousemove', (e) => {
  if (!data) return;
  const [r, g, b, px, py] = at(e.clientX, e.clientY);
  // beside the cursor (the other side near an edge)
  const left = e.clientX + 24 + 154 > innerWidth ? e.clientX - 24 - 154 : e.clientX + 24;
  const top = e.clientY + 24 + 184 > innerHeight ? e.clientY - 24 - 184 : e.clientY + 24;
  loupe.style.left = left + 'px'; loupe.style.top = top + 'px';
  const n = 15, cell = 308 / n;
  lctx.imageSmoothingEnabled = false;
  lctx.fillStyle = '#111'; lctx.fillRect(0, 0, 308, 368);
  lctx.drawImage(shot, px - (n >> 1), py - (n >> 1), n, n, 0, 0, 308, 308);
  lctx.strokeStyle = 'rgba(0,0,0,.25)'; lctx.lineWidth = 1;
  for (let i = 1; i < n; i++) { lctx.beginPath(); lctx.moveTo(i * cell, 0); lctx.lineTo(i * cell, 308); lctx.moveTo(0, i * cell); lctx.lineTo(308, i * cell); lctx.stroke(); }
  lctx.strokeStyle = '#fff'; lctx.lineWidth = 3;
  lctx.strokeRect((n >> 1) * cell, (n >> 1) * cell, cell, cell);
  lctx.fillStyle = hex(r, g, b); lctx.fillRect(0, 308, 76, 60);
  lctx.fillStyle = '#eee'; lctx.font = '600 26px system-ui, sans-serif';
  lctx.fillText(hex(r, g, b).toUpperCase(), 92, 348);
});
addEventListener('mousedown', (e) => {
  if (!data) return;
  if (e.button !== 0) { document.title = 'pick:cancel'; return; }
  const [r, g, b] = at(e.clientX, e.clientY);
  document.title = 'pick:' + [r, g, b].join(',');
});
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => { if (e.key === 'Escape') document.title = 'pick:cancel'; });
</script></body></html>`;

let busy = false;

/** The colour (0…255 each) picked on the screen the mouse is on; null: given up. */
export async function pickScreenColor(owner: BrowserWindow | null): Promise<[number, number, number] | null> {
  if (busy) return null;
  busy = true;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lumatic-pick-'));
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = display.scaleFactor;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
    const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    if (source === undefined) return null;
    // (the picture inside the page: one read from a file of its own would taint the canvas)
    await fs.writeFile(path.join(folder, 'pick.html'), PAGE.replace('__SHOT__', source.thumbnail.toPNG().toString('base64')));
    const { x, y, width, height } = display.bounds;
    const win = new BrowserWindow({ x, y, width, height, frame: false, resizable: false, movable: false, skipTaskbar: true, show: false, alwaysOnTop: true, fullscreenable: false, hasShadow: false, enableLargerThanScreen: true, backgroundColor: '#000000', webPreferences: { sandbox: true, contextIsolation: true } });
    win.setAlwaysOnTop(true, 'screen-saver');
    return await new Promise((resolve) => {
      let done = false;
      const finish = (value: [number, number, number] | null) => {
        if (done) return;
        done = true;
        if (!win.isDestroyed()) win.destroy();
        owner?.focus();
        resolve(value);
      };
      win.webContents.on('page-title-updated', (_event, title) => {
        if (title === 'ready') {
          win.setBounds({ x, y, width, height });
          win.show();
          win.focus();
          return;
        }
        if (!title.startsWith('pick:')) return;
        const parts = title.slice(5).split(',').map(Number);
        finish(parts.length === 3 && parts.every((value) => Number.isFinite(value)) ? (parts as [number, number, number]) : null);
      });
      win.on('closed', () => finish(null));
      win.on('blur', () => {
        // (another window came up — given up, not left hanging over the screen)
        setTimeout(() => {
          if (!done && !win.isDestroyed() && !win.isFocused()) finish(null);
        }, 300);
      });
      void win.loadFile(path.join(folder, 'pick.html'));
    });
  } finally {
    busy = false;
    void fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
