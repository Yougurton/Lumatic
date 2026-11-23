import { unzipSync } from 'fflate';
import { packForBeatSaver, packName, referencedFiles } from '../src/editor/beatsaver';

/**
 * A map packed for BeatSaver: Info.dat and what it points to, nothing of Lumatic's own.
 *
 * npx tsx tests/beatsaver.ts
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

const info = {
  _version: '2.1.0',
  _songName: 'Song',
  _songAuthorName: 'Artist',
  _levelAuthorName: 'Mapper',
  _songFilename: 'song.ogg',
  _coverImageFilename: 'cover.jpg',
  _difficultyBeatmapSets: [{ _beatmapCharacteristicName: 'Standard', _difficultyBeatmaps: [{ _beatmapFilename: 'ExpertStandard.dat' }, { _beatmapFilename: 'HardStandard.dat' }] }],
};
const text = JSON.stringify(info);
check('referenced', JSON.stringify(referencedFiles(text)) === JSON.stringify(['song.ogg', 'cover.jpg', 'ExpertStandard.dat', 'HardStandard.dat']), referencedFiles(text));

const folder: Record<string, string> = {
  'info.dat': text,
  'song.ogg': 'OggS…',
  'cover.jpg': 'jpeg',
  'ExpertStandard.dat': '{"version":"3.3.0"}',
  'ExpertStandard.lumatic.json': '{}',
  'Lumatic backups/song source.mp3': 'mp3',
};
const read = async (name: string) => new TextEncoder().encode(folder[name]!).buffer as ArrayBuffer;
const pack = await packForBeatSaver(Object.keys(folder), read);
const inside = Object.keys(unzipSync(pack.data)).sort();
check('only the map', JSON.stringify(inside) === JSON.stringify(['ExpertStandard.dat', 'Info.dat', 'cover.jpg', 'song.ogg']), inside);
check('the missing difficulty found', JSON.stringify(pack.missing) === JSON.stringify(['HardStandard.dat']), pack.missing);
check('no warnings', pack.warnings.length === 0, pack.warnings);
check('a name', packName(text) === 'Artist - Song (Mapper).zip', packName(text));

// v4: the audio data and the lightshows too
const v4 = { version: '4.0.0', song: { title: 'T/X', author: 'A' }, audio: { songFilename: 'song.egg', audioDataFilename: 'AudioData.dat' }, coverImageFilename: 'cover.png', difficultyBeatmaps: [{ beatmapDataFilename: 'E.dat', lightshowDataFilename: 'L.dat', beatmapAuthors: { mappers: ['M'] } }] };
check('v4 referenced', JSON.stringify(referencedFiles(JSON.stringify(v4))) === JSON.stringify(['song.egg', 'AudioData.dat', 'cover.png', 'E.dat', 'L.dat']), referencedFiles(JSON.stringify(v4)));
check('v4 name, no slash', packName(JSON.stringify(v4)) === 'A - T_X (M).zip', packName(JSON.stringify(v4)));

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
