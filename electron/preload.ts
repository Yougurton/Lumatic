import { contextBridge, ipcRenderer, webFrame } from 'electron';

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
  setLanguage: (language: string) => ipcRenderer.send('set-language', language),
  setZoom: (factor: number) => webFrame.setZoomFactor(factor),
});
