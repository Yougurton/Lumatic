import { app } from 'electron';
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Lumatic's log: what went wrong (the page's errors and warnings, a window that stopped answering
 * or crashed, the main process's own failures), a file a day in the app's "logs" folder — the last
 * 14 kept. Something to look at (or send) after a hang.
 */

export const logFolder = () => path.join(app.getPath('userData'), 'logs');

let pruned = false;

export function log(kind: string, message: string) {
  try {
    const folder = logFolder();
    mkdirSync(folder, { recursive: true });
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    appendFileSync(path.join(folder, `lumatic-${day}.log`), `${now.toISOString()} [${kind}] ${message.replace(/\s+$/u, '')}\n`);
    if (!pruned) {
      pruned = true;
      const files = readdirSync(folder).filter((name) => /^lumatic-\d{4}-\d\d-\d\d\.log$/u.test(name)).sort();
      for (const old of files.slice(0, Math.max(0, files.length - 14))) rmSync(path.join(folder, old), { force: true });
    }
  } catch {
    // (no log is no reason to fail)
  }
}
