# 🎵 Spotty

<img width="1710" height="1107" alt="Spotty preview" src="https://github.com/user-attachments/assets/bffc0cec-64b7-48f5-8622-45221847af1f" />


A barebones personal music streaming server. Drop your audio files in a folder,
run one command, and play them from any browser — including your car's interface
while driving.

Spotty comes as a Node application that has zero dependencies, so no `npm install` required!

## Quick start

1. Put your music files in the `music/` folder (subfolders are fine).
   Supported: `.mp3`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.flac`, `.wav`.

2. Start the server:

   ```sh
   node server.js
   ```

3. Open `http://localhost:3000` on this computer, or on your phone open
   `http://<this-computer-ip>:3000` (they must be on the same network/Wi-Fi).

## Using it on the go

Spotty has no authentication. For this reason I strongly discourage simply opening port 3000 on your router and allowing incoming traffic from the public internet.
It is encouraged to use tools like ngrok or tailscale to serve Spotty to the public internet.

I personally have Spotty running 24/7 on a Raspbery Pi in combination with Tailscale, works like a charm.

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
