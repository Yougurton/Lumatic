import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

/**
 * Environments taken from the user's own copy of the game: the editor has the data of some of the
 * game's environments, and the rest are made from the installed game by scripts/game-environments.py
 * (Python with UnityPy and Pillow, which the user has to have). What it makes stays in the user's data
 * folder — it is the game's data and is never part of the app.
 */

export interface GameEnvironment {
  /** The name the game's files use: "panic2", "rockmixtape". */
  name: string;
  /** Megabytes of its scene file. */
  size: number;
}

export interface GameFolder {
  folder: string;
  /** "1.46.0_34060", or '' when the game doesn't say. */
  version: string;
  environments: GameEnvironment[];
}

export interface ImportedEnvironment {
  id: string;
  title: string;
  /** How many light groups it has (a GLS environment: more than none). */
  groups: number;
  /** What the converter did not understand, most first. */
  notUnderstood: [string, number][];
  gameVersion: string;
}

export const importedFolder = () => path.join(app.getPath('userData'), 'game-environments');

const bundles = (folder: string) => path.join(folder, 'Beat Saber_Data', 'StreamingAssets', 'aa', 'StandaloneWindows64');

/** The game in a folder: its version and the environments its files have (null: not the game's folder). */
export async function readGameFolder(folder: string): Promise<GameFolder | null> {
  let files: string[];
  try {
    files = await readdir(bundles(folder));
  } catch {
    return null;
  }
  const environments: GameEnvironment[] = [];
  for (const file of files) {
    const match = /^(.+)environment_scenes_all_[0-9a-f]+\.bundle$/u.exec(file);
    if (match === null) continue;
    environments.push({ name: match[1]!, size: 0 });
  }
  if (environments.length === 0) return null;
  let version = '';
  try {
    version = (await readFile(path.join(folder, 'BeatSaberVersion.txt'), 'utf8')).trim();
  } catch {
    // (older games have no such file)
  }
  return { folder, version, environments: environments.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** The environments made so far. */
export async function importedEnvironments(): Promise<ImportedEnvironment[]> {
  let files: string[];
  try {
    files = await readdir(importedFolder());
  } catch {
    return [];
  }
  const out: ImportedEnvironment[] = [];
  for (const file of files) {
    if (!file.endsWith('.report.json')) continue;
    try {
      const report = JSON.parse(await readFile(path.join(importedFolder(), file), 'utf8')) as { id: string; title?: string; groups?: number; notUnderstood?: Record<string, number>; gameVersion?: string };
      if (!existsSync(path.join(importedFolder(), `${report.id}.json`))) continue;
      out.push({
        id: report.id,
        title: report.title ?? report.id,
        groups: report.groups ?? 0,
        notUnderstood: Object.entries(report.notUnderstood ?? {}).sort((a, b) => b[1] - a[1]),
        gameVersion: report.gameVersion ?? '',
      });
    } catch {
      // (a report that can't be read: as if not made)
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

function scriptFiles() {
  // (packaged: beside the app's archive — Python can't read inside it; from the sources: in scripts/)
  const packaged = path.join(process.resourcesPath, 'game-environments.py');
  if (existsSync(packaged)) return { script: packaged, reference: path.join(process.resourcesPath, 'game-environment-materials.json') };
  const root = path.join(app.getAppPath(), 'scripts');
  return { script: path.join(root, 'game-environments.py'), reference: path.join(root, 'game-environment-materials.json') };
}

const run = (command: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string; error: string; missing: boolean }>((resolve) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (error, stdout, stderr) => {
      const missing = error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
      resolve({ ok: error === null, out: String(stdout), error: String(stderr), missing });
    });
  });

/** The Python to run the converter with: the launcher on Windows, then whatever is called python. */
const PYTHONS: [string, string[]][] = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];

export type ImportResult = { ok: true; environment: ImportedEnvironment } | { ok: false; reason: 'no-python' | 'no-modules' | 'failed'; detail: string };

/** Makes one environment from the game's files (some seconds to a minute). */
export async function importEnvironment(folder: string, name: string): Promise<ImportResult> {
  if (!/^[a-z0-9]+$/u.test(name)) return { ok: false, reason: 'failed', detail: 'bad environment name' };
  const game = await readGameFolder(folder);
  if (game === null) return { ok: false, reason: 'failed', detail: 'not a Beat Saber folder' };
  const { script, reference } = scriptFiles();
  if (!existsSync(script)) return { ok: false, reason: 'failed', detail: `no converter at ${script}` };
  await mkdir(importedFolder(), { recursive: true });
  let last = '';
  for (const [command, prefix] of PYTHONS) {
    const probe = await run(command, [...prefix, '-c', 'import UnityPy, PIL']);
    if (probe.missing) continue;
    if (!probe.ok) {
      // (a Python without the modules: say so rather than try the next, which is likely the same one)
      if (/ModuleNotFoundError|No module named/u.test(probe.error)) return { ok: false, reason: 'no-modules', detail: `${command} ${prefix.join(' ')}`.trim() };
      last = probe.error;
      continue;
    }
    const result = await run(command, [...prefix, '-I', script, folder, name, importedFolder(), reference]);
    if (!result.ok) return { ok: false, reason: 'failed', detail: (result.error || result.out).trim().split('\n').slice(-3).join('\n') };
    const made = (await importedEnvironments()).find((item) => result.out.includes(`"id": "${item.id}"`));
    if (made === undefined) return { ok: false, reason: 'failed', detail: 'the converter wrote nothing' };
    return { ok: true, environment: made };
  }
  return last === '' ? { ok: false, reason: 'no-python', detail: '' } : { ok: false, reason: 'failed', detail: last.trim().split('\n').slice(-3).join('\n') };
}

/** Takes a made environment away (its textures stay: others may use them). */
export async function removeImported(id: string) {
  if (!/^[A-Za-z0-9]+$/u.test(id)) return;
  await rm(path.join(importedFolder(), `${id}.json`), { force: true });
  await rm(path.join(importedFolder(), `${id}.report.json`), { force: true });
}
