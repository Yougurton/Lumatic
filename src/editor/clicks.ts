import type { Editor } from './editor';
import { settings } from './settings';

/**
 * Clicks while the song plays (as the settings say): the metronome on every beat (higher on every
 * 4th), and a click at the start of every event on the picked row — to hear whether the lights are on
 * the music. Scheduled a little ahead on their own audio clock, so they keep time between frames.
 */

/** How far ahead clicks are put on the audio clock (seconds of the song). */
const AHEAD = 0.15;

export class Clicks {
  private context: AudioContext | null = null;
  /** The song's time clicks are scheduled up to (seconds); null: not playing. */
  private until: number | null = null;

  constructor(private readonly editor: Editor) {
    window.setInterval(() => this.tick(), 25);
  }

  private tick() {
    const editor = this.editor;
    const { metronome, eventClicks, clickVolume } = settings();
    const noteHits = settings().noteHits && settings().noteHitVolume > 0 && editor.tab === 'notes';
    if (!editor.isPlaying() || (!metronome && !eventClicks && !noteHits) || (clickVolume <= 0 && !noteHits)) {
      this.until = null;
      return;
    }
    const now = editor.songSeconds();
    // (from where the song is when it starts or jumps; on from where it was scheduled to)
    const from = this.until === null || this.until < now - 0.2 || this.until > now + AHEAD * 2 ? now : this.until;
    const to = now + AHEAD;
    this.until = to;
    if (to <= from) return;
    const context = this.audio();
    const start = editor.secondsToBeat(from);
    const end = editor.secondsToBeat(to);
    const clicks: { beat: number; pitch: number; volume?: number }[] = [];
    if (metronome) {
      for (let beat = Math.floor(start) + 1; beat <= end; beat++) if (beat > start) clicks.push({ beat, pitch: beat % 4 === 0 ? 1760 : 1320 });
    }
    if (noteHits) {
      const beats = new Set(editor.objects.notes.map((note) => Math.round(note.b * 1000) / 1000));
      for (const beat of beats) if (beat > start && beat <= end) clicks.push({ beat, pitch: 2900, volume: settings().noteHitVolume });
    }
    if (eventClicks && editor.tab === 'lights') {
      const row = editor.libraryRow();
      if (row !== null) {
        const starts = new Set(editor.rowClips(row).map((shown) => Math.round(shown.clip.start * 1000) / 1000));
        for (const beat of starts) if (beat > start && beat <= end) clicks.push({ beat, pitch: 2400 });
      }
    }
    for (const click of clicks) {
      const wait = (editor.beatToSeconds(click.beat) - now) / editor.rate;
      this.click(context, context.currentTime + Math.max(0, wait), click.pitch, click.volume ?? clickVolume);
    }
  }

  private audio() {
    this.context ??= new AudioContext();
    if (this.context.state === 'suspended') void this.context.resume();
    return this.context;
  }

  private click(context: AudioContext, at: number, pitch: number, volume: number) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = pitch;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.6 * volume), at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(gain).connect(context.destination);
    osc.start(at);
    osc.stop(at + 0.07);
  }
}
