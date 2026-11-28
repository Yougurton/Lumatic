import { app, BrowserWindow, shell, type WebContents } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { log } from './log';
import type { PreviewSnapshot, PreviewTick, RemoteEditorPatch } from '../src/editor/preview-state';

interface PreviewPreferences {
  width: number;
  height: number;
  x?: number;
  y?: number;
  alwaysOnTop: boolean;
}

const DEFAULT_PREFERENCES: PreviewPreferences = { width: 1100, height: 720, alwaysOnTop: false };

export class PreviewWindowManager {
  private window: BrowserWindow | null = null;
  private owner: BrowserWindow | null = null;
  private state: PreviewSnapshot | null = null;
  private tickState: PreviewTick | null = null;
  private preferences = { ...DEFAULT_PREFERENCES };
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly observedOwners = new WeakSet<BrowserWindow>();

  constructor(
    private readonly distRoot: string,
    /** Automation drives the window while it may be occluded: keep its render loop un-throttled. */
    private readonly keepUnthrottled = false,
  ) {}

  private preferencesFile() {
    return path.join(app.getPath('userData'), 'preview-window.json');
  }

  private async readPreferences() {
    try {
      const saved = JSON.parse(await fs.readFile(this.preferencesFile(), 'utf8')) as Partial<PreviewPreferences>;
      this.preferences = {
        width: typeof saved.width === 'number' ? Math.max(480, saved.width) : DEFAULT_PREFERENCES.width,
        height: typeof saved.height === 'number' ? Math.max(320, saved.height) : DEFAULT_PREFERENCES.height,
        ...(typeof saved.x === 'number' && typeof saved.y === 'number' ? { x: saved.x, y: saved.y } : {}),
        alwaysOnTop: saved.alwaysOnTop === true,
      };
    } catch {
      this.preferences = { ...DEFAULT_PREFERENCES };
    }
  }

  private savePreferences(immediate = false) {
    const window = this.window;
    if (window !== null && !window.isDestroyed()) {
      const [width, height] = window.getContentSize();
      const { x, y } = window.getBounds();
      this.preferences = { ...this.preferences, width, height, x, y, alwaysOnTop: window.isAlwaysOnTop() };
    }
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const write = () => void fs.writeFile(this.preferencesFile(), JSON.stringify(this.preferences, null, 2)).catch((error: unknown) => log('preview', `preferences: ${String(error)}`));
    if (immediate) write();
    else this.saveTimer = setTimeout(write, 200);
  }

  /** The detached 3D window, if it is open and alive. */
  previewWindow(): BrowserWindow | null {
    return this.window !== null && !this.window.isDestroyed() ? this.window : null;
  }

  /** PNG bytes of the detached 3D window's current frame, or null when it is not open. */
  async capture(): Promise<Buffer | null> {
    const window = this.previewWindow();
    if (window === null) return null;
    const image = await window.webContents.capturePage();
    return image.toPNG();
  }

  async detach(owner: BrowserWindow, state: PreviewSnapshot): Promise<boolean> {
    this.state = state;
    if (this.window !== null && !this.window.isDestroyed()) {
      this.window.focus();
      this.window.webContents.send('preview-state', state);
      return true;
    }
    await this.readPreferences();
    this.owner = owner;
    const window = new BrowserWindow({
      width: this.preferences.width,
      height: this.preferences.height,
      useContentSize: true,
      ...(this.preferences.x !== undefined && this.preferences.y !== undefined ? { x: this.preferences.x, y: this.preferences.y } : {}),
      minWidth: 480,
      minHeight: 320,
      backgroundColor: '#000000',
      title: 'Lumatic — 3D',
      icon: path.join(this.distRoot, 'icon.png'),
      autoHideMenuBar: true,
      alwaysOnTop: this.preferences.alwaysOnTop,
      webPreferences: {
        backgroundThrottling: !this.keepUnthrottled,
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.window = window;
    window.on('resize', () => this.savePreferences());
    window.on('move', () => this.savePreferences());
    window.on('close', () => this.savePreferences(true));
    window.on('closed', () => {
      this.window = null;
      if (this.owner !== null && !this.owner.isDestroyed()) this.owner.webContents.send('preview-closed');
      this.owner = null;
    });
    if (!this.observedOwners.has(owner)) {
      this.observedOwners.add(owner);
      owner.once('closed', () => {
        if (this.window !== null && !this.window.isDestroyed()) this.window.close();
      });
    }
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        window.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('console-message', (details) => {
      if (details.level === 'warning' || details.level === 'error') log('preview', `${details.message} (${details.sourceId}:${String(details.lineNumber)})`);
    });
    const page = new URL('preview.html', process.env.CHROEDITOR_DEV_URL ?? 'app://local/');
    await window.loadURL(page.toString());
    return true;
  }

  sync(state: PreviewSnapshot) {
    this.state = state;
    if (this.window !== null && !this.window.isDestroyed()) this.window.webContents.send('preview-state', state);
  }

  tick(state: PreviewTick) {
    this.tickState = state;
    if (this.window !== null && !this.window.isDestroyed()) this.window.webContents.send('preview-tick', state);
  }

  patch(state: RemoteEditorPatch) {
    if (this.owner !== null && !this.owner.isDestroyed()) this.owner.webContents.send('preview-editor-patch', state);
  }

  hotkey(action: string) {
    if (this.owner !== null && !this.owner.isDestroyed()) this.owner.webContents.send('preview-hotkey', action);
  }

  keyState(code: string, down: boolean) {
    if (this.owner !== null && !this.owner.isDestroyed()) this.owner.webContents.send('preview-key-state', code, down);
  }

  ready(sender: WebContents) {
    if (this.state !== null) sender.send('preview-state', this.state);
    if (this.tickState !== null) sender.send('preview-tick', this.tickState);
    sender.send('preview-always-on-top', this.window?.isAlwaysOnTop() ?? this.preferences.alwaysOnTop);
  }

  setAlwaysOnTop(alwaysOnTop: boolean) {
    if (this.window !== null && !this.window.isDestroyed()) this.window.setAlwaysOnTop(alwaysOnTop);
    this.preferences.alwaysOnTop = alwaysOnTop;
    this.savePreferences();
    return alwaysOnTop;
  }

  close() {
    if (this.window !== null && !this.window.isDestroyed()) this.window.close();
  }
}
