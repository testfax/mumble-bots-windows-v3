MUMBLE BOT CONTROLLER - WINDOWS

SETUP

This folder is designed to be portable.

You do NOT need to install Node.js, FFmpeg, Python, npm packages, or Visual Studio separately.


STARTING THE CONTROLLER

1. Double-click:

   Mumble-Bot-Controller.bat

2. Your default browser will open:

   http://127.0.0.1:8787

3. Wait for a Portable NodeJS to install, FFMpeg, and dependencies.

URL

1. Enter the URL of the mumble server that you wish the bots to connect to
2. Click Save

ACCESS TOKEN

1. Paste your token into the Access Token field.
2. Click Save Token.



RUNNING BOTS

In the browser controller:

Bots
    Number of bots to start.

Talkers
    Number of those bots that continuously transmit the included test audio.

Start delay (ms)
    Delay between starting each bot.

Click:

    Start Bots

to start the requested bots.


STOPPING BOTS

Click:

    Stop All

to disconnect all bots started by the controller.


RUNNING STATUS

The controller displays the currently running LoadBot processes.

Example:

    Running: 10

    LoadBot-001
    LoadBot-002
    LoadBot-003
    ...


TALKING BOTS

Talking bots use:

    audio\dca-atc.mp3

through the bundled FFmpeg runtime.

No external audio software is required.


TOKEN SECURITY

Each token belongs to a specific subscriber/server configuration on the VPS.

The VPS determines the correct:
- subscriber slug
- Mumble hostname
- Mumble port
- test-bot authentication password

from the token.

If the administrator clears or revokes that token on the VPS, it will stop working.


IMPORTANT FILES

Mumble-Bot-Controller.bat
    Double-click this to start the controller.

controller.js
    Localhost web controller.

mumble-bots.ps1
    Windows bot launcher.

connect-one.js
    Individual Mumble bot client.

config.json
    Stores the local access token and local runtime settings.

audio\
    Test audio.

codecs\
    Opus codec adapter.

runtime\node\
    Bundled Node.js runtime.

runtime\ffmpeg\
    Bundled FFmpeg runtime.

node_modules\
    Bundled Node dependencies.


NETWORK ACCESS

The browser controller listens only on:

    127.0.0.1:8787

It is not exposed to the local network or internet.

The bots themselves connect outbound to the VPS/Mumble server selected by the saved token.
