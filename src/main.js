// App shell: screens, song library, settings, results.

import { settings, saveSettings, resetSettings, getBest, submitScore } from './store.js';
import {
  audio, initAudio, resumeAudio, setMusicVolume, setSfxVolume, setPreviewVolume, decodeSong,
  stopSong, playPreview, stopPreview, sfxMove, sfxConfirm, sfxBack, sfxApplause,
} from './audio.js';
import { loadBeatmap, peekBeatmap, starColor, formatTime } from './chart.js';
import { BEATMAP_REPO, listRepoBeatmaps, peekRemoteBeatmap } from './beatmaps.js';
import { openRemoteZip, readZip } from './zip.js';
import { getMeta, putMeta, flushMeta, getBlob, putBlob, cacheSize, clearCache } from './cache.js';
import { logoSVG, generateCover, JUDGE_STYLE } from './skin.js';
import { Game, JUDGEMENTS } from './game.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = {
  library: [],        // { id, title, artist, mapper, cover, difficulties[], source }
  filtered: [],
  songIndex: 0,
  diffIndex: 0,
  beatmap: null,      // fully loaded beatmap for the current song
  loadedId: null,
  game: null,
  lastResult: null,
  screen: 'boot',
};

let bootStarted = false;

/* ================= screens ================= */

function show(name) {
  state.screen = name;
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#screen-${name}`).classList.add('active');
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ================= background ================= */

function setBackground({ image, video } = {}) {
  const img = $('#bg-image'), vid = $('#bg-video');
  img.style.backgroundImage = image ? `url("${image}")` : 'none';
  if (video && settings.video) {
    if (vid.src !== video) { vid.src = video; vid.loop = true; }
    vid.classList.add('on');
    vid.play().catch(err => warnVideoFailure(err.message));
  } else {
    vid.classList.remove('on');
    vid.pause();
  }
  applyDim();
}

let videoWarned = false;

/** Surface a video failure once instead of silently showing the static cover. */
function warnVideoFailure(detail) {
  if (videoWarned) return;
  videoWarned = true;
  console.warn(`[video] playback failed: ${detail}`);
  toast(`動画再生に失敗 / video playback failed — falling back to the cover image (${detail})`, 6000);
}

function applyDim() {
  const d = settings.dim / 100;
  $('#bg-dim').style.background =
    `radial-gradient(120% 90% at 50% 0%, rgba(157,107,255,${0.20 * (1 - d * 0.6)}), transparent 60%),` +
    `linear-gradient(180deg, rgba(4,2,10,${0.20 + d * 0.78}), rgba(4,2,10,${0.30 + d * 0.68}))`;
}

/* ================= ambient FX canvas ================= */

function startAmbient() {
  const c = $('#fx'), g = c.getContext('2d');
  const petals = Array.from({ length: 46 }, () => spawnPetal(true));
  function spawnPetal(anywhere) {
    return {
      x: Math.random() * window.innerWidth,
      y: anywhere ? Math.random() * window.innerHeight : -20,
      r: 3 + Math.random() * 7,
      vy: 0.25 + Math.random() * 0.75,
      vx: -0.35 + Math.random() * 0.7,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.02,
      a: 0.18 + Math.random() * 0.35,
      pink: Math.random() > 0.4,
    };
  }
  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fit();
  addEventListener('resize', fit);
  (function tick() {
    requestAnimationFrame(tick);
    g.clearRect(0, 0, innerWidth, innerHeight);
    if (state.screen === 'game') return;             // keep the playfield clean
    for (let i = 0; i < petals.length; i++) {
      const p = petals[i];
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      if (p.y > innerHeight + 20) petals[i] = spawnPetal(false);
      g.save();
      g.translate(p.x, p.y); g.rotate(p.rot);
      g.globalAlpha = p.a;
      g.fillStyle = p.pink ? '#ff8ec0' : '#38e8ff';
      g.beginPath(); g.ellipse(0, 0, p.r, p.r * 0.52, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    g.globalAlpha = 1;
  })();
}

/* ================= library ================= */

/** Build a library entry from a chart's metadata. */
function makeEntry(url, meta, difficulties, bgURL, bytes = 0) {
  return {
    id: url,
    bytes,
    backgroundName: meta.background || 'BG.jpg',
    audioName: meta.audio || 'audio.mp3',
    previewTime: Number(meta.previewTime) || 0,
    title: meta.titleUnicode || meta.title || url.split('/').pop(),
    titleRoman: meta.title || '',
    artist: meta.artistUnicode || meta.artist || 'Unknown',
    mapper: meta.creator || 'unknown',
    cover: bgURL || generateCover(meta.title || url),
    hasCover: !!bgURL,
    hasVideo: !!meta.video,
    length: Math.max(...difficulties.map(d => d.length), 0),
    difficulties: difficulties.map(d => ({
      name: d.name, keys: d.keys, od: d.od, hp: d.hp,
      noteCount: d.noteCount, length: d.length, stars: d.stars,
    })),
    url,
    source: 'server',
  };
}

// Concurrent, bounded worker pool — lets hundreds of beatmaps' metadata load in
// parallel instead of one round-trip at a time, without opening unbounded
// connections. raw.githubusercontent.com is a real CDN, so this is safe.
async function pool(items, limit, worker) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const item = items[i++];
      try { await worker(item); } catch (err) { console.error(err); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

// Rebuilding the whole song list is O(n) — fine once, ruinous if called after
// every single completion in a pool of hundreds. Coalesce bursts into at most
// one render every 150ms, plus a final one when the caller is done.
function throttled(fn, ms) {
  let last = 0, timer = null;
  const call = () => { last = Date.now(); clearTimeout(timer); timer = null; fn(); };
  const trigger = () => {
    const wait = ms - (Date.now() - last);
    if (wait <= 0) call();
    else if (!timer) timer = setTimeout(call, wait);
  };
  trigger.flush = () => { clearTimeout(timer); timer = null; fn(); };
  return trigger;
}

const METADATA_CONCURRENCY = 8;
const COVER_CONCURRENCY = 6;

async function loadLibrary() {
  state.library = [];

  let listed = [];
  try {
    listed = await listRepoBeatmaps();
  } catch (err) {
    console.warn(`Could not reach the beatmap repository: ${err.message}`);
    toast(`ビートマップ取得失敗 / ${err.message}`, 5000);
  }

  // Fall back to whatever files.js lists (local copies, offline play).
  const local = (window.MYUJIKKU_FILES?.songs ?? []).map(url => ({ url, name: url.split('/').pop() }));
  const sources = listed.length ? listed : local;

  if (!sources.length) {
    refreshList();
    $('#song-empty').classList.remove('hidden');
    return;
  }

  const seen = new Set();
  const renderSoon = throttled(refreshList, 150);

  // Cached beatmaps render with zero network at all — do them first, as one
  // batch, so a return visit shows the full list instantly. Their cover still
  // needs loading (from cache when possible), so they go into `pending` too —
  // skipping that step used to leave every previously-seen song stuck with
  // its placeholder art forever, since nothing ever re-checked it.
  const uncached = [];
  const pending = [];
  for (const item of sources) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    const cached = getMeta(item.url, item.bytes);
    if (cached) {
      const entry = makeEntry(item.url, cached.meta, cached.difficulties, null, item.bytes);
      state.library.push(entry);
      pending.push({ entry, item, zip: null });
    } else {
      uncached.push(item);
    }
  }
  refreshList();
  if (!state.library.length && !uncached.length) $('#song-empty').classList.remove('hidden');

  // Metadata is read over range requests — a few hundred KB each rather than
  // the whole archive — and fetched METADATA_CONCURRENCY at a time. Without a
  // known size (the files.js fallback) there's nothing to range against.
  await pool(uncached, METADATA_CONCURRENCY, async item => {
    if (item.bytes) {
      const peek = await peekRemoteBeatmap(item.url, { size: item.bytes });
      putMeta(item.url, item.bytes, { meta: peek.meta, difficulties: peek.difficulties });
      const entry = makeEntry(item.url, peek.meta, peek.difficulties, null, item.bytes);
      state.library.push(entry);
      pending.push({ entry, item, zip: peek.zip });
    } else {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const peek = await peekBeatmap(await res.arrayBuffer());
      state.library.push(makeEntry(item.url, peek.meta, peek.difficulties, peek.bgURL, item.bytes));
    }
    renderSoon();
  });
  renderSoon.flush();
  flushMeta();
  if (!state.library.length) $('#song-empty').classList.remove('hidden');

  // Cover art is the heaviest part of the metadata, so it loads after the list
  // is already usable, is pooled the same way, and is cached so it only ever
  // downloads once.
  await pool(pending, COVER_CONCURRENCY, async ({ entry, item, zip }) => {
    const bgURL = await loadCover(entry, item, zip);
    if (!bgURL) return;
    entry.cover = bgURL;
    entry.hasCover = true;
    renderSoon();
    if (state.filtered[state.songIndex]?.id === entry.id) {
      $('#detail-art').style.backgroundImage = `url('${bgURL}')`;
      setBackground({ image: bgURL });
    }
  });
  renderSoon.flush();
}

/** Cover art: from cache when we have it, otherwise read out of the archive. */
async function loadCover(entry, item, zip) {
  const cachedCover = await getBlob('cover', item.url, item.bytes);
  if (cachedCover) return URL.createObjectURL(new Blob([cachedCover], { type: 'image/jpeg' }));

  // A cached archive already holds the artwork — no need to go back to the network.
  const cachedArchive = await getBlob('archive', item.url, item.bytes);
  if (cachedArchive) {
    const peek = await peekBeatmap(cachedArchive.slice(0));
    return peek.bgURL;
  }

  if (!zip) {
    if (!item.bytes) return null;
    const peek = await peekRemoteBeatmap(item.url, { size: item.bytes });
    zip = peek.zip;
  }

  const name = [entry.backgroundName, 'BG.jpg', 'bg.jpg'].find(n => n && zip.entries.has(n));
  if (!name) return null;
  const bytes = await zip.read(name);
  if (!bytes) return null;
  await putBlob('cover', item.url, item.bytes, bytes, 'image/jpeg');
  return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
}
function normaliseIndexEntry(e) {
  return {
    id: e.id,
    title: e.titleUnicode || e.title,
    titleRoman: e.title,
    artist: e.artistUnicode || e.artist,
    mapper: e.creator || 'unknown',
    cover: e.cover || generateCover(e.title || e.id),
    hasVideo: !!e.video,
    length: e.length || 0,
    difficulties: e.difficulties,
    url: e.url,
    source: 'server',
  };
}

function refreshList() {
  const q = $('#search').value.trim().toLowerCase();
  state.filtered = state.library.filter(s =>
    !q || [s.title, s.titleRoman, s.artist, s.mapper].join(' ').toLowerCase().includes(q));

  const list = $('#song-list');
  list.innerHTML = '';
  state.filtered.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'song-card' + (i === state.songIndex ? ' sel' : '');
    el.innerHTML = `
      <div class="song-thumb" style="background-image:url('${s.cover}')"></div>
      <div class="song-meta">
        <div class="song-name"></div>
        <div class="song-sub"></div>
      </div>
      <div class="song-badges">
        ${s.hasVideo ? '<span class="badge">VIDEO</span>' : ''}
        <span class="badge">${s.difficulties.length} DIFF</span>
        <span class="badge">${formatTime(s.length)}</span>
      </div>`;
    el.querySelector('.song-name').textContent = s.title;
    el.querySelector('.song-sub').textContent = `${s.artist} · mapped by ${s.mapper}`;
    el.addEventListener('click', () => { selectSong(i); });
    el.addEventListener('dblclick', () => startPlay());
    list.appendChild(el);
  });

  $('#song-empty').classList.toggle('hidden', state.filtered.length > 0);
  if (state.filtered.length) selectSong(Math.min(state.songIndex, state.filtered.length - 1), true);
  else clearDetail();
}

function clearDetail() {
  $('#detail-title').textContent = '—';
  $('#detail-artist').textContent = '';
  $('#detail-mapper').textContent = '';
  $('#diff-list').innerHTML = '';
  $('#detail-stats').textContent = '';
  $('#detail-best').textContent = '';
  $('#btn-play').disabled = true;
}

function selectSong(i, quiet) {
  if (!state.filtered.length) return;
  state.songIndex = (i + state.filtered.length) % state.filtered.length;
  const s = state.filtered[state.songIndex];
  state.diffIndex = Math.min(state.diffIndex, s.difficulties.length - 1);

  $$('#song-list .song-card').forEach((el, idx) => el.classList.toggle('sel', idx === state.songIndex));
  const sel = $$('#song-list .song-card')[state.songIndex];
  sel?.scrollIntoView({ block: 'nearest' });

  $('#detail-art').style.backgroundImage = `url('${s.cover}')`;
  $('#detail-title').textContent = s.title;
  $('#detail-artist').textContent = s.artist;
  $('#detail-mapper').textContent = `mapped by ${s.mapper}`;
  $('#btn-play').disabled = false;
  setBackground({ image: s.cover });
  renderDiffs();
  if (!quiet) sfxMove();
  queuePreview(s);
}

/* ================= song preview ================= */

let previewTimer = null;
let previewToken = 0;

/** Debounced so arrow-key-mashing through the list doesn't fire a fetch per song. */
function queuePreview(song) {
  clearTimeout(previewTimer);
  const mine = ++previewToken;
  stopPreview();
  if (!settings.music) return;              // music volume 0 = previews off too
  previewTimer = setTimeout(() => startPreviewFor(song, mine), 260);
}

function cancelPreview() {
  clearTimeout(previewTimer);
  previewToken++;
  stopPreview();
}

async function startPreviewFor(song, token) {
  try {
    let buf;
    if (song.source === 'local') {
      buf = song.buffer;
    } else {
      // Same trick as loadCover: pull just the audio entry out of the remote
      // zip over range requests, not the whole archive.
      const cachedArchive = await getBlob('archive', song.url, song.bytes);
      if (cachedArchive) {
        buf = cachedArchive;
      } else if (song.bytes) {
        const zip = await openRemoteZip(song.url, song.bytes);
        const bytes = await zip.read(song.audioName) || await zip.read('audio.mp3');
        if (!bytes) return;
        buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } else {
        const res = await fetch(song.url);
        if (!res.ok) return;
        buf = await res.arrayBuffer();
      }
    }
    if (token !== previewToken) return;      // selection moved on while we were fetching

    initAudio();
    // `buf` may already be a bare audio file (remote fetch) or a whole .mjk
    // archive (local drag-drop, or an already-cached full download) — handle both.
    const decoded = await decodePreviewBuffer(await extractAudioIfArchive(buf));
    if (token !== previewToken) return;
    playPreview(decoded, song.previewTime || decoded.duration * 1000 * 0.25);
  } catch (err) {
    console.warn(`Preview unavailable for ${song.title}`, err);
  }
}

/** `buf` may be a raw audio file already, or a whole .mjk archive (local imports). */
async function extractAudioIfArchive(buf) {
  try {
    const files = await readZip(buf.slice ? buf.slice(0) : buf);
    if (files.has('audio.mp3')) {
      const b = files.get('audio.mp3');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
  } catch { /* not a zip — it's a plain audio file, fall through */ }
  return buf;
}

async function decodePreviewBuffer(bufOrPromise) {
  const buf = await bufOrPromise;
  return audio.ctx.decodeAudioData(buf.slice(0));
}

function renderDiffs() {
  const s = state.filtered[state.songIndex];
  if (!s) return;
  const list = $('#diff-list');
  list.innerHTML = '';
  s.difficulties.forEach((d, i) => {
    const el = document.createElement('div');
    el.className = 'diff-item' + (i === state.diffIndex ? ' sel' : '');
    el.innerHTML = `<span class="diff-dot" style="background:${starColor(d.stars)}"></span>
      <span class="diff-name"></span>
      <span class="diff-sr" style="color:${starColor(d.stars)}">${d.stars.toFixed(2)}★</span>`;
    el.querySelector('.diff-name').textContent = d.name;
    el.addEventListener('click', () => { state.diffIndex = i; renderDiffs(); sfxMove(); });
    el.addEventListener('dblclick', () => startPlay());
    list.appendChild(el);
  });

  const d = s.difficulties[state.diffIndex];
  $('#detail-stats').innerHTML = d
    ? `ノーツ / Notes: <b>${d.noteCount}</b> &nbsp;·&nbsp; ${d.keys}K<br>
       OD <b>${d.od}</b> &nbsp;·&nbsp; HP <b>${d.hp}</b> &nbsp;·&nbsp; ${formatTime(d.length)}`
    : '';

  const best = d ? getBest(s.id, d.name) : null;
  $('#detail-best').textContent = best
    ? `ベスト / Best: ${best.score.toLocaleString()} (${best.accuracy.toFixed(2)}% ${best.grade}) ×${best.maxCombo}`
    : '';
}

/* ================= loading + play ================= */

async function fetchBeatmapBuffer(song, onProgress) {
  if (song.source === 'local') return song.buffer;

  // Already downloaded once? Play straight from the cache.
  const cached = await getBlob('archive', song.url, song.bytes);
  if (cached) {
    onProgress(0.85, 'キャッシュから読み込み / from cache');
    return cached;
  }

  const res = await fetch(song.url);
  if (!res.ok) throw new Error(`Failed to fetch beatmap (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;

  let buffer;
  if (!res.body || !total) {
    buffer = await res.arrayBuffer();
  } else {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(Math.min(0.85, got / total * 0.85), `ダウンロード中… ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    buffer = out.buffer;
  }

  await putBlob('archive', song.url, song.bytes, buffer, 'application/zip');
  return buffer;
}

async function startPlay() {
  const song = state.filtered[state.songIndex];
  if (!song) return;
  const diffMeta = song.difficulties[state.diffIndex];
  if (!diffMeta) return;

  cancelPreview();
  sfxConfirm();
  show('loading');
  const setP = (p, label) => {
    $('#loading-bar').style.width = `${Math.round(p * 100)}%`;
    if (label) $('#loading-text').textContent = label;
  };
  setP(0.02, '準備中… / preparing');

  try {
    if (state.loadedId !== song.id) {
      const buf = await fetchBeatmapBuffer(song, setP);
      setP(0.87, '展開中… / unpacking');
      const bm = await loadBeatmap(buf, (p, l) => setP(0.87 + p * 0.06, l));
      setP(0.94, '音源をデコード中… / decoding audio');
      await decodeSong(bm.audioBuffer.slice(0));
      state.beatmap = bm;
      state.loadedId = song.id;
    }
    setP(1, 'スタート!');

    const diff = state.beatmap.difficulties.find(d => d.name === diffMeta.name)
              || state.beatmap.difficulties[state.diffIndex];
    setBackground({ image: state.beatmap.bgURL || song.cover, video: state.beatmap.videoURL });

    show('game');
    launchGame(song, diff);
  } catch (err) {
    console.error(err);
    toast(`読み込み失敗 / load failed: ${err.message}`, 5000);
    show('select');
  }
}

function launchGame(song, diff) {
  state.game?.destroy();
  $('#pause-overlay').classList.add('hidden');

  const vid = $('#bg-video');
  vid.loop = false;                       // the chart drives the video during play

  const game = new Game($('#playfield'), state.beatmap, diff, {
    onPause: () => { game.pause(); vid.pause(); $('#pause-overlay').classList.remove('hidden'); },
    onResume: () => { $('#pause-overlay').classList.add('hidden'); game.resume(); },
    onRestart: () => { launchGame(song, diff); },
    onEnd: (result) => finishGame(song, diff, result),
  });
  state.game = game;
  state.hud = setInterval(() => { updateHUD(game); syncVideo(game); }, 60);
  game.start();
  $('#hud-info').textContent = `${song.title} — ${diff.name}${settings.autoplay ? ' · AUTOPLAY' : ''}`;
}

/**
 * Keep the background video locked to the song clock.
 * `meta.videoOffset` is the song time at which the video's first frame belongs,
 * so the video's own timeline is (songTime − videoOffset).
 */
function syncVideo(game) {
  const vid = $('#bg-video');
  if (!state.beatmap?.videoURL || !settings.video) return;
  if (game.paused || !game.running) { if (!vid.paused) vid.pause(); return; }

  const target = (game._t - (state.beatmap.meta?.videoOffset || 0)) / 1000;
  if (target < 0 || (vid.duration && target > vid.duration)) {
    if (!vid.paused) vid.pause();
    return;
  }
  if (vid.paused) {
    vid.currentTime = target;
    vid.play().catch(() => {});
  } else if (Math.abs(vid.currentTime - target) > 0.18 && vid.readyState >= 2) {
    vid.currentTime = target;             // drifted (seek, lag spike) — snap back
  }
}

function updateHUD(game) {
  if (!game.running) return;
  $('#hud-score').textContent = game.score.toLocaleString();
  $('#hud-acc').textContent = `${game.accuracy.toFixed(2)}%`;
}

function finishGame(song, diff, result) {
  clearInterval(state.hud);
  stopSong();
  $('#bg-video').pause();
  state.lastResult = { song, diff, result };
  renderResults(song, diff, result);
  show('results');
  if (result.failed) { /* fail jingle already played */ } else sfxApplause();
}

function quitGame() {
  clearInterval(state.hud);
  state.game?.destroy();
  state.game = null;
  $('#pause-overlay').classList.add('hidden');
  $('#bg-video').pause();
  const s = state.filtered[state.songIndex];
  setBackground({ image: s?.cover });
  show('select');
  sfxBack();
  if (s) queuePreview(s);
}

/* ================= results ================= */

function renderResults(song, diff, r) {
  $('#r-title').textContent = `${song.title} — ${diff.name}`;
  $('#r-sub').textContent = `${song.artist} · ${diff.stars.toFixed(2)}★ · ${diff.noteCount} notes`;
  $('#r-grade').textContent = r.failed ? 'F' : r.grade;
  $('#r-score').textContent = r.score.toLocaleString();
  $('#r-acc').textContent = `${r.accuracy.toFixed(2)}%`;
  $('#r-combo').textContent = `${r.maxCombo}×`;
  $('#r-mean').textContent = `${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(1)} ms`;

  $('#r-grid').innerHTML = JUDGEMENTS.map(j => `
    <div class="r-cell">
      <b style="color:${JUDGE_STYLE[j].color}">${r.counts[j]}</b>
      <span>${JUDGE_STYLE[j].sub}</span>
    </div>`).join('');

  let isBest = false;
  if (!r.autoplay && !r.failed) {
    isBest = submitScore(song.id, diff.name, {
      score: r.score, accuracy: r.accuracy, grade: r.grade, maxCombo: r.maxCombo, at: Date.now(),
    });
  }
  $('#r-newbest').classList.toggle('hidden', !isBest);
  drawErrorGraph(r, diff);
}

function drawErrorGraph(r, diff) {
  const c = $('#r-graph'), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const W = c.width, H = c.height, mid = H / 2;
  const maxErr = 188 - 3 * diff.od;

  g.strokeStyle = 'rgba(255,255,255,.18)';
  g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,.08)';
  for (const f of [0.5, -0.5]) {
    g.beginPath(); g.moveTo(0, mid + f * mid); g.lineTo(W, mid + f * mid); g.stroke();
  }

  if (!r.errors.length) return;
  const tMax = Math.max(...r.errors.map(e => e.t)) || 1;
  for (const e of r.errors) {
    const x = (e.t / tMax) * (W - 8) + 4;
    const y = mid + (e.err / maxErr) * (mid - 8);
    const abs = Math.abs(e.err);
    const j = abs <= 16.5 ? 'MAX' : abs <= 64 - 3 * diff.od ? 'PERFECT'
            : abs <= 97 - 3 * diff.od ? 'GREAT' : abs <= 127 - 3 * diff.od ? 'GOOD' : 'MEH';
    g.fillStyle = JUDGE_STYLE[j].color;
    g.globalAlpha = 0.75;
    g.fillRect(x - 1, y - 1, 2.5, 2.5);
  }
  g.globalAlpha = 1;
  g.fillStyle = 'rgba(255,255,255,.5)';
  g.font = '11px "Segoe UI",sans-serif';
  g.fillText(`遅い / late  +${maxErr.toFixed(0)}ms`, 8, H - 8);
  g.fillText(`早い / early  −${maxErr.toFixed(0)}ms`, 8, 14);
}

/* ================= settings ================= */

function bindSettings() {
  const map = [
    ['#s-speed', 'speed', '#v-speed', v => `${v}`],
    ['#s-offset', 'offset', '#v-offset', v => `${v > 0 ? '+' : ''}${v} ms`],
    ['#s-music', 'music', '#v-music', v => `${v}%`],
    ['#s-hit', 'hit', '#v-hit', v => `${v}%`],
    ['#s-dim', 'dim', '#v-dim', v => `${v}%`],
  ];
  const sync = () => {
    for (const [sel, key, label, fmt] of map) {
      $(sel).value = settings[key];
      $(label).textContent = fmt(settings[key]);
    }
    $('#s-video').checked = settings.video;
    $('#s-upscroll').checked = settings.upscroll;
    $('#s-fx').checked = settings.fx;
    $('#s-autoplay').checked = settings.autoplay;
    setMusicVolume(settings.music / 100);
    setPreviewVolume(settings.music / 100);
    setSfxVolume(settings.hit / 100);
    applyDim();
    renderKeybinds();
  };

  for (const [sel, key, label, fmt] of map) {
    $(sel).addEventListener('input', e => {
      settings[key] = Number(e.target.value);
      $(label).textContent = fmt(settings[key]);
      if (key === 'music') { setMusicVolume(settings.music / 100); setPreviewVolume(settings.music / 100); if (!settings.music) cancelPreview(); }
      if (key === 'hit') setSfxVolume(settings.hit / 100);
      if (key === 'dim') applyDim();
      if (key === 'speed') state.game?.resize();
      saveSettings();
    });
  }
  for (const [sel, key] of [['#s-video', 'video'], ['#s-upscroll', 'upscroll'], ['#s-fx', 'fx'], ['#s-autoplay', 'autoplay']]) {
    $(sel).addEventListener('change', e => {
      settings[key] = e.target.checked;
      saveSettings();
      if (key === 'upscroll') state.game?.resize();
    });
  }
  $('#btn-settings-reset').addEventListener('click', () => { resetSettings(); sync(); toast('設定をリセットしました'); });

  $('#btn-cache-clear').addEventListener('click', async () => {
    await clearCache();
    state.loadedId = null;
    await refreshCacheReadout();
    toast('キャッシュを削除しました / cache cleared');
  });
  sync();
  settingsSync = sync;
}
let settingsSync = () => {};

function renderKeybinds() {
  const box = $('#keybinds');
  box.innerHTML = '';
  settings.keys.forEach((code, i) => {
    const el = document.createElement('div');
    el.className = 'kb';
    el.textContent = prettyKey(code);
    el.addEventListener('click', () => {
      $$('.kb').forEach(k => k.classList.remove('listening'));
      el.classList.add('listening');
      el.textContent = '…';
      const onKey = e => {
        e.preventDefault();
        window.removeEventListener('keydown', onKey, true);
        if (e.code !== 'Escape') settings.keys[i] = e.code;
        saveSettings();
        renderKeybinds();
      };
      window.addEventListener('keydown', onKey, true);
    });
    box.appendChild(el);
  });
}

function prettyKey(code) {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return '␣';
  if (code.startsWith('Arrow')) return { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }[code];
  if (code.startsWith('Semicolon')) return ';';
  return code.replace(/^(Numpad|Bracket)/, '');
}

/* ================= local .mjk import ================= */

async function importLocalFile(file) {
  try {
    toast(`読み込み中: ${file.name}`);
    const buf = await file.arrayBuffer();
    const peek = await peekBeatmap(buf.slice(0));
    const id = `local:${file.name}`;
    const entry = {
      id,
      title: peek.meta.titleUnicode || peek.meta.title,
      titleRoman: peek.meta.title,
      artist: peek.meta.artistUnicode || peek.meta.artist,
      mapper: peek.meta.creator || 'unknown',
      cover: peek.bgURL || generateCover(peek.meta.title || id),
      hasVideo: !!peek.meta.video,
      length: Math.max(...peek.difficulties.map(d => d.length), 0),
      difficulties: peek.difficulties.map(d => ({
        name: d.name, keys: d.keys, od: d.od, hp: d.hp,
        noteCount: d.noteCount, length: d.length, stars: d.stars,
      })),
      source: 'local',
      buffer: buf,
    };
    const existing = state.library.findIndex(s => s.id === id);
    if (existing >= 0) state.library[existing] = entry; else state.library.unshift(entry);
    if (state.loadedId === id) state.loadedId = null;
    refreshList();
    selectSong(state.library.indexOf(entry) >= 0 ? 0 : 0);
    toast(`追加しました: ${entry.title}`);
  } catch (err) {
    console.error(err);
    toast(`読み込み失敗: ${err.message}`, 5000);
  }
}

function bindDropAndImport() {
  const hint = $('#drop-hint');
  let depth = 0;
  addEventListener('dragenter', e => { e.preventDefault(); depth++; hint.classList.remove('hidden'); });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('dragleave', e => { e.preventDefault(); if (--depth <= 0) hint.classList.add('hidden'); });
  addEventListener('drop', async e => {
    e.preventDefault(); depth = 0; hint.classList.add('hidden');
    for (const f of e.dataTransfer.files) {
      if (f.name.toLowerCase().endsWith('.mjk')) await importLocalFile(f);
    }
  });

  $('#btn-import').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.mjk';
    inp.multiple = true;
    inp.onchange = async () => { for (const f of inp.files) await importLocalFile(f); };
    inp.click();
  });
}

/* ================= global keys ================= */

function bindKeys() {
  addEventListener('keydown', e => {
    if (document.activeElement === $('#search')) {
      if (e.key === 'Escape') { $('#search').blur(); }
      return;
    }
    if ($$('.kb.listening').length) return;

    if (state.screen === 'boot' && (e.key === 'Enter' || e.key === ' ')) { boot(); return; }

    if (state.screen === 'select') {
      if (e.key === 'ArrowDown') { e.preventDefault(); selectSong(state.songIndex + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selectSong(state.songIndex - 1); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const s = state.filtered[state.songIndex];
        if (s) {
          const n = s.difficulties.length;
          state.diffIndex = (state.diffIndex + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
          renderDiffs(); sfxMove();
        }
      } else if (e.key === 'Enter') { e.preventDefault(); startPlay(); }
      else if (e.key === 'Escape') { openSettings(); }
      else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    } else if (state.screen === 'settings' && e.key === 'Escape') {
      closeSettings();
    } else if (state.screen === 'results') {
      if (e.key === 'Enter' || e.key === 'Escape') { backToSelect(); }
      else if (e.key === '`') { retry(); }
    }
  });
}

async function refreshCacheReadout() {
  const { bytes, count, available } = await cacheSize();
  $('#v-cache').textContent = available
    ? `${count} 件 / ${(bytes / 1048576).toFixed(1)} MB`
    : '利用不可 / unavailable';
}

function openSettings() { show('settings'); settingsSync(); refreshCacheReadout(); sfxMove(); }
function closeSettings() { show('select'); sfxBack(); }

function backToSelect() {
  state.game?.destroy();
  state.game = null;
  const s = state.filtered[state.songIndex];
  setBackground({ image: s?.cover });
  show('select');
  renderDiffs();
  sfxBack();
  if (s) queuePreview(s);
}

function retry() {
  const last = state.lastResult;
  if (!last) return;
  show('game');
  launchGame(last.song, last.diff);
}

/* ================= boot ================= */

async function boot() {
  if (bootStarted) return;
  bootStarted = true;

  initAudio();
  await resumeAudio();

  setMusicVolume(settings.music / 100);
  setPreviewVolume(settings.music / 100);
  setSfxVolume(settings.hit / 100);

  sfxConfirm();

  show('select');

  await loadLibrary();
}

function init() {
  $('#logo-slot').innerHTML = logoSVG();
  startAmbient();
  bindSettings();
  bindDropAndImport();
  bindKeys();

$('#boot-start').addEventListener('click', e => {
  e.stopPropagation();
  boot();
});

$('#screen-boot').addEventListener('click', boot);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-settings-close').addEventListener('click', closeSettings);
  $('#btn-play').addEventListener('click', startPlay);
  $('#search').addEventListener('input', () => { state.songIndex = 0; refreshList(); });

  $('#btn-mobile-pause').addEventListener('click', () => state.game?.hooks.onPause?.());
  $('#btn-resume').addEventListener('click', () => state.game?.hooks.onResume?.());
  $('#btn-restart').addEventListener('click', () => state.game?.hooks.onRestart?.());
  $('#btn-quit').addEventListener('click', quitGame);
  $('#btn-r-retry').addEventListener('click', retry);
  $('#btn-r-back').addEventListener('click', backToSelect);

  applyDim();

  // The play() promise only catches *rejection*; a codec the browser can't
  // decode at all fires this event instead, with play() never settling.
  $('#bg-video').addEventListener('error', e => {
    const codes = { 1: 'aborted', 2: 'network error', 3: 'decode error — codec unsupported?', 4: 'source not supported' };
    warnVideoFailure(codes[e.target.error?.code] || 'unknown error');
  });

  // Debug handle — handy for tuning and automated smoke tests.
  window.MJK = { state, settings, audio, startPlay, show };
}

init();
