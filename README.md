# Lumatic

**A standalone editor for Beat Saber maps, lighting, and Chroma environments.**

Lumatic brings a timeline-first lighting workflow, practical mapping tools, and a 3D environment editor into one desktop application. The 3D view is used to preview and edit the scene, while the timeline provides a precise workspace for composing events over music.

> **Development status:** Lumatic is actively being developed. Features, workflows, and file-format support may change between versions. The current development version in `package.json` is `0.33.4`.

<!--
SCREENSHOT PLACEHOLDER — Main overview
Suggested file: docs/images/01-main-overview.png
Capture the full application window with a map open in the Lighting workspace:
show the timeline, light-group list, effect clips, and 3D preview together.
This should be the first/hero screenshot in the README.
-->

## What is Lumatic?

Many Beat Saber workflows separate mapping, lighting, and environment editing across different tools. Lumatic aims to bring these tasks together in a single application, with particular emphasis on a visual, editable lighting timeline.

The project uses the ChroViewer rendering and beatmap technology as its foundation, with a desktop interface built around Electron and Three.js.

## Features

### Lighting timeline

- **Timeline-based lightshow editing.** Create, move, resize, copy, and layer lighting clips directly over the song timeline.
- **Light ID organization.** Work with the lights in an environment, create custom groups and nested groups, and organize lights into meaningful sections.
- **Procedural effects.** Use parameter-driven effects such as waves, fills, strobes, gradients, twinkles, fire-like variations, and vibrato. Effects remain editable through their settings rather than being limited to a one-time generated result.
- **GLS editing.** Create and edit Group Lighting System blocks, including filters, distribution, timing, brightness, and ring-related events.
- **Ring and laser animation.** Create ring poses, rotations, zoom changes, and laser movement patterns.
- **Reusable presets.** Save selected lighting clips, effects, and ring blocks as presets and reuse them in other maps.
- **Live 3D preview.** Preview lighting changes in the environment while working on the timeline.

<!--
SCREENSHOT PLACEHOLDER — Lighting workspace
Suggested file: docs/images/02-lighting-timeline.png
Capture a close view of the Lighting workspace. Ideally show several light groups
(or nested groups), multiple clips on different layers, and the 3D preview displaying
the result at the current playhead position.
-->

### Audio analysis and audio-reactive lighting

- Import common audio formats, including MP3, WAV, FLAC, OGG, and M4A.
- Detect an estimated BPM and first beat, then refine the beat grid and downbeat alignment.
- Listen to the song with metronome clicks to check timing.
- Inspect the song using a spectrogram and frequency-band analysis.
- Use audio-reactive lighting effects based on frequency bands and loudness, including EQ-style, level, and meter modes.
- Convert audio to Ogg Vorbis and add silence at the beginning when preparing a map's audio file.

Audio-reactive effects use signal analysis of the song. They are not an AI-based automatic lighting generator.

<!--
SCREENSHOT PLACEHOLDER — Audio tools / audio-reactive effects
Suggested file: docs/images/03-audio-effects.png
Capture the effect library or effect inspector with one of the audio-reactive effects
(EQ, level, or meter) selected. Include the spectrogram or frequency display if it
can be shown clearly in the same frame.
-->

### Mapping tools

- Work with notes, bombs, walls, arcs, and chains on a timeline aligned with the song.
- Place, select, move, copy, and edit map objects in the note workspace.
- Use helper tools for repeated wall patterns and note-placement workflows.
- Review mapping issues through configurable checks based on guidance and criteria from the Beat Saber Mapping Wiki (BSMG), BeatLeader, and ScoreSaber.
- Jump from a reported issue to the affected part of the map.

The validation tools are intended to help spot potential problems; they do not guarantee that a map will pass ranking review.

<!--
SCREENSHOT PLACEHOLDER — Mapping workspace
Suggested file: docs/images/04-mapping-workspace.png
Capture the Notes workspace with a representative note pattern, walls or other map
objects, the song timeline/spectrogram, and (if possible) the mapping issues panel.
-->

### 3D environment editor

Lumatic includes a dedicated scene-editing workspace for Chroma environment modifications.

- **Scene hierarchy.** Browse the environment's objects, search by name, and filter to show modified objects.
- **3D selection and transforms.** Select objects in the viewport or hierarchy, multi-select them, and move, rotate, or scale them with 3D gizmos.
- **Modify existing objects.** Hide objects, duplicate them, and restore their original transforms.
- **Create custom geometry.** Add cubes, spheres, cylinders, capsules, planes, quads, and triangles.
- **Materials and lights.** Assign Chroma-compatible materials and create geometry-based lights that can be controlled from the Lighting workspace.
- **Parametric arrays.** Arrange objects in rows, circles, grids, lines, and scatter patterns; mirror objects and keep arrays editable.
- **Animation.** Keyframe object transforms and material colours, edit curves and easing, and use ready-made motion blocks.
- **Scene relationships.** Parent created objects and animate their relationships using supported Noodle Extensions track features.
- **Environment properties.** Adjust supported fog and light properties, and animate the player's position with safeguards for potentially uncomfortable movement.
- **Scene validation.** Check for missing objects, note-lane obstruction, light ID conflicts, unused materials, and potentially expensive scenes.
- **Chroma environment files.** Import and export Chroma `.dat` environment files.
- **Scene gallery and map settings.** Save reusable scene setups and edit supported recommended player and environment settings.

<!--
SCREENSHOT PLACEHOLDER — Environment Studio
Suggested file: docs/images/05-environment-editor.png
Capture the Environment/Scene workspace with all its main areas visible:
the object hierarchy on the left, a selected object and transform gizmo in the
3D viewport, the properties inspector, and the animation timeline if possible.
This is one of the most important screenshots for explaining Lumatic's Blender/SFM-like workflow.
-->

### Meta Quest workflow

The desktop application can send maps to a Meta Quest headset using ADB:

- Connect over USB or Wi-Fi.
- Discover and pair with headsets using Android wireless debugging.
- Use an existing ADB installation or download Google's Android platform-tools through the app.
- Upload to the WIP or custom-levels folder.
- Choose whether to restart Beat Saber or use a fresh level folder so the game reloads the updated map.

## Beat Saber mods and map features

Lumatic works with map data and custom events used by the Beat Saber modding ecosystem.

| Mod / system | Used for |
|---|---|
| **Chroma** | Environment modifications, custom geometry, materials, light IDs, and related environment data. |
| **Noodle Extensions** | Track relationships, parented objects, player-track assignment, and supported animated properties. |
| **Heck-compatible events** | Track and component animation workflows, point definitions, and related custom events. |
| **GLS (Group Lighting System)** | Group-based lighting blocks and distribution tools in the lighting workflow. |

Lumatic does not install these mods into Beat Saber. A map that uses mod-dependent features still requires the corresponding mods in the game.

### Beatmap formats

The project contains parsers for Beat Saber difficulty formats v2, v3, and v4. The current event writer supports v2 and v3; writing lighting events to v4 is not implemented yet.

## Libraries and technology

### Main runtime and libraries

| Component | Role |
|---|---|
| [ChroViewer](https://github.com/Umbranoxio/chroviewer) / ChroPaper renderer | Rendering and beatmap/environment technology used as the project's foundation. |
| [Electron](https://www.electronjs.org/) | Desktop application runtime (with Chromium). |
| [Three.js](https://threejs.org/) | 3D scene, viewport, and rendering utilities. |
| `troika-three-text` | Text rendering in the 3D view. |
| `zod` | Runtime data validation and schemas. |
| `fflate` | Compression and archive utilities. |
| `lzma-web` | LZMA compression support. |
| `better-result` | Result and error-handling utilities. |
| `use-intl` | Internationalization utilities. |
| `wasm-media-encoders` | WebAssembly-based audio encoding, including Ogg Vorbis support. |

### Development and build tools

- **TypeScript** — application source language.
- **Vite** — renderer development server and build.
- **esbuild** — Electron main/preload bundling.
- **electron-builder** — desktop packaging.

The direct dependencies and third-party license details are recorded in `package.json` and `THIRD_PARTY_NOTICES.md`.

## Development setup

Prerequisites: a recent Node.js LTS release and npm.

```bash
npm install
```

Useful scripts:

| Command | Description |
|---|---|
| `npm run dev` | Start the Vite renderer development server. |
| `npm run typecheck` | Run the TypeScript type check. |
| `npm run build` | Build the renderer and Electron main/preload bundles. |
| `npm start` | Build the application and launch it with Electron. |
| `npm run dist:win` | Build a Windows x64 ZIP package. |

## Roadmap

The roadmap is evolving alongside development. The next larger areas described in the project design notes include:

- **Advanced Noodle note and wall editing:** expose more Noodle-specific note and wall properties, path animation, and decorative/fake walls.
- **Environment-editor refinements:** improve object relationships and selection, add more flexible 3D placement workflows, and expand scene import options.
- **Format and compatibility improvements:** continue expanding map-format and mod-feature coverage, with particular attention to the v4 writing path.

Roadmap items are plans, not promises of a release date. Some parts of the roadmap may change as the editor develops.

## Current limitations

- Lighting event writing for Beat Saber v4 difficulties is not implemented yet; the current event writer targets v2 and v3.
- Chroma `.dat` environment export does not include the scene editor's keyframed animations.
- Some environment materials, including water and mirror-related shaders, are approximations in the preview renderer. Final appearance should be checked in Beat Saber.
- Vivify Unity asset bundles are not edited in Lumatic.

## Credits and third-party assets

Lumatic builds on [ChroViewer](https://github.com/Umbranoxio/chroviewer), whose renderer and beatmap/environment technology are distributed under GPL-2.0.

The ready-made Chroma environment collections included in the project come from their respective authors:

- [ChaseEnvs](https://github.com/MadChase/ChaseEnvs) — MadChase.
- [BSCEL](https://github.com/Phoenix-BS/BSCEL) — Phøenix.
- [Lonely's Chroma Environments](https://github.com/LonelyCen/Chroma-Environments) — Lonely; BTS Witch Edit by Fatalution.

Please refer to the individual license and attribution files in `public/custom-envs/licenses/` and to `THIRD_PARTY_NOTICES.md` before reusing any bundled data or assets.

Beat Saber and its game assets are the property of their respective rights holders. Lumatic is an independent community project and is not affiliated with or endorsed by Beat Games.

## License

Lumatic is licensed under **GNU General Public License v2.0 only (GPL-2.0-only)**. See [LICENSE](LICENSE) for the full text and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party component and asset information.
