import type { AudioReply, AudioRequest } from './audio-worker';
import type { BpmResult } from './bpm-detect';

/** The song tools of the new-map dialog: decoding any audio file, the tempo, Ogg Vorbis. */

/** Decodes an audio file (mp3, wav, flac, ogg, m4a…) at 44.1 kHz. */
export async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, 1, 44100);
  return context.decodeAudioData(data.slice(0));
}

function channelsOf(buffer: AudioBuffer) {
  return Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, index) => buffer.getChannelData(index).slice());
}

function run(request: AudioRequest, onProgress?: (done: number) => void): Promise<AudioReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./audio-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<AudioReply>) => {
      const reply = event.data;
      if (reply.kind === 'progress') {
        onProgress?.(reply.done);
        return;
      }
      worker.terminate();
      if (reply.kind === 'error') reject(new Error(reply.message));
      else resolve(reply);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'audio worker failed'));
    };
    worker.postMessage(request, request.channels.map((channel) => channel.buffer));
  });
}

/** Where the song's strong beats are (see detectDownbeat). */
export async function findDownbeat(buffer: AudioBuffer, bpm: number, firstBeat: number, beatsPerBar: number) {
  const reply = await run({ kind: 'downbeat', channels: channelsOf(buffer), sampleRate: buffer.sampleRate, bpm, firstBeat, beatsPerBar });
  if (reply.kind !== 'downbeat') throw new Error('unexpected reply');
  return reply.result;
}

export async function findBpm(buffer: AudioBuffer): Promise<BpmResult> {
  const reply = await run({ kind: 'bpm', channels: channelsOf(buffer), sampleRate: buffer.sampleRate });
  if (reply.kind !== 'bpm') throw new Error('unexpected reply');
  return reply.result;
}

/** The song as Ogg Vorbis with `silence` seconds in front of it. */
export async function encodeOgg(buffer: AudioBuffer, silence: number, onProgress?: (done: number) => void): Promise<Uint8Array> {
  const reply = await run({ kind: 'ogg', channels: channelsOf(buffer), sampleRate: buffer.sampleRate, silence: Math.max(0, silence), quality: 6 }, onProgress);
  if (reply.kind !== 'ogg') throw new Error('unexpected reply');
  return reply.data;
}

/** Plays the song from `from` seconds with a click on every beat of the grid (to check a tempo by
 *  ear). Returns a stop function. */
export function playWithClicks(buffer: AudioBuffer, bpm: number, firstBeat: number, from: number, bar: { downbeat: number; beats: number } | null = null): () => void {
  const context = new AudioContext();
  const source = context.createBufferSource();
  source.buffer = buffer;
  const music = context.createGain();
  music.gain.value = 0.7;
  source.connect(music).connect(context.destination);
  const start = context.currentTime + 0.1;
  source.start(start, from);
  const period = 60 / bpm;
  const firstIndex = Math.ceil((from - firstBeat) / period);
  const clicks: OscillatorNode[] = [];
  for (let k = firstIndex; k < firstIndex + 64; k++) {
    const at = firstBeat + k * period - from;
    if (at < 0) continue;
    const osc = context.createOscillator();
    const gain = context.createGain();
    // (the strong beat — found, or every 4th — clicks higher)
    const strong = bar === null ? k % 4 === 0 : ((Math.round((firstBeat + k * period - bar.downbeat) / period) % bar.beats) + bar.beats) % bar.beats === 0;
    osc.frequency.value = strong ? 1760 : 1320;
    gain.gain.setValueAtTime(0.0001, start + at);
    gain.gain.exponentialRampToValueAtTime(0.5, start + at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.06);
    osc.connect(gain).connect(context.destination);
    osc.start(start + at);
    osc.stop(start + at + 0.08);
    clicks.push(osc);
  }
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void context.close();
  };
  window.setTimeout(stop, Math.min(64 * period, 30) * 1000);
  return stop;
}
