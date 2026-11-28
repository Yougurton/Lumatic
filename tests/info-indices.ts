import { readFileSync } from 'node:fs';

import { colorSchemeForDifficulty, environmentNameForDifficulty, parseInfo } from '../src/engine/core/beatmap/info';

let checks = 0;
let failures = 0;
const check = (ok: boolean, name: string, actual: unknown) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL', name, JSON.stringify(actual)?.slice(0, 200));
  }
};

// An Info.dat whose difficulty entries omit _environmentNameIdx/_beatmapColorSchemeIdx (the shape
// this editor's "add difficulty" used to write): the reader must not silently drop the difficulty.
const dir = 'A:/SteamLibrary/steamapps/common/Beat Saber/BSManager/BSInstances/1.40.8/Beat Saber_Data/CustomWIPLevels/The Vanished People - Hide and Seek';
const info = parseInfo(readFileSync(`${dir}/Info.dat`, 'utf8'));
check(info.difficultySets.length === 1, 'one characteristic set survives the strict schema', info.difficultySets.length);
const entry = info.difficultySets[0]?.difficulties[0];
check(entry !== undefined, 'the difficulty entry is not dropped by the schema', info.difficultySets[0]?.difficulties.length ?? 0);
check(entry?.difficulty === 'ExpertPlus', 'the difficulty keeps its name', entry?.difficulty);

// a missing environment index falls back to the map's environment (Beat Saber treats absent as 0)
check(environmentNameForDifficulty(info, entry!) === 'TimbalandEnvironment', 'missing environment index falls back to the map environment', environmentNameForDifficulty(info, entry!));
check(
  colorSchemeForDifficulty(info, entry!).leftNote !== undefined,
  'missing color scheme index falls back to custom colors/defaults',
  colorSchemeForDifficulty(info, entry!).leftNote,
);

// a normal Info (indices present) keeps parsing as before
const good = parseInfo(readFileSync('A:/SteamLibrary/steamapps/common/Beat Saber/BSManager/BSInstances/1.40.8/Beat Saber_Data/CustomLevels/3f6e7 (Pictured as Perfect - Excess10n)/Info.dat', 'utf8'));
check(good.difficultySets[0]?.difficulties.length === 2, 'an Info with indices keeps all its difficulties', good.difficultySets[0]?.difficulties.length ?? 0);

console.log(`${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
