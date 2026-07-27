// ミュージック! chart editor — timeline, note editing, playback, .osz import, export/upload.

import { readZip, bytesToText } from './zip.js';
import { convertOsz, packMjk } from './osz.js';
import { starRating, formatTime } from './chart.js';
import { LANE_COLORS, hexA } from './skin.js';
import {
  audio, initAudio, resumeAudio, decodeSong, playSong, stopSong, songTime,
  setMusicVolume, setSfxVolume, playHit,
} from './audio.js';

const $ = s => document.querySelector(s);

const KEYS = 4;
const PLAYHEAD_FRAC = 0.78;      // playhead sits here down the stage
const WAVE_W = 84;
const LANE_W = 92;

const ed = {
  chart: null,                   // { format, version, meta, difficulties }
  media: { audio: null, video: null, background: null },
  diffName: null,
  buffer: null,                  // decoded AudioBuffer
  peaks: null,                   // Float32Array of waveform peaks, 10 ms per bin
  view: 0,                       // time at the playhead, ms
  zoom: 60,                      // px per 100 ms
  snap: 4,
  rate: 1,
  playing: false,
  hitsounds: true,
  selection: new Set(),
  undo: [],
  redo: [],
  drag: null,
  dirty: false,
  nextHitIndex: 0,
  taps: [],
};

const PEAK_MS = 10;

/* ================= helpers ================= */

const notes = () => ed.chart?.difficulties?.[ed.diffName]?.notes || [];
const diff = () => ed.chart?.difficulties?.[ed.diffName];
const beatMs = () => 60000 / Math.max(1, Number($('#t-bpm').value) || 120);
const timingOffset = () => Number($('#t-offset').value) || 0;
const duration = () => (ed.buffer ? ed.buffer.duration * 1000 : 0);

function toast(msg, ms = 2800) {
  const el = $('#ed-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function status(msg) { $('#tr-status').textContent = msg; }

function snapTime(t) {
  if (!ed.snap) return Math.round(t);
  const step = beatMs() / ed.snap;
  return Math.round(timingOffset() + Math.round((t - timingOffset()) / step) * step);
}

function pushUndo() {
  const d = diff();
  if (!d) return;
  ed.undo.push(JSON.stringify(d.notes));
  if (ed.undo.length > 120) ed.undo.shift();
  ed.redo.length = 0;
  ed.dirty = true;
}

function applySnapshot(stack, other) {
  const d = diff();
  if (!d || !stack.length) return;
  other.push(JSON.stringify(d.notes));
  d.notes = JSON.parse(stack.pop());
  d.noteCount = d.notes.length;
  ed.selection.clear();
  refreshDiffList();
}

const undo = () => applySnapshot(ed.undo, ed.redo);
const redo = () => applySnapshot(ed.redo, ed.undo);

function sortNotes() {
  const d = diff();
  if (!d) return;
  d.notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
  d.noteCount = d.notes.length;
}

function fileDialog(accept, multiple = false) {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = multiple;
    inp.onchange = () => resolve(multiple ? [...inp.files] : inp.files[0] || null);
    inp.click();
  });
}

/* ================= loading ================= */

async function decodeCurrentAudio() {
  if (!ed.media.audio) return;
  initAudio();
  await resumeAudio();
  const copy = ed.media.audio.slice().buffer;
  ed.buffer = await decodeSong(copy);
  buildPeaks();
  $('#tr-seek').max = Math.max(1, Math.round(duration()));
}

function buildPeaks() {
  const buf = ed.buffer;
  if (!buf) { ed.peaks = null; return; }
  const data = buf.getChannelData(0);
  const per = Math.max(1, Math.floor(buf.sampleRate * PEAK_MS / 1000));
  const bins = Math.ceil(data.length / per);
  const peaks = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    let max = 0;
    const start = i * per, end = Math.min(data.length, start + per);
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  ed.peaks = peaks;
}

function newChartSkeleton(name = 'audio.mp3') {
  return {
    format: 'mjc',
    version: 1,
    meta: {
      title: name.replace(/\.[^.]+$/, ''),
      titleUnicode: '',
      artist: 'Unknown Artist',
      artistUnicode: '',
      creator: '',
      source: '',
      tags: '',
      audio: 'audio.mp3',
      video: null,
      videoOffset: 0,
      background: null,
      editor: { bpm: 120, offset: 0 },
      createdWith: 'myujikku-editor',
      createdAt: new Date().toISOString(),
    },
    difficulties: {
      Normal: { keys: 4, od: 7, hp: 6, originalMode: 'mania', noteCount: 0, notes: [] },
    },
  };
}

async function adoptChart(chart, media, label) {
  ed.chart = chart;
  ed.media = media;
  ed.diffName = Object.keys(chart.difficulties)[0] || null;
  ed.undo.length = 0;
  ed.redo.length = 0;
  ed.selection.clear();
  ed.view = 0;
  ed.dirty = false;

  status('音源をデコード中…');
  await decodeCurrentAudio();

  $('#t-bpm').value = chart.meta.editor?.bpm ?? 120;
  $('#t-offset').value = chart.meta.editor?.offset ?? 0;
  $('#m-videoOffset').value = chart.meta.videoOffset ?? 0;

  syncMetaInputs();
  refreshDiffList();
  refreshMedia();
  $('#ed-empty').classList.add('hidden');
  status(label || 'ready');
  resize();
}

async function openMjkFile(file) {
  status('読み込み中…');
  const files = await readZip(await file.arrayBuffer());
  const chartBytes = files.get('chart.mjc');
  if (!chartBytes) throw new Error('chart.mjc missing from archive');
  const chart = JSON.parse(bytesToText(chartBytes));
  const meta = chart.meta || {};
  await adoptChart(chart, {
    audio: files.get(meta.audio || 'audio.mp3') || files.get('audio.mp3') || null,
    video: files.get(meta.video || 'video.mp4') || files.get('video.mp4') || null,
    background: files.get(meta.background || 'BG.jpg') || files.get('BG.jpg') || null,
  }, `開きました: ${file.name}`);
  toast(`${chart.meta?.title || file.name} を読み込みました`);
}

async function importOszFile(file) {
  status('.osz を変換中…');
  const result = await convertOsz(await file.arrayBuffer(), (p, l) => status(`${l} ${Math.round(p * 100)}%`));
  await adoptChart(result.chart, result.media, '変換完了');
  ed.dirty = true;
  const count = Object.keys(result.chart.difficulties).length;
  toast(`変換しました: ${count} 難易度 / ${Object.values(result.chart.difficulties).reduce((a, d) => a + d.notes.length, 0)} ノーツ`);
}

async function newFromAudio(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await adoptChart(newChartSkeleton(file.name), { audio: bytes, video: null, background: null }, '新規チャート');
  ed.dirty = true;
  toast('新規チャートを作成しました');
}

/* ================= UI sync ================= */

function syncMetaInputs() {
  const m = ed.chart?.meta || {};
  $('#m-title').value = m.title || '';
  $('#m-titleU').value = m.titleUnicode || '';
  $('#m-artist').value = m.artist || '';
  $('#m-artistU').value = m.artistUnicode || '';
  $('#m-creator').value = m.creator || '';
  $('#m-tags').value = m.tags || '';
}

function bindMetaInputs() {
  const map = {
    '#m-title': 'title', '#m-titleU': 'titleUnicode', '#m-artist': 'artist',
    '#m-artistU': 'artistUnicode', '#m-creator': 'creator', '#m-tags': 'tags',
  };
  for (const [sel, key] of Object.entries(map)) {
    $(sel).addEventListener('input', e => {
      if (!ed.chart) return;
      ed.chart.meta[key] = e.target.value;
      ed.dirty = true;
    });
  }
  $('#m-videoOffset').addEventListener('input', e => {
    if (!ed.chart) return;
    ed.chart.meta.videoOffset = Number(e.target.value) || 0;
    ed.dirty = true;
  });
  for (const sel of ['#t-bpm', '#t-offset']) {
    $(sel).addEventListener('input', () => {
      if (!ed.chart) return;
      ed.chart.meta.editor = { bpm: Number($('#t-bpm').value) || 120, offset: Number($('#t-offset').value) || 0 };
      ed.dirty = true;
    });
  }
}

function refreshMedia() {
  const fmt = b => (b ? `${(b.length / 1048576).toFixed(2)} MB` : 'なし / none');
  $('#media-audio').textContent = fmt(ed.media.audio);
  $('#media-bg').textContent = fmt(ed.media.background);
  $('#media-video').textContent = fmt(ed.media.video);
}

function refreshDiffList() {
  const box = $('#ed-diffs');
  box.innerHTML = '';
  if (!ed.chart) return;
  for (const [name, d] of Object.entries(ed.chart.difficulties)) {
    const el = document.createElement('div');
    el.className = 'ed-diff' + (name === ed.diffName ? ' sel' : '');
    el.innerHTML = `<span class="n"></span><span class="c">${d.notes.length} · ${starRating(
      d.notes.map(n => ({ ...n, lane: n.lane - 1, hold: n.type === 'hold', end: n.end ?? n.t }))
    ).toFixed(2)}★</span>`;
    el.querySelector('.n').textContent = name;
    el.addEventListener('click', () => {
      ed.diffName = name;
      ed.selection.clear();
      ed.undo.length = 0; ed.redo.length = 0;
      refreshDiffList();
    });
    box.appendChild(el);
  }
  const d = diff();
  if (d) {
    $('#d-od').value = d.od ?? 7;
    $('#d-hp').value = d.hp ?? 6;
    $('#v-od').textContent = (d.od ?? 7).toFixed(1);
    $('#v-hp').textContent = (d.hp ?? 6).toFixed(1);
    const holds = d.notes.filter(n => n.type === 'hold').length;
    $('#d-stats').innerHTML =
      `ノーツ <b>${d.notes.length}</b> (tap ${d.notes.length - holds} / hold ${holds})<br>` +
      `長さ ${formatTime(d.notes.length ? Math.max(...d.notes.map(n => n.end ?? n.t)) : 0)} · 4K`;
  } else {
    $('#d-stats').textContent = '';
  }
}

/* ================= canvas ================= */

const canvas = $('#ed-canvas');
const g = canvas.getContext('2d');
let W = 0, H = 0, playheadY = 0, fieldX = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  playheadY = Math.floor(H * PLAYHEAD_FRAC);
  fieldX = Math.max(WAVE_W + 20, Math.floor((W - LANE_W * KEYS) / 2));
}

const pxPerMs = () => ed.zoom / 100;
const yFor = t => playheadY - (t - ed.view) * pxPerMs();
const timeFor = y => ed.view + (playheadY - y) / pxPerMs();
const laneX = i => fieldX + i * LANE_W;
const laneAt = x => {
  const i = Math.floor((x - fieldX) / LANE_W);
  return i >= 0 && i < KEYS ? i : -1;
};

function draw() {
  requestAnimationFrame(draw);
  drawFrame();
}

function drawFrame() {
  if (!W || !H) return;

  g.clearRect(0, 0, W, H);
  if (!ed.chart) return;

  if (ed.playing) {
    ed.view = songTime();
    if (ed.view >= duration()) pause();
    $('#tr-seek').value = Math.max(0, Math.round(ed.view));
    fireHitsounds();
  }
  $('#tr-time').textContent = fmtTime(ed.view);

  drawWaveform();
  drawGrid();
  drawNotes();
  drawPlayhead();
  drawDragPreview();
}

function fmtTime(ms) {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor(Math.abs(ms) % 1000)).padStart(3, '0')}`;
}

function drawWaveform() {
  if (!ed.peaks) return;
  const x0 = fieldX - WAVE_W - 16;
  g.fillStyle = 'rgba(255,255,255,.04)';
  g.fillRect(x0, 0, WAVE_W, H);

  const tTop = timeFor(0), tBottom = timeFor(H);
  const startBin = Math.max(0, Math.floor(tBottom / PEAK_MS));
  const endBin = Math.min(ed.peaks.length - 1, Math.ceil(tTop / PEAK_MS));
  const cx = x0 + WAVE_W / 2;

  g.strokeStyle = 'rgba(56,232,255,.55)';
  g.lineWidth = 1;
  g.beginPath();
  for (let b = startBin; b <= endBin; b++) {
    const y = yFor(b * PEAK_MS);
    const half = ed.peaks[b] * (WAVE_W / 2 - 2);
    g.moveTo(cx - half, y);
    g.lineTo(cx + half, y);
  }
  g.stroke();
}

function drawGrid() {
  const beat = beatMs();
  const off = timingOffset();
  const div = ed.snap || 1;
  const step = beat / div;
  const tTop = timeFor(-40), tBottom = timeFor(H + 40);

  // lane backdrop
  g.fillStyle = 'rgba(6,3,14,.6)';
  g.fillRect(fieldX, 0, LANE_W * KEYS, H);
  g.strokeStyle = 'rgba(255,255,255,.09)';
  for (let i = 1; i < KEYS; i++) {
    g.beginPath(); g.moveTo(laneX(i) + .5, 0); g.lineTo(laneX(i) + .5, H); g.stroke();
  }
  g.strokeStyle = 'rgba(255,61,139,.45)';
  g.beginPath();
  g.moveTo(fieldX + .5, 0); g.lineTo(fieldX + .5, H);
  g.moveTo(fieldX + LANE_W * KEYS + .5, 0); g.lineTo(fieldX + LANE_W * KEYS + .5, H);
  g.stroke();

  if (step * pxPerMs() < 3) return;      // too dense to be useful

  const first = Math.floor((tBottom - off) / step) * step + off;
  g.font = '10px "Segoe UI",sans-serif';
  g.textAlign = 'right';
  for (let t = first; t <= tTop; t += step) {
    const y = yFor(t);
    if (y < -20 || y > H + 20) continue;
    const beatIndex = (t - off) / beat;
    const isBeat = Math.abs(beatIndex - Math.round(beatIndex)) < 1e-6;
    const isMeasure = isBeat && Math.abs(Math.round(beatIndex) % 4) < 1e-6;

    g.strokeStyle = isMeasure ? 'rgba(255,255,255,.55)'
                  : isBeat ? 'rgba(255,255,255,.26)'
                  : 'rgba(255,255,255,.10)';
    g.lineWidth = isMeasure ? 2 : 1;
    g.beginPath();
    g.moveTo(fieldX, y + .5);
    g.lineTo(fieldX + LANE_W * KEYS, y + .5);
    g.stroke();

    if (isMeasure) {
      g.fillStyle = 'rgba(255,255,255,.5)';
      g.fillText(String(Math.round(beatIndex / 4) + 1), fieldX - 8, y + 4);
    }
  }
  g.textAlign = 'left';
}

function drawNotes() {
  const list = notes();
  const h = 16;
  const tTop = timeFor(-60), tBottom = timeFor(H + 60);

  for (const n of list) {
    const end = n.type === 'hold' ? n.end : n.t;
    if (end < tBottom || n.t > tTop) continue;
    const lane = n.lane - 1;
    if (lane < 0 || lane >= KEYS) continue;
    const col = LANE_COLORS[lane];
    const x = laneX(lane) + 6;
    const w = LANE_W - 12;
    const selected = ed.selection.has(n);

    if (n.type === 'hold') {
      const yh = yFor(n.t), yt = yFor(n.end);
      g.fillStyle = hexA(col.main, selected ? 0.75 : 0.45);
      g.fillRect(x + w * 0.18, yt, w * 0.64, yh - yt);
      g.strokeStyle = selected ? '#fff' : hexA(col.glow, 0.8);
      g.lineWidth = selected ? 2 : 1;
      g.strokeRect(x + w * 0.18, yt, w * 0.64, yh - yt);
      // tail cap
      g.fillStyle = col.glow;
      g.fillRect(x, yt - h / 2, w, h);
    }

    g.fillStyle = col.main;
    g.fillRect(x, yFor(n.t) - h / 2, w, h);
    g.strokeStyle = selected ? '#ffffff' : 'rgba(255,255,255,.75)';
    g.lineWidth = selected ? 2.5 : 1;
    g.strokeRect(x, yFor(n.t) - h / 2, w, h);
  }
}

function drawPlayhead() {
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(fieldX - WAVE_W - 20, playheadY + .5);
  g.lineTo(fieldX + LANE_W * KEYS + 10, playheadY + .5);
  g.stroke();
  g.fillStyle = '#ff3d8b';
  g.beginPath();
  g.moveTo(fieldX + LANE_W * KEYS + 10, playheadY);
  g.lineTo(fieldX + LANE_W * KEYS + 22, playheadY - 7);
  g.lineTo(fieldX + LANE_W * KEYS + 22, playheadY + 7);
  g.fill();
}

function drawDragPreview() {
  const d = ed.drag;
  if (!d) return;
  if (d.mode === 'create') {
    const col = LANE_COLORS[d.lane];
    const y1 = yFor(d.t), y2 = yFor(d.end ?? d.t);
    g.fillStyle = hexA(col.glow, 0.55);
    g.fillRect(laneX(d.lane) + 6, Math.min(y1, y2) - 8, LANE_W - 12, Math.abs(y1 - y2) + 16);
  } else if (d.mode === 'select') {
    g.strokeStyle = 'var(--cyan)';
    g.strokeStyle = '#38e8ff';
    g.setLineDash([5, 4]);
    g.strokeRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
    g.setLineDash([]);
    g.fillStyle = 'rgba(56,232,255,.12)';
    g.fillRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
  }
}

/* ================= playback ================= */

function fireHitsounds() {
  if (!ed.hitsounds) return;
  const list = notes();
  while (ed.nextHitIndex < list.length && list[ed.nextHitIndex].t <= ed.view) {
    const n = list[ed.nextHitIndex++];
    if (ed.view - n.t < 120) playHit(n.lane - 1);
  }
}

function resyncHitIndex() {
  const list = notes();
  let i = 0;
  while (i < list.length && list[i].t < ed.view) i++;
  ed.nextHitIndex = i;
}

function play() {
  if (!ed.buffer || ed.playing) return;
  resyncHitIndex();
  playSong(Math.max(0, ed.view), ed.rate);
  ed.playing = true;
  $('#tr-play').textContent = '❚❚';
}

function pause() {
  if (!ed.playing) return;
  ed.view = songTime();
  stopSong();
  ed.playing = false;
  $('#tr-play').textContent = '▶';
}

const togglePlay = () => (ed.playing ? pause() : play());

function seek(ms) {
  const was = ed.playing;
  if (was) pause();
  ed.view = Math.max(0, Math.min(duration(), ms));
  $('#tr-seek').value = Math.round(ed.view);
  if (was) play();
}

/* ================= editing ================= */

function noteAt(x, y) {
  const lane = laneAt(x);
  if (lane < 0) return null;
  for (const n of notes()) {
    if (n.lane - 1 !== lane) continue;
    const yh = yFor(n.t);
    if (Math.abs(y - yh) <= 10) return { note: n, part: 'head' };
    if (n.type === 'hold') {
      const yt = yFor(n.end);
      if (Math.abs(y - yt) <= 10) return { note: n, part: 'tail' };
      if (y < yh && y > yt) return { note: n, part: 'body' };
    }
  }
  return null;
}

function addNote(lane, t, end = null) {
  pushUndo();
  const n = end !== null && end > t
    ? { t, lane: lane + 1, type: 'hold', end }
    : { t, lane: lane + 1, type: 'tap' };
  diff().notes.push(n);
  sortNotes();
  refreshDiffList();
  return n;
}

function deleteNotes(list) {
  if (!list.length) return;
  pushUndo();
  const d = diff();
  const doomed = new Set(list);
  d.notes = d.notes.filter(n => !doomed.has(n));
  d.noteCount = d.notes.length;
  ed.selection.clear();
  refreshDiffList();
}

function mirrorSelection() {
  const list = ed.selection.size ? [...ed.selection] : notes();
  if (!list.length) return;
  pushUndo();
  for (const n of list) n.lane = KEYS + 1 - n.lane;
  sortNotes();
  refreshDiffList();
  toast('ミラーしました / mirrored');
}

function bindCanvas() {
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    const hit = noteAt(e.offsetX, e.offsetY);
    if (hit) deleteNotes([hit.note]);
  });

  canvas.addEventListener('pointerdown', e => {
    if (!ed.chart || e.button !== 0) return;
    const x = e.offsetX, y = e.offsetY;

    if (e.ctrlKey || e.metaKey) {
      ed.drag = { mode: 'select', x0: x, y0: y, x1: x, y1: y };
      return;
    }

    const hit = noteAt(x, y);
    if (hit) {
      if (e.shiftKey) {
        if (ed.selection.has(hit.note)) ed.selection.delete(hit.note);
        else ed.selection.add(hit.note);
        return;
      }
      pushUndo();
      ed.drag = {
        mode: hit.part === 'tail' ? 'resize' : 'move',
        note: hit.note,
        grabT: snapTime(timeFor(y)),
        origT: hit.note.t,
        origEnd: hit.note.end ?? hit.note.t,
        origLane: hit.note.lane,
        moved: false,
      };
      return;
    }

    const lane = laneAt(x);
    if (lane < 0) { ed.selection.clear(); return; }
    ed.drag = { mode: 'create', lane, t: snapTime(timeFor(y)), end: null };
  });

  window.addEventListener('pointermove', e => {
    const d = ed.drag;
    if (!d) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    if (d.mode === 'create') {
      const t = snapTime(timeFor(y));
      d.end = t > d.t ? t : null;
    } else if (d.mode === 'select') {
      d.x1 = x; d.y1 = y;
    } else if (d.mode === 'move') {
      const t = snapTime(timeFor(y));
      const dt = t - d.grabT;
      const lane = laneAt(x);
      const len = d.origEnd - d.origT;
      d.note.t = Math.max(0, d.origT + dt);
      if (d.note.type === 'hold') d.note.end = d.note.t + len;
      if (lane >= 0) d.note.lane = lane + 1;
      d.moved = true;
    } else if (d.mode === 'resize') {
      const t = snapTime(timeFor(y));
      if (t > d.note.t) {
        d.note.type = 'hold';
        d.note.end = t;
      } else {
        d.note.type = 'tap';
        delete d.note.end;
      }
      d.moved = true;
    }
  });

  window.addEventListener('pointerup', () => {
    const d = ed.drag;
    ed.drag = null;
    if (!d) return;

    if (d.mode === 'create') {
      addNote(d.lane, d.t, d.end);
      if (ed.hitsounds && !ed.playing) playHit(d.lane);
    } else if (d.mode === 'select') {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
      const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      ed.selection.clear();
      for (const n of notes()) {
        const y = yFor(n.t), x = laneX(n.lane - 1) + LANE_W / 2;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) ed.selection.add(n);
      }
      status(`${ed.selection.size} 選択中`);
    } else if (d.moved) {
      sortNotes();
      refreshDiffList();
    } else {
      ed.undo.pop();          // click without a drag: nothing actually changed
    }
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey) {
      ed.zoom = Math.max(10, Math.min(220, ed.zoom - Math.sign(e.deltaY) * 6));
      $('#tr-zoom').value = ed.zoom;
      return;
    }
    if (ed.playing) pause();
    const step = ed.snap ? beatMs() / ed.snap : 50;
    seek(ed.view - Math.sign(e.deltaY) * step * (e.shiftKey ? 4 : 1));
  }, { passive: false });
}

/* ================= keyboard ================= */

function bindKeys() {
  window.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!ed.chart && e.code !== 'KeyO') return;

    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey && (e.code === 'KeyY' || (e.shiftKey && e.code === 'KeyZ'))) { e.preventDefault(); redo(); return; }
    if (e.ctrlKey && e.code === 'KeyA') {
      e.preventDefault();
      ed.selection = new Set(notes());
      status(`${ed.selection.size} 選択中`);
      return;
    }
    if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); saveMjk(); return; }
    if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); deleteNotes([...ed.selection]); return; }
    if (e.code === 'KeyM') { mirrorSelection(); return; }
    if (e.code === 'Home') { seek(0); return; }
    if (e.code === 'End') { seek(duration()); return; }

    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      const step = ed.snap ? beatMs() / ed.snap : 50;
      seek(ed.view + (e.code === 'ArrowUp' ? step : -step));
      return;
    }

    const laneKey = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
    if (laneKey >= 0) {
      e.preventDefault();
      const t = snapTime(ed.view);
      const existing = notes().find(n => n.lane - 1 === laneKey && Math.abs(n.t - t) < 2);
      if (existing) deleteNotes([existing]);
      else { addNote(laneKey, t); if (ed.hitsounds) playHit(laneKey); }
    }
  });
}

/* ================= file operations ================= */

async function saveMjk() {
  if (!ed.chart) return;
  try {
    status('パッケージ中…');
    const blob = await buildMjk();
    const name = `${(ed.chart.meta.title || 'chart').replace(/[^\w\-() ]+/g, '').trim().replace(/\s+/g, '_') || 'chart'}.mjk`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    ed.dirty = false;
    status(`保存しました (${(blob.size / 1048576).toFixed(2)} MB)`);
    toast(`${name} を書き出しました`);
  } catch (err) {
    console.error(err);
    toast(`保存失敗: ${err.message}`, 5000);
  }
}

async function buildMjk() {
  // Keep note counts and editor timing in sync before packing.
  for (const d of Object.values(ed.chart.difficulties)) {
    d.notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
    d.noteCount = d.notes.length;
  }
  ed.chart.meta.editor = {
    bpm: Number($('#t-bpm').value) || 120,
    offset: Number($('#t-offset').value) || 0,
  };
  ed.chart.meta.audio = 'audio.mp3';
  ed.chart.meta.video = ed.media.video ? 'video.mp4' : null;
  ed.chart.meta.background = ed.media.background ? 'BG.jpg' : null;
  return packMjk(ed.chart, ed.media, (p, name) => status(`packing ${name} ${Math.round(p * 100)}%`));
}

async function handleDroppedFile(file) {
  const lower = file.name.toLowerCase();
  try {
    if (lower.endsWith('.mjk')) await openMjkFile(file);
    else if (lower.endsWith('.osz')) await importOszFile(file);
    else if (/\.(mp3|ogg|wav|m4a)$/.test(lower)) await newFromAudio(file);
    else if (/\.(jpg|jpeg|png)$/.test(lower) && ed.chart) {
      ed.media.background = new Uint8Array(await file.arrayBuffer());
      refreshMedia(); ed.dirty = true; toast('背景を設定しました');
    } else if (/\.mp4$/.test(lower) && ed.chart) {
      ed.media.video = new Uint8Array(await file.arrayBuffer());
      refreshMedia(); ed.dirty = true; toast('動画を設定しました');
    } else {
      toast('対応していないファイルです');
    }
  } catch (err) {
    console.error(err);
    toast(`失敗: ${err.message}`, 5000);
    status('error');
  }
}

/* ================= modals ================= */

function closeModal() { $('#ed-modal').classList.add('hidden'); }

function openModal(html, setup) {
  const panel = $('#ed-modal-panel');
  panel.innerHTML = html;
  $('#ed-modal').classList.remove('hidden');
  setup?.(panel);
}

function promptText(title, value, onOk) {
  openModal(`
    <h2>${title}</h2>
    <label>名前 / Name<input id="pm-input" type="text"></label>
    <div class="ed-err" id="pm-err"></div>
    <div class="panel-actions">
      <button class="ghost-btn" id="pm-cancel">キャンセル</button>
      <button class="big-btn" id="pm-ok">OK</button>
    </div>`, panel => {
    const input = panel.querySelector('#pm-input');
    input.value = value;
    input.focus();
    input.select();
    const ok = () => {
      const v = input.value.trim();
      if (!v) { panel.querySelector('#pm-err').textContent = '名前を入力してください'; return; }
      closeModal();
      onOk(v);
    };
    panel.querySelector('#pm-ok').onclick = ok;
    panel.querySelector('#pm-cancel').onclick = closeModal;
    input.onkeydown = e => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') closeModal(); };
  });
}

/* ================= wiring ================= */

function bindTransport() {
  $('#tr-play').onclick = togglePlay;
  $('#tr-seek').oninput = e => seek(Number(e.target.value));
  $('#tr-snap').onchange = e => { ed.snap = Number(e.target.value); };
  $('#tr-rate').onchange = e => {
    ed.rate = Number(e.target.value);
    if (ed.playing) { pause(); play(); }
  };
  $('#tr-zoom').oninput = e => { ed.zoom = Number(e.target.value); };
  $('#tr-vol').oninput = e => { setMusicVolume(Number(e.target.value) / 100); };
  $('#tr-hitsound').onchange = e => { ed.hitsounds = e.target.checked; };
}

function bindToolbar() {
  const openMjk = async () => { const f = await fileDialog('.mjk'); if (f) handleDroppedFile(f); };
  const importOsz = async () => { const f = await fileDialog('.osz'); if (f) handleDroppedFile(f); };
  const newChart = async () => { const f = await fileDialog('audio/*'); if (f) handleDroppedFile(f); };

  $('#ed-open').onclick = openMjk;
  $('#ed-import').onclick = importOsz;
  $('#ed-new').onclick = newChart;
  $('#empty-open').onclick = openMjk;
  $('#empty-import').onclick = importOsz;
  $('#empty-new').onclick = newChart;
  $('#ed-save').onclick = saveMjk;

  for (const btn of document.querySelectorAll('[data-media]')) {
    btn.onclick = async () => {
      const kind = btn.dataset.media;
      const accept = kind === 'audio' ? 'audio/*' : kind === 'video' ? 'video/mp4' : 'image/*';
      const f = await fileDialog(accept);
      if (!f || !ed.chart) return;
      ed.media[kind] = new Uint8Array(await f.arrayBuffer());
      if (kind === 'audio') await decodeCurrentAudio();
      refreshMedia();
      ed.dirty = true;
      toast(`${kind} を差し替えました`);
    };
  }

  $('#diff-add').onclick = () => promptText('新しい難易度', 'Insane', name => {
    if (ed.chart.difficulties[name]) { toast('同名の難易度があります'); return; }
    ed.chart.difficulties[name] = { keys: 4, od: 8, hp: 6, originalMode: 'mania', noteCount: 0, notes: [] };
    ed.diffName = name;
    ed.dirty = true;
    refreshDiffList();
  });

  $('#diff-dup').onclick = () => {
    if (!diff()) return;
    promptText('難易度を複製', `${ed.diffName} copy`, name => {
      if (ed.chart.difficulties[name]) { toast('同名の難易度があります'); return; }
      ed.chart.difficulties[name] = JSON.parse(JSON.stringify(diff()));
      ed.diffName = name;
      ed.dirty = true;
      refreshDiffList();
    });
  };

  $('#diff-ren').onclick = () => {
    if (!diff()) return;
    const old = ed.diffName;
    promptText('難易度の名前を変更', old, name => {
      if (name === old) return;
      if (ed.chart.difficulties[name]) { toast('同名の難易度があります'); return; }
      const entries = Object.entries(ed.chart.difficulties)
        .map(([k, v]) => [k === old ? name : k, v]);
      ed.chart.difficulties = Object.fromEntries(entries);
      ed.diffName = name;
      ed.dirty = true;
      refreshDiffList();
    });
  };

  $('#diff-del').onclick = () => {
    if (!diff()) return;
    if (Object.keys(ed.chart.difficulties).length <= 1) { toast('最後の難易度は削除できません'); return; }
    const name = ed.diffName;
    delete ed.chart.difficulties[name];
    ed.diffName = Object.keys(ed.chart.difficulties)[0];
    ed.dirty = true;
    refreshDiffList();
    toast(`${name} を削除しました`);
  };

  $('#d-od').oninput = e => { if (diff()) { diff().od = Number(e.target.value); $('#v-od').textContent = Number(e.target.value).toFixed(1); ed.dirty = true; } };
  $('#d-hp').oninput = e => { if (diff()) { diff().hp = Number(e.target.value); $('#v-hp').textContent = Number(e.target.value).toFixed(1); ed.dirty = true; } };

  $('#t-here').onclick = () => { $('#t-offset').value = Math.round(ed.view); $('#t-offset').dispatchEvent(new Event('input')); };
  $('#t-tap').onclick = () => {
    const now = performance.now();
    if (ed.taps.length && now - ed.taps[ed.taps.length - 1] > 2500) ed.taps.length = 0;
    ed.taps.push(now);
    if (ed.taps.length < 2) { $('#t-taphint').textContent = 'tap along with the beat…'; return; }
    const spans = ed.taps.slice(1).map((t, i) => t - ed.taps[i]);
    const avg = spans.reduce((a, b) => a + b, 0) / spans.length;
    const bpm = 60000 / avg;
    $('#t-bpm').value = bpm.toFixed(3);
    $('#t-bpm').dispatchEvent(new Event('input'));
    $('#t-taphint').textContent = `${ed.taps.length} taps → ${bpm.toFixed(2)} BPM`;
  };
}

function bindDrop() {
  const hint = $('#ed-drop');
  let depth = 0;
  addEventListener('dragenter', e => { e.preventDefault(); depth++; hint.classList.remove('hidden'); });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('dragleave', e => { e.preventDefault(); if (--depth <= 0) hint.classList.add('hidden'); });
  addEventListener('drop', async e => {
    e.preventDefault(); depth = 0; hint.classList.add('hidden');
    const f = e.dataTransfer.files[0];
    if (f) await handleDroppedFile(f);
  });
}

async function init() {
  initAudio();
  setMusicVolume(0.7);
  setSfxVolume(0.55);
  bindMetaInputs();
  bindToolbar();
  bindTransport();
  bindCanvas();
  bindKeys();
  bindDrop();

  addEventListener('resize', resize);
  addEventListener('beforeunload', e => {
    if (ed.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('click', () => resumeAudio(), { once: true });
  $('#ed-modal').addEventListener('click', e => { if (e.target.id === 'ed-modal') closeModal(); });

  resize();
  requestAnimationFrame(draw);

  status('ready');

  window.MJKED = {
    ed, notes, addNote, deleteNotes, mirrorSelection, undo, redo, seek, play, pause,
    handleDroppedFile, buildMjk, snapTime, draw: drawFrame, resize,
    yFor, timeFor, laneX, laneAt, noteAt,
  };
}

init();
