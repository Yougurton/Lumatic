import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * A copy of a map's file before it's overwritten: "<name> <date> <time>.<ext>" in the map folder's
 * "Lumatic backups", the oldest copies of that file past `keep` deleted. Nothing when the file isn't
 * there yet.
 */
export async function backupFile(file: string, keep: number, now = new Date()) {
  try {
    await fs.access(file);
  } catch {
    return;
  }
  const folder = path.join(path.dirname(file), 'Lumatic backups');
  await fs.mkdir(folder, { recursive: true });
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const stamp = `${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1)}${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  await fs.copyFile(file, path.join(folder, `${base} ${stamp}${ext}`));
  const copies = (await fs.readdir(folder)).filter((name) => name.startsWith(`${base} `) && name.endsWith(ext) && /^\d{8} \d{6}$/u.test(name.slice(base.length + 1, name.length - ext.length))).sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - Math.max(1, keep)))) await fs.unlink(path.join(folder, old));
}
