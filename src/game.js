// Gameplay: 4K mania engine — timing, judgement, scoring and rendering.

import { settings } from './store.js';
import { audio, playSong, stopSong, songTime, songDuration, playHit, playRelease, sfxFail } from './audio.js';
import { LANE_COLORS, JUDGE_STYLE, noteTexture, holdTexture, receptorTexture, burstTexture, hexA } from './skin.js';

export const JUDGEMENTS = ['MAX', 'PERFECT', 'GREAT', 'GOOD', 'MEH', 'MISS'];
export const HIT_VALUE = { MAX: 320, PERFECT: 300, GREAT: 200, GOOD: 100, MEH: 50, MISS: 0 };
const ACC_WEIGHT = { MAX: 1, PERFECT: 1, GREAT: 2 / 3, GOOD: 1 / 3, MEH: 1 / 6, MISS: 0 };

/** osu!mania judgement windows, in ms, derived from Overall Difficulty. */
export function windowsFor(od) {
  return {
    MAX: 16.5,
    PERFECT: 64 - 3 * od,
    GREAT: 97 - 3 * od,
    GOOD: 127 - 3 * od,
    MEH: 151 - 3 * od,
    MISS: 188 - 3 * od,
  };
}

const LEAD_IN = 2000;      // silent run-up before the audio starts
const END_PAD = 2500;      // grace time after the last note

export class Game {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} beatmap  loaded beatmap ({meta, audioBuffer, ...})
   * @param {object} diff     selected difficulty
   * @param {object} hooks    { onEnd(result), onExit() }
   */
  constructor(canvas, beatmap, diff, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.beatmap = beatmap;
    this.diff = diff;
    this.hooks = hooks;
    this.keys = diff.keys || 4;
    this.win = windowsFor(diff.od);

    this.notes = diff.notes.map(n => ({ ...n, state: 'idle', headJudge: null, headErr: 0 }));
    this.laneQueues = Array.from({ length: this.keys }, () => []);
    this.notes.forEach(n => this.laneQueues[n.lane].push(n));
    this.laneCursor = new Array(this.keys).fill(0);

    this.pressed = new Array(this.keys).fill(false);
    this.lastPressAt = new Array(this.keys).fill(-1e9);

    this.counts = Object.fromEntries(JUDGEMENTS.map(j => [j, 0]));
    this.combo = 0;
    this.maxCombo = 0;
    this.score = 0;
    this.accSum = 0;
    this.valueSum = 0;
    this.comboSum = 0;
    this.judged = 0;
    this.errors = [];
    this.hp = 1;
    this.failed = false;

    this.total = this.notes.length;
    this.comboDenom = this.total * (this.total + 1) / 2 || 1;
    this.hpDrain = 0.012 + (10 - (diff.hp ?? 7)) * 0.0022;
    this.hpGain = 0.006 + (10 - (diff.hp ?? 7)) * 0.0012;

    this.effects = [];       // hit bursts
    this.judgeFx = null;     // centre judgement popup
    this.comboFx = 0;
    this.particles = [];
    this.laneFlash = new Array(this.keys).fill(0);

    this.running = false;
    this.paused = false;
    this.startedAudio = false;
    this._raf = 0;
    this._clockStart = 0;
    this._t = -LEAD_IN;
    this.endsAt = (diff.length || 0) + END_PAD;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._loop = this._loop.bind(this);
    this.resize = this.resize.bind(this);
  }

  /* ---------------- lifecycle ---------------- */

  start() {
    this.resize();
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this.running = true;
    this._clockStart = performance.now();
    this._t = -LEAD_IN;
    this.startedAudio = false;
    this._raf = requestAnimationFrame(this._loop);
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    stopSong();
  }

  pause() {
    if (this.paused || !this.running) return;
    this.paused = true;
    this._pausedAt = this._t;
    stopSong();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    // Rewind slightly so the player can re-sync.
    this._t = Math.max(-LEAD_IN, this._pausedAt - 1200);
    if (this._t >= 0) { playSong(this._t); this.startedAudio = true; }
    else { this.startedAudio = false; this._clockStart = performance.now() - (this._t + LEAD_IN); }
    this._clockStart = performance.now() - (this._t + LEAD_IN);
  }

  /* ---------------- layout ---------------- */

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w;
    this.H = h;

    this.laneW = Math.min(112, Math.max(58, Math.floor(h * 0.115)));
    this.fieldW = this.laneW * this.keys;
    this.fieldX = Math.floor((w - this.fieldW) / 2);
    this.noteH = Math.max(20, Math.floor(this.laneW * 0.34));
    this.recH = Math.floor(this.laneW * 0.5);
    this.judgeY = settings.upscroll ? Math.floor(h * 0.14) : Math.floor(h - h * 0.16);
    this.pxPerMs = (settings.speed * this.H) / 11000;
  }

  laneX(i) { return this.fieldX + i * this.laneW; }

  /** Screen Y for a given song time. */
  yFor(t) {
    const d = (t - this._t) * this.pxPerMs;
    return settings.upscroll ? this.judgeY + d : this.judgeY - d;
  }

  /* ---------------- input ---------------- */

  _onKeyDown(e) {
    if (e.repeat) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      if (this.paused) this.hooks.onResume?.(); else this.hooks.onPause?.();
      return;
    }
    if (e.code === 'Backquote') { e.preventDefault(); this.hooks.onRestart?.(); return; }
    if (this.paused) return;
    const lane = settings.keys.indexOf(e.code);
    if (lane < 0 || lane >= this.keys) return;
    e.preventDefault();
    if (settings.autoplay) return;
    this._press(lane);
  }

  _onKeyUp(e) {
    const lane = settings.keys.indexOf(e.code);
    if (lane < 0 || lane >= this.keys) return;
    if (settings.autoplay) return;
    this._release(lane);
  }

  _press(lane) {
    if (this.pressed[lane]) return;
    this.pressed[lane] = true;
    this.laneFlash[lane] = 1;

    const n = this._nextHittable(lane);
    if (!n) { playHit(lane); return; }

    // Autoplay presses on the next animation frame, so ignore that sub-frame jitter.
    const err = settings.autoplay ? 0 : this._t - n.t;
    if (err < -this.win.MISS) { playHit(lane); return; }   // way too early: ignore the note

    playHit(lane);
    const j = this._judgeOf(Math.abs(err));
    if (n.hold) {
      if (j === 'MISS') { this._finalize(n, 'MISS', err); return; }
      n.state = 'holding';
      n.headJudge = j;
      n.headErr = err;
      this._spawnBurst(lane, j);
    } else {
      this._finalize(n, j, err);
      if (j !== 'MISS') this._spawnBurst(lane, j);
    }
  }

  _release(lane) {
    if (!this.pressed[lane]) return;
    this.pressed[lane] = false;
    const n = this.laneQueues[lane].find(x => x.state === 'holding');
    if (!n) return;
    const rel = settings.autoplay ? 0 : this._t - n.end;
    if (rel < -this.win.MEH * 1.5) {
      this._finalize(n, 'MISS', rel);                       // let go far too early
    } else {
      const relJ = this._judgeOf(Math.abs(rel) / 1.5);
      const worse = JUDGEMENTS.indexOf(relJ) > JUDGEMENTS.indexOf(n.headJudge) ? relJ : n.headJudge;
      this._finalize(n, worse, n.headErr);
      playRelease();
      this._spawnBurst(lane, worse);
    }
  }

  _nextHittable(lane) {
    const q = this.laneQueues[lane];
    for (let i = this.laneCursor[lane]; i < q.length; i++) {
      const n = q[i];
      if (n.state === 'idle' && this._t <= n.t + this.win.MISS) return n;
    }
    return null;
  }

  _judgeOf(absErr) {
    if (absErr <= this.win.MAX) return 'MAX';
    if (absErr <= this.win.PERFECT) return 'PERFECT';
    if (absErr <= this.win.GREAT) return 'GREAT';
    if (absErr <= this.win.GOOD) return 'GOOD';
    if (absErr <= this.win.MEH) return 'MEH';
    return 'MISS';
  }

  /* ---------------- scoring ---------------- */

  _finalize(n, judge, err) {
    n.state = 'done';
    n.judge = judge;
    this.counts[judge]++;
    this.judged++;

    if (judge === 'MISS') {
      this.combo = 0;
      this.hp = Math.max(0, this.hp - this.hpDrain * 3.2);
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.comboSum += this.combo;
      this.hp = Math.min(1, this.hp + this.hpGain * (judge === 'MEH' ? 0.15 : 1));
      if (judge === 'MEH' || judge === 'GOOD') this.hp = Math.max(0, this.hp - this.hpDrain * 0.5);
      this.errors.push({ t: n.t, err });
      this.comboFx = 1;
    }

    this.valueSum += HIT_VALUE[judge];
    this.accSum += ACC_WEIGHT[judge];
    this.score = Math.round(
      700000 * (this.valueSum / (320 * this.total)) +
      300000 * (this.comboSum / this.comboDenom)
    );

    this.judgeFx = { judge, life: 1 };

    if (this.hp <= 0 && !this.failed && !settings.autoplay) {
      this.failed = true;
      sfxFail();
      this._end();
    }
  }

  get accuracy() {
    return this.judged ? (this.accSum / this.judged) * 100 : 100;
  }

  grade() {
    const a = this.accuracy;
    if (this.failed) return 'F';
    if (this.counts.MISS === 0 && this.counts.MEH === 0 && this.counts.GOOD === 0 && a >= 99) return 'SS';
    if (a >= 95) return 'S';
    if (a >= 90) return 'A';
    if (a >= 80) return 'B';
    if (a >= 70) return 'C';
    return 'D';
  }

  /* ---------------- effects ---------------- */

  _spawnBurst(lane, judge) {
    if (!settings.fx) return;
    this.effects.push({ lane, life: 1, judge });
    const col = LANE_COLORS[lane % 4];
    const cx = this.laneX(lane) + this.laneW / 2;
    const count = judge === 'MAX' || judge === 'PERFECT' ? 9 : 5;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.4 + Math.random() * 3.4;
      this.particles.push({
        x: cx, y: this.judgeY,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - (settings.upscroll ? -1.6 : 1.6),
        life: 1, r: 2 + Math.random() * 3, color: col.glow,
      });
    }
  }

  /* ---------------- main loop ---------------- */

  _loop(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);
    if (this.paused) { this._draw(); return; }

    if (!this.startedAudio) {
      this._t = (now - this._clockStart) - LEAD_IN;
      if (this._t >= 0) {
        playSong(Math.max(0, this._t));
        this.startedAudio = true;
      }
    } else {
      this._t = songTime() - settings.offset;
    }

    if (settings.autoplay) this._autoplay();
    this._updateNotes();
    this._draw();

    const dur = songDuration();
    if (this._t > Math.max(this.endsAt, dur + 500) || (this.judged >= this.total && this._t > this.endsAt - END_PAD + 900)) {
      this._end();
    }
  }

  _autoplay() {
    for (let lane = 0; lane < this.keys; lane++) {
      const q = this.laneQueues[lane];
      for (let i = this.laneCursor[lane]; i < q.length; i++) {
        const n = q[i];
        if (n.state === 'idle' && this._t >= n.t) { this._press(lane); break; }
        if (n.state === 'holding' && this._t >= n.end) { this._release(lane); break; }
        if (n.t > this._t) break;
      }
      if (this.pressed[lane]) {
        const holding = q.some(x => x.state === 'holding');
        const justTapped = q.some(x => x.state === 'done' && !x.hold && Math.abs(this._t - x.t) < 40);
        if (!holding && !justTapped) this._release(lane);
      }
    }
  }

  _updateNotes() {
    for (let lane = 0; lane < this.keys; lane++) {
      const q = this.laneQueues[lane];
      let cur = this.laneCursor[lane];
      for (let i = cur; i < q.length; i++) {
        const n = q[i];
        if (n.state === 'idle' && this._t > n.t + this.win.MISS) {
          this._finalize(n, 'MISS', this.win.MISS);
        } else if (n.state === 'holding' && this._t > n.end + this.win.MEH * 1.5) {
          this._finalize(n, n.headJudge, n.headErr);        // held all the way through
          this.laneFlash[lane] = 1;
        }
        if (n.state === 'done' && i === cur) cur = i + 1;
        if (n.t > this._t + 4000) break;
      }
      this.laneCursor[lane] = cur;
    }
  }

  _end() {
    if (this._ended) return;
    this._ended = true;
    this.running = false;
    cancelAnimationFrame(this._raf);
    stopSong();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('resize', this.resize);
    this.hooks.onEnd?.(this.result());
  }

  result() {
    const errs = this.errors.map(e => e.err);
    const mean = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0;
    return {
      score: this.score,
      accuracy: this.accuracy,
      counts: { ...this.counts },
      maxCombo: this.maxCombo,
      grade: this.grade(),
      failed: this.failed,
      mean,
      errors: this.errors.slice(),
      total: this.total,
      autoplay: settings.autoplay,
    };
  }

  /* ---------------- rendering ---------------- */

  _draw() {
    const g = this.ctx, W = this.W, H = this.H;
    g.clearRect(0, 0, W, H);

    const fx = this.fieldX, fw = this.fieldW;

    // playfield backdrop
    g.fillStyle = 'rgba(6,3,14,.80)';
    g.fillRect(fx, 0, fw, H);
    g.strokeStyle = 'rgba(255,255,255,.10)';
    g.lineWidth = 1;
    for (let i = 1; i < this.keys; i++) {
      g.beginPath(); g.moveTo(this.laneX(i) + .5, 0); g.lineTo(this.laneX(i) + .5, H); g.stroke();
    }
    g.strokeStyle = 'rgba(255,61,139,.55)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(fx, 0); g.lineTo(fx, H); g.moveTo(fx + fw, 0); g.lineTo(fx + fw, H); g.stroke();

    // lane key flash
    for (let i = 0; i < this.keys; i++) {
      if (this.pressed[i] || this.laneFlash[i] > 0) {
        const a = this.pressed[i] ? 0.16 : this.laneFlash[i] * 0.16;
        const col = LANE_COLORS[i % 4];
        const grad = g.createLinearGradient(0, this.judgeY, 0, settings.upscroll ? H : 0);
        grad.addColorStop(0, hexA(col.main, a * 2.2));
        grad.addColorStop(1, hexA(col.main, 0));
        g.fillStyle = grad;
        g.fillRect(this.laneX(i), 0, this.laneW, H);
        this.laneFlash[i] = Math.max(0, this.laneFlash[i] - 0.06);
      }
    }

    this._drawNotes(g);
    this._drawReceptors(g);
    this._drawEffects(g);
    this._drawHUD(g);
  }

  _drawNotes(g) {
    const visTop = -this.noteH * 3;
    const visBot = this.H + this.noteH * 3;

    // hold bodies first
    for (const n of this.notes) {
      if (!n.hold || n.state === 'done') continue;
      const yHead = this.yFor(n.state === 'holding' ? Math.max(this._t, n.t) : n.t);
      const yTail = this.yFor(n.end);
      const top = Math.min(yHead, yTail), bot = Math.max(yHead, yTail);
      if (bot < visTop || top > visBot) continue;
      const w = this.laneW * 0.72;
      const x = this.laneX(n.lane) + (this.laneW - w) / 2;
      g.save();
      g.globalAlpha = n.state === 'holding' ? 1 : 0.9;
      const tex = holdTexture(Math.round(w), n.lane);
      g.drawImage(tex, x, top, w, Math.max(2, bot - top));
      g.restore();
    }

    // heads + tails
    for (const n of this.notes) {
      if (n.state === 'done') continue;
      const w = this.laneW * 0.86;
      const x = this.laneX(n.lane) + (this.laneW - w) / 2;

      if (n.hold) {
        const yTail = this.yFor(n.end);
        if (yTail > visTop && yTail < visBot) {
          const t = noteTexture(Math.round(w), this.noteH, n.lane);
          g.drawImage(t.canvas, x - t.pad, yTail - this.noteH / 2 - t.pad);
        }
      }
      if (n.state === 'holding') continue;             // head is locked to the receptor
      const y = this.yFor(n.t);
      if (y < visTop || y > visBot) continue;
      const t = noteTexture(Math.round(w), this.noteH, n.lane);
      g.drawImage(t.canvas, x - t.pad, y - this.noteH / 2 - t.pad);
    }
  }

  _drawReceptors(g) {
    const y = settings.upscroll ? this.judgeY - this.recH : this.judgeY;
    for (let i = 0; i < this.keys; i++) {
      const w = this.laneW * 0.88;
      const x = this.laneX(i) + (this.laneW - w) / 2;
      const t = receptorTexture(Math.round(w), this.recH, i, this.pressed[i]);
      g.drawImage(t.canvas, x - t.pad, y - t.pad);
    }
    // judgement line
    g.strokeStyle = 'rgba(255,255,255,.85)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(this.fieldX, this.judgeY + .5);
    g.lineTo(this.fieldX + this.fieldW, this.judgeY + .5);
    g.stroke();
  }

  _drawEffects(g) {
    // hit bursts
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= 0.055;
      if (e.life <= 0) { this.effects.splice(i, 1); continue; }
      const size = this.laneW * (1.5 + (1 - e.life) * 1.0);
      const cx = this.laneX(e.lane) + this.laneW / 2;
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = e.life * 0.85;
      g.drawImage(burstTexture(128, e.lane), cx - size / 2, this.judgeY - size / 2, size, size);
      g.restore();
    }

    // particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= 0.028;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.x += p.vx; p.y += p.vy; p.vy += 0.14;
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = p.life;
      g.fillStyle = p.color;
      g.beginPath(); g.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2); g.fill();
      g.restore();
    }

    const cx = this.fieldX + this.fieldW / 2;

    // combo
    if (this.combo > 1) {
      this.comboFx = Math.max(0, this.comboFx - 0.08);
      const scale = 1 + this.comboFx * 0.22;
      g.save();
      g.translate(cx, this.H * (settings.upscroll ? 0.58 : 0.36));
      g.scale(scale, scale);
      g.textAlign = 'center';
      g.font = '800 46px "Segoe UI", system-ui, sans-serif';
      g.fillStyle = 'rgba(255,255,255,.95)';
      g.shadowColor = 'rgba(255,61,139,.9)';
      g.shadowBlur = 26;
      g.fillText(String(this.combo), 0, 0);
      g.font = '700 13px "Segoe UI", system-ui, sans-serif';
      g.fillStyle = 'rgba(255,142,192,.9)';
      g.shadowBlur = 8;
      g.fillText('COMBO', 0, 22);
      g.restore();
    }

    // judgement popup
    if (this.judgeFx) {
      this.judgeFx.life -= 0.045;
      if (this.judgeFx.life <= 0) this.judgeFx = null;
      else {
        const st = JUDGE_STYLE[this.judgeFx.judge] || JUDGE_STYLE.MISS;
        const l = this.judgeFx.life;
        g.save();
        g.translate(cx, this.H * (settings.upscroll ? 0.76 : 0.56));
        g.scale(1 + (1 - l) * 0.12, 1 + (1 - l) * 0.12);
        g.globalAlpha = Math.min(1, l * 1.6);
        g.textAlign = 'center';
        g.font = '800 30px "Yu Gothic UI","Hiragino Sans",system-ui,sans-serif';
        g.fillStyle = st.color;
        g.shadowColor = st.color; g.shadowBlur = 22;
        g.fillText(st.text, 0, 0);
        g.font = '700 12px "Segoe UI", system-ui, sans-serif';
        g.globalAlpha *= 0.8;
        g.fillText(st.sub, 0, 18);
        g.restore();
      }
    }
  }

  _drawHUD(g) {
    const H = this.H;

    // HP bar (left of the field)
    const barX = this.fieldX - 22, barTop = H * 0.12, barH = H * 0.7;
    g.fillStyle = 'rgba(255,255,255,.10)';
    g.fillRect(barX, barTop, 8, barH);
    const hpH = barH * this.hp;
    const grad = g.createLinearGradient(0, barTop + barH - hpH, 0, barTop + barH);
    grad.addColorStop(0, '#66ffb2');
    grad.addColorStop(1, this.hp < 0.3 ? '#ff5c7a' : '#38e8ff');
    g.fillStyle = grad;
    g.fillRect(barX, barTop + barH - hpH, 8, hpH);

    // song progress (right of the field)
    const dur = Math.max(1, songDuration());
    const p = Math.max(0, Math.min(1, this._t / dur));
    const px = this.fieldX + this.fieldW + 14;
    g.fillStyle = 'rgba(255,255,255,.10)';
    g.fillRect(px, barTop, 5, barH);
    g.fillStyle = '#ff3d8b';
    g.fillRect(px, barTop, 5, barH * p);

    // timing bar under the field
    if (this.errors.length) {
      const cx = this.fieldX + this.fieldW / 2;
      const halfW = this.fieldW * 0.46;
      const y = settings.upscroll ? H * 0.06 : H - 22;
      g.fillStyle = 'rgba(255,255,255,.14)';
      g.fillRect(cx - halfW, y - 2, halfW * 2, 4);
      const scale = halfW / this.win.MISS;
      const recent = this.errors.slice(-24);
      recent.forEach((e, i) => {
        const a = (i + 1) / recent.length;
        g.globalAlpha = a * 0.85;
        g.fillStyle = JUDGE_STYLE[this._judgeOf(Math.abs(e.err))].color;
        g.fillRect(cx + e.err * scale - 1, y - 7, 2, 14);
      });
      g.globalAlpha = 1;
      g.fillStyle = '#fff';
      g.fillRect(cx - 1, y - 9, 2, 18);
    }
  }
}
