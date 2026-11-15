# Windows online installer

The online installer separates the Lumatic application payload from the Electron runtime at download and installation time.

## What is distributed

The Lumatic payload archive, Lumatic-win-x64.zip, contains only:

- resources/app.asar — the bundled Lumatic application (renderer, Electron main process, and preload);
- LICENSE.txt;
- THIRD_PARTY_NOTICES.md.

It does not contain electron.exe, Chromium DLLs, or the Electron runtime.

The Inno Setup installer embeds this small Lumatic payload and downloads the official Electron Windows x64 ZIP from the Electron project's GitHub release during installation. The runtime version is read from the exact Electron version locked in package-lock.json. Before extraction, Inno Setup verifies the downloaded archive against the matching entry in Electron's published SHASUMS256.txt.

The installer is per-user and does not request administrator rights. It preserves Electron's LICENSE and Chromium's LICENSES.chromium.html next to the installed application.

## Build locally

On Windows:

1. Install Node.js 22.
2. Install Inno Setup 6.1 or later.
3. Run:

~~~powershell
npm ci
npm run typecheck
npm run dist:win:online
~~~

The build produces:

- release/Lumatic-win-x64.zip — app-only payload, also used by Lumatic's in-app updater;
- release/Lumatic-Setup-<version>-win-x64.exe — online installer. Electron is downloaded when the installer runs.

To build just the app-only payload without compiling the Windows installer:

~~~powershell
npm run dist:app
~~~

## GitHub Releases

The .github/workflows/build-windows-installer.yml workflow checks the build on pull requests. Pushing a tag matching the package version (for example, v0.33.4) builds the installer and uploads both the installer and app-only ZIP to that GitHub Release.

The app-only ZIP keeps the existing in-app updater working: it looks for a Windows ZIP asset in the latest release and copies its files over the installed application. The Electron runtime remains in place between app updates.

## Important licensing note

This packaging layout keeps the Electron runtime out of the Lumatic payload archive and downloads it separately from the official Electron release. It is a distribution/packaging choice, not a legal determination that the resulting installed application is a GPLv2 "mere aggregation." Lumatic executes inside Electron, so the legal relationship between the application and runtime still needs to be assessed separately. Separate downloads alone do not settle that question.

Do not remove electron/main.ts, electron/preload.ts, or other Lumatic source files from the source repository. Those are part of Lumatic's corresponding source code. See the GNU GPL FAQ's discussion of aggregation and the boundary between separate programs: https://www.gnu.org/licenses/gpl-faq.html#MereAggregation

## Current Electron version

The repository currently locks Electron 38.8.6. That branch has reached end of support. The build prints a warning, but the version should be upgraded to a supported Electron branch and tested before publishing an installer for general use.
