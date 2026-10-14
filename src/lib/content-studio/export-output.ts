import { CAROUSEL_FILE_NAMES } from "./creative-plan.ts";

// Content Studio Fast Mode -- the export-side output gate and the carousel ZIP. PURE (Uint8Array, no
// Node Buffer, no zlib), so the browser builds the ZIP from the very bytes it previewed: what the
// owner inspected is byte for byte what they download.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Width and height from a PNG's IHDR chunk, or null if the bytes are not a PNG.
export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((value, i) => bytes[i] !== value)) return null;
  // Chunk type at 12..16 must be IHDR, then width and height as big-endian uint32.
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export type CarouselExportFile = { name: string; bytes: Uint8Array };

// Exactly five PNGs, named carousel-01..05.png in order, each 1080x1350. Anything else is not a
// carousel this app produced and is refused rather than zipped.
export function validateCarouselExport(files: CarouselExportFile[], expected = { width: 1080, height: 1350 }): string[] {
  const problems: string[] = [];
  if (files.length !== CAROUSEL_FILE_NAMES.length) problems.push(`expected ${CAROUSEL_FILE_NAMES.length} slides, got ${files.length}.`);
  files.forEach((file, i) => {
    if (file.name !== CAROUSEL_FILE_NAMES[i]) problems.push(`slide ${i + 1} is named ${file.name}, expected ${CAROUSEL_FILE_NAMES[i]}.`);
    const size = readPngDimensions(file.bytes);
    if (!size) problems.push(`${file.name} is not a PNG.`);
    else if (size.width !== expected.width || size.height !== expected.height) {
      problems.push(`${file.name} is ${size.width}x${size.height}, expected ${expected.width}x${expected.height}.`);
    }
  });
  return problems;
}

// --- stored ZIP -----------------------------------------------------------------------------------
//
// PNGs are already compressed, so deflating them again gains nothing; a STORED zip keeps this to the
// format's three record types with no dependency. The timestamp is fixed (1980-01-01), so the same
// slides always produce the same bytes.

let crcTable: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function createStoredZip(entries: CarouselExportFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const checksum = crc32(entry.bytes);
    const size = entry.bytes.length;

    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    parts.push(local, name, entry.bytes);

    const record = new Uint8Array(46);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.push(record, name);

    offset += local.length + name.length + size;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of all) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

// Reads a stored ZIP back into its entries. Used by tests to prove the download holds exactly the
// previewed slides; it handles only what createStoredZip writes.
export function readStoredZip(zip: Uint8Array): CarouselExportFile[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  const files: CarouselExportFile[] = [];
  let cursor = 0;
  while (cursor + 4 <= zip.length && view.getUint32(cursor, true) === 0x04034b50) {
    if (view.getUint16(cursor + 8, true) !== 0) throw new Error("only stored entries are supported.");
    const size = view.getUint32(cursor + 18, true);
    const nameLength = view.getUint16(cursor + 26, true);
    const extraLength = view.getUint16(cursor + 28, true);
    const nameStart = cursor + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const bytes = zip.slice(dataStart, dataStart + size);
    if (crc32(bytes) !== view.getUint32(cursor + 14, true)) throw new Error("ZIP entry checksum mismatch.");
    files.push({ name: decoder.decode(zip.subarray(nameStart, nameStart + nameLength)), bytes });
    cursor = dataStart + size;
  }
  return files;
}
