import { documentName, PIECE_BYTES } from '../kept-files';

import { memoryKeptFiles } from './memory-kept-files';

/**
 * The phone's store of files (round seven): kept in 1 MB pieces in a second encrypted database, so an upload reads
 * a 6 MB piece without the whole file, a download writes as it arrives, and nothing is a plain file on the phone.
 * On real SQLite, as the phone runs it (SQLCipher is SQLite with its pages encrypted).
 */

const store = memoryKeptFiles;

/** Bytes that say where they are, so a wrong offset shows. */
function bytes(length: number, start = 0): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (start + i) % 251;
  return out;
}

/** The same bytes (jest's deep equality walks a megabyte one byte at a time). */
const same = (a: Uint8Array | null, b: Uint8Array) =>
  !!a && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

describe('keeping a file', () => {
  it('keeps a photo whole and gives it back', () => {
    const { kept } = store();
    const photo = bytes(700_000);
    kept.put('f1.jpg', 'waiting', photo, { mimeType: 'image/jpeg' });
    expect(kept.has('f1.jpg')).toBe(true);
    expect(same(kept.read('f1.jpg'), photo)).toBe(true);
    expect(kept.info('f1.jpg')).toMatchObject({
      kind: 'waiting',
      sizeBytes: 700_000,
      mimeType: 'image/jpeg',
      complete: true,
    });
  });

  it('keeps a big one in pieces, and reads any range across them', () => {
    const { kept, sqlite } = store();
    const size = 2 * PIECE_BYTES + 12_345;
    kept.put('big.jpg', 'waiting', bytes(size));
    const pieces = sqlite.prepare('SELECT count(*) AS n FROM kept_pieces').get() as { n: number };
    expect(pieces.n).toBe(3);
    // Across the first boundary, and running off the end.
    expect(same(kept.readRange('big.jpg', PIECE_BYTES - 10, 20), bytes(20, PIECE_BYTES - 10))).toBe(
      true,
    );
    expect(same(kept.readRange('big.jpg', size - 5, 100), bytes(5, size - 5))).toBe(true);
    expect(kept.read('big.jpg')!.length).toBe(size);
  });

  it('keeps a download as its pieces arrive, complete only once every byte is here', () => {
    const { kept } = store();
    const size = PIECE_BYTES + 500;
    const name = documentName('d1');
    kept.begin(name, 'document', size, { fileId: 'd1', fileName: 'Offer.pdf' });
    expect(kept.has(name)).toBe(false);
    expect(kept.read(name)).toBeNull();
    kept.append(name, 0, bytes(PIECE_BYTES));
    expect(kept.storedBytes(name)).toBe(PIECE_BYTES);
    expect(kept.has(name)).toBe(false);
    kept.append(name, PIECE_BYTES, bytes(500, PIECE_BYTES));
    expect(kept.has(name)).toBe(true);
    expect(same(kept.read(name), bytes(size))).toBe(true);
    expect(() => kept.append(name, 10, bytes(1))).toThrow();
  });

  it('remembers a file to keep before any of it is here, never as complete', () => {
    const { kept } = store();
    kept.reserve(documentName('p'), 'document', { fileId: 'p', pinned: true });
    expect(kept.info(documentName('p'))).toMatchObject({ complete: false, pinned: true });
    expect(kept.read(documentName('p'))).toBeNull();
  });

  it('starting again throws away what was there', () => {
    const { kept } = store();
    kept.put('a', 'document', bytes(10));
    kept.begin('a', 'document', 20);
    expect(kept.storedBytes('a')).toBe(0);
  });
});

describe('what the store holds', () => {
  it('counts documents’ bytes, keeps pins, and removes a kind at once', () => {
    let now = 1_000;
    const { kept } = store(() => now);
    kept.put(documentName('a'), 'document', bytes(100));
    now = 2_000;
    kept.put(documentName('b'), 'document', bytes(50), { pinned: true });
    kept.begin(documentName('c'), 'document', 999);
    kept.put('p.jpg', 'waiting', bytes(70));
    expect(kept.usedBytes('document')).toBe(150);

    kept.touch(documentName('a'));
    expect(kept.info(documentName('a'))!.openedAt).toBe(2_000);
    expect(kept.info(documentName('b'))!.pinned).toBe(true);
    kept.setPinned(documentName('b'), false);
    expect(kept.info(documentName('b'))!.pinned).toBe(false);

    expect(kept.removeKind('document')).toBe(3);
    expect(kept.list().map((f) => f.name)).toEqual(['p.jpg']);
  });

  it('removes a file with its pieces', () => {
    const { kept, sqlite } = store();
    kept.put('x', 'waiting', bytes(PIECE_BYTES * 2));
    kept.remove('x');
    expect(kept.info('x')).toBeNull();
    expect(sqlite.prepare('SELECT count(*) AS n FROM kept_pieces').get()).toEqual({ n: 0 });
  });
});
