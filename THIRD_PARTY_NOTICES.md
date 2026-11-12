# Lumatic — сторонние компоненты и их лицензии

Lumatic распространяется под **GNU General Public License версии 2** (`LICENSE.txt` рядом с
программой). Исходный код: https://github.com/Yougurton/ChroEditor

Всё, что входит в программу, совместимо с GPL-2.0: ниже — что откуда взято и под какой лицензией.

## Основа

| Компонент | Лицензия | Что из него |
|---|---|---|
| [ChroViewer](https://github.com/Umbranoxio/chroviewer) (движок ChroPaper 1.1.0) | GPL-2.0 | 3D-вид, разбор карт, данные окружений |

## Библиотеки, собранные в программу

| Пакет | Лицензия |
|---|---|
| three | MIT |
| troika-three-text, troika-three-utils, troika-worker-utils | MIT |
| bidi-js, webgl-sdf-generator | MIT |
| zod | MIT |
| fflate | MIT |
| lzma-web | MIT |
| better-result | MIT |
| use-intl, icu-minify, @formatjs/* , @schummar/icu-type-parser | MIT |
| intl-messageformat | BSD-3-Clause |
| react | MIT |
| tslib | 0BSD |
| wasm-media-encoders | MIT; внутри — кодировщики Ogg Vorbis (libvorbis, libogg — BSD-3-Clause) и LAME (LGPL-2.0-or-later), скомпилированные в WebAssembly |

Три вспомогательные функции, которых `wasm-media-encoders` ждёт от `@swc/helpers` (Apache-2.0 —
несовместима с GPL-2.0), заменены своими (`src/shims/swc`). Декодер Ogg на WebAssembly
(`@wasm-audio-decoders/ogg-vorbis`: его `codec-parser` — LGPL-3.0, несовместима с GPL-2.0-only)
убран — песню читает сам Chromium.

## Среда выполнения

Electron (MIT) и Chromium — их лицензии лежат рядом с программой: `LICENSE.electron.txt`,
`LICENSES.chromium.html`.

## Готовые окружения Chroma (данные)

| Набор | Автор | Условия |
|---|---|---|
| ChaseEnvs | MadChase | MIT (`resources/app.asar/dist/custom-envs/licenses/madchase.txt`) |
| BSCEL | Phøenix | MIT (`…/licenses/bscel.txt`) |
| Lonely's Chroma Environments | Lonely (BTS Witch Edit — Fatalution) | свободно с указанием авторства, как в README автора (`…/licenses/lonely.txt`) |

## Данные окружений игры

Описания окружений Beat Saber (`environments/*.json`) взяты из ChroViewer вместе с движком; это
данные самой игры (© Beat Games), а не код Lumatic.
