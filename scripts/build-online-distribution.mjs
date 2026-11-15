import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const { createPackage } = require('@electron/asar');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'release');
const STAGING = path.join(RELEASE, 'online-app');
const PAYLOAD = path.join(RELEASE, 'online-payload');
const APP_ASAR = path.join(PAYLOAD, 'resources', 'app.asar');
const PAYLOAD_ZIP = path.join(RELEASE, 'Lumatic-win-x64.zip');
const BUILD_INFO = path.join(ROOT, 'installer', 'build-info.iss');
const ISS_FILE = path.join(ROOT, 'installer', 'Lumatic-Online.iss');

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function ensureExists(file, label) {
  try {
    await fs.access(file);
  } catch {
    throw new Error(label + ' is missing. Run the normal application build first: ' + file);
  }
}

async function getElectronChecksum(version, filename) {
  const url = 'https://github.com/electron/electron/releases/download/v' + version + '/SHASUMS256.txt';
  const response = await fetch(url, { headers: { 'User-Agent': 'Lumatic-build' } });
  if (!response.ok) {
    throw new Error('Could not retrieve the official Electron checksums (' + response.status + '): ' + url);
  }

  const sums = await response.text();
  const matchingLine = sums.split(/\r?\n/u).find((line) => line.trim().endsWith(filename));
  if (matchingLine === undefined) {
    throw new Error('The official SHASUMS256.txt does not contain ' + filename);
  }

  const hash = matchingLine.trim().split(/\s+/u)[0];
  if (!/^[a-f0-9]{64}$/iu.test(hash ?? '')) {
    throw new Error('Could not parse the SHA-256 checksum for ' + filename);
  }
  return hash.toLowerCase();
}

async function main() {
  const packageJson = await readJson(path.join(ROOT, 'package.json'));
  const packageLock = await readJson(path.join(ROOT, 'package-lock.json'));

  const appVersion = packageJson.version;
  const electronVersion = packageLock.packages?.['node_modules/electron']?.version;
  if (!electronVersion) {
    throw new Error('Could not determine the exact Electron version from package-lock.json');
  }

  if (Number.parseInt(electronVersion.split('.')[0], 10) < 43) {
    console.warn(
      'WARNING: Electron ' + electronVersion + ' is outside the currently supported Electron release branches. ' +
      'Upgrade the Electron dependency and lockfile before publishing a public release.'
    );
  }

  await ensureExists(path.join(ROOT, 'dist', 'index.html'), 'Vite renderer output');
  await ensureExists(path.join(ROOT, 'dist-electron', 'main.cjs'), 'Electron main-process bundle');
  await ensureExists(path.join(ROOT, 'dist-electron', 'preload.cjs'), 'Electron preload bundle');

  await fs.rm(STAGING, { recursive: true, force: true });
  await fs.rm(PAYLOAD, { recursive: true, force: true });
  await fs.mkdir(STAGING, { recursive: true });
  await fs.mkdir(path.dirname(APP_ASAR), { recursive: true });

  await fs.cp(path.join(ROOT, 'dist'), path.join(STAGING, 'dist'), { recursive: true });
  await fs.cp(path.join(ROOT, 'dist-electron'), path.join(STAGING, 'dist-electron'), { recursive: true });

  // Keep only the runtime manifest fields. All application dependencies are bundled into dist
  // and dist-electron; the Electron binary itself is not included in app.asar.
  const runtimeManifest = {
    name: packageJson.name,
    productName: packageJson.productName,
    version: appVersion,
    description: packageJson.description,
    main: packageJson.main,
    license: packageJson.license,
    type: packageJson.type
  };
  await fs.writeFile(
    path.join(STAGING, 'package.json'),
    JSON.stringify(runtimeManifest, null, 2) + '\n',
    'utf8'
  );

  await createPackage(STAGING, APP_ASAR);

  await fs.copyFile(path.join(ROOT, 'LICENSE'), path.join(PAYLOAD, 'LICENSE.txt'));
  await fs.copyFile(
    path.join(ROOT, 'THIRD_PARTY_NOTICES.md'),
    path.join(PAYLOAD, 'THIRD_PARTY_NOTICES.md')
  );

  const payloadFiles = {
    'resources/app.asar': new Uint8Array(await fs.readFile(APP_ASAR)),
    'LICENSE.txt': new Uint8Array(await fs.readFile(path.join(PAYLOAD, 'LICENSE.txt'))),
    'THIRD_PARTY_NOTICES.md': new Uint8Array(
      await fs.readFile(path.join(PAYLOAD, 'THIRD_PARTY_NOTICES.md'))
    )
  };
  const zipBytes = zipSync(payloadFiles, { level: 9 });
  await fs.writeFile(PAYLOAD_ZIP, zipBytes);

  const electronZipName = 'electron-v' + electronVersion + '-win32-x64.zip';
  const electronSha256 = await getElectronChecksum(electronVersion, electronZipName);

  const buildInfo = [
    '#define LumaticVersion "' + appVersion + '"',
    '#define ElectronVersion "' + electronVersion + '"',
    '#define ElectronSha256 "' + electronSha256 + '"',
    ''
  ].join('\r\n');
  await fs.writeFile(BUILD_INFO, buildInfo, 'utf8');

  const payloadSha256 = await import('node:crypto').then(({ createHash }) =>
    createHash('sha256').update(zipBytes).digest('hex')
  );
  await fs.writeFile(
    path.join(RELEASE, 'Lumatic-win-x64.zip.sha256'),
    payloadSha256 + '  Lumatic-win-x64.zip\n',
    'utf8'
  );

  console.log('Created: ' + path.relative(ROOT, PAYLOAD_ZIP));
  console.log('Application version: ' + appVersion);
  console.log('Electron runtime version: ' + electronVersion);
  console.log('Electron runtime SHA-256: ' + electronSha256);

  if (!process.argv.includes('--compile')) {
    console.log('Installer compilation skipped. Run npm run dist:win:online on Windows with Inno Setup 6 installed.');
    return;
  }

  if (process.platform !== 'win32') {
    throw new Error('The Inno Setup installer must be compiled on Windows.');
  }

  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const compilerCandidates = [
    process.env.INNO_SETUP_COMPILER,
    path.join(programFilesX86, 'Inno Setup 6', 'ISCC.exe'),
    path.join(programFiles, 'Inno Setup 6', 'ISCC.exe'),
    path.join(programFilesX86, 'Inno Setup 7', 'ISCC.exe'),
    path.join(programFiles, 'Inno Setup 7', 'ISCC.exe')
  ].filter(Boolean);

  let compiler = null;
  for (const candidate of compilerCandidates) {
    try {
      await fs.access(candidate);
      compiler = candidate;
      break;
    } catch {
      // Try the next known installation path.
    }
  }
  if (!compiler) {
    throw new Error(
      'Inno Setup compiler not found. Install Inno Setup 6.5+ or set INNO_SETUP_COMPILER to the full path of ISCC.exe.'
    );
  }

  const result = spawnSync(compiler, [ISS_FILE], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('Inno Setup failed with exit code ' + String(result.status));
  }

  console.log('Installer compiled into ' + path.relative(ROOT, RELEASE));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
