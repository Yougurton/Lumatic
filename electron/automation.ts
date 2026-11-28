import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

import { log } from './log';

export interface AutomationWindows {
  editor: () => BrowserWindow | null;
  preview: () => BrowserWindow | null;
}

/** Where capture series are written (PNG for viewing + raw BGRA for pixel diffs). */
const CAPTURE_DIR = path.join(os.tmpdir(), 'lumatic-captures');

const json = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

async function runInPage(window: BrowserWindow | null, expression: string) {
  if (window === null || window.isDestroyed()) throw new Error('the editor window is not available');
  return window.webContents.executeJavaScript(expression, true);
}

async function capture(window: BrowserWindow | null): Promise<string> {
  if (window === null || window.isDestroyed()) throw new Error('the window is not available');
  const image = await window.webContents.capturePage();
  return image.toPNG().toString('base64');
}

/** Compare two raw BGRA bitmaps of the same size: how much and where they differ. This is how an
 *  agent sees flicker — a series of captures at one beat must produce (near) identical frames. */
function compareRaw(a: Buffer, b: Buffer, width: number, height: number, threshold = 6) {
  let total = 0;
  let changedPixels = 0;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = -1;
  let y1 = -1;
  for (let offset = 0; offset + 3 < a.length; offset += 4) {
    const delta =
      Math.abs(a[offset]! - b[offset]!) +
      Math.abs(a[offset + 1]! - b[offset + 1]!) +
      Math.abs(a[offset + 2]! - b[offset + 2]!) +
      Math.abs(a[offset + 3]! - b[offset + 3]!);
    total += delta;
    if (delta > threshold) {
      changedPixels += 1;
      const pixel = offset / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const pixels = width * height;
  const bbox =
    x1 < 0 ? null : { x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) };
  return {
    meanDiff: Math.round((total / Math.max(pixels, 1)) * 1000) / 1000,
    changedPixels,
    changedRatio: Math.round((changedPixels / Math.max(pixels, 1)) * 100000) / 100000,
    bbox,
  };
}

/** PNG header: width/height live at fixed offsets (signature + IHDR length/type). */
function pngSize(file: string): { width: number; height: number } {
  const header = fs.readFileSync(file);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function route(request: http.IncomingMessage, response: http.ServerResponse, windows: AutomationWindows) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  switch (`${request.method} ${url.pathname}`) {
    case 'GET /state': {
      const state = await runInPage(windows.editor(), 'window.chroeditor.automation.state()');
      json(response, 200, state);
      return;
    }
    case 'POST /seek': {
      const body = JSON.parse(await readBody(request)) as { beat?: unknown };
      const beat = Number(body.beat);
      if (!Number.isFinite(beat)) throw new Error('beat must be a number');
      await runInPage(windows.editor(), `window.chroeditor.automation.seek(${JSON.stringify(beat)})`);
      const state = await runInPage(windows.editor(), 'window.chroeditor.automation.state()');
      json(response, 200, state);
      return;
    }
    case 'POST /play': {
      await runInPage(windows.editor(), 'window.chroeditor.automation.play()');
      json(response, 200, { ok: true });
      return;
    }
    case 'POST /pause': {
      await runInPage(windows.editor(), 'window.chroeditor.automation.pause()');
      json(response, 200, { ok: true });
      return;
    }
    case 'POST /open': {
      const body = JSON.parse(await readBody(request)) as { folder?: unknown };
      if (typeof body.folder !== 'string') throw new Error('folder must be a string');
      await runInPage(windows.editor(), `window.chroeditor.automation.open(${JSON.stringify(body.folder)})`);
      json(response, 200, { ok: true });
      return;
    }
    case 'GET /difficulties': {
      const list = await runInPage(windows.editor(), 'window.chroeditor.automation.difficulties()');
      json(response, 200, list);
      return;
    }
    case 'POST /difficulty': {
      const body = JSON.parse(await readBody(request)) as { key?: unknown };
      if (typeof body.key !== 'string') throw new Error('key must be a string');
      await runInPage(windows.editor(), `window.chroeditor.automation.difficulty(${JSON.stringify(body.key)})`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const state = await runInPage(windows.editor(), 'window.chroeditor.automation.state()');
      json(response, 200, state);
      return;
    }
    case 'POST /preview': {
      const body = JSON.parse(await readBody(request)) as { detach?: unknown };
      const call = body.detach === true ? 'previewDetach' : 'previewAttach';
      await runInPage(windows.editor(), `window.chroeditor.automation.${call}()`);
      json(response, 200, { ok: true });
      return;
    }
    case 'GET /screenshot': {
      const target = url.searchParams.get('target') === 'preview' ? 'preview' : 'editor';
      const base64 = await capture(target === 'preview' ? windows.preview() : windows.editor());
      json(response, 200, { target, format: 'png', base64 });
      return;
    }
    case 'GET /logs': {
      const after = Math.max(0, Math.round(Number(url.searchParams.get('after') ?? 0)) || 0);
      const clear = url.searchParams.get('clear') === '1';
      const logs = await runInPage(
        windows.editor(),
        `window.chroeditor.automation.logs(${JSON.stringify(after)}, ${clear === true})`,
      );
      json(response, 200, logs);
      return;
    }
    case 'GET /query': {
      const number = (name: string, fallback: number) => {
        const value = Number(url.searchParams.get(name));
        return Number.isFinite(value) ? value : fallback;
      };
      const from = number('from', 0);
      const to = number('to', Number.POSITIVE_INFINITY);
      const track = url.searchParams.get('track');
      const kind = url.searchParams.get('kind');
      const result = await runInPage(
        windows.editor(),
        `window.chroeditor.automation.query(${JSON.stringify(from)}, ${Number.isFinite(to) ? JSON.stringify(to) : 'Number.POSITIVE_INFINITY'}, ${JSON.stringify(track)}, ${JSON.stringify(kind)})`,
      );
      json(response, 200, result);
      return;
    }
    case 'GET /scene': {
      const scene = await runInPage(windows.editor(), 'window.chroeditor.automation.scene()');
      json(response, 200, scene);
      return;
    }
    case 'GET /rows': {
      const rows = await runInPage(
        windows.editor(),
        'window.chroeditor.automation.rows()',
      );
      json(response, 200, rows);
      return;
    }
    case 'POST /capture': {
      const body = JSON.parse(await readBody(request)) as { count?: unknown; intervalMs?: unknown; target?: unknown };
      const count = Math.max(1, Math.min(40, Math.round(Number(body.count ?? 8)) || 8));
      const intervalMs = Math.max(30, Math.min(5000, Math.round(Number(body.intervalMs ?? 250)) || 250));
      const target = body.target === 'preview' ? 'preview' : 'editor';
      const window_ = target === 'preview' ? windows.preview() : windows.editor();
      if (window_ === null || window_.isDestroyed()) throw new Error('the window is not available');
      fs.mkdirSync(CAPTURE_DIR, { recursive: true });
      const stamp = `${target}-${Date.now().toString(36)}`;
      const files: string[] = [];
      const diffs: unknown[] = [];
      let previous: Buffer | null = null;
      let width = 0;
      let height = 0;
      for (let index = 0; index < count; index += 1) {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const image = await window_.webContents.capturePage();
        const size = image.getSize();
        if (width === 0) {
          width = size.width;
          height = size.height;
        }
        const name = `${stamp}-${String(index).padStart(2, '0')}`;
        fs.writeFileSync(path.join(CAPTURE_DIR, `${name}.png`), image.toPNG());
        fs.writeFileSync(path.join(CAPTURE_DIR, `${name}.raw`), image.toBitmap());
        files.push(`${name}.png`);
        const raw = image.toBitmap();
        if (previous !== null && previous.length === raw.length && width > 0) {
          const comparison = compareRaw(previous, raw, width, height);
          diffs.push({ index, ...comparison });
        }
        previous = raw;
      }
      fs.writeFileSync(path.join(CAPTURE_DIR, `${stamp}.json`), JSON.stringify({ target, width, height, files }));
      json(response, 200, { dir: CAPTURE_DIR, target, width, height, files, diffs });
      return;
    }
    case 'POST /diff': {
      const body = JSON.parse(await readBody(request)) as { a?: unknown; b?: unknown };
      const name = (value: unknown) => path.basename(String(value));
      const nameA = name(body.a);
      const nameB = name(body.b);
      const rawA = path.join(CAPTURE_DIR, nameA.replace(/\.png$/i, '.raw'));
      const rawB = path.join(CAPTURE_DIR, nameB.replace(/\.png$/i, '.raw'));
      const a = fs.readFileSync(rawA);
      const b = fs.readFileSync(rawB);
      if (a.length !== b.length) throw new Error('captures have different sizes');
      const size = pngSize(path.join(CAPTURE_DIR, nameA));
      const comparison = compareRaw(a, b, size.width, size.height);
      json(response, 200, { a: nameA, b: nameB, width: size.width, height: size.height, ...comparison });
      return;
    }
    default:
      json(response, 404, { error: `unknown route ${request.method} ${url.pathname}` });
  }
}

/** Local JSON API over the running editor for agents and tests. Bound to 127.0.0.1 and only
 *  started when the app runs with --automation (see main.ts), so it is off for normal use. */
export function startAutomationServer(port: number, windows: AutomationWindows): http.Server {
  const server = http.createServer((request, response) => {
    void route(request, response, windows).catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.on('error', (error) => log('automation', `server on port ${port}: ${String(error)}`));
  server.listen(port, '127.0.0.1', () => log('automation', `listening on 127.0.0.1:${port}`));
  return server;
}
