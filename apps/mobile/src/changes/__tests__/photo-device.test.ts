import { File } from 'expo-file-system';
import { ImageManipulator } from 'expo-image-manipulator';

import { keepRecording } from '@/addons/realestate/recorder';
import { PIECE_BYTES } from '@/sync/kept-files';
import { keptStore, NoKeptFiles } from '@/sync/kept-store';
import { base64Of, keptPhotoUri } from '@/sync/kept-uri';
import { openMemoryKeptFiles } from '@/sync/__tests__/memory-kept-files';

import { devicePhotoTransport, keepLargeTestFile, keepPhoto, removePhoto } from '../photo-device';

/**
 * Photos and voice notes waiting to upload are kept encrypted (round seven): in the person's kept files, never as a
 * plain file on the phone. The one the camera or the recorder wrote is deleted once it's in; the upload reads it from
 * there, whole or 6 MB at a time; a waiting photo shows on screen from memory.
 */

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE_ELSE = '22222222-2222-4222-8222-222222222222';
const files = (jest.requireMock('expo-file-system') as { __files: Map<string, unknown> }).__files;

function bytes(length: number, start = 0): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (start + i) % 251;
  return out;
}
const same = (a: Uint8Array | null, b: Uint8Array) =>
  !!a && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

beforeEach(() => {
  files.clear();
  keptStore.closing(false);
});

describe('keeping what waits to upload', () => {
  it('keeps a photo encrypted and deletes the plain one the camera left', async () => {
    const kept = openMemoryKeptFiles(ME);
    const jpeg = bytes(300_000);
    new File('file:///cache/shrunk.jpg').write(jpeg);
    (ImageManipulator.manipulate as jest.Mock).mockReturnValue({
      resize: jest.fn(),
      renderAsync: async () => ({
        saveAsync: async () => ({ uri: 'file:///cache/shrunk.jpg', width: 2048, height: 1536 }),
      }),
    });
    const photo = await keepPhoto({
      userId: ME,
      fileId: 'f1',
      uri: 'file:///picked.heic',
      width: 4032,
      height: 3024,
    });
    expect(photo).toEqual({ localName: 'f1.jpg', sizeBytes: 300_000, width: 2048, height: 1536 });
    expect(same(kept.read('f1.jpg'), jpeg)).toBe(true);
    expect(files.has('file:///cache/shrunk.jpg')).toBe(false);
    // Shown on the tray from memory, never from a file.
    expect(keptPhotoUri(ME, 'f1.jpg')).toBe(`data:image/jpeg;base64,${base64Of(jpeg)}`);
    expect(keptPhotoUri(SOMEONE_ELSE, 'f1.jpg')).toBeNull();
  });

  it('keeps a voice note the same way', () => {
    const kept = openMemoryKeptFiles(ME);
    new File('file:///cache/recording.m4a').write(bytes(40_000));
    expect(keepRecording({ userId: ME, fileId: 'v1', uri: 'file:///cache/recording.m4a' })).toEqual(
      { localName: 'v1.m4a', sizeBytes: 40_000 },
    );
    expect(kept.info('v1.m4a')).toMatchObject({ kind: 'waiting', mimeType: 'audio/mp4' });
    expect(files.has('file:///cache/recording.m4a')).toBe(false);
  });

  it('refuses to keep anything while the person’s copy isn’t open, and leaves no plain file', () => {
    new File('file:///cache/recording.m4a').write(bytes(10));
    expect(() =>
      keepRecording({ userId: ME, fileId: 'v1', uri: 'file:///cache/recording.m4a' }),
    ).toThrow(NoKeptFiles);
    expect(files.has('file:///cache/recording.m4a')).toBe(false);
  });

  it('removes a photo that won’t be sent', () => {
    const kept = openMemoryKeptFiles(ME);
    kept.put('f1.jpg', 'waiting', bytes(10));
    removePhoto(ME, 'f1.jpg');
    expect(kept.info('f1.jpg')).toBeNull();
  });
});

describe('uploading from the kept files', () => {
  const transport = (fetch: typeof globalThis.fetch) =>
    devicePhotoTransport({ userId: () => ME, fetch, offline: () => false });

  it('sends a small photo whole, with its type', async () => {
    const kept = openMemoryKeptFiles(ME);
    kept.put('f1.jpg', 'waiting', bytes(5_000));
    const fetch = jest.fn(
      async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }),
    );
    const sent: number[] = [];
    const answer = await transport(fetch as never).uploadWhole(
      {
        url: 'https://storage/object/files/f1.jpg',
        headers: { authorization: 'Bearer t' },
        localName: 'f1.jpg',
        mimeType: 'image/jpeg',
      },
      (n) => sent.push(n),
    );
    expect(answer).toMatchObject({ reached: true, status: 200 });
    const init = fetch.mock.calls[0]![1];
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'image/jpeg', authorization: 'Bearer t' });
    expect(same(init.body as Uint8Array, bytes(5_000))).toBe(true);
    expect(sent).toEqual([5_000]);
  });

  it('reads a big one 6 MB at a time', () => {
    const kept = openMemoryKeptFiles(ME);
    const t = transport(jest.fn() as never);
    const big = keepLargeTestFile({
      userId: ME,
      fileId: 'big',
      sizeBytes: 3 * PIECE_BYTES + 7,
      randomBytes: (n) => bytes(n, 3),
    });
    expect(big.sizeBytes).toBe(3 * PIECE_BYTES + 7);
    expect(kept.has('big.jpg')).toBe(true);
    expect(t.exists('big.jpg')).toBe(true);
    // Each megabyte was made on its own, starting again at 3.
    expect(same(t.readPiece('big.jpg', PIECE_BYTES, 4), bytes(4, 3))).toBe(true);
    expect(t.readPiece('big.jpg', 3 * PIECE_BYTES, 6 * PIECE_BYTES).length).toBe(7);
    t.remove('big.jpg');
    expect(t.exists('big.jpg')).toBe(false);
  });
});
