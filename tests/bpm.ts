import { readFileSync, readdirSync } from 'node:fs';
import { OggVorbisDecoder } from '@wasm-audio-decoders/ogg-vorbis';
import { detectBpm } from '../src/editor/bpm-detect';

for (const dir of process.argv.slice(2)) {
  const files = readdirSync(dir);
  const song = files.find((name) => /\.(ogg|egg)$/i.test(name));
  const infoName = files.find((name) => name.toLowerCase() === 'info.dat')!;
  const info = JSON.parse(readFileSync(`${dir}/${infoName}`, 'utf8'));
  if (song === undefined) continue;
  const decoder = new OggVorbisDecoder();
  await decoder.ready;
  const decoded = await decoder.decodeFile(new Uint8Array(readFileSync(`${dir}/${song}`)));
  const t0 = performance.now();
  const result = detectBpm(decoded.channelData, decoded.sampleRate);
  console.log(dir.split('/').at(-1), 'info', info._beatsPerMinute ?? info.audio?.bpm, 'offset', info._songTimeOffset, '→', JSON.stringify({ ...result, firstBeat: result.firstBeat.toFixed(3) }), `${(performance.now() - t0).toFixed(0)} ms`);
  decoder.free();
}
