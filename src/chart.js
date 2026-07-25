// .mjk beatmap loading + chart analysis.
//
// A .mjk file is a zip archive containing:
//   chart.mjc  — JSON: { format, version, meta, difficulties }
//   audio.mp3  — the track
//   BG.jpg     — background still (optional)
//   video.mp4  — background video (optional)

import { readZip, bytesToText, bytesToURL } from './zip.js';

/** Parse + normalise a chart.mjc payload. */
export function parseChart(json) {
  const c = typeof json === 'string' ? JSON.parse(json) : json;
  if (c.format !== 'mjc') throw new Error(`Unknown chart format: ${c.format}`);

  const diffs = Object.entries(c.difficulties).map(([name, d]) => {
    const notes = d.notes
      .map((n, i) => ({
        id: i,
        t: n.t,
        lane: (n.lane | 0) - 1,                       // .mjc lanes are 1-based
        hold: n.type === 'hold',
        end: n.type === 'hold' ? n.end : n.t,
      }))
      .filter(n => n.lane >= 0 && n.lane < (d.keys || 4))
      .sort((a, b) => a.t - b.t || a.lane - b.lane);
    notes.forEach((n, i) => { n.id = i; });
    return {
      name,
      keys: d.keys || 4,
      od: d.od ?? 8,
      hp: d.hp ?? 7,
      notes,
      noteCount: notes.length,
      length: notes.length ? Math.max(...notes.map(n => n.end)) : 0,
      stars: starRating(notes),
    };
  });

  diffs.sort((a, b) => a.stars - b.stars);
  return { meta: c.meta, difficulties: diffs };
}

/**
 * Difficulty estimate in "stars".
 * Blends note density with per-column strain (how often the *same* finger is
 * asked to move), which is what actually makes mania charts hard.
 */
export function starRating(notes) {
  if (notes.length < 2) return 0;
  const span = (notes[notes.length - 1].t - notes[0].t) / 1000;
  if (span <= 0) return 0;

  const nps = notes.length / span;

  const lastInLane = {};
  let strain = 0;
  for (const n of notes) {
    const prev = lastInLane[n.lane];
    if (prev !== undefined) {
      const dt = Math.max(20, n.t - prev);
      strain += Math.min(1, 260 / dt);               // fast repeats on one finger hurt most
    }
    lastInLane[n.lane] = n.hold ? n.end : n.t;
  }
  const strainRate = strain / span;

  // Chords add pressure too: count simultaneous groups.
  let chords = 0;
  for (let i = 1; i < notes.length; i++) if (notes[i].t - notes[i - 1].t < 12) chords++;
  const chordRate = chords / span;

  const raw = nps * 0.62 + strainRate * 0.85 + chordRate * 0.5;
  return Math.round(Math.min(9.99, Math.pow(raw, 0.86) * 1.16) * 100) / 100;
}

export function starColor(sr) {
  if (sr < 1.8) return '#7ee6a0';
  if (sr < 2.6) return '#7ec8ff';
  if (sr < 3.6) return '#ffe680';
  if (sr < 4.8) return '#ff9f5c';
  if (sr < 6.0) return '#ff5c7a';
  if (sr < 7.2) return '#d16bff';
  return '#ffffff';
}

/**
 * Load a .mjk archive.
 * @param {ArrayBuffer} buffer
 * @param {(p:number,label:string)=>void} onProgress
 */
export async function loadBeatmap(buffer, onProgress = () => {}) {
  onProgress(0.1, 'アーカイブを展開中… / unpacking');
  const files = await readZip(buffer);

  const chartBytes = files.get('chart.mjc');
  if (!chartBytes) throw new Error('chart.mjc missing from archive.');
  onProgress(0.55, 'チャートを解析中… / parsing chart');
  const chart = parseChart(bytesToText(chartBytes));

  onProgress(0.8, 'メディアを準備中… / preparing media');
  const audioBytes = files.get(chart.meta.audio || 'audio.mp3') || files.get('audio.mp3');
  if (!audioBytes) throw new Error('audio track missing from archive.');

  const bgBytes = files.get(chart.meta.background || 'BG.jpg') || files.get('BG.jpg');
  const vidBytes = chart.meta.video ? files.get(chart.meta.video) : files.get('video.mp4');

  onProgress(1, '完了 / ready');
  return {
    meta: chart.meta,
    difficulties: chart.difficulties,
    audioBuffer: audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength),
    bgURL: bgBytes ? bytesToURL(bgBytes, 'image/jpeg') : null,
    videoURL: vidBytes ? bytesToURL(vidBytes, 'video/mp4') : null,
  };
}

/** Read only chart.mjc + BG from an archive — used to build the song list cheaply. */
export async function peekBeatmap(buffer) {
  const files = await readZip(buffer);
  const chartBytes = files.get('chart.mjc');
  if (!chartBytes) throw new Error('chart.mjc missing from archive.');
  const chart = parseChart(bytesToText(chartBytes));
  const bgBytes = files.get(chart.meta.background || 'BG.jpg') || files.get('BG.jpg');
  return {
    meta: chart.meta,
    difficulties: chart.difficulties,
    bgURL: bgBytes ? bytesToURL(bgBytes, 'image/jpeg') : null,
  };
}

export function formatTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
