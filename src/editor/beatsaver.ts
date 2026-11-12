import { zipSync, type Zippable } from 'fflate';
import { tr } from './i18n';

/**
 * A map packed for BeatSaver: a zip of Info.dat and only what it points to — the song, the cover, the
 * difficulties (in v4 also the audio data and the lightshows), the contributors' pictures — all at the
 * zip's top. Lumatic's own files (projects, backups, the song's kept source) stay out.
 */

type Json = Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** The files Info.dat points to (as written there). */
export function referencedFiles(infoText: string): string[] {
  const info = JSON.parse(infoText) as Json;
  const out: (string | null)[] = [];
  if (String(info.version ?? '').startsWith('4')) {
    const audio = (info.audio ?? {}) as Json;
    out.push(text(audio.songFilename), text(audio.audioDataFilename), text(info.coverImageFilename));
    for (const entry of (info.difficultyBeatmaps ?? []) as Json[]) out.push(text(entry.beatmapDataFilename), text(entry.lightshowDataFilename));
  } else {
    out.push(text(info._songFilename), text(info._coverImageFilename));
    for (const set of (info._difficultyBeatmapSets ?? []) as Json[]) for (const entry of (set._difficultyBeatmaps ?? []) as Json[]) out.push(text(entry._beatmapFilename));
  }
  const custom = ((info._customData ?? info.customData) ?? {}) as Json;
  for (const person of (custom._contributors ?? custom.contributors ?? []) as Json[]) out.push(text(person._iconPath ?? person.iconPath));
  return [...new Set(out.filter((name): name is string => name !== null))];
}

export interface BeatSaverPack {
  /** The zip's bytes. */
  data: Uint8Array;
  /** What's in it. */
  files: string[];
  /** Files Info.dat points to that the folder hasn't. */
  missing: string[];
  /** What BeatSaver may not like. */
  warnings: string[];
}

/** BeatSaver's limit on a zip (bytes). */
export const BEATSAVER_LIMIT = 15 * 1024 * 1024;

/**
 * The zip: `files` — the folder's file names; `read` — a file's bytes. Already squeezed files (the
 * song, pictures) are stored as they are, the rest compressed.
 */
export async function packForBeatSaver(files: readonly string[], read: (name: string) => Promise<ArrayBuffer>): Promise<BeatSaverPack> {
  const find = (name: string) => files.find((file) => file.toLowerCase() === name.toLowerCase().replace(/\\/gu, '/'));
  const infoName = find('Info.dat');
  if (infoName === undefined) throw new Error('В папке карты нет Info.dat');
  const infoBytes = new Uint8Array(await read(infoName));
  const infoText = new TextDecoder().decode(infoBytes);
  const wanted = referencedFiles(infoText);
  const zip: Zippable = { 'Info.dat': [infoBytes, { level: 6 }] };
  const packed = ['Info.dat'];
  const missing: string[] = [];
  const warnings: string[] = [];
  for (const name of wanted) {
    const found = find(name);
    if (found === undefined) {
      missing.push(name);
      continue;
    }
    // (BeatSaver wants everything at the top: a file in a subfolder can't be found by the game there)
    if (name.includes('/') || name.includes('\\')) warnings.push(tr('Файл в подпапке: {0} — BeatSaver ждёт все файлы рядом с Info.dat', name));
    const stored = /\.(ogg|egg|png|jpe?g|webp)$/iu.test(name);
    zip[name] = [new Uint8Array(await read(found)), { level: stored ? 0 : 6 }];
    packed.push(name);
  }
  const info = JSON.parse(infoText) as Json;
  const song = String(info.version ?? '').startsWith('4') ? text(((info.audio ?? {}) as Json).songFilename) : text(info._songFilename);
  if (song !== null && !/\.(ogg|egg)$/iu.test(song)) warnings.push(tr('Песня не в ogg/egg: {0}', song));
  const cover = String(info.version ?? '').startsWith('4') ? text(info.coverImageFilename) : text(info._coverImageFilename);
  if (cover === null) warnings.push(tr('Нет обложки'));
  const data = zipSync(zip);
  if (data.byteLength > BEATSAVER_LIMIT) warnings.push(tr('Архив больше 15 МБ ({0} МБ) — BeatSaver его не примет', (data.byteLength / 1024 / 1024).toFixed(1)));
  return { data, files: packed, missing, warnings };
}

/** A name for the zip: "Artist - Title (mapper).zip", without what file names can't hold. */
export function packName(infoText: string): string {
  const info = JSON.parse(infoText) as Json;
  const v4 = String(info.version ?? '').startsWith('4');
  const song = (info.song ?? {}) as Json;
  const title = text(v4 ? song.title : info._songName) ?? 'map';
  const artist = text(v4 ? song.author : info._songAuthorName);
  const mappers = v4 ? (((info.difficultyBeatmaps ?? []) as Json[])[0]?.beatmapAuthors as Json | undefined)?.mappers : undefined;
  const mapper = text(v4 ? (Array.isArray(mappers) ? mappers[0] : null) : info._levelAuthorName);
  const name = `${artist === null ? '' : `${artist} - `}${title}${mapper === null ? '' : ` (${mapper})`}`;
  return `${name.replace(/[\\/:*?"<>|]+/gu, '_').trim() || 'map'}.zip`;
}
