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

async function inflateRaw(bytes) {
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
