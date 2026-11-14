import { convertMap, mapVersion } from './convert';
import type { Editor } from './editor';
import { safeName } from './new-map';
import { createMapFolder } from './platform';

/**
 * The map in the other format, as a copy in a new folder (the one open stays as it is): v3 → v4 or
 * v4 → v3. The copy is opened when it's made; what didn't go across is told.
 */
export async function convertMapFolder(editor: Editor, status: (text: string) => void): Promise<boolean> {
  const map = editor.map;
  const infoName = map?.folder.files.find((name) => name.toLowerCase() === 'info.dat');
  if (map === null || infoName === undefined) return false;
  const from = mapVersion(await map.folder.readText(infoName));
  const to = from === '4' ? '3' : '4';
  const note =
    to === '4'
      ? 'В v4 у Chroma и Noodle поддержка неполная, а Lumatic пока сохраняет только v2/v3: карту v4 можно смотреть, но править свет лучше в v3.'
      : 'Свет и ноты переносятся полностью; кривые переходов цвета групп света (easing) в v3 станут линейными.';
  if (!window.confirm(`Перевести карту в формат v${to}? Будет сделана копия в новой папке, эта карта останется как есть.\n\n${note}`)) return false;
  if (editor.dirty) {
    if (!window.confirm('Сначала сохранить изменения? Без этого в копию попадёт карта, как она сохранена сейчас.')) return false;
    await editor.save();
  }
  status('Читаю карту…');
  const texts: Record<string, string> = {};
  for (const name of map.folder.files) if (/\.(dat|json)$/iu.test(name)) texts[name] = await map.folder.readText(name);
  const result = convertMap({ infoName, texts, song: editor.songSamples() }, to);
  const info = JSON.parse(texts[infoName]!) as { _songName?: string; song?: { title?: string } };
  const folder = await createMapFolder(safeName(`${info._songName ?? info.song?.title ?? 'Карта'} (v${to})`));
  if (folder === null) return false;
  const skip = new Set(result.dropped);
  let done = 0;
  for (const name of map.folder.files) {
    if (skip.has(name) || result.files[name] !== undefined) continue;
    status(`Копирую ${name}…`);
    if (texts[name] !== undefined) await folder.writeText(name, texts[name]);
    else await folder.writeBinary(name, await map.folder.readBinary(name));
    done++;
  }
  for (const [name, text] of Object.entries(result.files)) {
    status(`Пишу ${name}…`);
    await folder.writeText(name, text);
    done++;
  }
  await folder.refresh();
  status('Открываю копию…');
  await editor.open(folder);
  editor.setStatus(`Карта переведена в v${to}: ${String(done)} файлов в ${folder.name}`);
  if (result.warnings.length > 0) window.alert(`Карта переведена в v${to}. Что не перенеслось:\n\n• ${result.warnings.slice(0, 20).join('\n• ')}${result.warnings.length > 20 ? `\n…и ещё ${String(result.warnings.length - 20)}` : ''}`);
  return true;
}
