/**
 * A zip file made in memory, for the transaction export (Real Estate round six, step 10). Node has what a zip needs
 * (raw deflate and CRC-32, `zlib.crc32` from 22.2), so this is the format and nothing else: no library to pin.
 *
 * - **Plain zip**, no Zip64: an export is refused well before 4 GB (200 MB), and a zip holds 65,535 entries.
 * - **Deflated** where it saves room, **stored** where it doesn't (PDFs and photos are compressed already).
 * - **Names are UTF-8** (general purpose bit 11), with folders written as `a/b.json`.
 * - **Times** are each entry's own, as the DOS time a zip keeps (2-second steps, local to nobody: UTC).
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly at?: Date;
}

const MAX_ENTRIES = 65_535;
const MAX_BYTES = 0xffff_fffe;

function dosTime(at: Date): { time: number; date: number } {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/** A safe name inside the zip: forward slashes, no leading slash, no `..`, no control characters. */
export function zipName(name: string): string {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .map((part) =>
      Array.from(part, (c) => (c.charCodeAt(0) < 32 || '<>:"|?*'.includes(c) ? '_' : c))
        .join('')
        .trim(),
    )
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
    .slice(0, 400);
}

export function makeZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > MAX_ENTRIES) throw new Error('too many files for one zip');
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    let name = zipName(e.name) || 'file';
    // Two files of one name: the second gets " (2)" before its extension.
    for (let n = 2; seen.has(name); n++)
      name = zipName(e.name).replace(/(\.[^./]+)?$/, ` (${n})$1`);
    seen.add(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(e.data) >>> 0;
    const deflated = deflateRawSync(e.data, { level: 6 });
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    if (body.length > MAX_BYTES || e.data.length > MAX_BYTES || offset > MAX_BYTES)
      throw new Error('too big for one zip');
    const { time, date } = dosTime(e.at ?? new Date());
    const method = stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}
