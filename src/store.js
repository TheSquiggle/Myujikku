// Persistent settings + local score records (localStorage).

const SKEY = 'myujikku.settings.v1';
const RKEY = 'myujikku.scores.v1';

export const DEFAULTS = {
  speed: 22,          // scroll speed (higher = faster)
  offset: 0,          // audio offset in ms (+ = notes later)
  music: 70,
  hit: 55,
  dim: 70,
  video: true,
  upscroll: false,
  fx: true,
  autoplay: false,
  keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
};

export const settings = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(SKEY) || '{}');
    const s = { ...DEFAULTS, ...raw };
    if (!Array.isArray(s.keys) || s.keys.length !== 4) s.keys = [...DEFAULTS.keys];
    return s;
  } catch {
    return { ...DEFAULTS, keys: [...DEFAULTS.keys] };
  }
}

export function saveSettings() {
  try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch { /* storage disabled */ }
}

export function resetSettings() {
  Object.assign(settings, DEFAULTS, { keys: [...DEFAULTS.keys] });
  saveSettings();
}

/* ---------------- scores ---------------- */

function allScores() {
  try { return JSON.parse(localStorage.getItem(RKEY) || '{}'); } catch { return {}; }
}

export function scoreKey(songId, diffName) { return `${songId}::${diffName}`; }

export function getBest(songId, diffName) {
  return allScores()[scoreKey(songId, diffName)] || null;
}

/** Saves if better than the stored record. Returns true when a new best was set. */
export function submitScore(songId, diffName, record) {
  const all = allScores();
  const k = scoreKey(songId, diffName);
  const prev = all[k];
  if (prev && prev.score >= record.score) return false;
  all[k] = record;
  try { localStorage.setItem(RKEY, JSON.stringify(all)); } catch { /* ignore */ }
  return true;
}
