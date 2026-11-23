import { app, net } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Updates from the project's GitHub releases: the newest release's version and what's new in it (its
 * description), its Windows zip downloaded, and — once the app is closed — put in place of the app's
 * files by a small PowerShell script, the app started again.
 */

/** Where the releases are (a public repository: the app asks without a sign-in). */
export const UPDATE_REPO = 'Yougurton/Lumatic';

export interface UpdateInfo {
  /** The app's own version. */
  current: string;
  /** The newest release's version (null: no release at all). */
  latest: string | null;
  newer: boolean;
  /** What's new (the release's description, Markdown). */
  notes: string;
  /** The release's page. */
  page: string;
  /** The zip for Windows in it (null: none). */
  asset: { url: string; size: number; name: string } | null;
}

/** Whether version `a` is later than `b` (1.2.10 > 1.2.9). */
export function laterThan(a: string, b: string): boolean {
  const parts = (value: string) => value.replace(/^v/iu, '').split(/[.-]/u).map((part) => Number.parseInt(part, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let k = 0; k < Math.max(x.length, y.length); k++) {
    const diff = (x[k] ?? 0) - (y[k] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion();
  const response = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Lumatic' } });
  if (response.status === 404) return { current, latest: null, newer: false, notes: '', page: `https://github.com/${UPDATE_REPO}/releases`, asset: null };
  if (!response.ok) throw new Error(`GitHub: ${String(response.status)}`);
  const release = (await response.json()) as { tag_name?: string; name?: string; body?: string; html_url?: string; assets?: { name: string; browser_download_url: string; size: number }[] };
  const latest = (release.tag_name ?? release.name ?? '').replace(/^v/iu, '');
  const zip = (release.assets ?? []).find((asset) => /win.*\.zip$/iu.test(asset.name));
  return {
    current,
    latest,
    newer: latest !== '' && laterThan(latest, current),
    notes: release.body ?? '',
    page: release.html_url ?? `https://github.com/${UPDATE_REPO}/releases`,
    asset: zip === undefined ? null : { url: zip.browser_download_url, size: zip.size, name: zip.name },
  };
}

const updateFolder = () => path.join(app.getPath('temp'), 'lumatic-update');

/** The release's zip downloaded (`progress`: 0…1). Where it is. */
export async function downloadUpdate(url: string, size: number, progress: (done: number) => void): Promise<string> {
  const folder = updateFolder();
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, 'update.zip');
  const response = await net.fetch(url, { headers: { 'User-Agent': 'Lumatic' } });
  if (!response.ok || response.body === null) throw new Error(`download: ${String(response.status)}`);
  const total = Number(response.headers.get('content-length')) || size || 1;
  const out = createWriteStream(file);
  const reader = response.body.getReader();
  let done = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    done += chunk.value.byteLength;
    if (!out.write(chunk.value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    progress(Math.min(1, done / total));
  }
  await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
  return file;
}

/** Whether this app can put an update in place itself (the Windows app, not run from the sources). */
export const canInstall = () => process.platform === 'win32' && app.isPackaged;

/**
 * The downloaded zip put in place of the app's files once the app has closed, the app started again:
 * a PowerShell script waits for this process to end, unpacks the zip and copies it over the app's
 * folder (files only added and replaced — nothing of the user's deleted). The app quits after.
 */
export async function installUpdate(zip: string): Promise<void> {
  if (!canInstall()) throw new Error('not the Windows app');
  const appDir = path.dirname(process.execPath);
  const exe = path.basename(process.execPath);
  const unpacked = path.join(updateFolder(), 'unpacked');
  const quote = (value: string) => `'${value.replace(/'/gu, "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `try { Wait-Process -Id ${String(process.pid)} -Timeout 60 -ErrorAction SilentlyContinue } catch {}`,
    `if (Test-Path ${quote(unpacked)}) { Remove-Item ${quote(unpacked)} -Recurse -Force }`,
    `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(unpacked)} -Force`,
    // (a zip with the app in a folder of its own: that folder)
    `$from = ${quote(unpacked)}`,
    `$inner = Get-ChildItem -LiteralPath $from`,
    `if ($inner.Count -eq 1 -and $inner[0].PSIsContainer) { $from = $inner[0].FullName }`,
    `robocopy $from ${quote(appDir)} /E /R:5 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null`,
    `Start-Process -FilePath (Join-Path ${quote(appDir)} ${quote(exe)})`,
  ].join('\r\n');
  const file = path.join(updateFolder(), 'update.ps1');
  await fs.writeFile(file, `﻿${script}`, 'utf8');
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => app.quit(), 200);
}
