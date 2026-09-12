/* Minimal standards-compliant STORE ZIP for browser-local demo exports. */
export function zipText(files: Record<string, string>): Blob {
  const encoder = new TextEncoder(); const chunks: Uint8Array[] = []; const directory: Uint8Array[] = []; let offset = 0;
  function crc(data: Uint8Array) { let c = 0xffffffff; for (const b of data) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
  for (const [name, value] of Object.entries(files)) {
    const n = encoder.encode(name), data = encoder.encode(value), checksum = crc(data); const local = new Uint8Array(30 + n.length); const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); l.setUint32(14, checksum, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true); l.setUint16(26, n.length, true); local.set(n, 30);
    const central = new Uint8Array(46 + n.length); const c = new DataView(central.buffer); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint32(16, checksum, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, n.length, true); c.setUint32(42, offset, true); central.set(n, 46);
    chunks.push(local, data); directory.push(central); offset += local.length + data.length;
  }
  const size = directory.reduce((s, x) => s + x.length, 0); const end = new Uint8Array(22); const e = new DataView(end.buffer); e.setUint32(0, 0x06054b50, true); e.setUint16(8, directory.length, true); e.setUint16(10, directory.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end].map(c => c.slice().buffer), { type: 'application/zip' });
}
export async function sha256(blob: Blob) { const bytes = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()); return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join(''); }
