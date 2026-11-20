import { canInstall, checkForUpdate, downloadUpdate, installUpdate } from './updater';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupFile } from './backup';
import { importEnvironment, importedEnvironments, importedFolder, readGameFolder, removeImported } from './game-environments';
import { pickScreenColor } from './eyedropper';
import { log, logFolder } from './log';
import { copyMapToWip, gameInstallations, mapLibraryKind, readMapCover, scanMapLibrary } from './map-library';
import { findAdbServices } from './mdns';
import { PreviewWindowManager } from './preview-window';
import { connect, devices, disconnect, discover, downloadAdb, enableWifi, findAdb, pair, upload, type UploadOptions } from './quest';

/**
 * Lumatic's window (the editor was called ChroEditor before). The page (dist/) is served from app://local so it can fetch its environment
 * data like a website; map folders are read and written through IPC (preload.ts), and only inside
 * folders the user opened.
 */

// (a page that hangs can tell where it's stuck: its JavaScript call stack, into the log)
app.commandLine.appendSwitch('enable-features', 'DocumentPolicyIncludeJSCallStacksInCrashReports');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const distRoot = path.join(__dirname, '..', 'dist');
const previewWindows = new PreviewWindowManager(distRoot);
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

/** `reopen`: a map folder to open again as the page starts (after a restart from a hang). */
function createWindow(reopen?: string) {
  const window = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#101114',
    title: 'Lumatic',
    icon: path.join(distRoot, 'icon.png'),
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
  // what goes wrong, into the log
  window.webContents.on('console-message', (details) => {
    const level = (details as unknown as { level?: string | number }).level;
    if (level === 'warning' || level === 'error' || level === 2 || level === 3) log(`page ${String(level)}`, `${details.message} (${details.sourceId}:${String(details.lineNumber)})`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    log('crash', `the page's process is gone: ${details.reason} (${String(details.exitCode)})`);
    if (details.reason === 'clean-exit' || window.isDestroyed()) return;
    void dialog
      .showMessageBox(window, { type: 'error', title: 'Lumatic', message: say('Окно Lumatic упало.', 'The Lumatic window crashed.'), detail: say('Оно откроется заново с последней картой; несохранённое можно вернуть из автокопии.', 'It opens again with the last map; what was not saved can be brought back from the autosave.'), buttons: ['OK'] })
      .then(() => restart(window));
  });
  // a page that stopped answering: wait for it, or start it again (the last map opened again)
  let asking = false;
  window.on('unresponsive', () => {
    log('hang', 'the window stopped answering');
    // where it's stuck: the page's JavaScript call stack
    void Promise.resolve(window.webContents.mainFrame.collectJavaScriptCallStack())
      .then((stack) => log('hang', `stuck at:\n${typeof stack === 'string' && stack !== '' ? stack : '(no call stack given)'}`))
      .catch((error: unknown) => log('hang', `no call stack: ${String(error)}`));
    if (asking) return;
    asking = true;
    void dialog
      .showMessageBox(window, {
        type: 'warning',
        title: 'Lumatic',
        message: say('Lumatic не отвечает.', 'Lumatic is not responding.'),
        detail: say('Можно подождать или перезапустить окно: последняя карта откроется снова, несохранённое можно вернуть из автокопии (раз в 2 минуты). Что случилось — в журнале (Настройки → Журнал).', 'Wait, or restart the window: the last map opens again, what was not saved can be brought back from the autosave (every 2 minutes). What happened is in the log (Settings → Log).'),
        buttons: [say('Подождать', 'Wait'), say('Перезапустить', 'Restart')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then(({ response }) => {
        asking = false;
        if (response === 1 && !window.isDestroyed()) restart(window);
      });
  });
  window.on('responsive', () => log('hang', 'answering again'));
  // closing with unsaved changes: save them, drop them, or stay (the page says what it has)
  let closing = false;
  window.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    void (async () => {
      let unsaved: string | null = null;
      // (a page that doesn't answer in a few seconds — hung: asked whether to close it as it is)
      const answer = await Promise.race([
        window.webContents.executeJavaScript('window.chroeditorUnsaved ? window.chroeditorUnsaved() : null').then((value: unknown) => ({ value: value as string | null })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]).catch(() => ({ value: null }));
      if (answer === null) {
        log('hang', 'closing: the page did not answer');
        const { response } = await dialog.showMessageBox(window, {
          type: 'warning',
          title: 'Lumatic',
          message: say('Окно не отвечает. Закрыть его?', 'The window is not responding. Close it?'),
          detail: say('Несохранённое можно будет вернуть из автокопии при следующем открытии карты.', 'What was not saved can be brought back from the autosave when the map is opened next.'),
          buttons: [say('Закрыть', 'Close'), say('Отмена', 'Cancel')],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (response === 1) return;
        closing = true;
        window.destroy();
        return;
      }
      unsaved = answer.value;
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
  const page = new URL(devUrl ?? 'app://local/index.html');
  if (reopen !== undefined) page.searchParams.set('reopen', reopen);
  void window.loadURL(page.toString());
}

/** The window started again (after a hang or a crash), the last map opened again in it. */
function restart(window: BrowserWindow) {
  log('restart', 'the window is started again');
  void readRecent().then((recent) => {
    if (!window.isDestroyed()) window.destroy();
    createWindow(recent[0]);
  });
}

process.on('uncaughtException', (error) => log('main', error.stack ?? String(error)));
process.on('unhandledRejection', (error) => log('main', error instanceof Error ? (error.stack ?? error.message) : String(error)));

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let file = path.normalize(path.join(distRoot, decodeURIComponent(url.pathname)));
    if (!file.startsWith(distRoot)) return new Response('forbidden', { status: 403 });
    // (an environment made from the user's game: in their data folder, not in the app)
    const environments = path.join(distRoot, 'environments') + path.sep;
    if (file.startsWith(environments) && !existsSync(file)) {
      const made = path.normalize(path.join(importedFolder(), file.slice(environments.length)));
      if (made.startsWith(importedFolder() + path.sep) && existsSync(made)) file = made;
    }
    return net.fetch(pathToFileURL(file).toString()).then((response) => {
      if (!file.endsWith('.html')) return response;
      // (the page lets a hang's call stack be taken: see 'unresponsive')
      const headers = new Headers(response.headers);
      headers.set('Document-Policy', 'include-js-call-stacks-in-crash-reports');
      return new Response(response.body, { status: response.status, headers });
    });
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
    // (a file in a folder of the map's — "Lumatic backups" — made with it)
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof data === 'string' ? data : Buffer.from(data));
  });
  ipcMain.handle('backup-file', async (_event, file: string, keep: number) => {
    if (!allowed(file)) throw new Error('not in an opened folder');
    await backupFile(file, keep);
  });
  ipcMain.handle('save-file-as', async (event, name: string, data: ArrayBuffer, filterName: string, extensions: string[]) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { title: say('Сохранить', 'Save'), defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: filterName, extensions }] };
    const result = window === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(window, options);
    if (result.canceled || result.filePath === undefined) return null;
    await fs.writeFile(result.filePath, Buffer.from(data));
    return result.filePath;
  });
  ipcMain.handle('delete-file', async (_event, file: string) => {
    if (!allowed(file)) throw new Error('not in an opened folder');
    // (a copy kept first: a deleted difficulty can be brought back from "Lumatic backups")
    await backupFile(file, 50);
    await fs.unlink(file);
  });
  ipcMain.handle('map-installations', (_event, folder: string) => gameInstallations(folder));
  ipcMain.handle('map-scan', (_event, folder: string) => scanMapLibrary(folder));
  ipcMain.handle('map-kind', (_event, folder: string, gameFolder: string) => mapLibraryKind(folder, gameFolder));
  ipcMain.handle('map-cover', (_event, file: string, gameFolder: string) => readMapCover(file, gameFolder));
  ipcMain.handle('map-copy', async (_event, folder: string, gameFolder: string) => openFolder(await copyMapToWip(folder, gameFolder)));
  ipcMain.handle('preview-detach', (event, state) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    return owner === null ? false : previewWindows.detach(owner, state);
  });
  ipcMain.on('preview-sync', (_event, state) => previewWindows.sync(state));
  ipcMain.on('preview-tick', (_event, state) => previewWindows.tick(state));
  ipcMain.on('preview-editor-patch', (_event, state) => previewWindows.patch(state));
  ipcMain.on('preview-hotkey', (_event, action: string) => previewWindows.hotkey(action));
  ipcMain.on('preview-key-state', (_event, code: string, down: boolean) => previewWindows.keyState(code, down));
  ipcMain.on('preview-ready', (event) => previewWindows.ready(event.sender));
  ipcMain.on('preview-close', () => previewWindows.close());
  ipcMain.handle('preview-always-on-top', (_event, alwaysOnTop: boolean) => previewWindows.setAlwaysOnTop(alwaysOnTop));
  // the Quest: adb, the headsets, Wi-Fi, sending the map
  // a colour anywhere on the screen (the page's colour pick)
  ipcMain.handle('pick-screen-color', (event) => pickScreenColor(BrowserWindow.fromWebContents(event.sender)));
  // another map's saved colours: its folder picked, the palettes in its projects read (only read)
  ipcMain.handle('palette-from-map', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const picked = owner === null ? await dialog.showOpenDialog({ properties: ['openDirectory'] }) : await dialog.showOpenDialog(owner, { title: say('Карта, из которой взять палитру или пресеты', 'The map to take the palette or presets from'), properties: ['openDirectory'] });
    if (picked.canceled || picked.filePaths[0] === undefined) return null;
    const folder = picked.filePaths[0];
    const colors: number[][] = [];
    const presets: unknown[] = [];
    for (const name of await fs.readdir(folder)) {
      if (!/\.(lumatic|chroeditor)\.json$/iu.test(name)) continue;
      try {
        const project = JSON.parse(await fs.readFile(path.join(folder, name), 'utf8')) as { palette?: unknown };
        if (Array.isArray(project.palette)) for (const rgb of project.palette) if (Array.isArray(rgb) && rgb.length === 3 && rgb.every((v) => typeof v === 'number')) colors.push(rgb as number[]);
        // (its presets too: each once)
        const own = (project as { presets?: unknown }).presets;
        if (Array.isArray(own)) for (const preset of own) if (typeof preset === 'object' && preset !== null && typeof (preset as { id?: unknown }).id === 'string' && !presets.some((item) => (item as { id: string }).id === (preset as { id: string }).id)) presets.push(preset);
      } catch {
        // (not a project after all)
      }
    }
    return { name: path.basename(folder), colors, presets };
  });
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
  ipcMain.handle('quest-discover', (_event, remembered: string[]) => discover(remembered));
  ipcMain.handle('quest-pair', (_event, address: string, code: string) => pair(address, code));
  ipcMain.handle('quest-mdns', () => findAdbServices(1500));
  ipcMain.handle('quest-upload', async (event, options: UploadOptions) => {
    if (!allowed(options.folder)) throw new Error('not an opened folder');
    return upload(options, (text) => event.sender.send('quest-progress', text));
  });
  ipcMain.on('set-language', (_event, language: string) => {
    english = language === 'en';
  });
  // the keyboard back to the page (Windows: after the page's own confirm / alert boxes the window can
  // look focused while no field takes keys — a grey selection)
  ipcMain.on('refocus', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null || window.isDestroyed()) return;
    window.blur();
    window.focus();
    window.webContents.focus();
  });
  // the page's own log lines (an error it caught)
  ipcMain.on('log', (_event, kind: string, message: string) => log(String(kind).slice(0, 40), String(message).slice(0, 4000)));
  ipcMain.handle('game-pick-folder', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window === null ? await dialog.showOpenDialog({ properties: ['openDirectory'] }) : await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    return result.canceled || result.filePaths[0] === undefined ? null : result.filePaths[0];
  });
  ipcMain.handle('game-folder', (_event, folder: string) => readGameFolder(folder));
  ipcMain.handle('game-imported', () => importedEnvironments());
  ipcMain.handle('game-import', (_event, folder: string, name: string) => importEnvironment(folder, name));
  ipcMain.handle('game-remove', (_event, id: string) => removeImported(id));
  ipcMain.handle('open-logs', async () => {
    await fs.mkdir(logFolder(), { recursive: true });
    return shell.openPath(logFolder());
  });
  // updates: the newest release asked about, downloaded, put in place
  let downloaded: string | null = null;
  ipcMain.handle('update-check', () => checkForUpdate());
  ipcMain.handle('update-can-install', () => canInstall());
  ipcMain.handle('update-download', async (event, url: string, size: number) => {
    downloaded = await downloadUpdate(url, size, (done) => {
      if (!event.sender.isDestroyed()) event.sender.send('update-progress', done);
    });
    return true;
  });
  ipcMain.handle('update-install', async () => {
    if (downloaded === null) throw new Error('nothing downloaded');
    log('update', `installing over ${app.getVersion()}`);
    await installUpdate(downloaded);
  });
  log('start', `Lumatic ${app.getVersion()}`);

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
