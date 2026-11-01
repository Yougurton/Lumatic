import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupFile } from './backup';
import { connect, devices, disconnect, downloadAdb, enableWifi, findAdb, upload, type UploadOptions } from './quest';

/**
 * Lumatic's window (the editor was called ChroEditor before). The page (dist/) is served from app://local so it can fetch its environment
 * data like a website; map folders are read and written through IPC (preload.ts), and only inside
 * folders the user opened.
 */

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const distRoot = path.join(__dirname, '..', 'dist');
const allowedRoots = new Set<string>();
// (settings, recent folders and the rest of the page's storage stay where ChroEditor kept them)
{
  const before = path.join(app.getPath('appData'), 'ChroEditor');
  if (existsSync(before)) app.setPath('userData', before);
}
// the window's own questions in the editor's language (the page says which)
let english = false;
const say = (russian: string, englishText: string) => (english ? englishText : russian);

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
    title: 'Lumatic',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // (no menu: its accelerators — Ctrl+Z, Ctrl+R… — would take the keys from the editor; F12 still
  // opens the developer tools)
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      window.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  // (links open in the browser, not in the editor's window)
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // closing with unsaved changes: save them, drop them, or stay (the page says what it has)
  let closing = false;
  window.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    void (async () => {
      let unsaved: string | null = null;
      try {
        unsaved = (await window.webContents.executeJavaScript('window.chroeditorUnsaved ? window.chroeditorUnsaved() : null')) as string | null;
      } catch {
        // (a page that can't answer has nothing to lose)
      }
      if (unsaved !== null) {
        const { response } = await dialog.showMessageBox(window, {
          type: 'question',
          title: 'Lumatic',
          message: say('Сохранить изменения перед выходом?', 'Save the changes before quitting?'),
          detail: unsaved,
          buttons: [say('Сохранить', 'Save'), say('Не сохранять', "Don't save"), say('Отмена', 'Cancel')],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        if (response === 2) return;
        if (response === 0) {
          const saved = (await window.webContents.executeJavaScript('window.chroeditorSave ? window.chroeditorSave() : false').catch(() => false)) as boolean;
          if (!saved) {
            await dialog.showMessageBox(window, { type: 'error', title: 'Lumatic', message: say('Не получилось сохранить — окно остаётся открытым.', "Couldn't save — the window stays open."), buttons: ['OK'] });
            return;
          }
        }
      }
      closing = true;
      window.close();
    })();
  });
  const devUrl = process.env.CHROEDITOR_DEV_URL;
  void window.loadURL(devUrl ?? 'app://local/index.html');
}

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const file = path.normalize(path.join(distRoot, decodeURIComponent(url.pathname)));
    if (!file.startsWith(distRoot)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  ipcMain.handle('open-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: say('Папка карты (с Info.dat)', 'Map folder (with Info.dat)') });
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
  // a new map: where to put its folder (named by the user in the save dialog), made here
  ipcMain.handle('create-map-folder', async (_event, suggested: string) => {
    const recent = await readRecent();
    const parent = recent[0] === undefined ? app.getPath('documents') : path.dirname(recent[0]);
    const result = await dialog.showSaveDialog({
      title: say('Папка новой карты', "The new map's folder"),
      buttonLabel: say('Создать', 'Create'),
      defaultPath: path.join(parent, suggested),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || result.filePath === undefined) return null;
    const folder = result.filePath;
    await fs.mkdir(folder, { recursive: true });
    const existing = await listFolder(folder);
    if (existing.some((name) => name.toLowerCase() === 'info.dat')) throw new Error(say('В этой папке уже есть карта (Info.dat)', 'This folder already has a map (Info.dat)'));
    return openFolder(folder);
  });
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
  ipcMain.handle('backup-file', async (_event, file: string, keep: number) => {
    if (!allowed(file)) throw new Error('not in an opened folder');
    await backupFile(file, keep);
  });
  ipcMain.handle('delete-file', async (_event, file: string) => {
    if (!allowed(file)) throw new Error('not in an opened folder');
    // (a copy kept first: a deleted difficulty can be brought back from "Lumatic backups")
    await backupFile(file, 50);
    await fs.unlink(file);
  });
  // the Quest: adb, the headsets, Wi-Fi, sending the map
  ipcMain.handle('quest-find-adb', (_event, picked?: string) => findAdb(picked));
  ipcMain.handle('quest-download-adb', () => downloadAdb());
  ipcMain.handle('quest-pick-adb', async () => {
    const result = await dialog.showOpenDialog({ title: say('Где adb', 'Where adb is'), properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'adb', extensions: ['exe'] }] : [] });
    if (result.canceled || result.filePaths[0] === undefined) return null;
    return findAdb(result.filePaths[0]);
  });
  ipcMain.handle('quest-devices', () => devices());
  ipcMain.handle('quest-connect', (_event, address: string) => connect(address));
  ipcMain.handle('quest-disconnect', (_event, address: string) => disconnect(address));
  ipcMain.handle('quest-enable-wifi', (_event, serial: string) => enableWifi(serial));
  ipcMain.handle('quest-upload', async (event, options: UploadOptions) => {
    if (!allowed(options.folder)) throw new Error('not an opened folder');
    return upload(options, (text) => event.sender.send('quest-progress', text));
  });
  ipcMain.on('set-language', (_event, language: string) => {
    english = language === 'en';
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
