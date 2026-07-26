// Minimal ZIP reader for .mjk beatmap archives.
// Uses the browser's native DecompressionStream('deflate-raw') — no dependencies.

const te = new TextDecoder();

function findEOCD(view, bytes) {
  // End of central directory: signature 0x06054b50, within the last 64KiB + 22.
  const max = Math.min(bytes.length, 0xffff + 22);
  for (let i = 22; i <= max; i++) {
    const p = bytes.length - i;
    if (view.getUint32(p, true) === 0x06054b50) return p;
  }
  return -1;
}

export async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is unavailable — use a Chromium/Firefox-based browser.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read a zip archive.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Map<string, Uint8Array>>} filename -> bytes
 */
export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEOCD(view, bytes);
  if (eocd < 0) throw new Error('Not a valid .mjk archive (no zip end-of-central-directory).');

  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);

  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOff = view.getUint32(ptr + 42, true);
    const name = te.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;

    // Local header: name/extra lengths can differ from the central record.
    if (view.getUint32(localOff, true) !== 0x04034b50) throw new Error(`Corrupt local header for ${name}`);
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    if (method === 0) out.set(name, raw.slice());
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new Error(`Unsupported compression method ${method} in ${name}`);
  }
  return out;
}

export function bytesToText(b) { return te.decode(b); }
export function bytesToURL(b, type) { return URL.createObjectURL(new Blob([b], { type })); }

/* ================= remote (ranged) reading ================= */
//
// A .mjk is mostly audio and video, but the song list only needs chart.mjc and
// the cover. Zip keeps its index at the *end* of the file, so with HTTP range
// requests we can read the directory and pull out one entry — a few hundred KB
// instead of tens of megabytes.

/**
 * Fetch a byte range.
 *
 * Both ends are always given explicitly: a suffix range ("bytes=-500") is not
 * CORS-safelisted, so it would force a preflight that static file hosts such as
 * raw.githubusercontent.com refuse. "bytes=start-end" is safelisted and passes.
 */
async function fetchRange(url, start, end) {
  const range = `bytes=${start}-${end}`;
  const res = await fetch(url, { headers: { Range: range } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${range} of ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // If the server ignored the range and sent the lot, slice it ourselves.
  return res.status === 206 ? buf : buf.subarray(start, end + 1);
}

/**
 * Read a remote zip's central directory without downloading the whole archive.
 * @param {string} url
 * @param {number} size  total file size in bytes (the caller knows it from its listing)
 * @returns {Promise<{entries: Map<string,object>, read: (name:string)=>Promise<Uint8Array|null>}>}
 */
export async function openRemoteZip(url, size) {
  if (!Number.isFinite(size) || size <= 0) throw new Error('openRemoteZip needs the file size.');

  // The directory lives at the end; 64 KiB covers any realistic .mjk.
  const tailLen = Math.min(65_557, size);
  const tailOffset = size - tailLen;
  let tail = await fetchRange(url, tailOffset, size - 1);
  let view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocd = findEOCD(view, tail);
  if (eocd < 0) throw new Error('Could not find the zip directory — is this a .mjk?');

  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  let tailStart = tailOffset;
  if (cdOffset < tailStart) {
    // The directory begins before the chunk we fetched — grab exactly it.
    tail = await fetchRange(url, cdOffset, cdOffset + cdSize - 1);
    view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    tailStart = cdOffset;
  }

  let ptr = cdOffset - tailStart;
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const nameLen = view.getUint16(ptr + 28, true);
    const name = te.decode(tail.subarray(ptr + 46, ptr + 46 + nameLen));
    entries.set(name, {
      method: view.getUint16(ptr + 10, true),
      compSize: view.getUint32(ptr + 20, true),
      size: view.getUint32(ptr + 24, true),
      localOff: view.getUint32(ptr + 42, true),
    });
    ptr += 46 + nameLen + view.getUint16(ptr + 30, true) + view.getUint16(ptr + 32, true);
  }

  async function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    // The local header repeats the name and extra fields, and its lengths can
    // differ from the central record — read the header first, then the data.
    const head = await fetchRange(url, e.localOff, e.localOff + 29);
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (hv.getUint32(0, true) !== 0x04034b50) throw new Error(`Corrupt local header for ${name}`);
    const dataStart = e.localOff + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    const raw = await fetchRange(url, dataStart, dataStart + e.compSize - 1);
    if (e.method === 0) return raw;
    if (e.method === 8) return inflateRaw(raw);
    throw new Error(`Unsupported compression method ${e.method} in ${name}`);
  }

  return { entries, read };
}
