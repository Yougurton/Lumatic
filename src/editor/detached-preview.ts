import type { Preview } from './preview';
import type { PreviewSnapshot, RemoteEditorSnapshot } from './preview-state';

interface RemoteState {
  revision: string;
  state: RemoteEditorSnapshot;
}

/** Keeps the lightweight preview window in step with the editor's Preview. */
export class DetachedPreview {
  active = false;
  private sentRevision = -1;
  private sentRemoteRevision = '';
  private lastTick = 0;

  constructor(
    private readonly preview: Preview,
    private readonly beat: () => number,
    private readonly playing: () => boolean,
    private readonly beatRate: () => number,
    private readonly remote: (() => RemoteState) | null,
    private readonly changed: (detached: boolean) => void,
  ) {
    window.chroeditorNative?.preview?.onClosed(() => this.restore());
  }

  get available() {
    return window.chroeditorNative?.preview !== undefined;
  }

  async detach() {
    const api = window.chroeditorNative?.preview;
    if (api === undefined || this.active) return false;
    const opened = await api.detach(this.snapshot());
    if (!opened) return false;
    this.active = true;
    this.sentRevision = this.preview.revision;
    this.sentRemoteRevision = this.remote?.().revision ?? '';
    this.preview.setActive(false);
    this.changed(true);
    api.tick(this.preview.tick(this.beat(), this.playing(), this.beatRate()));
    return true;
  }

  close() {
    window.chroeditorNative?.preview?.close();
  }

  private restore() {
    if (!this.active) return;
    this.active = false;
    this.sentRevision = -1;
    this.sentRemoteRevision = '';
    this.preview.setActive(true);
    this.changed(false);
  }

  private snapshot(): PreviewSnapshot {
    return { ...this.preview.snapshot(), ...(this.remote === null ? {} : { editor: this.remote() }) };
  }

  tick(now: number) {
    if (!this.active) return;
    const api = window.chroeditorNative?.preview;
    if (api === undefined) return;
    const remoteRevision = this.remote?.().revision ?? '';
    if (this.sentRevision !== this.preview.revision || this.sentRemoteRevision !== remoteRevision) {
      api.sync(this.snapshot());
      this.sentRevision = this.preview.revision;
      this.sentRemoteRevision = remoteRevision;
    }
    if (now - this.lastTick < 33) return;
    this.lastTick = now;
    api.tick(this.preview.tick(this.beat(), this.playing(), this.beatRate()));
  }
}
