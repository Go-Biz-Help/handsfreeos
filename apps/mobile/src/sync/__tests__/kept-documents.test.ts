import { ADDON_CATALOG } from '@hfos/core';

import {
  downloadInto,
  filesAskedFor,
  keepDocuments,
  planKept,
  type FetchRange,
  type FileRow,
  type KeeperDeps,
  type PhoneRow,
  type WantedFile,
} from '../kept-documents';
import { documentName, PIECE_BYTES, type KeptFiles } from '../kept-files';

import { memoryKeptFiles } from './memory-kept-files';

/**
 * Documents on the phone (round seven): each current document on the deals the person works, downloaded on Wi-Fi a
 * few megabytes at a time, a signed one checked against its fingerprint, up to 1 GB with pins first, and let go when
 * its deal leaves the phone or it's replaced.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MB = 1024 * 1024;

const doc = (fileId: string, status: string): PhoneRow => ({
  workspace_id: WS,
  addon_id: 'realestate',
  source: 'documents',
  data: JSON.stringify({ file_id: fileId, status, title: fileId }),
});
const fileRow = (id: string, size: number, locked = false): FileRow => ({
  id,
  workspace_id: WS,
  bucket: 'files',
  object_path: `${WS}/${id}.pdf`,
  name: `${id}.pdf`,
  mime_type: 'application/pdf',
  size_bytes: size,
  status: 'ready',
  locked_at: locked ? '2026-10-01T00:00:00Z' : null,
});
const wanted = (id: string, size: number, locked = false): WantedFile => ({
  workspaceId: WS,
  fileId: id,
  bucket: 'files',
  objectPath: `${WS}/${id}.pdf`,
  sizeBytes: size,
  mimeType: 'application/pdf',
  fileName: `${id}.pdf`,
  locked,
});

function bytes(length: number, start = 0): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (start + i) % 251;
  return out;
}

/** Storage: answers ranges of each file's bytes, counting the requests. */
function storage(files: Record<string, Uint8Array>, opts: { ignoreRange?: boolean } = {}) {
  const asked: { path: string; start: number; end: number }[] = [];
  const fetchRange: FetchRange = async (url, start, end) => {
    const path = url.replace('signed:', '');
    asked.push({ path, start, end });
    const all = files[path];
    if (!all) return { status: 404, bytes: new Uint8Array() };
    if (opts.ignoreRange) return { status: 200, bytes: all };
    return { status: 206, bytes: all.subarray(start, end + 1) };
  };
  return { fetchRange, asked, signedUrl: async (_b: string, p: string) => `signed:${p}` };
}

describe('which documents the phone keeps', () => {
  it('keeps current documents, and knows of replaced and void ones only for pins', () => {
    const { wanted: w, present } = filesAskedFor(
      ADDON_CATALOG,
      [doc('a', 'signed'), doc('b', 'superseded'), doc('c', 'void'), doc('d', 'draft')],
      [fileRow('a', 10), fileRow('b', 10), fileRow('c', 10), fileRow('d', 10)],
    );
    expect(w.map((f) => f.fileId)).toEqual(['a', 'd']);
    expect([...present.keys()]).toEqual(['a', 'b', 'c', 'd']);
  });

  it('skips a file still uploading, one in another business, and rows no add-on keeps files for', () => {
    const uploading = { ...fileRow('a', 10), status: 'pending' };
    const elsewhere = { ...fileRow('b', 10), workspace_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const { wanted: w } = filesAskedFor(
      ADDON_CATALOG,
      [doc('a', 'signed'), doc('b', 'signed'), { ...doc('c', 'signed'), source: 'duties' }],
      [uploading, elsewhere, fileRow('c', 10)],
    );
    expect(w).toEqual([]);
  });
});

describe('keeping to the limit', () => {
  const k = (
    fileId: string,
    size: number,
    at: { kept: number; opened?: number; pinned?: boolean },
  ) => ({
    name: documentName(fileId),
    kind: 'document' as const,
    workspaceId: WS,
    fileId,
    sizeBytes: size,
    mimeType: null,
    fileName: null,
    complete: true,
    pinned: at.pinned ?? false,
    openedAt: at.opened ?? null,
    keptAt: at.kept,
  });

  it('downloads what’s missing and lets go of what the rows no longer ask for', () => {
    const plan = planKept({
      wanted: [wanted('a', 10), wanted('b', 10)],
      present: new Map([
        ['a', wanted('a', 10)],
        ['b', wanted('b', 10)],
      ]),
      kept: [k('a', 10, { kept: 1 }), k('gone', 10, { kept: 1 })],
    });
    expect(plan.download.map((f) => f.fileId)).toEqual(['b']);
    expect(plan.remove).toEqual([documentName('gone')]);
  });

  it('keeps a pinned one while its deal is on the phone, and lets it go with the deal', () => {
    const old = wanted('old', 10);
    const pinned = k('old', 10, { kept: 1, pinned: true });
    expect(
      planKept({ wanted: [], present: new Map([['old', old]]), kept: [pinned] }).remove,
    ).toEqual([]);
    expect(planKept({ wanted: [], present: new Map(), kept: [pinned] }).remove).toEqual([
      documentName('old'),
    ]);
  });

  it('keeps pins, then new documents, then the most recently opened, within the limit', () => {
    const plan = planKept({
      wanted: [wanted('opened', 40), wanted('stale', 40), wanted('new', 40)],
      present: new Map([['pin', wanted('pin', 50)]]),
      kept: [
        k('pin', 50, { kept: 1, pinned: true }),
        k('opened', 40, { kept: 1, opened: 500 }),
        k('stale', 40, { kept: 2 }),
      ],
      limitBytes: 130,
    });
    // 50 pinned + 40 new + 40 opened = 130; the one nobody opened goes.
    expect(plan.download.map((f) => f.fileId)).toEqual(['new']);
    expect(plan.remove).toEqual([documentName('stale')]);
  });
});

describe('downloading', () => {
  it('asks for a few megabytes at a time and carries on where it stopped', async () => {
    const { kept } = memoryKeptFiles();
    const size = 9 * MB + 3;
    const file = wanted('big', size);
    const s = storage({ [file.objectPath]: bytes(size) });
    let allowed = 2;
    const deps = { ...s, mayDownload: () => allowed-- > 0 };
    expect(await downloadInto(kept, file, deps)).toBe('later');
    expect(kept.storedBytes(documentName('big'))).toBe(8 * MB);
    allowed = 5;
    expect(await downloadInto(kept, file, deps)).toBe('kept');
    expect(s.asked.map((a) => a.start)).toEqual([0, 4 * MB, 8 * MB]);
    expect(kept.read(documentName('big'))!.length).toBe(size);
  });

  it('keeps only what it asked for when Storage sends the whole file', async () => {
    const { kept } = memoryKeptFiles();
    const file = wanted('small', PIECE_BYTES / 2);
    const s = storage({ [file.objectPath]: bytes(PIECE_BYTES / 2) }, { ignoreRange: true });
    expect(await downloadInto(kept, file, { ...s, mayDownload: () => true })).toBe('kept');
  });
});

describe('keeping documents', () => {
  function deps(kept: KeptFiles, overrides: Partial<KeeperDeps> = {}): KeeperDeps {
    const signed = bytes(2_000);
    const plain = bytes(1_000, 7);
    const s = storage({ [`${WS}/signed.pdf`]: signed, [`${WS}/plain.pdf`]: plain });
    return {
      kept: () => kept,
      read: async () => ({
        rows: [doc('signed', 'signed'), doc('plain', 'draft')],
        files: [fileRow('signed', 2_000, true), fileRow('plain', 1_000)],
      }),
      catalog: ADDON_CATALOG,
      mayDownload: () => true,
      signedUrl: s.signedUrl,
      fetchRange: s.fetchRange,
      fingerprints: async () => new Map([['signed', 'right']]),
      sha256: async (b) => (b.length === 2_000 ? 'right' : 'other'),
      ...overrides,
    };
  }

  it('keeps a signed document that matches its fingerprint', async () => {
    const { kept } = memoryKeptFiles();
    expect(await keepDocuments(deps(kept))).toEqual({ kept: 2, removed: 0, waiting: 0 });
    expect(kept.has(documentName('signed'))).toBe(true);
  });

  it('throws away a signed document that doesn’t match, and waits on one not yet fingerprinted', async () => {
    const { kept } = memoryKeptFiles();
    await keepDocuments(deps(kept, { sha256: async () => 'other' }));
    expect(kept.info(documentName('signed'))).toBeNull();
    expect(
      await keepDocuments(deps(kept, { fingerprints: async () => new Map([['signed', null]]) })),
    ).toMatchObject({ waiting: 1 });
    expect(kept.info(documentName('signed'))).toBeNull();
    expect(kept.has(documentName('plain'))).toBe(true);
  });

  it('downloads nothing off Wi-Fi unless allowed, and still lets go of what isn’t asked for', async () => {
    const { kept } = memoryKeptFiles();
    kept.put(documentName('gone'), 'document', bytes(5), { fileId: 'gone' });
    expect(await keepDocuments(deps(kept, { mayDownload: () => false }))).toEqual({
      kept: 0,
      removed: 1,
      waiting: 2,
    });
  });
});
