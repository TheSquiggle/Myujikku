// .osz (osu! beatmap archive) → .mjk conversion.
//
// Ported from the standalone osz-to-mjk-converter and rewritten against this
// project's own zip reader/writer, so it carries no JSZip dependency.
// Every .osu difficulty in the archive becomes a 4-key mania difficulty.

import { readZip, bytesToText } from './zip.js';
import { writeZip } from './zipwrite.js';

/* ---------------- .osu parsing ---------------- */

function parseSection(text, sectionName) {
  const m = text.match(new RegExp(`\\[${sectionName}\\]([\\s\\S]*?)(?:\\r?\\n\\[|$)`));
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

const stripQuotes = s => (s ? s.trim().replace(/^"|"$/g, '') : s);

function parseEventsSection(text) {
  const m = text.match(/\[Events\]([\s\S]*?)(?:\r?\n\[|$)/);
  const result = { video: null, videoOffset: 0, background: null };
  if (!m) return result;
  for (const line of m[1].split(/\r?\n/)) {
    if (line.startsWith('//')) continue;
    const parts = line.split(',');
    if (parts[0] === 'Video' || parts[0] === '1') {
      result.video = stripQuotes(parts[2]);
      result.videoOffset = Number(parts[1]) || 0;   // ms the video starts at
    } else if (parts[0] === '0' && !result.background) {
      result.background = stripQuotes(parts[2]);
    }
  }
  return result;
}

function parseTimingPoints(text) {
  const m = text.match(/\[TimingPoints\]([\s\S]*?)(?:\r?\n\[|$)/);
  if (!m) return [];
  const points = [];
  for (const line of m[1].split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const time = parseFloat(parts[0]);
    const beatLength = parseFloat(parts[1]);
    const uninherited = parts.length >= 7 ? parseInt(parts[6], 10) === 1 : beatLength > 0;
    points.push({ time, beatLength, uninherited });
  }
  return points.sort((a, b) => a.time - b.time);
}

function parseHitObjects(text) {
  const m = text.match(/\[HitObjects\]([\s\S]*?)(?:\r?\n\[|$)/);
  if (!m) return [];
  const objs = [];
  for (const line of m[1].split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    const parts = line.split(',');
    if (parts.length < 5) continue;
    const time = parseInt(parts[2], 10);
    const type = parseInt(parts[3], 10);
    const obj = {
      x: parseInt(parts[0], 10),
      y: parseInt(parts[1], 10),
      time, type,
      isCircle: (type & 1) !== 0,
      isSlider: (type & 2) !== 0,
      isSpinner: (type & 8) !== 0,
      isHold: (type & 128) !== 0,
    };
    if (obj.isSlider) {
      obj.repeatCount = parseInt(parts[6], 10) || 1;
      obj.pixelLength = parseFloat(parts[7]) || 0;
    } else if (obj.isSpinner) {
      obj.endTime = parseInt(parts[5], 10) || time;
    } else if (obj.isHold) {
      obj.endTime = parseInt((parts[5] || '').split(':')[0], 10) || time;
    }
    objs.push(obj);
  }
  return objs.sort((a, b) => a.time - b.time);
}

export function parseOsu(text) {
  const general = parseSection(text, 'General');
  const metadata = parseSection(text, 'Metadata');
  const difficultySec = parseSection(text, 'Difficulty');
  const mode = parseInt(general.Mode || '0', 10);
  const circleSize = parseFloat(difficultySec.CircleSize || '4');

  return {
    version: metadata.Version || 'Normal',
    metadata,
    mode,
    circleSize,
    overallDifficulty: parseFloat(difficultySec.OverallDifficulty || '5'),
    hpDrain: parseFloat(difficultySec.HPDrainRate || '5'),
    sliderMultiplier: parseFloat(difficultySec.SliderMultiplier || '1'),
    maniaKeys: mode === 3 ? Math.max(1, Math.round(circleSize)) : 4,
    timingPoints: parseTimingPoints(text),
    hitObjects: parseHitObjects(text),
  };
}

/* ---------------- hit objects → 4K mania ---------------- */

function getBeatLengthAt(points, time) {
  let bl = 500;
  for (const p of points) {
    if (p.time > time) break;
    if (p.uninherited) bl = p.beatLength;
  }
  return bl;
}

function getSVMultiplierAt(points, time) {
  let sv = 1;
  for (const p of points) {
    if (p.time > time) break;
    sv = p.uninherited ? 1 : -100 / p.beatLength;    // inherited points store negative ms as SV%
  }
  return sv;
}

const xToLane = (x, keys) =>
  Math.min(keys - 1, Math.floor((Math.max(0, Math.min(511, x)) / 512) * keys)) + 1;

const maniaColumnToLane = (x, keys) =>
  Math.max(0, Math.min(keys - 1, Math.floor(x / (512 / keys)))) + 1;

export function convertDifficultyToMania(diff) {
  const notes = [];
  const laneLastEnd = { 1: -Infinity, 2: -Infinity, 3: -Infinity, 4: -Infinity };

  for (const obj of diff.hitObjects) {
    if (diff.mode === 3) {
      // Native mania: remap the original column count onto 4 lanes.
      const lane = diff.maniaKeys === 4
        ? maniaColumnToLane(obj.x, 4)
        : Math.max(1, Math.min(4, Math.round(
            ((maniaColumnToLane(obj.x, diff.maniaKeys) - 1) / (diff.maniaKeys - 1 || 1)) * 3) + 1));
      if (obj.isHold) {
        notes.push({ t: obj.time, lane, type: 'hold', end: obj.endTime });
        laneLastEnd[lane] = obj.endTime;
      } else {
        notes.push({ t: obj.time, lane, type: 'tap' });
        laneLastEnd[lane] = obj.time;
      }
      continue;
    }

    if (obj.isCircle) {
      const lane = xToLane(obj.x, 4);
      notes.push({ t: obj.time, lane, type: 'tap' });
      laneLastEnd[lane] = obj.time;

    } else if (obj.isSlider) {
      const lane = xToLane(obj.x, 4);
      const beatLength = getBeatLengthAt(diff.timingPoints, obj.time);
      const sv = getSVMultiplierAt(diff.timingPoints, obj.time);
      const single = (obj.pixelLength / (diff.sliderMultiplier * 100 * sv)) * beatLength;
      const end = obj.time + Math.max(30, Math.round(single * (obj.repeatCount || 1)));
      notes.push({ t: obj.time, lane, type: 'hold', end });
      laneLastEnd[lane] = end;

    } else if (obj.isSpinner) {
      // Spinners land on whichever lane has been idle longest.
      let bestLane = 1, bestEnd = Infinity;
      for (let l = 1; l <= 4; l++) if (laneLastEnd[l] < bestEnd) { bestEnd = laneLastEnd[l]; bestLane = l; }
      const end = obj.endTime || obj.time + 500;
      notes.push({ t: obj.time, lane: bestLane, type: 'hold', end });
      laneLastEnd[bestLane] = end;
    }
  }

  return notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
}

/* ---------------- archive helpers ---------------- */

const basename = p => p.split('/').pop();

function findByExt(names, ext) {
  const exts = Array.isArray(ext) ? ext : [ext];
  return names.find(n => exts.some(e => n.toLowerCase().endsWith(e))) || null;
}

function findFileCI(names, wanted) {
  if (!wanted) return null;
  const w = wanted.toLowerCase().trim();
  return names.find(n => n.toLowerCase() === w)
      || names.find(n => basename(n).toLowerCase() === basename(w).toLowerCase())
      || null;
}

/**
 * Convert a .osz archive into the in-memory shape the game and editor use.
 * @param {ArrayBuffer} buffer
 * @param {(p:number,label:string)=>void} onProgress
 */
export async function convertOsz(buffer, onProgress = () => {}) {
  onProgress(0.05, 'アーカイブを展開中… / unpacking .osz');
  const files = await readZip(buffer);
  const names = [...files.keys()];

  const osuFiles = names.filter(n => n.toLowerCase().endsWith('.osu'));
  if (!osuFiles.length) throw new Error('No .osu difficulties found inside this .osz.');

  onProgress(0.2, 'アセットを検索中… / locating assets');
  const firstText = bytesToText(files.get(osuFiles[0]));
  const general = parseSection(firstText, 'General');
  const events = parseEventsSection(firstText);

  const audioName = general.AudioFilename ? general.AudioFilename.trim() : findByExt(names, '.mp3');
  const audioPath = findFileCI(names, audioName) || findByExt(names, ['.mp3', '.ogg']);
  if (!audioPath) throw new Error('No audio track found inside this .osz.');
  const videoPath = findFileCI(names, events.video) || findByExt(names, '.mp4');
  const bgPath = findFileCI(names, events.background) || findByExt(names, ['.jpg', '.jpeg', '.png']);

  onProgress(0.4, '難易度を解析中… / parsing difficulties');
  const parsed = [];
  for (const path of osuFiles) {
    try { parsed.push(parseOsu(bytesToText(files.get(path)))); }
    catch (err) { console.warn('Skipping unparsable difficulty', path, err); }
  }
  if (!parsed.length) throw new Error('Found .osu files but none could be parsed.');

  onProgress(0.7, 'ノーツを変換中… / converting notes');
  const difficulties = {};
  for (const d of parsed) {
    const notes = convertDifficultyToMania(d);
    difficulties[d.version] = {
      keys: 4,
      od: d.overallDifficulty,
      hp: d.hpDrain,
      originalMode: d.mode === 3 ? 'mania' : 'std',
      noteCount: notes.length,
      notes,
    };
  }

  const m0 = parsed[0].metadata;
  const chart = {
    format: 'mjc',
    version: 1,
    meta: {
      title: m0.Title || 'Unknown Title',
      titleUnicode: m0.TitleUnicode || m0.Title || '',
      artist: m0.Artist || 'Unknown Artist',
      artistUnicode: m0.ArtistUnicode || m0.Artist || '',
      creator: m0.Creator || '',
      source: m0.Source || '',
      tags: m0.Tags || '',
      audio: 'audio.mp3',
      video: videoPath ? 'video.mp4' : null,
      videoOffset: videoPath ? events.videoOffset : 0,
      background: bgPath ? 'BG.jpg' : null,
      previewTime: Number(general.PreviewTime) || 0,
      convertedFrom: 'osz',
      convertedAt: new Date().toISOString(),
    },
    difficulties,
  };

  onProgress(1, '変換完了 / converted');
  return {
    chart,
    media: {
      audio: files.get(audioPath),
      video: videoPath ? files.get(videoPath) : null,
      background: bgPath ? files.get(bgPath) : null,
    },
    suggestedName: `${(m0.Title || 'track').replace(/[^\w\-() ]+/g, '').trim().replace(/\s+/g, '_') || 'track'}.mjk`,
  };
}

/** Pack a chart + media back into a .mjk archive. */
export async function packMjk(chart, media, onProgress = () => {}) {
  const entries = [{ name: 'chart.mjc', data: JSON.stringify(chart, null, 2) }];
  // Media is already compressed — storing it is far faster and just as small.
  if (media.audio) entries.push({ name: 'audio.mp3', data: media.audio, store: true });
  if (media.video) entries.push({ name: 'video.mp4', data: media.video, store: true });
  if (media.background) entries.push({ name: 'BG.jpg', data: media.background, store: true });
  return writeZip(entries, onProgress);
}
