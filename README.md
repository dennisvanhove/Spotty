# 🎵 Spotty

A barebones personal music streaming server. Drop your audio files in a folder,
run one command, and play them from any browser — including your car's interface
while driving.

Zero dependencies. Just Node.js.

## Quick start

1. Put your music files in the `music/` folder (subfolders are fine).
   Supported: `.mp3`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.flac`, `.wav`.

2. Start the server:

   ```sh
   node server.js
   ```

3. Open `http://localhost:3000` on this computer, or on your phone open
   `http://<this-computer-ip>:3000` (they must be on the same network/Wi-Fi).

   Find your computer's IP with `ipconfig getifaddr en0` (macOS Wi-Fi).

## Using it in the car

1. Connect your phone to the car (Bluetooth, CarPlay, or Android Auto).
2. Open Spotty in your phone's browser and start a song.
3. Your car's play / pause / next / previous controls (steering wheel,
   touchscreen) will now control Spotty. This works via the browser's
   **Media Session API**, which is already wired up.

Tip: keep the screen on or the browser tab in the foreground for the most
reliable background playback, especially on iOS Safari.

## Playing from anywhere (not just home Wi-Fi)

The server serves over plain HTTP on your local network. To reach it from
mobile data while driving you have options, easiest first:

- **Tailscale** (recommended): install it on the computer and your phone, then
  use the computer's Tailscale IP — works anywhere, encrypted, no config.
- A tunnel like `cloudflared` or `ngrok` to expose the port temporarily.
- Port-forwarding on your router (least secure; avoid unless you add auth/HTTPS).

> Note: this server has **no authentication**. Don't expose it directly to the
> public internet without putting it behind a tunnel/VPN that handles access.

## Configuration

Environment variables:

- `PORT` — port to listen on (default `3000`).
- `MUSIC_DIR` — absolute path to your music folder (default `./music`).

```sh
PORT=8080 MUSIC_DIR=/Users/me/Music node server.js
```

## How it works

- `server.js` — zero-dependency Node HTTP server. Lists audio files via
  `/api/songs` and streams them from `/music/...` with HTTP Range support
  (so seeking and the car's progress bar work correctly).
- `public/index.html` — the entire client: song list, search, player, and the
  Media Session API hooks for car/lock-screen controls.
