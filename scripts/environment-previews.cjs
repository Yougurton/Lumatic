/*
 * The pictures of the game's environments in the environment gallery: each one in the editor's own 3D
 * view, its lights on, written to public/environment-previews/<id>.png (scale them down after).
 *
 *   npx vite --port 5173 &   then   node scripts/environment-previews.cjs <song.ogg>
 *
 * (needs Playwright; the environments are the ones a new map offers)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const song = fs.readFileSync(process.argv[2]);
const out = path.join(__dirname, '..', 'public', 'environment-previews');
fs.mkdirSync(out, { recursive: true });

function map(environment) {
  const info = {
    _version: '2.1.0', _songName: 'Preview', _songAuthorName: '', _levelAuthorName: '', _beatsPerMinute: 120, _songTimeOffset: 0,
    _songFilename: 'song.ogg', _coverImageFilename: '', _environmentName: environment,
    _difficultyBeatmapSets: [{ _beatmapCharacteristicName: 'Standard', _difficultyBeatmaps: [{ _difficulty: 'Expert', _difficultyRank: 7, _beatmapFilename: 'ExpertStandard.dat', _noteJumpMovementSpeed: 16, _noteJumpStartBeatOffset: 0 }] }],
  };
  // (every light on: back lasers, lasers and the extra lights in red, rings and the centre in blue)
  const red = new Set([0, 2, 3, 6, 10]);
  const events = [];
  for (let type = 0; type < 12; type++) if (type !== 5 && type !== 8 && type !== 9) events.push({ b: 0, et: type, i: red.has(type) ? 5 : 1, f: 1 });
  events.push({ b: 0, et: 12, i: 2, f: 1 }, { b: 0, et: 13, i: 2, f: 1 });
  const difficulty = { version: '3.3.0', bpmEvents: [], rotationEvents: [], colorNotes: [], bombNotes: [], obstacles: [], sliders: [], burstSliders: [], waypoints: [], basicBeatmapEvents: events, colorBoostBeatmapEvents: [], lightColorEventBoxGroups: [], lightRotationEventBoxGroups: [], lightTranslationEventBoxGroups: [], basicEventTypesWithKeywords: {}, useNormalEventsAsCompatibleEvents: true };
  return { 'Info.dat': JSON.stringify(info), 'ExpertStandard.dat': JSON.stringify(difficulty) };
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const listing = await browser.newPage();
  await listing.goto('http://localhost:5173/');
  const environments = await listing.evaluate(async () => {
    const m = await import('/src/editor/new-map.ts');
    return [...m.SHOW_ENVIRONMENTS, ...m.OTHER_ENVIRONMENTS].map(([id]) => id);
  });
  await listing.close();
  for (const environment of environments) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const files = map(environment);
    await page.addInitScript(({ files, song }) => {
      const folder = { ...files, 'song.ogg': Uint8Array.from(atob(song), (c) => c.charCodeAt(0)).buffer };
      window.__chroeditorTestFolder = folder;
    }, { files, song: song.toString('base64') });
    await page.goto('http://localhost:5173/');
    await page.waitForTimeout(800);
    await page.click('#open');
    await page.waitForFunction(() => window.chroeditor.editor.project !== null, null, { timeout: 120000 });
    await page.evaluate(() => window.chroeditor.timeline.setLook({ height: 0 }));
    await page.evaluate(() => window.chroeditor.editor.seek(4));
    await page.waitForTimeout(4000);
    // (the middle of the 3D view, 16:9)
    await page.screenshot({ path: path.join(out, `${environment}.png`), clip: { x: 650 - 356, y: 40, width: 711, height: 400 } });
    console.log(environment);
    await page.close();
  }
  await browser.close();
})();
