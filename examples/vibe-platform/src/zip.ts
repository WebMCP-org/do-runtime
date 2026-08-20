export type ZipEntry = readonly [name: string, content: string | Uint8Array];

const encoder = new TextEncoder();
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < CRC_TABLE.length; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  CRC_TABLE[n] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

function header(size: number): { bytes: Uint8Array<ArrayBuffer>; view: DataView } {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** A dependency-free, UTF-8, store-only ZIP writer (ZIP64 is deliberately out of scope). */
export function storeZip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  if (entries.length > 0xffff) throw new Error("ZIP has too many files");
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const names = new Set<string>();
  let offset = 0;

  for (const [name, value] of entries) {
    if (
      name === "" ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").includes("..") ||
      names.has(name)
    ) {
      throw new Error(`unsafe or duplicate ZIP path: ${name}`);
    }
    names.add(name);
    const nameBytes = encoder.encode(name);
    const data = typeof value === "string" ? encoder.encode(value) : value;
    if (nameBytes.length > 0xffff || data.length > 0xffffffff) {
      throw new Error(`ZIP entry is too large: ${name}`);
    }
    const crc = crc32(data);
    const localHeader = header(30);
    localHeader.view.setUint32(0, 0x04034b50, true);
    localHeader.view.setUint16(4, 20, true);
    localHeader.view.setUint16(6, 0x0800, true);
    localHeader.view.setUint16(10, time, true);
    localHeader.view.setUint16(12, date, true);
    localHeader.view.setUint32(14, crc, true);
    localHeader.view.setUint32(18, data.length, true);
    localHeader.view.setUint32(22, data.length, true);
    localHeader.view.setUint16(26, nameBytes.length, true);
    local.push(localHeader.bytes, nameBytes, data);

    const centralHeader = header(46);
    centralHeader.view.setUint32(0, 0x02014b50, true);
    centralHeader.view.setUint16(4, 20, true);
    centralHeader.view.setUint16(6, 20, true);
    centralHeader.view.setUint16(8, 0x0800, true);
    centralHeader.view.setUint16(12, time, true);
    centralHeader.view.setUint16(14, date, true);
    centralHeader.view.setUint32(16, crc, true);
    centralHeader.view.setUint32(20, data.length, true);
    centralHeader.view.setUint32(24, data.length, true);
    centralHeader.view.setUint16(28, nameBytes.length, true);
    centralHeader.view.setUint32(42, offset, true);
    central.push(centralHeader.bytes, nameBytes);
    offset += localHeader.bytes.length + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  return concat([...local, ...central, end.bytes]);
}
