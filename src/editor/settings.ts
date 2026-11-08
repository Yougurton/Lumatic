/**
 * The editor's settings (kept in this computer's storage, like the hotkeys): the language, what Ctrl+V
 * does, the 3D view, the timeline, the sound, saving. Read with `settings()`; changed with
 * `setSettings`, and whoever cares hears of it through `onSettings`.
 */

export type Language = 'ru' | 'en';

export interface Settings {
  language: Language;
  /** Ctrl+V: into the rows the events came from ('own'), or into the row under the mouse — the
   *  picked row when the mouse isn't over the timeline ('row'). */
  paste: 'own' | 'row';
  /** …at the song cursor or where the mouse is on the timeline. */
  pasteAt: 'cursor' | 'mouse';

  /** The floor's reflections (read when the 3D view is made: after a restart). */
  mirror: 'none' | 'low' | 'medium' | 'high';
  platform: boolean;
  /** The game's heat haze and other screen distortion. */
  distortion: boolean;
  /** Notes, bombs and walls in the 3D view too (on the lights side: the notes side always has them). */
  notes: boolean;
  /** The notes side's track: metres a beat along it (longer: the notes farther apart). */
  trackScale: number;
  /** The 3D track: how far behind the wall the passed notes still show (beats). */
  trackBehind: number;
  /** The notes side's track: the red line where the player's sight ends (the half jump). */
  visionLine: boolean;
  /** The show's lights in the 3D view (off: every lamp a dim white, nothing moving). */
  previewLights: boolean;
  /** Frames a second shown in the 3D view's corner. */
  fps: boolean;
  /** How many times a second the game's ring motion ticks (measured: ~30.6; Unity's usual step: 50):
   *  the 3D view's rings and the ring events the editor makes are worked out for it. */
  ringTicks: number;
  /** The whole window's scale (the desktop app). */
  uiScale: number;

  /** The wheel over the timeline: scrolls through the song, or moves the song cursor a grid step (as
   *  in ChroMapper). */
  wheel: 'time' | 'cursor';
  wheelSpeed: number;
  /** The timeline follows the song cursor while playing. */
  follow: boolean;
  /** The grid a map opens with (beats). */
  grid: number;

  /** The song's loudness (0–1). */
  volume: number;
  /** The sound comes this much later than the picture (ms): the cursor and the lights wait for it. */
  latency: number;
  metronome: boolean;
  /** A click at the start of every event on the picked row while playing. */
  eventClicks: boolean;
  /** On the notes side: a hit sound on every note while playing. */
  noteHits: boolean;
  /** …how loud (0–1). */
  noteHitVolume: number;
  /** The map checker's rules switched off (their ids). */
  disabledChecks: string[];
  /** Sending to a Quest: adb's path, the headset last picked, its Wi-Fi address, SongCore's folder,
   *  and how the game is made to see the new version. */
  /** adb picked by hand (empty: found — SideQuest's first). */
  adbPicked: string;
  questSerial: string;
  questAddress: string;
  questTarget: 'wip' | 'custom';
  questMode: 'restart' | 'fresh';
  /** Whose criteria the checker follows (one or more: their rules, the strictest of their thresholds). */
  checkSources: ('BSMG' | 'BL' | 'SS')[];
  clickVolume: number;

  /** Saved by itself every so many minutes while there are changes (0: never). */
  autosave: number;
  /** Copies of the difficulty before it's overwritten, in the map's "Lumatic backups" folder: how many
   *  to keep (0: none). */
  backups: number;
  /** The song's Ogg Vorbis quality when a map's song is made (Vorbis's -1…10; 6 ≈ 192 kbit/s). */
  oggQuality: number;
  /** The format of a new map's difficulty. */
  newFormat: '2' | '3';
}

const browserLanguage = (): Language => (/^(ru|uk|be|kk)\b/iu.test(navigator.language) ? 'ru' : 'en');

export const DEFAULT_SETTINGS: Settings = {
  language: browserLanguage(),
  paste: 'own',
  pasteAt: 'cursor',
  mirror: 'medium',
  platform: true,
  distortion: true,
  notes: false,
  previewLights: true,
  fps: true,
  visionLine: true,
  trackScale: 1.6,
  trackBehind: 1.5,
  ringTicks: 30.6,
  uiScale: 1,
  wheel: 'time',
  wheelSpeed: 1,
  follow: true,
  grid: 0.25,
  volume: 1,
  latency: 0,
  metronome: false,
  eventClicks: false,
  noteHits: true,
  noteHitVolume: 0.6,
  disabledChecks: [],
  checkSources: ['BSMG', 'BL', 'SS'],
  adbPicked: '',
  questSerial: '',
  questAddress: '',
  questTarget: 'wip',
  questMode: 'restart',
  clickVolume: 0.6,
  autosave: 0,
  backups: 5,
  newFormat: '3',
  oggQuality: 6,
};

const STORAGE = 'lumatic.settings';
let current: Settings = { ...DEFAULT_SETTINGS };
try {
  current = { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Partial<Settings>) };
} catch {
  current = { ...DEFAULT_SETTINGS };
}

const listeners: ((now: Settings, before: Settings) => void)[] = [];

export const settings = (): Readonly<Settings> => current;

export function setSettings(patch: Partial<Settings>) {
  const before = current;
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE, JSON.stringify(current));
  } catch {
    // (kept for this time only)
  }
  for (const listener of listeners) listener(current, before);
}

export function onSettings(listener: (now: Settings, before: Settings) => void) {
  listeners.push(listener);
}
