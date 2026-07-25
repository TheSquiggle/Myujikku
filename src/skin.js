// Procedural skin: every graphic in ミュージック! is drawn here at runtime.
// No image files ship with the game.

export const LANE_COLORS = [
  { main: '#ff3d8b', glow: '#ff8ec0', dark: '#7d0f3d' }, // outer left  — pink
  { main: '#38e8ff', glow: '#b6f7ff', dark: '#0d5f70' }, // inner left  — cyan
  { main: '#38e8ff', glow: '#b6f7ff', dark: '#0d5f70' }, // inner right — cyan
  { main: '#ff3d8b', glow: '#ff8ec0', dark: '#7d0f3d' }, // outer right — pink
];

export const JUDGE_STYLE = {
  MAX:    { text: '極',    color: '#ffd24a', sub: 'MAX' },
  PERFECT:{ text: '完璧',   color: '#ffe680', sub: 'PERFECT' },
  GREAT:  { text: 'グレート', color: '#66ffb2', sub: 'GREAT' },
  GOOD:   { text: 'グッド',  color: '#7ec8ff', sub: 'GOOD' },
  OK:     { text: 'オーケー', color: '#c69bff', sub: 'OK' },
  MEH:    { text: 'メー',   color: '#ff9f5c', sub: 'MEH' },
  MISS:   { text: 'ミス',   color: '#ff5c7a', sub: 'MISS' },
};

function rr(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/** Glossy capsule note. Cached per (width,height,lane). */
const noteCache = new Map();
export function noteTexture(w, h, lane) {
  const key = `${w}|${h}|${lane}`;
  if (noteCache.has(key)) return noteCache.get(key);
  const pad = Math.ceil(h * 0.5) + 6;
  const c = makeCanvas(w + pad * 2, h + pad * 2);
  const g = c.getContext('2d');
  const col = LANE_COLORS[lane % 4];
  const x = pad, y = pad;

  g.shadowColor = col.glow;
  g.shadowBlur = h * 0.9;
  g.fillStyle = col.main;
  rr(g, x, y, w, h, h * 0.34);
  g.fill();
  g.shadowBlur = 0;

  const grad = g.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.16, col.glow);
  grad.addColorStop(0.52, col.main);
  grad.addColorStop(1, col.dark);
  g.fillStyle = grad;
  rr(g, x, y, w, h, h * 0.34);
  g.fill();

  // top gloss
  const gloss = g.createLinearGradient(0, y, 0, y + h * 0.5);
  gloss.addColorStop(0, 'rgba(255,255,255,.75)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gloss;
  rr(g, x + w * 0.06, y + h * 0.1, w * 0.88, h * 0.4, h * 0.2);
  g.fill();

  g.strokeStyle = 'rgba(255,255,255,.85)';
  g.lineWidth = Math.max(1, h * 0.06);
  rr(g, x, y, w, h, h * 0.34);
  g.stroke();

  const tex = { canvas: c, pad };
  noteCache.set(key, tex);
  return tex;
}

/** Body texture for hold notes — a tiled vertical gradient with a moving sheen. */
const holdCache = new Map();
export function holdTexture(w, lane) {
  const key = `${w}|${lane}`;
  if (holdCache.has(key)) return holdCache.get(key);
  const h = 64;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const col = LANE_COLORS[lane % 4];
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, col.dark);
  grad.addColorStop(0.28, col.main);
  grad.addColorStop(0.5, col.glow);
  grad.addColorStop(0.72, col.main);
  grad.addColorStop(1, col.dark);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 0.22;
  g.fillStyle = '#fff';
  for (let y = 0; y < h; y += 16) g.fillRect(0, y, w, 3);
  g.globalAlpha = 1;
  holdCache.set(key, c);
  return c;
}

/** Receptor / key. `pressed` renders the lit state. */
const recCache = new Map();
export function receptorTexture(w, h, lane, pressed) {
  const key = `${w}|${h}|${lane}|${pressed}`;
  if (recCache.has(key)) return recCache.get(key);
  const pad = 18;
  const c = makeCanvas(w + pad * 2, h + pad * 2);
  const g = c.getContext('2d');
  const col = LANE_COLORS[lane % 4];
  const x = pad, y = pad;

  if (pressed) {
    g.shadowColor = col.glow;
    g.shadowBlur = 26;
  }
  g.fillStyle = pressed ? col.main : 'rgba(255,255,255,.09)';
  rr(g, x, y, w, h, h * 0.28);
  g.fill();
  g.shadowBlur = 0;

  const grad = g.createLinearGradient(0, y, 0, y + h);
  if (pressed) {
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, col.main);
  } else {
    grad.addColorStop(0, 'rgba(255,255,255,.20)');
    grad.addColorStop(1, 'rgba(255,255,255,.03)');
  }
  g.fillStyle = grad;
  rr(g, x, y, w, h, h * 0.28);
  g.fill();

  g.strokeStyle = pressed ? '#fff' : 'rgba(255,255,255,.35)';
  g.lineWidth = 2;
  rr(g, x, y, w, h, h * 0.28);
  g.stroke();

  const tex = { canvas: c, pad };
  recCache.set(key, tex);
  return tex;
}

/** Radial burst used for hit lighting. */
const burstCache = new Map();
export function burstTexture(size, lane) {
  const key = `${size}|${lane}`;
  if (burstCache.has(key)) return burstCache.get(key);
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const col = LANE_COLORS[lane % 4];
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,.95)');
  grad.addColorStop(0.28, col.glow);
  grad.addColorStop(0.62, hexA(col.main, 0.45));
  grad.addColorStop(1, hexA(col.main, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  burstCache.set(key, c);
  return c;
}

export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Title logo, drawn as inline SVG so it scales crisply. */
export function logoSVG() {
  return `
<svg viewBox="0 0 620 190" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ミュージック!">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ff3d8b"/>
      <stop offset="50%" stop-color="#9d6bff"/>
      <stop offset="100%" stop-color="#38e8ff"/>
    </linearGradient>
    <linearGradient id="lg2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="60%" stop-color="#ffd9ec"/>
      <stop offset="100%" stop-color="#ff8ec0"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <g filter="url(#soft)" opacity=".55">
    <ellipse cx="310" cy="95" rx="280" ry="62" fill="url(#lg)" opacity=".28"/>
  </g>

  <!-- decorative staff + notes -->
  <g stroke="url(#lg)" stroke-width="2.5" opacity=".5">
    <path d="M30 150 C 140 118, 240 178, 350 142 S 560 116, 596 138" fill="none"/>
  </g>
  <g fill="url(#lg)">
    <circle cx="86" cy="46" r="9"/><rect x="93" y="14" width="4" height="34" rx="2"/>
    <circle cx="536" cy="58" r="9"/><rect x="543" y="26" width="4" height="34" rx="2"/>
  </g>

  <text x="310" y="112" text-anchor="middle"
        font-family="'Yu Gothic UI','Hiragino Sans','Noto Sans JP',sans-serif"
        font-size="86" font-weight="900" letter-spacing="4"
        fill="url(#lg2)" stroke="url(#lg)" stroke-width="5" paint-order="stroke">ミュージック!</text>
  <text x="310" y="150" text-anchor="middle"
        font-family="'Segoe UI',sans-serif" font-size="17" font-weight="700"
        letter-spacing="14" fill="#ff8ec0">MYUJIKKU</text>
</svg>`;
}

/** Fallback cover art when a beatmap ships without BG.jpg. */
export function generateCover(seedText, w = 640, h = 400) {
  let seed = 0;
  for (let i = 0; i < seedText.length; i++) seed = (seed * 31 + seedText.charCodeAt(i)) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const hue = Math.floor(rand() * 360);
  const sky = g.createLinearGradient(0, 0, w * 0.4, h);
  sky.addColorStop(0, `hsl(${hue},72%,62%)`);
  sky.addColorStop(0.5, `hsl(${(hue + 40) % 360},68%,44%)`);
  sky.addColorStop(1, `hsl(${(hue + 300) % 360},60%,20%)`);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);

  // sun disc
  g.globalAlpha = 0.7;
  g.fillStyle = `hsl(${(hue + 20) % 360},95%,72%)`;
  g.beginPath(); g.arc(w * 0.72, h * 0.34, h * 0.22, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 1;

  // speed lines
  g.strokeStyle = 'rgba(255,255,255,.16)';
  for (let i = 0; i < 40; i++) {
    g.lineWidth = rand() * 3 + 0.4;
    const y = rand() * h;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y + (rand() - 0.5) * 60); g.stroke();
  }

  // petals
  for (let i = 0; i < 70; i++) {
    const x = rand() * w, y = rand() * h, r = rand() * 7 + 2;
    g.globalAlpha = rand() * 0.55 + 0.2;
    g.fillStyle = rand() > 0.5 ? '#ffd9ec' : '#ffffff';
    g.beginPath();
    g.ellipse(x, y, r, r * 0.55, rand() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;

  // vignette
  const vig = g.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, h * 0.85);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,.6)');
  g.fillStyle = vig;
  g.fillRect(0, 0, w, h);

  return c.toDataURL('image/jpeg', 0.85);
}
