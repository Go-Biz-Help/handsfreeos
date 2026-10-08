/**
 * A zip made in memory, for the reader of Facebook's download file (src/addons/outreach/download.ts): each file
 * deflated, or kept as is, dated as the zip says; `big` writes it the way a zip over 4 GB is written (ZIP64), so that
 * path is tested without one. The browser tests make theirs the same way (apps/web/e2e/outreach-download.ts).
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipFile {
  readonly name: string;
  readonly data: string | Uint8Array;
  /** Kept as is, not deflated. */
  readonly store?: boolean;
  /** Marked as having a password. */
  readonly locked?: boolean;
}

/** A zip's date and time: no time zone, two-second steps. */
function dosTime(at: Date): { date: number; time: number } {
  return {
    date: ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
  };
}

export function makeZip(
  files: readonly ZipFile[],
  options: { readonly at?: Date; readonly big?: boolean } = {},
): Uint8Array<ArrayBuffer> {
  const { date, time } = dosTime(options.at ?? new Date(Date.UTC(2026, 9, 1, 12)));
  const FULL = 0xffffffff;
  const parts: Buffer[] = [];
  const listed: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : Buffer.from(f.data);
    const packed = f.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(f.name, 'utf8');
    const flags = 0x0800 | (f.locked ? 1 : 0);
    const method = f.store ? 0 : 8;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(options.big ? 45 : 20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc32(raw), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, name, packed);

    // A big zip's list keeps the sizes and the place in an extra field, and FULL where they'd go.
    const extra = Buffer.alloc(options.big ? 28 : 0);
    if (options.big) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(packed.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(options.big ? 45 : 20, 4);
    entry.writeUInt16LE(options.big ? 45 : 20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(options.big ? FULL : packed.length, 20);
    entry.writeUInt32LE(options.big ? FULL : raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(extra.length, 30);
    entry.writeUInt32LE(options.big ? FULL : offset, 42);
    listed.push(entry, name, extra);
    offset += header.length + name.length + packed.length;
  }
  const list = Buffer.concat(listed);
  const tail: Buffer[] = [];
  if (options.big) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(files.length), 24);
    record.writeBigUInt64LE(BigInt(files.length), 32);
    record.writeBigUInt64LE(BigInt(list.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + list.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.big ? 0xffff : files.length, 8);
  end.writeUInt16LE(options.big ? 0xffff : files.length, 10);
  end.writeUInt32LE(options.big ? FULL : list.length, 12);
  end.writeUInt32LE(options.big ? FULL : offset, 16);
  return new Uint8Array(Buffer.concat([...parts, list, ...tail, end]));
}

/** Text as Facebook's download writes it: each byte of a letter outside plain English a character of its own. */
export const asFacebookWrites = (text: string): string =>
  String.fromCharCode(...Buffer.from(text, 'utf8'));
