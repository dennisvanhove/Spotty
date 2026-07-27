'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(__dirname, 'music'));
const PUBLIC_DIR = path.join(__dirname, 'public');
// External downloader. Override with YTDLP_PATH if it's not on PATH (e.g. under launchd).
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
// Playlists live in a small JSON file next to the server so they sync across devices
// (make a playlist on your laptop, it shows up on your phone in the car).
const PLAYLISTS_FILE = process.env.PLAYLISTS_FILE || path.join(__dirname, 'playlists.json');

// Audio extensions we will serve. mp3 is the main one, but these cost nothing extra.
const AUDIO_EXT = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
};

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Recursively collect audio files under MUSIC_DIR, returned as paths relative to MUSIC_DIR.
function listSongs(dir, base = dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(listSongs(full, base));
    } else if (AUDIO_EXT[path.extname(entry.name).toLowerCase()]) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

// Turn "Artist/Album/01 Track.mp3" into a friendlier title for display.
function prettify(rel) {
  const name = path.basename(rel, path.extname(rel));
  return name.replace(/_/g, ' ').trim();
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const type = STATIC_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // Don't let phones cache the client; otherwise UI changes won't show up until a
    // manual cache clear (iOS Safari is especially sticky about this).
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// Stream an audio file with HTTP Range support so the browser can seek and the
// car's player gets accurate duration/position info.
function serveAudio(req, res, absPath) {
  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const total = stat.size;
    const type = AUDIO_EXT[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      let start = match[1] === '' ? 0 : parseInt(match[1], 10);
      let end = match[2] === '' ? total - 1 : parseInt(match[2], 10);

      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }

      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(absPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(absPath).pipe(res);
    }
  });
}

// Read and JSON-parse a request body, with a small size cap to be safe.
function readJsonBody(req, cb) {
  let body = '';
  let aborted = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) { aborted = true; req.destroy(); }
  });
  req.on('end', () => {
    if (aborted) return cb(new Error('Request body too large'));
    try { cb(null, JSON.parse(body || '{}')); } catch (e) { cb(new Error('Invalid JSON')); }
  });
  req.on('error', cb);
}

// Only accept real YouTube links (defence in depth; the URL is never shell-interpolated).
function isValidYouTubeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  return (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtu.be'
  );
}

// Download the audio of a YouTube URL as mp3 into MUSIC_DIR via yt-dlp + ffmpeg.
// Calls back with the new song's metadata so the client can stream it right away.
function downloadAudio(url, cb) {
  const args = [
    '-x',                                   // extract audio only
    '--audio-format', 'mp3',
    '--audio-quality', '0',                 // best
    '--no-playlist',                        // a URL inside a playlist => just that song
    '--no-progress',
    '--no-simulate',
    '--print', 'after_move:filepath',       // print the final mp3 path after post-processing
    '-o', path.join(MUSIC_DIR, '%(title)s.%(ext)s'),
    url,
  ];

  let stdout = '';
  let stderr = '';
  let done = false;
  const finish = (err, result) => { if (!done) { done = true; cb(err, result); } };

  const child = spawn(YTDLP, args);
  child.on('error', (e) => {
    finish(new Error(
      e.code === 'ENOENT'
        ? 'yt-dlp not found on the server. Install it with: brew install yt-dlp'
        : 'Could not start yt-dlp: ' + e.message
    ));
  });
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => {
    if (code !== 0) {
      const last = stderr.trim().split('\n').filter(Boolean).pop() || 'download failed';
      return finish(new Error(last));
    }
    const filepath = stdout.trim().split('\n').filter(Boolean).pop();
    if (!filepath) return finish(new Error('Download finished but no file was produced.'));
    const rel = path.relative(MUSIC_DIR, filepath);
    finish(null, {
      ok: true,
      title: prettify(rel),
      url: '/music/' + rel.split(path.sep).map(encodeURIComponent).join('/'),
      path: rel,
    });
  });
}

// ---- Playlists: a flat array of { id, name, songs: [relativePath, ...] } ----
function readPlaylists() {
  try {
    const data = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writePlaylists(playlists) {
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(playlists, null, 2));
}

function sanitizeName(raw) {
  return typeof raw === 'string' ? raw.trim().slice(0, 100) : '';
}

function handlePlaylists(req, res, pathname) {
  const rest = pathname.slice('/api/playlists'.length); // '' or '/<id>'
  const id = rest.startsWith('/') ? rest.slice(1) : '';

  // Collection: /api/playlists
  if (!id) {
    if (req.method === 'GET') {
      sendJSON(res, 200, readPlaylists());
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req, (err, data) => {
        if (err) { sendJSON(res, 400, { error: err.message }); return; }
        const name = sanitizeName(data && data.name);
        if (!name) { sendJSON(res, 400, { error: 'Playlist name is required.' }); return; }
        const playlists = readPlaylists();
        const pl = { id: crypto.randomUUID(), name, songs: [] };
        playlists.push(pl);
        writePlaylists(playlists);
        sendJSON(res, 200, pl);
      });
      return;
    }
    sendJSON(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Single playlist: /api/playlists/<id>
  const playlists = readPlaylists();
  const idx = playlists.findIndex((p) => p.id === id);
  if (idx === -1) { sendJSON(res, 404, { error: 'Playlist not found.' }); return; }

  if (req.method === 'GET') { sendJSON(res, 200, playlists[idx]); return; }

  if (req.method === 'DELETE') {
    playlists.splice(idx, 1);
    writePlaylists(playlists);
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (req.method === 'PATCH' || req.method === 'PUT') {
    readJsonBody(req, (err, data) => {
      if (err) { sendJSON(res, 400, { error: err.message }); return; }
      if (data && typeof data.name === 'string') {
        const name = sanitizeName(data.name);
        if (!name) { sendJSON(res, 400, { error: 'Playlist name cannot be empty.' }); return; }
        playlists[idx].name = name;
      }
      if (data && Array.isArray(data.songs)) {
        playlists[idx].songs = data.songs.filter((s) => typeof s === 'string');
      }
      writePlaylists(playlists);
      sendJSON(res, 200, playlists[idx]);
    });
    return;
  }

  sendJSON(res, 405, { error: 'Method not allowed' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // API: download a YouTube URL's audio as mp3 into the music folder.
  if (pathname === '/api/download') {
    if (req.method !== 'POST') {
      sendJSON(res, 405, { error: 'Use POST' });
      return;
    }
    readJsonBody(req, (err, data) => {
      if (err) { sendJSON(res, 400, { error: err.message }); return; }
      const url = ((data && data.url) || '').trim();
      if (!isValidYouTubeUrl(url)) {
        sendJSON(res, 400, { error: 'Please enter a valid YouTube URL.' });
        return;
      }
      downloadAudio(url, (derr, result) => {
        if (derr) { sendJSON(res, 500, { error: derr.message }); return; }
        sendJSON(res, 200, result);
      });
    });
    return;
  }

  // API: playlists (list / create / rename / set songs / delete).
  if (pathname === '/api/playlists' || pathname.startsWith('/api/playlists/')) {
    handlePlaylists(req, res, pathname);
    return;
  }

  // API: list of available songs.
  if (pathname === '/api/songs') {
    const songs = listSongs(MUSIC_DIR)
      .sort((a, b) => a.localeCompare(b))
      .map((rel) => ({
        // Encode each path segment so subfolders and odd characters survive the URL.
        url: '/music/' + rel.split(path.sep).map(encodeURIComponent).join('/'),
        title: prettify(rel),
        path: rel,
      }));
    sendJSON(res, 200, songs);
    return;
  }

  // Audio files.
  if (pathname.startsWith('/music/')) {
    const rel = pathname.slice('/music/'.length);
    const absPath = path.join(MUSIC_DIR, rel);
    // Prevent path traversal outside MUSIC_DIR.
    if (!absPath.startsWith(MUSIC_DIR + path.sep) && absPath !== MUSIC_DIR) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    serveAudio(req, res, absPath);
    return;
  }

  // Static client.
  let staticPath = pathname === '/' ? '/index.html' : pathname;
  const absStatic = path.join(PUBLIC_DIR, staticPath);
  if (!absStatic.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  serveStatic(res, absStatic);
});

// Downloads hold the request open while yt-dlp runs; don't let Node time them out.
server.requestTimeout = 0;
server.timeout = 0;

server.listen(PORT, () => {
  console.log(`\n  🎵  Spotty is running`);
  console.log(`  Serving music from: ${MUSIC_DIR}`);
  console.log(`  Open on this machine:  http://localhost:${PORT}`);
  console.log(`  Open on your phone:    http://<this-computer-ip>:${PORT}\n`);
  if (!fs.existsSync(MUSIC_DIR)) {
    console.log(`  ⚠  Music folder doesn't exist yet. Create it and drop mp3s in:`);
    console.log(`     ${MUSIC_DIR}\n`);
  }
});
