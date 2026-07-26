// Persistent caching, so beatmaps are fetched once instead of on every visit.
//
//   metadata → localStorage  (small, needed before anything can render)
//   archives  → Cache API     (megabytes; survives reloads and restarts)
//
// Entries are keyed by URL *and* file size, so replacing a beatmap in the
// repository invalidates its cache automatically. Everything degrades to a
// no-op when storage is unavailable (private windows, file://, quota full).

const META_KEY = 'myujikku.meta.v1';
const CACHE_NAME = 'myujikku-beatmaps-v1';
const MAX_ARCHIVES = 12;              // keep the newest N; evict the rest

const hasCacheApi = typeof caches !== 'undefined' && typeof window !== 'undefined' && window.isSecureContext;

/* ---------------- metadata (localStorage) ---------------- */

function readMetaStore() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); }
  catch { return {}; }
}

function writeMetaStore(store) {
  try { localStorage.setItem(META_KEY, JSON.stringify(store)); }
  catch { /* quota or disabled — caching is optional */ }
}

const metaKey = (url, bytes) => `${url}|${bytes || 0}`;

/** Cached chart metadata for a beatmap, or null. */
export function getMeta(url, bytes) {
  const hit = readMetaStore()[metaKey(url, bytes)];
  return hit ? hit.value : null;
}

export function putMeta(url, bytes, value) {
  const store = readMetaStore();
  store[metaKey(url, bytes)] = { at: Date.now(), value };

  // Drop entries for beatmaps that are no longer around.
  const keys = Object.keys(store);
  if (keys.length > 60) {
    keys.sort((a, b) => store[a].at - store[b].at);
    for (const k of keys.slice(0, keys.length - 60)) delete store[k];
  }
  writeMetaStore(store);
}

/* ---------------- binaries (Cache API) ---------------- */

// Cache API keys on a URL, so synthesise one for each thing we store.
const blobRequest = (kind, url, bytes) =>
  `${location.origin}/__myujikku/${kind}/${bytes || 0}/${encodeURIComponent(url)}`;

async function openCache() {
  if (!hasCacheApi) return null;
  try { return await caches.open(CACHE_NAME); }
  catch { return null; }
}

/**
 * Read a cached binary.
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function getBlob(kind, url, bytes) {
  const cache = await openCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(blobRequest(kind, url, bytes));
    return hit ? await hit.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** Store a binary. Failures are ignored — the caller can always refetch. */
export async function putBlob(kind, url, bytes, data, contentType = 'application/octet-stream') {
  const cache = await openCache();
  if (!cache) return;
  try {
    await cache.put(
      blobRequest(kind, url, bytes),
      new Response(data, { headers: { 'Content-Type': contentType, 'X-Cached-At': String(Date.now()) } }),
    );
    await evictOldest(cache);
  } catch { /* out of quota; not fatal */ }
}

/** Keep the cache bounded: drop the least recently stored archives. */
async function evictOldest(cache) {
  try {
    const keys = await cache.keys();
    const archives = keys.filter(r => r.url.includes('/__myujikku/archive/'));
    if (archives.length <= MAX_ARCHIVES) return;

    const stamped = await Promise.all(archives.map(async req => ({
      req,
      at: Number((await cache.match(req))?.headers.get('X-Cached-At')) || 0,
    })));
    stamped.sort((a, b) => a.at - b.at);
    for (const { req } of stamped.slice(0, stamped.length - MAX_ARCHIVES)) await cache.delete(req);
  } catch { /* eviction is best-effort */ }
}

/* ---------------- housekeeping ---------------- */

/** Total bytes currently held, for the settings screen. */
export async function cacheSize() {
  const cache = await openCache();
  if (!cache) return { bytes: 0, count: 0, available: false };
  try {
    const keys = await cache.keys();
    let bytes = 0;
    for (const req of keys) {
      const res = await cache.match(req);
      const len = Number(res?.headers.get('Content-Length'));
      bytes += Number.isFinite(len) && len ? len : (await res.blob()).size;
    }
    return { bytes, count: keys.length, available: true };
  } catch {
    return { bytes: 0, count: 0, available: false };
  }
}

export async function clearCache() {
  try { localStorage.removeItem(META_KEY); } catch { /* ignore */ }
  if (!hasCacheApi) return;
  try { await caches.delete(CACHE_NAME); } catch { /* ignore */ }
}
