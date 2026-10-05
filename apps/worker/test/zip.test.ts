/**
 * The zip the transaction export makes (src/files/zip.ts): read back here the way any unzip reads it, from the
 * central directory, so a file stored and a file deflated both come out byte for byte.
 */
import { randomBytes } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { makeZip, zipName } from '../src/files/zip';

function readZip(zip: Buffer): { name: string; data: Buffer; method: number }[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: { name: string; data: Buffer; method: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + packed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(size);
    expect(crc32(data) >>> 0).toBe(crc);
    out.push({ name, data, method });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return out;
}

describe('a transaction export’s zip', () => {
  it('holds every file byte for byte, deflating only what gets smaller', () => {
    const photo = randomBytes(20_000);
    const words = Buffer.from('Closing on Oct 30. '.repeat(500), 'utf8');
    const files = readZip(
      makeZip([
        { name: 'manifest.json', data: Buffer.from('{"format":"hfos.transaction-export"}') },
        { name: 'files/documents/Purchase contract (contract.pdf)', data: photo },
        { name: 'data/term_entries.json', data: words },
      ]),
    );
    expect(files.map((f) => f.name)).toEqual([
      'manifest.json',
      'files/documents/Purchase contract (contract.pdf)',
      'data/term_entries.json',
    ]);
    expect(files[1]!.data.equals(photo)).toBe(true);
    expect(files[1]!.method).toBe(0);
    expect(files[2]!.data.equals(words)).toBe(true);
    expect(files[2]!.method).toBe(8);
  });

  it('keeps names inside the zip, in UTF-8, and two of one name apart', () => {
    const files = readZip(
      makeZip([
        { name: '../../etc/passwd', data: Buffer.from('a') },
        { name: 'files/proof/Café “inspection”.pdf', data: Buffer.from('b') },
        { name: 'files/proof/Café “inspection”.pdf', data: Buffer.from('c') },
      ]),
    );
    expect(files.map((f) => f.name)).toEqual([
      'etc/passwd',
      'files/proof/Café “inspection”.pdf',
      'files/proof/Café “inspection” (2).pdf',
    ]);
    expect(zipName('a\\b/./c:d')).toBe('a/b/c_d');
  });
});
