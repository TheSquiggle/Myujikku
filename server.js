#!/usr/bin/env node
// ミュージック! — zero-dependency local server.
//
//   node server.js [--port 8080] [--songs "ミュージック！ beatmaps"]
//
// Serves the game and indexes every .mjk beatmap in the songs folder so the
// song-select screen can list them without downloading whole archives.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = __dirname;
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(argOf('--port', process.env.PORT || 8080));
const SONGS_DIR = path.resolve(ROOT, argOf('--songs', 'songs'));
const CACHE_DIR = path.join(ROOT, '.cache');

/* ---------------- tiny zip reader (central directory) ---------------- */

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 0xffff - 22; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, size, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, e) {
  const lNameLen = buf.readUInt16LE(e.localOff + 26);
  const lExtraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + lNameLen + lExtraLen;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported compression method ${e.method}`);
}

/* ---------------- difficulty rating (mirrors src/chart.js) ---------------- */

function starRating(notes) {
  if (notes.length < 2) return 0;
  const span = (notes[notes.length - 1].t - notes[0].t) / 1000;
  if (span <= 0) return 0;
  const nps = notes.length / span;
  const last = {};
  let strain = 0;
  for (const n of notes) {
    const prev = last[n.lane];
    if (prev !== undefined) strain += Math.min(1, 260 / Math.max(20, n.t - prev));
    last[n.lane] = n.type === 'hold' ? n.end : n.t;
  }
  let chords = 0;
  for (let i = 1; i < notes.length; i++) if (notes[i].t - notes[i - 1].t < 12) chords++;
  const raw = nps * 0.62 + (strain / span) * 0.85 + (chords / span) * 0.5;
  return Math.round(Math.min(9.99, Math.pow(raw, 0.86) * 1.16) * 100) / 100;
}

/* ---------------- library index ---------------- */

let INDEX = [];

function buildIndex() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!fs.existsSync(SONGS_DIR)) {
    console.warn(`! songs folder not found: ${SONGS_DIR}`);
    INDEX = [];
    return;
  }
  const files = fs.readdirSync(SONGS_DIR).filter(f => f.toLowerCase().endsWith('.mjk'));
  const out = [];
  for (const file of files) {
    const full = path.join(SONGS_DIR, file);
    try {
      const stat = fs.statSync(full);
      const id = crypto.createHash('sha1').update(file + stat.size).digest('hex').slice(0, 12);
      const buf = fs.readFileSync(full);
      const entries = zipEntries(buf);

      const chartEntry = entries.get('chart.mjc');
      if (!chartEntry) throw new Error('chart.mjc missing');
      const chart = JSON.parse(readEntry(buf, chartEntry).toString('utf8'));

      // cache the background so the browser can show art without the full archive
      let cover = null;
      const bgName = chart.meta.background || 'BG.jpg';
      const bgEntry = entries.get(bgName) || entries.get('BG.jpg');
      if (bgEntry) {
        const ext = path.extname(bgName) || '.jpg';
        const rel = path.join('.cache', `${id}${ext}`);
        const dest = path.join(ROOT, rel);
        if (!fs.existsSync(dest)) fs.writeFileSync(dest, readEntry(buf, bgEntry));
        cover = rel.split(path.sep).map(encodeURIComponent).join('/');
      }

      const difficulties = Object.entries(chart.difficulties).map(([name, d]) => ({
        name,
        keys: d.keys || 4,
        od: d.od ?? 8,
        hp: d.hp ?? 7,
        noteCount: d.noteCount ?? d.notes.length,
        length: d.notes.length ? Math.max(...d.notes.map(n => n.end ?? n.t)) : 0,
        stars: starRating(d.notes),
      })).sort((a, b) => a.stars - b.stars);

      out.push({
        id,
        file,
        url: `beatmaps/${encodeURIComponent(file)}`,
        title: chart.meta.title,
        titleUnicode: chart.meta.titleUnicode,
        artist: chart.meta.artist,
        artistUnicode: chart.meta.artistUnicode,
        creator: chart.meta.creator,
        video: !!chart.meta.video,
        cover,
        length: Math.max(...difficulties.map(d => d.length), 0),
        bytes: stat.size,
        difficulties,
      });
      console.log(`  ✓ ${chart.meta.title} (${difficulties.length} diffs)`);
    } catch (err) {
      console.warn(`  ✗ ${file}: ${err.message}`);
    }
  }
  INDEX = out;
}

/* ---------------- http ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjk': 'application/zip',
  '.mjc': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};

function sendFile(req, res, filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return send(res, 404, 'Not found'); }
  if (stat.isDirectory()) return send(res, 404, 'Not found');

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  // Source files change on every deploy and must be revalidated every load,
  // or a browser can sit on a stale style.css/main.js indefinitely with no
  // visible sign anything is wrong. Beatmaps/media are immutable once
  // published (content-addressed by filename), so those are fine to cache.
  const ext = path.extname(filePath).toLowerCase();
  const cacheControl = ['.html', '.css', '.js', '.json'].includes(ext)
    ? 'no-cache'
    : 'public, max-age=604800';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      if (start >= stat.size) return send(res, 416, 'Range not satisfiable');
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
  });
  fs.createReadStream(filePath).pipe(res);
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { return send(res, 400, 'Bad request'); }

  if (urlPath === '/') urlPath = '/index.html';

  if (urlPath === '/api/songs') {
    return send(res, 200, JSON.stringify(INDEX), 'application/json; charset=utf-8');
  }
  if (urlPath === '/api/reload') {
    buildIndex();
    return send(res, 200, JSON.stringify({ ok: true, songs: INDEX.length }), 'application/json; charset=utf-8');
  }

  if (urlPath.startsWith('/beatmaps/')) {
    const name = path.basename(urlPath.slice('/beatmaps/'.length));
    return sendFile(req, res, path.join(SONGS_DIR, name));
  }

  const target = path.normalize(path.join(ROOT, urlPath));
  if (!target.startsWith(ROOT)) return send(res, 403, 'Forbidden');
  sendFile(req, res, target);
});

console.log('ミュージック! — building beatmap index…');
console.log(`  songs: ${SONGS_DIR}`);
buildIndex();
server.listen(PORT, () => {
  console.log(`\n♪ ミュージック! ready — http://localhost:${PORT}  (${INDEX.length} beatmaps)\n`);
});
