import type { MapFolder } from './platform';

/**
 * The song as it was first put into the map, kept in the map's "Lumatic backups" folder: when the
 * silence in front of it is changed later the song is made again from this one — a single
 * compression, however many times it's changed (made from the map's ogg, compressed again each
 * time, it would lose a little more every time).
 */

const FOLDER = 'Lumatic backups';
const META = `${FOLDER}/song source.json`;

export interface SongSource {
  /** The file, in the map's folder. */
  file: string;
  /** Seconds of silence the map's song has in front of the source (below 0: cut off it). */
  lead: number;
}

/** The kept source and what it is (null: none — a map made elsewhere or before this was kept). */
export async function readSongSource(folder: MapFolder): Promise<{ source: SongSource; data: ArrayBuffer } | null> {
  try {
    const source = JSON.parse(await folder.readText(META)) as SongSource;
    if (typeof source.file !== 'string' || !Number.isFinite(source.lead)) return null;
    return { source, data: await folder.readBinary(source.file) };
  } catch {
    return null;
  }
}

/** Keeps `data` (a file named `name`) as the song's source, the map's song having `lead` seconds in front of it. */
export async function writeSongSource(folder: MapFolder, data: ArrayBuffer, name: string, lead: number): Promise<boolean> {
  const extension = /\.([a-z0-9]{1,5})$/iu.exec(name)?.[1]?.toLowerCase() ?? 'audio';
  const source: SongSource = { file: `${FOLDER}/song source.${extension}`, lead };
  try {
    await folder.writeBinary(source.file, data);
    await folder.writeText(META, JSON.stringify(source, null, 2));
    return true;
  } catch (error) {
    // (a folder that can't hold one — the browser's: the song is made from the map's own then)
    console.warn('[lumatic] the song source was not kept', error);
    return false;
  }
}

/** The map's song made again with `lead` seconds in front of the source. */
export async function setSongSourceLead(folder: MapFolder, source: SongSource, lead: number): Promise<void> {
  await folder.writeText(META, JSON.stringify({ ...source, lead }, null, 2)).catch(() => undefined);
}
