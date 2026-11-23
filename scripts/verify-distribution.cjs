const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const unpacked = path.join(root, 'release', 'win-unpacked');
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function sameFile(relative, source) {
  const target = path.join(unpacked, relative);
  check(fs.existsSync(target), `Missing ${relative}`);
  if (fs.existsSync(target)) check(fs.readFileSync(target).equals(fs.readFileSync(path.join(root, source))), `${relative} differs from ${source}`);
}

for (const file of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'ffmpeg.dll', 'resources/app.asar']) {
  check(fs.existsSync(path.join(unpacked, file)), `Missing ${file}`);
}
sameFile('LICENSE.txt', 'LICENSE');
sameFile('THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md');
sameFile('LICENSE.electron.txt', 'node_modules/electron/dist/LICENSE.electron.txt');
sameFile('LICENSES.chromium.html', 'node_modules/electron/dist/LICENSES.chromium.html');

const archive = path.join(unpacked, 'resources', 'app.asar');
if (fs.existsSync(archive)) {
  const entries = asar.listPackage(archive).map((entry) => entry.replace(/\\/gu, '/'));
  check(!entries.some((entry) => entry.includes('node_modules')), 'app.asar must not contain node_modules');
  check(!entries.some((entry) => entry.includes('@swc/helpers')), 'app.asar contains Apache-2.0 @swc/helpers');
  check(!entries.some((entry) => /(?:^|\/)mp3\.wasm$/u.test(entry)), 'app.asar contains unused MP3/LAME WASM');
  check(entries.some((entry) => /\/dist\/index\.html$/u.test(entry)), 'app.asar is missing dist/index.html');
  check(entries.some((entry) => /\/dist-electron\/main\.cjs$/u.test(entry)), 'app.asar is missing dist-electron/main.cjs');
}

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(file) : entry.isFile() && entry.name.endsWith('.js') ? [file] : [];
  });
}

const bundles = javascriptFiles(path.join(root, 'dist')).map((file) => fs.readFileSync(file, 'utf8'));
const mp3Signature = fs.readFileSync(path.join(root, 'node_modules/wasm-media-encoders/wasm/mp3.wasm')).toString('base64').slice(0, 240);
const oggSignature = fs.readFileSync(path.join(root, 'node_modules/wasm-media-encoders/wasm/ogg.wasm')).toString('base64').slice(0, 240);
check(!bundles.some((source) => source.includes(mp3Signature)), 'A renderer/worker bundle contains unused MP3/LAME WASM');
check(bundles.some((source) => source.includes(oggSignature)), 'Ogg Vorbis WASM was not found in the bundles');
check(!bundles.some((source) => source.includes('@swc/helpers')), 'A bundle contains @swc/helpers imports');

const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
for (const required of [
  'https://github.com/Yougurton/Lumatic',
  `https://github.com/electron/electron/tree/v${electronVersion}`,
  'bada45718453ac27b56773ae663f7e65112f6a6e',
  '0657aee69dec8508a0011f47f3b69d7538e9d262',
]) {
  check(notices.includes(required), `THIRD_PARTY_NOTICES.md is missing ${required}`);
}

if (failures.length) {
  console.error(`Distribution verification failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Distribution verification passed: notices present; app.asar has no node_modules, Apache SWC helpers or MP3/LAME; only Ogg WASM is bundled.');
}
