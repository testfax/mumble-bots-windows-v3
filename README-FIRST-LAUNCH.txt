FIRST LAUNCH (Windows x64)

Double-click Mumble-Bot-Controller.bat. It downloads portable Node.js 24.13.0 and Gyan.dev FFmpeg 9.0.1 full build when missing, then runs npm ci from the committed package-lock.json and starts the controller. An internet connection is required on first run. Existing runtime executables are never replaced.

The controller opens at http://127.0.0.1:8787. If installation fails, the BAT window remains open with the error.

This package has not been tested on a Windows machine. The @discordjs/opus native module may require a compatible prebuilt binary or Windows build tools.

Never commit config.json containing credentials or private tokens. Inspect it before publishing.

Opus compatibility (updated 2026-11-01):
  Uses Node.js 22.14.0 (Windows x64, ABI 127) because @discordjs/opus 0.10.0
  publishes an official win32-x64 prebuilt binary for that ABI.
  Existing Node.js runtimes with other versions are preserved; Node 22 is
  downloaded into runtime\node-v22 when needed. Native Opus encode is verified.
  A prior failed npm ci will be retried, and version/lock changes invalidate the marker.
