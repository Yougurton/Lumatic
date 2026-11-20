import { promises as fs } from 'node:fs';
import path from 'node:path';

export type MapLibraryKind = 'wip' | 'levels';

export interface GameInstallation {
  folder: string;
  version: string;
}

export interface MapLibraryEntry {
  path: string;
  songName: string;
  songAuthor: string;
  mapAuthor: string;
  environment: string;
  infoVersion: string;
  versions: string[];
  modified: number;
  cover: string | null;
}

function resolved(value: string) {
  const result = path.resolve(value);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function directChild(root: string, target: string) {
  return resolved(path.dirname(target)) === resolved(root);
}

async function directoryExists(folder: string) {
  try {
    return (await fs.stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

async function gameVersion(folder: string) {
  try {
    return (await fs.readFile(path.join(folder, 'BeatSaberVersion.txt'), 'utf8')).trim();
  } catch {
    return path.basename(folder);
  }
}

export async function gameInstallations(folder: string): Promise<GameInstallation[]> {
  const candidates = new Set<string>();
  if (folder.trim() !== '') candidates.add(path.resolve(folder));
  const instances = path.join(folder, 'BSManager', 'BSInstances');
  try {
    for (const entry of await fs.readdir(instances, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.add(path.join(instances, entry.name));
    }
  } catch {
    // BSManager is optional.
  }
  try {
    const config = JSON.parse(await fs.readFile(path.join(folder, 'BSManager', 'config.cfg'), 'utf8')) as { 'custom-versions'?: unknown };
    if (Array.isArray(config['custom-versions'])) {
      for (const item of config['custom-versions']) {
        if (typeof item === 'string') candidates.add(item);
        else if (typeof item === 'object' && item !== null) {
          const record = item as Record<string, unknown>;
          const custom = record.path ?? record.folder ?? record.location;
          if (typeof custom === 'string') candidates.add(custom);
        }
      }
    }
  } catch {
    // Custom installation paths are optional too.
  }
  const out: GameInstallation[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = resolved(candidate);
    if (seen.has(key) || !(await directoryExists(path.join(candidate, 'Beat Saber_Data')))) continue;
    seen.add(key);
    out.push({ folder: candidate, version: await gameVersion(candidate) });
  }
  return out.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
}

function major(value: unknown) {
  const match = /^(\d+)/u.exec(String(value ?? ''));
  return match?.[1] ?? '';
}

function difficultyFiles(value: unknown, out: string[] = []) {
  if (Array.isArray(value)) for (const item of value) difficultyFiles(item, out);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if ((key === '_beatmapFilename' || key === 'beatmapDataFilename') && typeof item === 'string') out.push(item);
      else difficultyFiles(item, out);
    }
  }
  return out;
}

function mapAuthors(info: Record<string, unknown>) {
  const classic = String(info._levelAuthorName ?? '');
  if (classic !== '') return classic;
  const authors = new Set<string>();
  const beatmaps = Array.isArray(info.difficultyBeatmaps) ? info.difficultyBeatmaps : [];
  for (const beatmap of beatmaps) {
    if (typeof beatmap !== 'object' || beatmap === null) continue;
    const credits = (beatmap as Record<string, unknown>).beatmapAuthors;
    if (typeof credits !== 'object' || credits === null) continue;
    const mappers = (credits as Record<string, unknown>).mappers;
    if (Array.isArray(mappers)) for (const mapper of mappers) if (typeof mapper === 'string') authors.add(mapper);
  }
  if (authors.size > 0) return [...authors].join(', ');
  const beatmapsWithLighters = beatmaps.flatMap((beatmap) => {
    if (typeof beatmap !== 'object' || beatmap === null) return [];
    const credits = (beatmap as Record<string, unknown>).beatmapAuthors;
    if (typeof credits !== 'object' || credits === null) return [];
    const lighters = (credits as Record<string, unknown>).lighters;
    return Array.isArray(lighters) ? lighters.filter((item): item is string => typeof item === 'string') : [];
  });
  return [...new Set(beatmapsWithLighters)].join(', ');
}

async function fileVersion(file: string) {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(512);
      await handle.read(buffer, 0, buffer.length, 0);
      return major(/"_?version"\s*:\s*"(\d+)/u.exec(buffer.toString('utf8'))?.[1]);
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

const entryCache = new Map<string, { modified: number; entry: MapLibraryEntry }>();

async function readMapEntry(folder: string): Promise<MapLibraryEntry | null> {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const infoName = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'info.dat')?.name;
    if (infoName === undefined) return null;
    let modified = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await fs.stat(path.join(folder, entry.name));
      modified = Math.max(modified, stat.mtimeMs);
    }
    const cached = entryCache.get(folder);
    if (cached?.modified === modified) return cached.entry;
    const info = JSON.parse(await fs.readFile(path.join(folder, infoName), 'utf8')) as Record<string, unknown>;
    const song = (typeof info.song === 'object' && info.song !== null ? info.song : {}) as Record<string, unknown>;
    const audio = (typeof info.audio === 'object' && info.audio !== null ? info.audio : {}) as Record<string, unknown>;
    const versions = new Set<string>();
    const infoVersion = major(info._version ?? info.version);
    if (infoVersion !== '') versions.add(infoVersion);
    for (const file of difficultyFiles(info)) {
      const version = await fileVersion(path.join(folder, file));
      if (version !== '') versions.add(version);
    }
    const coverName = String(info._coverImageFilename ?? info.coverImageFilename ?? '');
    const cover = coverName === '' ? null : path.join(folder, coverName);
    const entry = {
      path: folder,
      songName: String(info._songName ?? song.title ?? path.basename(folder)),
      songAuthor: String(info._songAuthorName ?? song.author ?? ''),
      mapAuthor: mapAuthors(info),
      environment: String(info._environmentName ?? (Array.isArray(info.environmentNames) ? info.environmentNames[0] : '') ?? ''),
      infoVersion,
      versions: [...versions].sort((a, b) => Number(a) - Number(b)),
      modified,
      cover: cover !== null && (await fs.stat(cover).catch(() => null))?.isFile() === true ? cover : null,
    };
    entryCache.set(folder, { modified, entry });
    return entry;
  } catch {
    return null;
  }
}

async function scanKind(gameFolder: string, kind: MapLibraryKind) {
  const root = path.join(gameFolder, 'Beat Saber_Data', kind === 'wip' ? 'CustomWIPLevels' : 'CustomLevels');
  const out: MapLibraryEntry[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const folders = entries.filter((entry) => entry.isDirectory());
    for (let index = 0; index < folders.length; index += 16) {
      const maps = await Promise.all(folders.slice(index, index + 16).map((entry) => readMapEntry(path.join(root, entry.name))));
      out.push(...maps.filter((map): map is MapLibraryEntry => map !== null));
    }
  } catch {
    // A missing library is an empty one.
  }
  return out;
}

export async function scanMapLibrary(gameFolder: string) {
  const [wip, levels] = await Promise.all([scanKind(gameFolder, 'wip'), scanKind(gameFolder, 'levels')]);
  return { wip, levels };
}

export async function mapLibraryKind(folder: string, gameFolder: string): Promise<MapLibraryKind | null> {
  if (directChild(path.join(gameFolder, 'Beat Saber_Data', 'CustomLevels'), folder)) return 'levels';
  if (directChild(path.join(gameFolder, 'Beat Saber_Data', 'CustomWIPLevels'), folder)) return 'wip';
  return null;
}

export async function readMapCover(file: string, gameFolder: string) {
  const kind = await mapLibraryKind(path.dirname(file), gameFolder);
  if (kind === null || !/\.(?:png|jpe?g|webp)$/iu.test(file)) return null;
  const data = await fs.readFile(file);
  if (data.byteLength > 8 * 1024 * 1024) return null;
  const extension = path.extname(file).toLowerCase();
  const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${data.toString('base64')}`;
}

export async function copyMapToWip(source: string, gameFolder: string) {
  if ((await mapLibraryKind(source, gameFolder)) !== 'levels') throw new Error('Копировать можно только карту из CustomLevels');
  const root = path.join(gameFolder, 'Beat Saber_Data', 'CustomWIPLevels');
  await fs.mkdir(root, { recursive: true });
  const base = `${path.basename(source)} (copy)`;
  let destination = path.join(root, base);
  for (let index = 2; ; index++) {
    if (!(await directoryExists(destination))) break;
    destination = path.join(root, `${base} ${String(index)}`);
  }
  await fs.cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    filter: (entry) => !/(?:^|[\\/])(?:lumatic|chroeditor) backups(?:[\\/]|$)/iu.test(entry),
  });
  return destination;
}
