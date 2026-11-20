import { promises as fs } from 'node:fs';
import path from 'node:path';
import { copyMapToWip, gameInstallations, mapLibraryKind, readMapCover, scanMapLibrary } from '../electron/map-library';

/**
 * Map discovery, metadata and copying into CustomWIPLevels.
 *
 * npx tsx tests/map-library.ts
 */

let checks = 0;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL', name, detail ?? '');
  }
};

const game = path.resolve('tmp/test-map-library');
await fs.rm(game, { recursive: true, force: true });
const data = path.join(game, 'Beat Saber_Data');
const wip = path.join(data, 'CustomWIPLevels', 'own-map');
const levels = path.join(data, 'CustomLevels', 'other-map');
await fs.mkdir(wip, { recursive: true });
await fs.mkdir(levels, { recursive: true });
await fs.mkdir(path.join(game, 'BSManager', 'BSInstances', '1.46.0', 'Beat Saber_Data'), { recursive: true });
await fs.writeFile(path.join(game, 'BSManager', 'config.cfg'), JSON.stringify({ 'custom-versions': [] }));
await fs.writeFile(path.join(game, 'BSManager', 'BSInstances', '1.46.0', 'BeatSaberVersion.txt'), '1.46.0_34060');

await fs.writeFile(
  path.join(levels, 'Info.dat'),
  JSON.stringify({
    _version: '2.1.0',
    _songName: 'Other song',
    _songAuthorName: 'Artist',
    _levelAuthorName: 'Mapper',
    _environmentName: 'BritneyEnvironment',
    _coverImageFilename: 'cover.png',
    _difficultyBeatmapSets: [
      { _difficultyBeatmaps: [{ _beatmapFilename: 'Expert.dat' }, { _beatmapFilename: 'Plus.dat' }] },
    ],
  }),
);
await fs.writeFile(path.join(levels, 'Expert.dat'), '{"version":"3.3.0"}');
await fs.writeFile(path.join(levels, 'Plus.dat'), '{"_version":"2.6.0"}');
await fs.writeFile(path.join(levels, 'cover.png'), 'cover');
await fs.mkdir(path.join(levels, 'Lumatic backups'), { recursive: true });
await fs.writeFile(path.join(levels, 'Lumatic backups', 'old.dat'), 'backup');

await fs.writeFile(
  path.join(wip, 'Info.dat'),
  JSON.stringify({
    version: '4.0.1',
    song: { title: 'Own song', author: 'V4 artist' },
    coverImageFilename: 'cover.png',
    environmentNames: ['ColdplayEnvironment'],
    difficultyBeatmaps: [
      { beatmapAuthors: { mappers: ['Mapper A'], lighters: ['Mapper B'] }, beatmapDataFilename: 'Expert.dat' },
    ],
  }),
);
await fs.writeFile(path.join(wip, 'Expert.dat'), '{"version":"4.0.0"}');
await fs.writeFile(path.join(wip, 'cover.png'), 'own-cover');

const installations = await gameInstallations(game);
check('the main game and BSManager instances are found', installations.length === 2 && installations.some((item) => item.version === '1.46.0_34060'), installations);

const { wip: own, levels: other } = await scanMapLibrary(game);
check('both immediate-child libraries are scanned', own.length === 1 && other.length === 1);
check('classic metadata is read', other[0]?.songName === 'Other song' && other[0]?.songAuthor === 'Artist' && other[0]?.mapAuthor === 'Mapper' && other[0]?.environment === 'BritneyEnvironment');
check('all differing difficulty versions are collected', other[0]?.versions.join('+') === '2+3', other[0]?.versions);
check('v4 metadata and authors are read', own[0]?.songName === 'Own song' && own[0]?.songAuthor === 'V4 artist' && own[0]?.mapAuthor === 'Mapper A' && own[0]?.environment === 'ColdplayEnvironment' && own[0]?.versions.join('+') === '4');
check('library kind is recognized', (await mapLibraryKind(levels, game)) === 'levels' && (await mapLibraryKind(wip, game)) === 'wip');
check('cover is returned as a data URL', (await readMapCover(path.join(levels, 'cover.png'), game))?.startsWith('data:image/png;base64,') === true);

const first = await copyMapToWip(levels, game);
const second = await copyMapToWip(levels, game);
check('copy lands in CustomWIPLevels', path.dirname(first) === path.join(data, 'CustomWIPLevels'));
check('a second copy gets a unique name', first !== second && second.includes('(copy) 2'));
check('editor backups are not copied', !(await fs.stat(path.join(first, 'Lumatic backups')).catch(() => null)));
check('the original remains intact', (await fs.readFile(path.join(levels, 'Info.dat'), 'utf8')).includes('Other song') && (await fs.readFile(path.join(levels, 'Lumatic backups', 'old.dat'), 'utf8')) === 'backup');

await fs.rm(game, { recursive: true, force: true });
console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
