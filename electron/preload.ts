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
