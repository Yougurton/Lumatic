import { readTags } from '../src/editor/song-tags';

/**
 * A song file's title, artist and cover, made up in each format the new-map dialog takes: ID3 v2.3
 * (UTF-16) and v2.4 (UTF-8) with a picture, ID3 v1, FLAC, Ogg Vorbis (the comment packet over two
 * pages, a picture in it), Opus, MP4 and WAV.
 *
 * npx tsx tests/tags.ts
 */

let failures = 0;
let checks = 0;
const check = (ok: boolean, ...what: unknown[]) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('fail', ...what);
  }
};

const text = (value: string) => [...new TextEncoder().encode(value)];
const latin = (value: string) => [...value].map((char) => char.charCodeAt(0));
const be = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const le = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
const safe = (value: number) => [(value >> 21) & 127, (value >> 14) & 127, (value >> 7) & 127, value & 127];
const utf16 = (value: string) => [0xff, 0xfe, ...[...value].flatMap((char) => [char.charCodeAt(0) & 255, char.charCodeAt(0) >> 8])];
const jpeg = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9];
const png = [0x89, ...latin('PNG'), 13, 10, 26, 10, 9, 9, 9];
const buffer = (bytes: number[]) => Uint8Array.from(bytes).buffer;
const expect = (name: string, bytes: number[], title: string, artist: string, picture?: number[], type = 'image/jpeg') => {
  const tags = readTags(buffer(bytes));
  check(tags.title === title && tags.artist === artist, name, tags.title, tags.artist);
  if (picture !== undefined) check(tags.picture !== undefined && tags.picture.type === type && JSON.stringify([...tags.picture.data]) === JSON.stringify(picture), name, 'picture', tags.picture);
};

// ID3 v2.3: UTF-16 text, a picture with a description
{
  const frame = (id: string, body: number[]) => [...latin(id), ...be(body.length), 0, 0, ...body];
  const frames = [...frame('TIT2', [1, ...utf16('Песня')]), ...frame('TPE1', [1, ...utf16('Группа')]), ...frame('APIC', [1, ...latin('image/jpeg'), 0, 3, ...utf16('обложка'), 0, 0, ...jpeg])];
  expect('id3v2.3', [...latin('ID3'), 3, 0, 0, ...safe(frames.length), ...frames, 0xff, 0xfb, 0, 0], 'Песня', 'Группа', jpeg);
}
// ID3 v2.4: UTF-8, sizes syncsafe, a PNG said to be a jpeg
{
  const frame = (id: string, body: number[]) => [...latin(id), ...safe(body.length), 0, 0, ...body];
  const frames = [...frame('TIT2', [3, ...text('Title ✓'), 0]), ...frame('TPE1', [3, ...text('Artist')]), ...frame('APIC', [0, ...latin('image/jpeg'), 0, 3, 0, ...png])];
  expect('id3v2.4', [...latin('ID3'), 4, 0, 0, ...safe(frames.length + 20), ...frames, ...new Array(20).fill(0)], 'Title ✓', 'Artist', png, 'image/png');
}
// ID3 v2.2: three-letter frames
{
  const frame = (id: string, body: number[]) => [...latin(id), 0, 0, body.length, ...body];
  const frames = [...frame('TT2', [0, ...latin('Old')]), ...frame('TP1', [0, ...latin('Tagger')]), ...frame('PIC', [0, ...latin('JPG'), 3, 0, ...jpeg])];
  expect('id3v2.2', [...latin('ID3'), 2, 0, 0, ...safe(frames.length), ...frames], 'Old', 'Tagger', jpeg);
}
// ID3 v1 at the end
{
  const field = (value: string, length: number) => [...latin(value), ...new Array(length - value.length).fill(0)];
  expect('id3v1', [0xff, 0xfb, 1, 2, 3, ...latin('TAG'), ...field('One', 30), ...field('Two', 30), ...new Array(65).fill(0)], 'One', 'Two');
}

// Vorbis comments, and FLAC's picture block
const comments = (entries: string[]) => [...le(6), ...latin('vendor'), ...le(entries.length), ...entries.flatMap((entry) => [...le(text(entry).length), ...text(entry)])];
const pictureBlock = (data: number[], mime: string) => [...be(3), ...be(mime.length), ...latin(mime), ...be(0), ...be(1), ...be(1), ...be(24), ...be(0), ...be(data.length), ...data];
{
  const vorbis = comments(['title=Flac Song', 'ARTIST=Flac Band']);
  const picture = pictureBlock(png, 'image/png');
  const block = (type: number, last: boolean, body: number[]) => [(last ? 0x80 : 0) | type, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body];
  expect('flac', [...latin('fLaC'), ...block(0, false, new Array(34).fill(0)), ...block(4, false, vorbis), ...block(6, true, picture)], 'Flac Song', 'Flac Band', png, 'image/png');
}
// Ogg: the comment packet over two pages, the picture as METADATA_BLOCK_PICTURE
const page = (serial: number, sequence: number, packets: number[][], continued = false, open = false) => {
  const lacing: number[] = [];
  packets.forEach((packet, index) => {
    let left = packet.length;
    while (left >= 255) {
      lacing.push(255);
      left -= 255;
    }
    if (!(open && index === packets.length - 1)) lacing.push(left);
    else if (left > 0) lacing.push(left);
  });
  return [...latin('OggS'), 0, continued ? 1 : 0, ...new Array(8).fill(0), ...le(serial), ...le(sequence), ...le(0), lacing.length, ...lacing, ...packets.flat()];
};
{
  const picture = btoa(String.fromCharCode(...pictureBlock(jpeg, 'image/jpeg')));
  const packet = [3, ...latin('vorbis'), ...comments(['TITLE=Ogg Song', 'ARTIST=Ogg Band', `METADATA_BLOCK_PICTURE=${picture}`, `PADDING=${'x'.repeat(600)}`]), 1];
  const first = packet.slice(0, 510);
  const rest = packet.slice(510);
  const bytes = [...page(7, 0, [[1, ...latin('vorbis'), ...new Array(23).fill(0)]]), ...page(7, 1, [first], false, true), ...page(7, 2, [rest], true), ...page(7, 3, [[5, 5, 5]])];
  expect('ogg', bytes, 'Ogg Song', 'Ogg Band', jpeg);
  // Opus
  expect('opus', [...page(9, 0, [[...latin('OpusHead'), 1, 2]]), ...page(9, 1, [[...latin('OpusTags'), ...comments(['title=Opus', 'artist=Band'])]])], 'Opus', 'Band');
}
// MP4
{
  const atom = (type: number[] | string, body: number[]) => [...be(body.length + 8), ...(typeof type === 'string' ? latin(type) : type), ...body];
  const data = (kind: number, body: number[]) => atom('data', [...be(kind), ...be(0), ...body]);
  const ilst = atom('ilst', [...atom([0xa9, ...latin('nam')], data(1, text('M4A Song'))), ...atom([0xa9, ...latin('ART')], data(1, text('M4A Band'))), ...atom('covr', data(13, jpeg))]);
  const moov = atom('moov', [...atom('mvhd', new Array(20).fill(0)), ...atom('udta', atom('meta', [0, 0, 0, 0, ...atom('hdlr', new Array(25).fill(0)), ...ilst]))]);
  expect('mp4', [...atom('ftyp', latin('M4A \0\0\0\0')), ...moov, ...atom('mdat', [1, 2, 3])], 'M4A Song', 'M4A Band', jpeg);
}
// WAV
{
  const chunk = (id: string, body: number[]) => [...latin(id), ...le(body.length), ...body, ...(body.length % 2 === 1 ? [0] : [])];
  const info = [...latin('INFO'), ...chunk('INAM', [...text('Wav Song'), 0]), ...chunk('IART', [...text('Wav Band'), 0])];
  const body = [...latin('WAVE'), ...chunk('fmt ', new Array(16).fill(0)), ...chunk('LIST', info), ...chunk('data', [0, 0, 0, 0])];
  expect('wav', [...latin('RIFF'), ...le(body.length), ...body], 'Wav Song', 'Wav Band');
}
// nothing to read: nothing, no error
check(Object.keys(readTags(buffer([1, 2, 3]))).length === 0, 'none');
check(Object.keys(readTags(buffer([...latin('ID3'), 3, 0, 0, 127, 127, 127, 127, 1]))).length === 0, 'broken');

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
