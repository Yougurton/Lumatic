# Windows online installer

The online installer separates the Lumatic application payload from the Electron runtime at download and installation time.

## What is distributed

`Lumatic-win-x64.zip` contains only:

- `resources/app.asar` — the bundled Lumatic renderer, Electron main process and preload;
- `LICENSE.txt`;
- `THIRD_PARTY_NOTICES.md`.

It does not contain `electron.exe`, Chromium DLLs, `node_modules`, Apache-2.0 SWC helpers or MP3/LAME. The Inno Setup installer embeds this small payload and downloads the official Electron Windows x64 ZIP from the Electron project's GitHub release during installation. The exact runtime version comes from `package-lock.json`, and the archive is checked against Electron's published `SHASUMS256.txt`.

By default, the installer requests administrator rights and installs Lumatic for all users in Program Files. The privilege-override dialog also allows installing only for the current user. It preserves Electron's `LICENSE` as `LICENSE.electron.txt` and Chromium's `LICENSES.chromium.html` next to the installed application. After the runtime checksum is verified and extracted, `rcedit` applies Lumatic's icon to `Lumatic.exe`; app-only updates leave that executable unchanged. Shortcuts explicitly use `icon.ico`, and the installer notifies Windows and refreshes the shell icon cache so an older Electron icon does not persist until Explorer restarts.

## Build locally

On Windows:

1. Install Node.js 22.
2. Install Inno Setup 6.5 or later; ZIP extraction support is required.
3. Run:

~~~powershell
npm ci
npm run typecheck
npm run dist:win:online
~~~

The build produces:

- `release/Lumatic-win-x64.zip` — app-only payload, also used by Lumatic's in-app updater;
- `release/Lumatic-win-x64.zip.sha256`;
- `release/Lumatic-Setup-<version>-win-x64.exe` — online installer.

To build just the app-only payload without compiling the installer:

~~~powershell
npm run dist:app
~~~

For a public release, commit and publish the exact version tag first, then run `npm run release:win:online`. This also creates the corresponding source archive and refuses to build from a dirty working copy.

## GitHub Releases

`.github/workflows/build-windows-installer.yml` checks the build on pull requests. Pushing a tag matching the package version builds the installer and uploads the installer, app-only ZIP, checksum and source archive to that GitHub Release.

Publish the app-only ZIP as `Lumatic-win-x64.zip`; do not publish the older full-runtime ZIP in the same release. The in-app updater selects the first Windows ZIP asset and copies it over the installed application, while the Electron runtime remains in place.

## Licensing boundary

This layout keeps the Electron runtime out of the Lumatic payload and downloads it separately from the official Electron release. It is a distribution/packaging choice, not a legal determination that the installed application is a GPLv2 "mere aggregation".

Do not remove `electron/main.ts`, `electron/preload.ts` or other Lumatic sources from the source repository. They are part of Lumatic's corresponding source code. See the GNU GPL FAQ: https://www.gnu.org/licenses/gpl-faq.html#MereAggregation

The exact Electron version comes from `package-lock.json`. The build prints a warning when the locked branch is outside the supported release branches.
