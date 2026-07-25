// Audio engine: sample-accurate song clock + fully synthesised hitsounds/UI SFX.
// Every sound in the game is generated here at runtime — no audio files ship with the game.

export const audio = {
  ctx: null,
  musicGain: null,
  sfxGain: null,
  buffer: null,
  source: null,
  _startCtxTime: 0,
  _startOffset: 0,
  playing: false,
  _hitBuf: null,
  _clapBuf: null,
};

export function initAudio() {
  if (audio.ctx) return audio.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  audio.ctx = new AC({ latencyHint: 'interactive' });
  audio.musicGain = audio.ctx.createGain();
  audio.sfxGain = audio.ctx.createGain();
  audio.musicGain.connect(audio.ctx.destination);
  audio.sfxGain.connect(audio.ctx.destination);
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

export async function decodeSong(arrayBuffer) {
  initAudio();
  audio.buffer = await audio.ctx.decodeAudioData(arrayBuffer);
  return audio.buffer;
}

/** Start (or restart) the song from `offsetMs` into the track. */
export function playSong(offsetMs = 0) {
  stopSong();
  const src = audio.ctx.createBufferSource();
  src.buffer = audio.buffer;
  src.connect(audio.musicGain);
  const off = Math.max(0, offsetMs / 1000);
  src.start(0, off);
  audio.source = src;
  audio._startCtxTime = audio.ctx.currentTime;
  audio._startOffset = off;
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

/** Current position in the song, in milliseconds. */
export function songTime() {
  if (!audio.ctx) return 0;
  if (!audio.playing) return audio._startOffset * 1000;
  return (audio.ctx.currentTime - audio._startCtxTime + audio._startOffset) * 1000;
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
