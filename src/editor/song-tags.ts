/**
 * What a song file says about itself: its title, artist and cover picture — from ID3 (mp3; v2.2–2.4,
 * and v1 at the end), Vorbis comments (ogg/opus, flac — with flac's own picture block or the
 * METADATA_BLOCK_PICTURE comment), MP4 atoms (m4a/aac: ©nam, ©ART, covr) and RIFF INFO (wav).
 * Anything it can't make sense of is left out, not an error.
 */

export interface SongTags {
  title?: string;
  artist?: string;
  album?: string;
  picture?: { data: Uint8Array; type: string };
}

export function readTags(buffer: ArrayBuffer): SongTags {
  const bytes = new Uint8Array(buffer);
  try {
    if (ascii(bytes, 0, 3) === 'ID3') return { ...id3v1(bytes), ...id3v2(bytes) };
    if (ascii(bytes, 0, 4) === 'fLaC') return flac(bytes);
    if (ascii(bytes, 0, 4) === 'OggS') return ogg(bytes);
    if (ascii(bytes, 4, 4) === 'ftyp') return mp4(bytes);
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return wav(bytes);
    return id3v1(bytes);
  } catch {
    return {};
  }
}

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
const be32 = (bytes: Uint8Array, at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
const le32 = (bytes: Uint8Array, at: number) => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
const syncsafe = (bytes: Uint8Array, at: number) => (bytes[at]! << 21) | (bytes[at + 1]! << 14) | (bytes[at + 2]! << 7) | bytes[at + 3]!;
const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);
const clean = (text: string) => text.replace(/\0+$/u, '').trim();

/** The picture's type from its first bytes (what a tag says is not always right). */
function imageType(data: Uint8Array, said = '') {
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x89 && ascii(data, 1, 3) === 'PNG') return 'image/png';
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(data, 0, 3) === 'GIF') return 'image/gif';
  return said.includes('/') ? said : 'image/jpeg';
}

// ----- ID3

function id3v1(bytes: Uint8Array): SongTags {
  const at = bytes.length - 128;
  if (at < 0 || ascii(bytes, at, 3) !== 'TAG') return {};
  const field = (from: number, length: number) => clean(new TextDecoder('latin1').decode(bytes.subarray(at + from, at + from + length)));
  const out: SongTags = {};
  const title = field(3, 30);
  const artist = field(33, 30);
  if (title !== '') out.title = title;
  if (artist !== '') out.artist = artist;
  return out;
}

/** Text in one of ID3's encodings (0 latin1, 1 UTF-16 with BOM, 2 UTF-16BE, 3 UTF-8). */
function id3Text(encoding: number, data: Uint8Array) {
  if (encoding === 1 || encoding === 2) {
    let little = encoding === 1;
    let from = 0;
    if (data[0] === 0xff && data[1] === 0xfe) [little, from] = [true, 2];
    else if (data[0] === 0xfe && data[1] === 0xff) [little, from] = [false, 2];
    return clean(new TextDecoder(little ? 'utf-16le' : 'utf-16be').decode(data.subarray(from, from + ((data.length - from) & ~1))));
  }
  return clean(new TextDecoder(encoding === 3 ? 'utf-8' : 'latin1').decode(data));
}

/** Where a string in that encoding ends (its terminator) from `at`, and where what follows starts. */
function terminated(encoding: number, data: Uint8Array, at: number): [number, number] {
  if (encoding === 1 || encoding === 2) {
    for (let i = at; i + 1 < data.length; i += 2) if (data[i] === 0 && data[i + 1] === 0) return [i, i + 2];
    return [data.length, data.length];
  }
  const end = data.indexOf(0, at);
  return end < 0 ? [data.length, data.length] : [end, end + 1];
}

function id3v2(bytes: Uint8Array): SongTags {
  const major = bytes[3]!;
  const flags = bytes[5]!;
  let tag = bytes.subarray(10, 10 + syncsafe(bytes, 6));
  // (unsynchronised: every FF 00 was an FF)
  if ((flags & 0x80) !== 0 && major < 4) {
    const out: number[] = [];
    for (let i = 0; i < tag.length; i++) if (!(tag[i - 1] === 0xff && tag[i] === 0)) out.push(tag[i]!);
    tag = Uint8Array.from(out);
  }
  let at = 0;
  if ((flags & 0x40) !== 0 && major >= 3) at = major === 4 ? syncsafe(tag, 0) : be32(tag, 0) + 4;
  const out: SongTags = {};
  const idLength = major === 2 ? 3 : 4;
  const head = major === 2 ? 6 : 10;
  while (at + head <= tag.length) {
    const id = ascii(tag, at, idLength);
    if (!/^[A-Z0-9]+$/u.test(id)) break;
    const size = major === 2 ? (tag[at + 3]! << 16) | (tag[at + 4]! << 8) | tag[at + 5]! : major === 4 ? syncsafe(tag, at + 4) : be32(tag, at + 4);
    const data = tag.subarray(at + head, at + head + size);
    at += head + size;
    if (size <= 0) continue;
    if (id === 'TIT2' || id === 'TT2') out.title = id3Text(data[0]!, data.subarray(1));
    else if (id === 'TPE1' || id === 'TP1') out.artist = id3Text(data[0]!, data.subarray(1));
    else if (id === 'TALB' || id === 'TAL') out.album = id3Text(data[0]!, data.subarray(1));
    else if ((id === 'APIC' || id === 'PIC') && out.picture === undefined) {
      const encoding = data[0]!;
      let mime: string;
      let next: number;
      if (id === 'PIC') {
        mime = `image/${ascii(data, 1, 3).toLowerCase().replace('jpg', 'jpeg')}`;
        next = 4;
      } else {
        const end = data.indexOf(0, 1);
        mime = ascii(data, 1, end - 1);
        next = end + 1;
      }
      // (the picture's kind, then its description)
      const [, after] = terminated(encoding, data, next + 1);
      const picture = data.slice(after);
      if (picture.length > 0) out.picture = { data: picture, type: imageType(picture, mime) };
    }
  }
  return out;
}

// ----- Vorbis comments (ogg, opus, flac)

function vorbisComments(data: Uint8Array): SongTags {
  let at = 4 + le32(data, 0);
  const count = le32(data, at);
  at += 4;
  const out: SongTags = {};
  for (let i = 0; i < count && at + 4 <= data.length; i++) {
    const length = le32(data, at);
    const text = utf8(data.subarray(at + 4, at + 4 + length));
    at += 4 + length;
    const split = text.indexOf('=');
    if (split < 0) continue;
    const key = text.slice(0, split).toUpperCase();
    const value = text.slice(split + 1).trim();
    if (key === 'TITLE' && out.title === undefined) out.title = value;
    else if (key === 'ARTIST' && out.artist === undefined) out.artist = value;
    else if (key === 'ALBUM' && out.album === undefined) out.album = value;
    else if (key === 'METADATA_BLOCK_PICTURE' && out.picture === undefined) {
      const binary = atob(value);
      const picture = flacPicture(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
      if (picture !== undefined) out.picture = picture;
    }
  }
  return out;
}

function flacPicture(data: Uint8Array): SongTags['picture'] {
  let at = 4;
  const mimeLength = be32(data, at);
  const mime = ascii(data, at + 4, mimeLength);
  at += 4 + mimeLength;
  at += 4 + be32(data, at);
  at += 16;
  const length = be32(data, at);
  const picture = data.slice(at + 4, at + 4 + length);
  return picture.length > 0 ? { data: picture, type: imageType(picture, mime) } : undefined;
}

function flac(bytes: Uint8Array): SongTags {
  let at = 4;
  let out: SongTags = {};
  for (let last = false; !last && at + 4 <= bytes.length; ) {
    last = (bytes[at]! & 0x80) !== 0;
    const type = bytes[at]! & 0x7f;
    const length = (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    const data = bytes.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    if (type === 4) out = { ...vorbisComments(data), ...(out.picture !== undefined ? { picture: out.picture } : {}) };
    else if (type === 6 && out.picture === undefined) {
      const picture = flacPicture(data);
      if (picture !== undefined) out.picture = picture;
    }
  }
  return out;
}

/** The first packets of an Ogg file's first stream (the comment header is the second). */
function oggPackets(bytes: Uint8Array, wanted: number): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let current: number[][] = [];
  let at = 0;
  let serial: number | null = null;
  while (at + 27 <= bytes.length && ascii(bytes, at, 4) === 'OggS' && packets.length < wanted) {
    const segments = bytes[at + 26]!;
    const pageSerial = le32(bytes, at + 14);
    const lacing = bytes.subarray(at + 27, at + 27 + segments);
    let body = at + 27 + segments;
    serial ??= pageSerial;
    for (const length of lacing) {
      if (pageSerial === serial) {
        current.push([...bytes.subarray(body, body + length)]);
        if (length < 255) {
          packets.push(Uint8Array.from(current.flat()));
          current = [];
        }
      }
      body += length;
    }
    at = body;
  }
  return packets;
}

function ogg(bytes: Uint8Array): SongTags {
  const comments = oggPackets(bytes, 2)[1];
  if (comments === undefined) return {};
  if (comments[0] === 3 && ascii(comments, 1, 6) === 'vorbis') return vorbisComments(comments.subarray(7));
  if (ascii(comments, 0, 8) === 'OpusTags') return vorbisComments(comments.subarray(8));
  return {};
}

// ----- MP4 (m4a, aac)

function mp4(bytes: Uint8Array): SongTags {
  const out: SongTags = {};
  /** The atoms between `from` and `to`: the ones that hold others gone into. */
  const walk = (from: number, to: number, path: string) => {
    let at = from;
    while (at + 8 <= to) {
      let size = be32(bytes, at);
      const type = ascii(bytes, at + 4, 4);
      let head = 8;
      if (size === 1) {
        size = be32(bytes, at + 12) + be32(bytes, at + 8) * 2 ** 32;
        head = 16;
      } else if (size === 0) size = to - at;
      if (size < head) break;
      const end = Math.min(to, at + size);
      if (type === 'moov' || type === 'udta' || type === 'ilst') walk(at + head, end, `${path}/${type}`);
      else if (type === 'meta') walk(at + head + 4, end, `${path}/meta`);
      else if (path.endsWith('/ilst')) {
        // (each item holds a 'data' atom: its kind, a locale, the value)
        const data = at + head;
        if (ascii(bytes, data + 4, 4) === 'data') {
          const length = be32(bytes, data);
          const kind = be32(bytes, data + 8) & 0xffffff;
          const value = bytes.subarray(data + 16, data + length);
          if (type === '©nam') out.title = clean(utf8(value));
          else if (type === '©ART' || (type === 'aART' && out.artist === undefined)) out.artist = clean(utf8(value));
          else if (type === '©alb') out.album = clean(utf8(value));
          else if (type === 'covr' && out.picture === undefined && value.length > 0) out.picture = { data: value.slice(), type: imageType(value, kind === 14 ? 'image/png' : 'image/jpeg') };
        }
      }
      at += size;
    }
  };
  walk(0, bytes.length, '');
  return out;
}

// ----- WAV

function wav(bytes: Uint8Array): SongTags {
  const out: SongTags = {};
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, 4);
    const size = le32(bytes, at + 4);
    if (id === 'LIST' && ascii(bytes, at + 8, 4) === 'INFO') {
      let inner = at + 12;
      while (inner + 8 <= at + 8 + size) {
        const key = ascii(bytes, inner, 4);
        const length = le32(bytes, inner + 4);
        const value = clean(utf8(bytes.subarray(inner + 8, inner + 8 + length)));
        if (key === 'INAM') out.title = value;
        else if (key === 'IART') out.artist = value;
        else if (key === 'IPRD') out.album = value;
        inner += 8 + length + (length & 1);
      }
    }
    at += 8 + size + (size & 1);
  }
  return { ...id3v1(bytes), ...out };
}
