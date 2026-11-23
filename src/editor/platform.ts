import type { PreviewSnapshot, PreviewTick, RemoteEditorPatch } from './preview-state';

/**
 * Files: in the desktop app through Electron (electron/preload.ts → window.chroeditorNative), in a
 * browser (development, tests) through the folder picker / File System Access API, or a folder
 * handed in by a test (window.__chroeditorTestFolder).
 */

export interface MapFolder {
  /** Shown to the user. */
  name: string;
  files: string[];
  readText(name: string): Promise<string>;
  readBinary(name: string): Promise<ArrayBuffer>;
  writeText(name: string, text: string): Promise<void>;
  writeBinary(name: string, data: ArrayBuffer): Promise<void>;
  /** Re-reads the list of files. */
  refresh(): Promise<void>;
  /** A copy of a file in the map's "Lumatic backups" folder, keeping that many copies of it (only in
   *  the desktop app). */
  backup?(name: string, keep: number): Promise<void>;
  /** Deletes a file (the desktop app: a copy of it kept in "Lumatic backups" first). */
  remove?(name: string): Promise<void>;
  readOnly?: boolean;
}

/** The newest release against this app (electron/updater.ts). */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  newer: boolean;
  notes: string;
  page: string;
  asset: { url: string; size: number; name: string } | null;
}

interface NativeApi {
  openFolder(): Promise<{ path: string; files: string[] } | null>;
  listFolder(path: string): Promise<string[]>;
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, data: ArrayBuffer | string): Promise<void>;
  /** A copy of a file of an opened folder in its "Lumatic backups" folder, the oldest copies of that
   *  file past `keep` deleted. */
  backupFile?(path: string, keep: number): Promise<void>;
  /** Deletes a file of an opened folder (a copy kept in its "Lumatic backups" folder first). */
  deleteFile?(path: string): Promise<void>;
  /** A file saved where the user picks (null: cancelled; else where it went). */
  saveFileAs?(name: string, data: ArrayBuffer, filterName: string, extensions: string[]): Promise<string | null>;
  /** The language of the window's own questions (closing with unsaved changes, picking folders). */
  setLanguage?(language: string): void;
  /** The whole window's scale. */
  setZoom?(factor: number): void;
  /** The keyboard back to the page (after a native box took it). */
  refocus?(): void;
  /** A line into the app's log. */
  log?(kind: string, message: string): void;
  /** The log's folder opened. */
  openLogs?(): Promise<string>;
  /** A colour picked anywhere on the screen (0…255 each; null: given up). */
  pickScreenColor?(): Promise<[number, number, number] | null>;
  /** The colours saved in another map's projects (its folder picked; null: cancelled). */
  paletteFromMap?(): Promise<{ name: string; colors: number[][]; presets?: unknown[] } | null>;
  preview?: {
    detach(state: PreviewSnapshot): Promise<boolean>;
    close(): void;
    sync(state: PreviewSnapshot): void;
    tick(state: PreviewTick): void;
    patch(state: RemoteEditorPatch): void;
    hotkey(action: string): void;
    keyState(code: string, down: boolean): void;
    ready(): void;
    setAlwaysOnTop(alwaysOnTop: boolean): Promise<boolean>;
    onSnapshot(callback: (state: PreviewSnapshot) => void): () => void;
    onTick(callback: (state: PreviewTick) => void): () => void;
    onPatch(callback: (state: RemoteEditorPatch) => void): () => void;
    onHotkey(callback: (action: string) => void): () => void;
    onKeyState(callback: (code: string, down: boolean) => void): () => void;
    onClosed(callback: () => void): () => void;
    onAlwaysOnTop(callback: (alwaysOnTop: boolean) => void): () => void;
  };
  /** Updates from the project's releases (electron/updater.ts). */
  updates?: {
    check(): Promise<UpdateInfo>;
    canInstall(): Promise<boolean>;
    download(url: string, size: number, progress: (done: number) => void): Promise<boolean>;
    install(): Promise<void>;
  };
  /** Environments made from the user's own copy of the game (electron/game-environments.ts). */
  game?: {
    pickFolder(): Promise<string | null>;
    folder(folder: string): Promise<GameFolder | null>;
    imported(): Promise<ImportedEnvironment[]>;
    importEnvironment(folder: string, name: string): Promise<{ ok: true; environment: ImportedEnvironment } | { ok: false; reason: 'no-python' | 'no-modules' | 'failed'; detail: string }>;
    remove(id: string): Promise<void>;
  };
  maps?: {
    installations(folder: string): Promise<GameInstallation[]>;
    scan(folder: string): Promise<{ wip: MapLibraryEntry[]; levels: MapLibraryEntry[] }>;
    kind(folder: string, gameFolder: string): Promise<MapLibraryKind | null>;
    cover(file: string, gameFolder: string): Promise<string | null>;
    copy(folder: string, gameFolder: string): Promise<{ path: string; files: string[] }>;
  };
  /** The folders opened before (newest first). */
  recentFolders(): Promise<string[]>;
  openRecent(path: string): Promise<{ path: string; files: string[] } | null>;
  /** A new, empty folder for a new map (the user names it and picks where). */
  createMapFolder(suggested: string): Promise<{ path: string; files: string[] } | null>;
}

export interface GameFolder {
  folder: string;
  version: string;
  /** The names the game's files use: "panic2", "rockmixtape". */
  environments: { name: string; size: number }[];
}

export type MapLibraryKind = 'wip' | 'levels';

export interface GameInstallation {
  folder: string;
  version: string;
}

export interface MapLibraryEntry {
  path: string;
  songName: string;
  songAuthor: string;
  mapAuthor: string;
  environment: string;
  infoVersion: string;
  versions: string[];
  modified: number;
  cover: string | null;
}

export interface ImportedEnvironment {
  id: string;
  title: string;
  /** Light groups (a GLS environment: more than none). */
  groups: number;
  notUnderstood: [string, number][];
  gameVersion: string;
}

/** The game's environments in the desktop app (undefined in a browser). */
export const gameEnvironments = () => window.chroeditorNative?.game;

declare global {
  interface Window {
    chroeditorNative?: NativeApi;
    __chroeditorTestFolder?: Record<string, string | ArrayBuffer>;
    /** Tests: where a new map goes. */
    __chroeditorNewFolder?: Record<string, string | ArrayBuffer>;
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
}

export const isDesktop = () => window.chroeditorNative !== undefined;

/** A file saved where the user picks (the browser: downloaded). Where it went (null: cancelled; the
 *  browser: its name). */
export async function saveFileAs(name: string, data: Uint8Array, filterName: string, extensions: string[]): Promise<string | null> {
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const native = window.chroeditorNative;
  if (native?.saveFileAs !== undefined) return native.saveFileAs(name, bytes, filterName, extensions);
  const url = URL.createObjectURL(new Blob([bytes]));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}

function joinPath(folder: string, name: string) {
  return `${folder.replace(/[\\/]+$/u, '')}/${name}`;
}

function nativeFolder(native: NativeApi, opened: { path: string; files: string[] }, readOnly = false): MapFolder {
  const writable = () => {
    if (readOnly) throw new Error('Карта из CustomLevels открыта только для чтения. Создайте копию в CustomWIPLevels.');
  };
  const folder: MapFolder = {
    name: opened.path,
    files: opened.files,
    readOnly,
    readText: async (name) => new TextDecoder().decode(await native.readFile(joinPath(opened.path, name))),
    readBinary: (name) => native.readFile(joinPath(opened.path, name)),
    writeText: (name, text) => {
      writable();
      return native.writeFile(joinPath(opened.path, name), text);
    },
    writeBinary: (name, data) => {
      writable();
      return native.writeFile(joinPath(opened.path, name), data);
    },
    backup: (name, keep) => {
      writable();
      return native.backupFile?.(joinPath(opened.path, name), keep) ?? Promise.resolve();
    },
    remove: async (name) => {
      writable();
      await native.deleteFile?.(joinPath(opened.path, name));
      folder.files = await native.listFolder(opened.path);
    },
    refresh: async () => {
      folder.files = await native.listFolder(opened.path);
    },
  };
  return folder;
}

function memoryFolder(name: string, files: Record<string, string | ArrayBuffer>): MapFolder {
  const folder: MapFolder = {
    name,
    files: Object.keys(files),
    readText: (file) => {
      const data = files[file];
      if (data === undefined) return Promise.reject(new Error(`no ${file}`));
      return Promise.resolve(typeof data === 'string' ? data : new TextDecoder().decode(data));
    },
    readBinary: (file) => {
      const data = files[file];
      if (data === undefined) return Promise.reject(new Error(`no ${file}`));
      return Promise.resolve(typeof data === 'string' ? (new TextEncoder().encode(data).buffer as ArrayBuffer) : data);
    },
    writeText: (file, text) => {
      files[file] = text;
      folder.files = Object.keys(files);
      return Promise.resolve();
    },
    writeBinary: (file, data) => {
      files[file] = data;
      folder.files = Object.keys(files);
      return Promise.resolve();
    },
    remove: (file) => {
      delete files[file];
      folder.files = Object.keys(files);
      return Promise.resolve();
    },
    refresh: () => Promise.resolve(),
  };
  return folder;
}

async function handleFolder(handle: FileSystemDirectoryHandle): Promise<MapFolder> {
  const list = async () => {
    const names: string[] = [];
    for await (const [name, entry] of handle as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (entry.kind === 'file') names.push(name);
    }
    return names;
  };
  const folder: MapFolder = {
    name: handle.name,
    files: await list(),
    readText: async (name) => (await (await handle.getFileHandle(name)).getFile()).text(),
    readBinary: async (name) => (await (await handle.getFileHandle(name)).getFile()).arrayBuffer(),
    writeText: async (name, text) => {
      const writable = await (await handle.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    },
    writeBinary: async (name, data) => {
      const writable = await (await handle.getFileHandle(name, { create: true })).createWritable();
      await writable.write(data);
      await writable.close();
    },
    remove: async (name) => {
      await handle.removeEntry(name);
      folder.files = await list();
    },
    refresh: async () => {
      folder.files = await list();
    },
  };
  return folder;
}

/** "Open a map": its folder (null: cancelled). */
export async function openMapFolder(): Promise<MapFolder | null> {
  const native = window.chroeditorNative;
  if (native !== undefined) {
    const opened = await native.openFolder();
    return opened === null ? null : nativeFolder(native, opened);
  }
  if (window.__chroeditorTestFolder !== undefined) return memoryFolder('test', window.__chroeditorTestFolder);
  if (window.showDirectoryPicker !== undefined) {
    try {
      return await handleFolder(await window.showDirectoryPicker({ mode: 'readwrite' }));
    } catch {
      return null;
    }
  }
  return null;
}

export async function recentFolders(): Promise<string[]> {
  return (await window.chroeditorNative?.recentFolders()) ?? [];
}

export async function openRecentFolder(path: string, gameFolder = ''): Promise<MapFolder | null> {
  const native = window.chroeditorNative;
  if (native === undefined) return null;
  const kind = gameFolder === '' ? null : await native.maps?.kind(path, gameFolder).catch(() => null);
  const opened = await native.openRecent(path);
  return opened === null ? null : nativeFolder(native, opened, kind === 'levels');
}

export async function openLibraryMap(folder: string, kind: MapLibraryKind): Promise<MapFolder | null> {
  const native = window.chroeditorNative;
  if (native === undefined) return null;
  const opened = await native.openRecent(folder);
  return opened === null ? null : nativeFolder(native, opened, kind === 'levels');
}

export async function copyMapToWip(folder: string, gameFolder: string): Promise<MapFolder | null> {
  const native = window.chroeditorNative;
  if (native?.maps === undefined) return null;
  return nativeFolder(native, await native.maps.copy(folder, gameFolder));
}

/** "New map": an empty folder for it (null: cancelled). */
export async function createMapFolder(suggested: string): Promise<MapFolder | null> {
  const native = window.chroeditorNative;
  if (native !== undefined) {
    const created = await native.createMapFolder(suggested);
    return created === null ? null : nativeFolder(native, created);
  }
  if (window.__chroeditorNewFolder !== undefined) return memoryFolder(suggested, window.__chroeditorNewFolder);
  if (window.showDirectoryPicker !== undefined) {
    try {
      const folder = await handleFolder(await window.showDirectoryPicker({ mode: 'readwrite' }));
      if (folder.files.some((name) => name.toLowerCase() === 'info.dat')) throw new Error('В этой папке уже есть карта (Info.dat)');
      return folder;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Info.dat')) throw error;
      return null;
    }
  }
  return null;
}
