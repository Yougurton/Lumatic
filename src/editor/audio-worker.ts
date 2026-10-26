import { createOggEncoder } from 'wasm-media-encoders';

import { detectBpm, detectDownbeat } from './bpm-detect';

/**
 * Off the page's thread: the tempo of a song, and the song as Ogg Vorbis (what Beat Saber plays),
 * with silence put in front of it.
 */

export type AudioRequest =
  | { kind: 'bpm'; channels: Float32Array[]; sampleRate: number }
  | { kind: 'downbeat'; channels: Float32Array[]; sampleRate: number; bpm: number; firstBeat: number; beatsPerBar: number }
  | { kind: 'ogg'; channels: Float32Array[]; sampleRate: number; silence: number; quality: number };

export type AudioReply =
  | { kind: 'bpm'; result: ReturnType<typeof detectBpm> }
  | { kind: 'downbeat'; result: ReturnType<typeof detectDownbeat> }
  | { kind: 'progress'; done: number }
  | { kind: 'ogg'; data: Uint8Array }
  | { kind: 'error'; message: string };

const post = (reply: AudioReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = async (event: MessageEvent<AudioRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'bpm') {
      post({ kind: 'bpm', result: detectBpm(request.channels, request.sampleRate) });
      return;
    }
    if (request.kind === 'downbeat') {
      post({ kind: 'downbeat', result: detectDownbeat(request.channels, request.sampleRate, request.bpm, request.firstBeat, request.beatsPerBar) });
      return;
    }
    const encoder = await createOggEncoder();
    const channels = request.channels.slice(0, 2);
    encoder.configure({ channels: channels.length === 1 ? 1 : 2, sampleRate: request.sampleRate, vbrQuality: request.quality });
    const parts: Uint8Array[] = [];
    let size = 0;
    const keep = (chunk: Uint8Array) => {
      // (the encoder owns what it returns: copied)
      const copy = chunk.slice();
      parts.push(copy);
      size += copy.length;
    };
    const chunk = 16384;
    const silent = Math.round(request.silence * request.sampleRate);
    for (let at = 0; at < silent; at += chunk) {
      const length = Math.min(chunk, silent - at);
      keep(encoder.encode(channels.map(() => new Float32Array(length))));
    }
    const total = channels[0]!.length;
    for (let at = 0; at < total; at += chunk) {
      keep(encoder.encode(channels.map((channel) => channel.subarray(at, Math.min(total, at + chunk)))));
      if ((at / chunk) % 40 === 0) post({ kind: 'progress', done: at / total });
    }
    keep(encoder.finalize());
    const data = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }
    post({ kind: 'ogg', data }, [data.buffer]);
  } catch (error) {
    post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
