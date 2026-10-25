import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * ChroEditor's window. The page (dist/) is served from app://local so it can fetch its environment
 * data like a website; map folders are read and written through IPC (preload.ts), and only inside
 * folders the user opened.
 */

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const distRoot = path.join(__dirname, '..', 'dist');
const allowedRoots = new Set<string>();
const recentFile = () => path.join(app.getPath('userData'), 'recent-folders.json');

function allowed(target: string) {
  const resolved = path.resolve(target);
  for (const root of allowedRoots) {
    const relative = path.relative(root, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return true;
  }
  return false;
}

async function listFolder(folder: string) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

async function readRecent(): Promise<string[]> {
  try {
    const list = JSON.parse(await fs.readFile(recentFile(), 'utf8')) as unknown;
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function rememberFolder(folder: string) {
  const list = [folder, ...(await readRecent()).filter((item) => item !== folder)].slice(0, 12);
  await fs.writeFile(recentFile(), JSON.stringify(list, null, 2)).catch(() => undefined);
}

async function openFolder(folder: string) {
  const resolved = path.resolve(folder);
  allowedRoots.add(resolved);
  await rememberFolder(resolved);
  return { path: resolved, files: await listFolder(resolved) };
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#101114',
    title: 'ChroEditor',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // (links open in the browser, not in the editor's window)
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  const devUrl = process.env.CHROEDITOR_DEV_URL;
  void window.loadURL(devUrl ?? 'app://local/index.html');
}

void app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const file = path.normalize(path.join(distRoot, decodeURIComponent(url.pathname)));
    if (!file.startsWith(distRoot)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  ipcMain.handle('open-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Папка карты (с Info.dat)' });
    if (result.canceled || result.filePaths[0] === undefined) return null;
    return openFolder(result.filePaths[0]);
  });
  ipcMain.handle('open-recent', async (_event, folder: string) => {
    try {
      await fs.access(path.join(folder));
      return await openFolder(folder);
    } catch {
      return null;
    }
  });
  ipcMain.handle('recent-folders', () => readRecent());
  ipcMain.handle('list-folder', async (_event, folder: string) => {
    if (!allowed(folder)) throw new Error('not an opened folder');
    return listFolder(folder);
  });
  ipcMain.handle('read-file', async (_event, file: string) => {
    if (!allowed(file)) throw new Error('not in an opened folder');
    const data = await fs.readFile(file);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  });
  ipcMain.handle('write-file', async (_event, file: string, data: ArrayBuffer | string) => {
    if (!allowed(file)) throw new Error('not in an opened folder');
    await fs.writeFile(file, typeof data === 'string' ? data : Buffer.from(data));
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
