// Minimal ZIP writer — the counterpart to zip.js.
// Deflates with the browser's native CompressionStream; no dependencies.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a zip archive.
 * @param {Array<{name:string, data:Uint8Array|ArrayBuffer|string, store?:boolean}>} entries
 *        `store: true` skips compression — use it for already-compressed media.
 * @param {(p:number, name:string)=>void} onProgress
 * @returns {Promise<Blob>}
 */
export async function writeZip(entries, onProgress = () => {}) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    onProgress(i / entries.length, e.name);

    let data = e.data;
    if (typeof data === 'string') data = enc.encode(data);
    else if (data instanceof ArrayBuffer) data = new Uint8Array(data);

    const nameBytes = enc.encode(e.name);
    const crc = crc32(data);
    const store = e.store ?? false;
    const body = store ? data : await deflateRaw(data);
    const method = store ? 0 : 8;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0, true);           // flags
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);          // extra length
    local.set(nameBytes, 30);

    chunks.push(local, body);
    central.push({ nameBytes, crc, method, comp: body.length, size: data.length, offset });
    offset += local.length + body.length;
  }

  const cdStart = offset;
  for (const c of central) {
    const rec = new Uint8Array(46 + c.nameBytes.length);
    const rv = new DataView(rec.buffer);
    rv.setUint32(0, 0x02014b50, true);
    rv.setUint16(4, 20, true);          // version made by
    rv.setUint16(6, 20, true);          // version needed
    rv.setUint16(8, 0, true);
    rv.setUint16(10, c.method, true);
    rv.setUint16(12, time, true);
    rv.setUint16(14, date, true);
    rv.setUint32(16, c.crc, true);
    rv.setUint32(20, c.comp, true);
    rv.setUint32(24, c.size, true);
    rv.setUint16(28, c.nameBytes.length, true);
    rv.setUint32(42, c.offset, true);
    rec.set(c.nameBytes, 46);
    chunks.push(rec);
    offset += rec.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, offset - cdStart, true);
  ev.setUint32(16, cdStart, true);
  chunks.push(eocd);

  onProgress(1, 'done');
  return new Blob(chunks, { type: 'application/zip' });
}
