import QRCode from 'qrcode';

/**
 * A form's QR code (M17): the squares, drawn on the screen as an SVG path and saved as a PNG, both from the one
 * pattern, so the picture somebody saves is the code they were shown. Made with the library the web's Share tab uses,
 * at the same error correction. No React and no device here, so the tests read it straight.
 */

/** The empty border round the code that scanners need to find it: four squares, as the standard asks. */
export const QUIET = 4;

/** The code's squares: `dark(x, y)` for the one in column x of row y. */
export function qrMatrix(text: string): {
  readonly size: number;
  dark(x: number, y: number): boolean;
} {
  const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  return { size, dark: (x, y) => Boolean(data[y * size + x]) };
}

/**
 * The dark squares as one SVG path, a rectangle per run of dark squares along each row, so a code of a few hundred
 * squares is one short path rather than hundreds of shapes.
 */
export function qrPath(text: string): { readonly size: number; readonly d: string } {
  const { size, dark } = qrMatrix(text);
  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!dark(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && dark(x, y)) x++;
      d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
    }
  }
  return { size, d };
}

/**
 * The code as a PNG, about `target` pixels square: big enough to print on a flyer or a truck door without going soft.
 * Black and white at one bit a pixel, with the quiet border, a whole number of pixels per square so the edges stay
 * sharp. Written here rather than rendered from the screen, which makes it the same on every phone and checkable
 * pixel by pixel in a test.
 */
export function qrPng(text: string, target = 1024): Uint8Array {
  const { size, dark } = qrMatrix(text);
  const box = size + QUIET * 2;
  const scale = Math.max(1, Math.floor(target / box));
  const side = box * scale;
  const rowBytes = Math.ceil(side / 8);
  const stride = rowBytes + 1; // Each row starts with its filter type: 0, none.

  // White everywhere (a set bit is white in a one-bit greyscale PNG), then each row of squares drawn once and copied
  // down for the rest of its pixels.
  const raw = new Uint8Array(stride * side).fill(0xff);
  for (let py = 0; py < side; py++) raw[py * stride] = 0;
  for (let y = 0; y < size; y++) {
    const first = (QUIET + y) * scale * stride;
    for (let x = 0; x < size; x++) {
      if (!dark(x, y)) continue;
      for (let px = (QUIET + x) * scale; px < (QUIET + x + 1) * scale; px++) {
        const at = first + 1 + (px >> 3);
        raw[at] = raw[at]! & ~(0x80 >> (px & 7));
      }
    }
    for (let copy = 1; copy < scale; copy++)
      raw.copyWithin(first + copy * stride, first, first + stride);
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, side);
  view.setUint32(4, side);
  header[8] = 1; // bit depth
  header[9] = 0; // greyscale
  // compression, filter and interlace stay 0

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------- PNG's own pieces ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * The image data in a zlib wrapper with deflate's "stored" blocks: not squeezed, which a picture of about a hundred
 * kilobytes can afford, and which keeps a compressor out of the app.
 */
function zlibStored(raw: Uint8Array): Uint8Array {
  const MAX = 65535;
  const blocks = Math.max(1, Math.ceil(raw.length / MAX));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  let o = 0;
  out[o++] = 0x78; // deflate, 32K window
  out[o++] = 0x01; // no dictionary, fastest; (0x78 << 8 | 0x01) is a multiple of 31, as zlib checks
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX;
    const length = Math.min(MAX, raw.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = length & 0xff;
    out[o++] = length >>> 8;
    out[o++] = ~length & 0xff;
    out[o++] = (~length >>> 8) & 0xff;
    out.set(raw.subarray(start, start + length), o);
    o += length;
  }
  const check = adler32(raw);
  out[o++] = check >>> 24;
  out[o++] = (check >>> 16) & 0xff;
  out[o++] = (check >>> 8) & 0xff;
  out[o++] = check & 0xff;
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
