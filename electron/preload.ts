import { contextBridge, ipcRenderer, webFrame } from 'electron';

function listen<T extends unknown[]>(channel: string, callback: (...values: T) => void) {
  const listener = (_event: unknown, ...values: T) => callback(...values);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// What the page may do with files (see src/editor/platform.ts): only through these calls, and the
// main process only lets them touch folders the user opened.
contextBridge.exposeInMainWorld('chroeditorNative', {
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openRecent: (folder: string) => ipcRenderer.invoke('open-recent', folder),
  recentFolders: () => ipcRenderer.invoke('recent-folders'),
  createMapFolder: (suggested: string) => ipcRenderer.invoke('create-map-folder', suggested),
  listFolder: (folder: string) => ipcRenderer.invoke('list-folder', folder),
  readFile: (file: string) => ipcRenderer.invoke('read-file', file),
  writeFile: (file: string, data: ArrayBuffer | string) => ipcRenderer.invoke('write-file', file, data),
  backupFile: (file: string, keep: number) => ipcRenderer.invoke('backup-file', file, keep),
  deleteFile: (file: string) => ipcRenderer.invoke('delete-file', file),
  saveFileAs: (name: string, data: ArrayBuffer, filterName: string, extensions: string[]) => ipcRenderer.invoke('save-file-as', name, data, filterName, extensions),
  setLanguage: (language: string) => ipcRenderer.send('set-language', language),
  setZoom: (factor: number) => webFrame.setZoomFactor(factor),
  pickScreenColor: () => ipcRenderer.invoke('pick-screen-color'),
  refocus: () => ipcRenderer.send('refocus'),
  log: (kind: string, message: string) => ipcRenderer.send('log', kind, message),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  paletteFromMap: () => ipcRenderer.invoke('palette-from-map'),
  preview: {
    detach: (state: unknown) => ipcRenderer.invoke('preview-detach', state),
    close: () => ipcRenderer.send('preview-close'),
    sync: (state: unknown) => ipcRenderer.send('preview-sync', state),
    tick: (state: unknown) => ipcRenderer.send('preview-tick', state),
    patch: (state: unknown) => ipcRenderer.send('preview-editor-patch', state),
    hotkey: (action: string) => ipcRenderer.send('preview-hotkey', action),
    keyState: (code: string, down: boolean) => ipcRenderer.send('preview-key-state', code, down),
    ready: () => ipcRenderer.send('preview-ready'),
    setAlwaysOnTop: (alwaysOnTop: boolean) => ipcRenderer.invoke('preview-always-on-top', alwaysOnTop),
    onSnapshot: (callback: (state: unknown) => void) => listen('preview-state', callback),
    onTick: (callback: (state: unknown) => void) => listen('preview-tick', callback),
    onPatch: (callback: (state: unknown) => void) => listen('preview-editor-patch', callback),
    onHotkey: (callback: (action: string) => void) => listen('preview-hotkey', callback),
    onKeyState: (callback: (code: string, down: boolean) => void) => listen('preview-key-state', callback),
    onClosed: (callback: () => void) => listen('preview-closed', callback),
    onAlwaysOnTop: (callback: (alwaysOnTop: boolean) => void) => listen('preview-always-on-top', callback),
  },
  maps: {
    installations: (folder: string) => ipcRenderer.invoke('map-installations', folder),
    scan: (folder: string) => ipcRenderer.invoke('map-scan', folder),
    kind: (folder: string, gameFolder: string) => ipcRenderer.invoke('map-kind', folder, gameFolder),
    cover: (file: string, gameFolder: string) => ipcRenderer.invoke('map-cover', file, gameFolder),
    copy: (folder: string, gameFolder: string) => ipcRenderer.invoke('map-copy', folder, gameFolder),
  },
  game: {
    pickFolder: () => ipcRenderer.invoke('game-pick-folder'),
    folder: (folder: string) => ipcRenderer.invoke('game-folder', folder),
    imported: () => ipcRenderer.invoke('game-imported'),
    importEnvironment: (folder: string, name: string) => ipcRenderer.invoke('game-import', folder, name),
    remove: (id: string) => ipcRenderer.invoke('game-remove', id),
  },
  updates: {
    check: () => ipcRenderer.invoke('update-check'),
    canInstall: () => ipcRenderer.invoke('update-can-install'),
    download: (url: string, size: number, progress: (done: number) => void) => {
      const listener = (_event: unknown, done: number) => progress(done);
      ipcRenderer.on('update-progress', listener);
      return ipcRenderer.invoke('update-download', url, size).finally(() => ipcRenderer.removeListener('update-progress', listener));
    },
    install: () => ipcRenderer.invoke('update-install'),
  },
  quest: {
    findAdb: (picked?: string) => ipcRenderer.invoke('quest-find-adb', picked),
    downloadAdb: () => ipcRenderer.invoke('quest-download-adb'),
    pickAdb: () => ipcRenderer.invoke('quest-pick-adb'),
    devices: () => ipcRenderer.invoke('quest-devices'),
    connect: (address: string) => ipcRenderer.invoke('quest-connect', address),
    disconnect: (address: string) => ipcRenderer.invoke('quest-disconnect', address),
    enableWifi: (serial: string) => ipcRenderer.invoke('quest-enable-wifi', serial),
    discover: (remembered: string[]) => ipcRenderer.invoke('quest-discover', remembered),
    pair: (address: string, code: string) => ipcRenderer.invoke('quest-pair', address, code),
    mdns: () => ipcRenderer.invoke('quest-mdns'),
    upload: (options: unknown, progress: (text: string) => void) => {
      const listener = (_event: unknown, text: string) => progress(text);
      ipcRenderer.on('quest-progress', listener);
      return ipcRenderer.invoke('quest-upload', options).finally(() => ipcRenderer.removeListener('quest-progress', listener));
    },
  },
});
