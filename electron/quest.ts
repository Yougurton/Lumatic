import { app, net } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

/**
 * Sending a map to a Quest over adb (a cable or Wi-Fi): finding adb (the user's own, SideQuest's, the
 * Android SDK's, or Google's platform-tools downloaded on request), the headsets, Wi-Fi debugging, and
 * the upload itself.
 *
 * Why a map sent again doesn't change in the game (ChroMapper's trouble): the Quest's SongCore keeps
 * every level it loaded under its folder's path, and "Refresh Songs" doesn't read a path it already
 * has again — only starting the game does (or deleting the level in the game, which drops it). Its
 * cache of level hashes is also keyed by the path, checked by the files' sizes and times. So an upload
 * here either restarts the game after the files are in place (a fresh load of everything), or puts
 * the map in a folder of a new name (a path SongCore hasn't seen: "Refresh Songs" loads it), deleting
 * the folder of the copy before; the files' times are set anew either way.
 */

const GAME = 'com.beatgames.beatsaber';
const MOD_DATA = `/sdcard/ModData/${GAME}/Mods`;

type Run = { code: number; out: string; err: string };

function run(file: string, args: string[], timeout = 120_000): Promise<Run> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1;
      resolve({ code, out: String(stdout), err: String(stderr) || (error?.message ?? '') });
    });
  });
}

const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
const downloaded = () => path.join(app.getPath('userData'), 'platform-tools', exe);

/** Where adb may be: the one picked, the downloaded one, SideQuest's, the Android SDK's, the PATH. */
function candidates(picked: string | undefined) {
  // (SideQuest's first: one adb server for both — an adb of another version restarts the server, and
  // the headsets connected over Wi-Fi drop off)
  const out: string[] = [];
  if (picked !== undefined && picked !== '') out.push(picked);
  const env = process.env;
  if (process.platform === 'win32') {
    if (env.APPDATA !== undefined) out.push(path.join(env.APPDATA, 'SideQuest', 'platform-tools', exe));
    if (env.LOCALAPPDATA !== undefined) out.push(path.join(env.LOCALAPPDATA, 'Programs', 'SideQuest', 'resources', 'app.asar.unpacked', 'build', 'platform-tools', exe));
    if (env.ProgramFiles !== undefined) out.push(path.join(env.ProgramFiles, 'SideQuest', 'resources', 'app.asar.unpacked', 'build', 'platform-tools', exe));
  } else {
    const home = app.getPath('home');
    out.push(path.join(home, '.config', 'SideQuest', 'platform-tools', exe), path.join(home, 'Library', 'Application Support', 'SideQuest', 'platform-tools', exe));
  }
  out.push(downloaded());
  if (process.platform === 'win32') {
    if (env.LOCALAPPDATA !== undefined) out.push(path.join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', exe));
  } else {
    const home = app.getPath('home');
    out.push(path.join(home, 'Android', 'Sdk', 'platform-tools', exe), path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', exe), '/usr/bin/adb', '/usr/local/bin/adb', '/opt/homebrew/bin/adb');
  }
  if (env.ANDROID_HOME !== undefined) out.push(path.join(env.ANDROID_HOME, 'platform-tools', exe));
  out.push('adb');
  return out;
}

let adbPath: string | null = null;

/** Finds a working adb (null: none). */
export async function findAdb(picked?: string): Promise<{ path: string; version: string } | null> {
  for (const candidate of candidates(picked)) {
    if (candidate !== 'adb' && !existsSync(candidate)) continue;
    const result = await run(candidate, ['version'], 15_000);
    if (result.code === 0) {
      adbPath = candidate;
      return { path: candidate, version: result.out.split('\n')[0]?.trim() ?? '' };
    }
  }
  adbPath = null;
  return null;
}

/** Google's platform-tools (adb) fetched into the app's own folder. */
export async function downloadAdb(): Promise<{ path: string; version: string } | null> {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const response = await net.fetch(`https://dl.google.com/android/repository/platform-tools-latest-${platform}.zip`);
  if (!response.ok) throw new Error(`download failed: ${String(response.status)}`);
  const folder = app.getPath('userData');
  const zip = path.join(folder, 'platform-tools.zip');
  await fs.writeFile(zip, Buffer.from(await response.arrayBuffer()));
  await fs.rm(path.join(folder, 'platform-tools'), { recursive: true, force: true });
  const unpacked =
    process.platform === 'win32'
      ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/gu, "''")}' -DestinationPath '${folder.replace(/'/gu, "''")}' -Force`], 300_000)
      : await run('unzip', ['-o', zip, '-d', folder], 300_000);
  await fs.rm(zip, { force: true });
  if (unpacked.code !== 0) throw new Error(unpacked.err || 'unzip failed');
  if (process.platform !== 'win32') await fs.chmod(downloaded(), 0o755).catch(() => undefined);
  return findAdb(downloaded());
}

async function adb(args: string[], timeout?: number) {
  if (adbPath === null && (await findAdb()) === null) throw new Error('adb not found');
  return run(adbPath!, args, timeout);
}

export interface QuestDevice {
  serial: string;
  /** 'device' (ready), 'unauthorized' (allow it in the headset), 'offline'… */
  state: string;
  model: string;
  wifi: boolean;
}

export async function devices(): Promise<QuestDevice[]> {
  const result = await adb(['devices', '-l'], 20_000);
  return result.out
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('*'))
    .map((line) => {
      const [serial = '', state = ''] = line.split(/\s+/u);
      const model = /model:(\S+)/u.exec(line)?.[1]?.replace(/_/gu, ' ') ?? '';
      return { serial, state, model, wifi: /:\d+$/u.test(serial) || serial.includes('._adb-tls-connect') };
    });
}

/** `adb connect` to a headset's address (port 5555 when none given). */
export async function connect(address: string) {
  const target = address.includes(':') ? address : `${address}:5555`;
  const result = await adb(['connect', target], 20_000);
  const text = `${result.out}${result.err}`.trim();
  return { ok: /connected to/iu.test(text) && !/cannot|failed|unable/iu.test(text), text, address: target };
}

/** Pairing with a headset's "Wireless debugging" (Android 11+): its pairing address and code. */
export async function pair(address: string, code: string) {
  const result = await adb(['pair', address, code], 30_000);
  const text = `${result.out}${result.err}`.trim();
  return { ok: /successfully paired/iu.test(text), text };
}

/** Whether something listens on a port (a short try). */
function open(host: string, port: number, timeout: number) {
  return new Promise<boolean>((resolve) => {
    const socket = new Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Headsets on the network found and connected (as SideQuest does, no cable needed): the ones adb's
 * mDNS sees (wireless debugging), the addresses used before, and any machine of this computer's local
 * networks with adb listening on 5555 (adb over Wi-Fi left on since it was switched on).
 */
export async function discover(remembered: string[]) {
  const found = new Set<string>();
  const mdns = await adb(['mdns', 'services'], 10_000).catch(() => null);
  for (const line of (mdns?.out ?? '').split('\n')) {
    if (!/_adb(-tls-connect)?\._tcp/u.test(line)) continue;
    const address = /(\d+\.\d+\.\d+\.\d+:\d+)/u.exec(line)?.[1];
    if (address !== undefined) found.add(address);
  }
  for (const address of remembered) if (address.trim() !== '') found.add(address.includes(':') ? address.trim() : `${address.trim()}:5555`);
  // the local networks (/24 around each private IPv4 address of this computer)
  const hosts: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(item.address)) continue;
      const base = item.address.split('.').slice(0, 3).join('.');
      for (let k = 1; k < 255; k++) {
        const host = `${base}.${String(k)}`;
        if (host !== item.address) hosts.push(host);
      }
    }
  }
  const listening: string[] = [];
  for (let i = 0; i < hosts.length; i += 128) {
    const batch = hosts.slice(i, i + 128);
    const results = await Promise.all(batch.map((host) => open(host, 5555, 600)));
    batch.forEach((host, index) => {
      if (results[index]) listening.push(`${host}:5555`);
    });
  }
  for (const address of listening) found.add(address);
  const known = new Set((await devices()).map((device) => device.serial));
  const connected: string[] = [];
  await Promise.all(
    [...found]
      .filter((address) => !known.has(address))
      .map(async (address) => {
        const result = await connect(address).catch(() => null);
        if (result?.ok === true) connected.push(result.address);
      }),
  );
  return { connected, tried: [...found] };
}

export async function disconnect(address: string) {
  await adb(['disconnect', address], 15_000);
}

/** Wi-Fi debugging switched on for a headset on the cable: its address found, adb listening on 5555, connected. */
export async function enableWifi(serial: string) {
  const route = await adb(['-s', serial, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'], 15_000);
  const ip = /inet (\d+\.\d+\.\d+\.\d+)/u.exec(route.out)?.[1];
  if (ip === undefined) throw new Error('no Wi-Fi address (is the headset on Wi-Fi?)');
  await adb(['-s', serial, 'tcpip', '5555'], 20_000);
  // (adb on the headset restarts to listen: a moment)
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return connect(`${ip}:5555`);
}

const quote = (text: string) => `'${text.replace(/'/gu, `'\\''`)}'`;

async function shell(serial: string, command: string, timeout?: number) {
  return adb(['-s', serial, 'shell', command], timeout);
}

/** What of the map folder goes to the headset: its files, without the editor's own (projects, backups). */
async function mapFiles(folder: string) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && !/\.(lumatic|chroeditor)\.json$/iu.test(name) && !/\.(bak|tmp)$/iu.test(name));
}

export interface UploadOptions {
  serial: string;
  /** The map folder on this computer. */
  folder: string;
  /** The folder's name on the headset. */
  name: string;
  /** 'wip': SongCore's CustomWIPLevels, 'custom': CustomLevels. */
  target: 'wip' | 'custom';
  /** 'restart': the game started again after the upload; 'fresh': a folder of a new name (Refresh Songs). */
  mode: 'restart' | 'fresh';
}

export async function upload(options: UploadOptions, progress: (text: string) => void) {
  const { serial } = options;
  const files = await mapFiles(options.folder);
  if (!files.some((name) => name.toLowerCase() === 'info.dat')) throw new Error('no Info.dat in the map folder');
  // SongCore's folders (an older SongLoader's when that's what the headset has)
  const sub = options.target === 'wip' ? 'CustomWIPLevels' : 'CustomLevels';
  const songCore = `${MOD_DATA}/SongCore/${sub}`;
  const songLoader = `${MOD_DATA}/SongLoader/${sub}`;
  const hasLoader = (await shell(serial, `[ -d ${quote(`${MOD_DATA}/SongCore`)} ] && echo core || ([ -d ${quote(`${MOD_DATA}/SongLoader`)} ] && echo loader)`)).out.trim();
  const base = hasLoader === 'loader' ? songLoader : songCore;
  const safe = options.name.replace(/[\\/:*?"<>|]/gu, '_').trim() || 'Lumatic map';
  // the copies sent before: "<name>" and "<name> ~N"
  const listing = await shell(serial, `ls -1 ${quote(base)} 2>/dev/null`);
  const before = listing.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === safe || (line.startsWith(`${safe} ~`) && /^\d+$/u.test(line.slice(safe.length + 2))));
  let name = safe;
  if (options.mode === 'fresh') {
    const used = before.map((line) => (line === safe ? 0 : Number(line.slice(safe.length + 2))));
    name = `${safe} ~${String(Math.max(0, ...used) + 1)}`;
  }
  const remote = `${base}/${name}`;
  progress(`→ ${remote}`);
  for (const old of before) {
    if (old === name) continue;
    await shell(serial, `rm -rf ${quote(`${base}/${old}`)}`);
  }
  await shell(serial, `rm -rf ${quote(remote)} && mkdir -p ${quote(remote)}`);
  progress(`${String(files.length)} files…`);
  const pushed = await adb(['-s', serial, 'push', ...files.map((file) => path.join(options.folder, file)), `${remote}/`], 600_000);
  if (pushed.code !== 0) throw new Error(pushed.err || pushed.out || 'adb push failed');
  // (new times on every file: SongCore's cache of the level's hash can't take it for the old one)
  await shell(serial, `touch ${quote(remote)}/*`);
  progress(pushed.out.trim().split('\n').pop() ?? 'pushed');
  if (options.mode === 'restart') {
    progress('restarting Beat Saber…');
    await shell(serial, `am force-stop ${GAME}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await shell(serial, `monkey -p ${GAME} -c android.intent.category.LAUNCHER 1`);
  }
  return { remote, name, files: files.length };
}
