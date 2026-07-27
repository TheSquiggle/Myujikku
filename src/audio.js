// Audio engine: sample-accurate song clock + fully synthesised hitsounds/UI SFX.
// Every sound in the game is generated here at runtime — no audio files ship with the game.

export const audio = {
  ctx: null,
  musicGain: null,
  sfxGain: null,
  previewGain: null,
  buffer: null,
  source: null,
  _startCtxTime: 0,
  _startOffset: 0,
  _rate: 1,
  playing: false,
  _hitBuf: null,
  _clapBuf: null,
  _previewSource: null,
};

export function initAudio() {
  if (audio.ctx) return audio.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  audio.ctx = new AC({ latencyHint: 'interactive' });
  audio.musicGain = audio.ctx.createGain();
  audio.sfxGain = audio.ctx.createGain();
  audio.previewGain = audio.ctx.createGain();
  audio.previewGain.gain.value = 0;
  audio.musicGain.connect(audio.ctx.destination);
  audio.sfxGain.connect(audio.ctx.destination);
  audio.previewGain.connect(audio.ctx.destination);
  audio._hitBuf = buildHitBuffer(audio.ctx);
  audio._clapBuf = buildClapBuffer(audio.ctx);
  return audio.ctx;
}

export function resumeAudio() {
  if (audio.ctx && audio.ctx.state === 'suspended') return audio.ctx.resume();
  return Promise.resolve();
}

export function setMusicVolume(v) { if (audio.musicGain) audio.musicGain.gain.value = v; }
export function setSfxVolume(v) { if (audio.sfxGain) audio.sfxGain.gain.value = v; }
export function setPreviewVolume(v) { audio._previewTarget = v; }

export async function decodeSong(arrayBuffer) {
  initAudio();
  audio.buffer = await audio.ctx.decodeAudioData(arrayBuffer);
  return audio.buffer;
}

/**
 * Start (or restart) the song from `offsetMs` into the track.
 * `rate` slows playback down for editor scrubbing (pitch shifts with it).
 */
export function playSong(offsetMs = 0, rate = 1) {
  stopSong();
  const src = audio.ctx.createBufferSource();
  src.buffer = audio.buffer;
  src.playbackRate.value = rate;
  src.connect(audio.musicGain);
  const off = Math.max(0, offsetMs / 1000);
  src.start(0, off);
  audio.source = src;
  audio._startCtxTime = audio.ctx.currentTime;
  audio._startOffset = off;
  audio._rate = rate;
  audio.playing = true;
}

export function stopSong() {
  if (audio.source) {
    try { audio.source.stop(); } catch { /* already stopped */ }
    audio.source.disconnect();
    audio.source = null;
  }
  audio.playing = false;
}

const PREVIEW_LOOP_MS = 18000;   // loop window length for the song-select preview
const PREVIEW_FADE = 0.35;       // seconds

/**
 * Play a short looping preview of `buffer`, starting at `startMs` (typically
 * the beatmap's own previewTime) and looping over the next ~18s. Used on the
 * song-select screen — separate gain/source from the gameplay music path so
 * it can't interfere with an actual play session.
 */
export function playPreview(buffer, startMs = 0) {
  if (!audio.ctx || !buffer) return;
  stopPreview(0);

  const dur = buffer.duration;
  const start = Math.min(Math.max(0, startMs / 1000), Math.max(0, dur - 0.5));
  const loopEnd = Math.min(dur, start + PREVIEW_LOOP_MS / 1000);

  const src = audio.ctx.createBufferSource();
  src.buffer = buffer;
  if (loopEnd > start + 1) {
    src.loop = true;
    src.loopStart = start;
    src.loopEnd = loopEnd;
  }
  src.connect(audio.previewGain);

  const g = audio.previewGain.gain;
  const now = audio.ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(0, now);
  g.linearRampToValueAtTime(audio._previewTarget ?? 0.7, now + PREVIEW_FADE);

  src.start(0, start);
  audio._previewSource = src;
}

/** Fade the preview out over `fadeSec` (0 = immediate) and stop it. */
export function stopPreview(fadeSec = PREVIEW_FADE) {
  const src = audio._previewSource;
  if (!src) return;
  audio._previewSource = null;

  if (!audio.ctx || fadeSec <= 0) {
    try { src.stop(); } catch { /* already stopped */ }
    src.disconnect();
    return;
  }
  const g = audio.previewGain.gain;
  const now = audio.ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + fadeSec);
  setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } src.disconnect(); }, fadeSec * 1000 + 30);
}

/** Current position in the song, in milliseconds. */
export function songTime() {
  if (!audio.ctx) return 0;
  if (!audio.playing) return audio._startOffset * 1000;
  const elapsed = (audio.ctx.currentTime - audio._startCtxTime) * (audio._rate || 1);
  return (elapsed + audio._startOffset) * 1000;
}

export function songDuration() { return audio.buffer ? audio.buffer.duration * 1000 : 0; }

/* ---------------- synthesised sounds ---------------- */

// Short filtered noise + pitched body: the classic "tick" hit.
function buildHitBuffer(ctx) {
  const dur = 0.075, sr = ctx.sampleRate, n = Math.floor(dur * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 62);
    const noise = Math.random() * 2 - 1;
    lp += (noise - lp) * 0.45;                       // gentle low-pass on the noise
    const body = Math.sin(2 * Math.PI * 1180 * t) * 0.55
               + Math.sin(2 * Math.PI * 2360 * t) * 0.18;
    d[i] = (lp * 0.55 + body) * env * 0.85;
  }
  return buf;
}

// Brighter, slightly longer burst used for hold releases / finishes.
function buildClapBuffer(ctx) {
  const dur = 0.16, sr = ctx.sampleRate, n = Math.floor(dur * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let hp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const burst = Math.exp(-t * 26) + 0.6 * Math.exp(-Math.abs(t - 0.012) * 300)
                                    + 0.5 * Math.exp(-Math.abs(t - 0.026) * 300);
    const noise = Math.random() * 2 - 1;
    hp = 0.86 * (hp + noise - prev);                  // high-pass → crisp
    prev = noise;
    d[i] = hp * burst * 0.5;
  }
  return buf;
}

function playBuf(buf, gain = 1, rate = 1) {
  if (!audio.ctx || !buf) return;
  const s = audio.ctx.createBufferSource();
  s.buffer = buf;
  s.playbackRate.value = rate;
  const g = audio.ctx.createGain();
  g.gain.value = gain;
  s.connect(g); g.connect(audio.sfxGain);
  s.start();
}

export function playHit(lane = 0) {
  // Tiny per-lane detune so dense patterns stay legible.
  playBuf(audio._hitBuf, 0.9, 1 + lane * 0.035);
}
export function playRelease() { playBuf(audio._clapBuf, 0.45); }

/** Simple synth blip for menus. */
export function blip(freq = 660, dur = 0.07, type = 'triangle', gain = 0.16) {
  if (!audio.ctx) return;
  const o = audio.ctx.createOscillator();
  const g = audio.ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, audio.ctx.currentTime);
  g.gain.setValueAtTime(gain, audio.ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.ctx.currentTime + dur);
  o.connect(g); g.connect(audio.sfxGain);
  o.start(); o.stop(audio.ctx.currentTime + dur + 0.02);
}

export function sfxMove() { blip(560, 0.05, 'square', 0.09); }
export function sfxConfirm() { blip(880, 0.09); setTimeout(() => blip(1320, 0.12), 55); }
export function sfxBack() { blip(420, 0.09, 'sine', 0.13); }
export function sfxFail() { blip(220, 0.5, 'sawtooth', 0.14); setTimeout(() => blip(160, 0.7, 'sawtooth', 0.12), 90); }
export function sfxApplause() {
  for (const [d, f] of [[0, 523], [90, 659], [180, 784], [280, 1046]]) {
    setTimeout(() => blip(f, 0.28, 'triangle', 0.13), d);
  }
}
