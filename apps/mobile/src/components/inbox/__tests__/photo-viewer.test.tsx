import type { MediaShape } from '@hfos/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Sharing from 'expo-sharing';
import * as React from 'react';
import { Linking, Platform } from 'react-native';

import { MediaThumb } from '@/components/inbox/thread-items';

/**
 * A photo in a text opens full screen inside the app, as the phone's Messages app shows one, rather than going out to
 * the browser. Share passes it to the share sheet (Save Image); a file that isn't a photo still opens with the phone.
 */

// Pictures load through signed links: here, one made up from where the picture is kept.
jest.mock('@/inbox/storage', () => ({
  useSignedUrl: (bucket: string | null, path: string | null) =>
    bucket && path ? `https://files.test/${path}` : null,
  signedUrl: jest.fn(async (_bucket: string, path: string) => `https://files.test/${path}`),
}));
// The thread's voicemail player plays audio, which has nothing to do with photos and no player in a test.
jest.mock('@/components/inbox/voicemail-player', () => ({ VoicemailPlayer: () => null }));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
// The stand-in file system (jest.setup.ts) downloads nothing: the photo lands where it was asked to.
const fs = jest.requireMock('expo-file-system') as { File: { downloadFileAsync?: jest.Mock } };
fs.File.downloadFileAsync = jest.fn(async (_url: string, to: { uri: string }) => to);

const photo: MediaShape = {
  bucket: 'attachments',
  objectPath: 'ws/p/IMG_2041.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 900,
  name: 'IMG_2041.jpg',
};

let openURL: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

test('a photo opens full screen in the app, not in the browser, and closes back to the thread', async () => {
  await render(<MediaThumb media={photo} />);
  expect(screen.queryByTestId('photo-viewer')).toBeNull();

  await fireEvent.press(screen.getByTestId('media-thumb'));
  expect(await screen.findByTestId('photo-viewer')).toBeTruthy();
  expect(screen.getByRole('image', { name: 'IMG_2041.jpg' })).toBeTruthy();
  expect(openURL).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByTestId('photo-viewer-close'));
  await waitFor(() => expect(screen.queryByTestId('photo-viewer')).toBeNull());
});

test('Share hands the photo to the share sheet', async () => {
  await render(<MediaThumb media={photo} />);
  await fireEvent.press(screen.getByTestId('media-thumb'));
  await fireEvent.press(await screen.findByTestId('photo-viewer-share'));

  await waitFor(() =>
    expect(Sharing.shareAsync).toHaveBeenCalledWith(
      'file:///cache/IMG_2041.jpg',
      expect.objectContaining({ mimeType: 'image/jpeg' }),
    ),
  );
  expect(fs.File.downloadFileAsync).toHaveBeenCalledWith(
    'https://files.test/ws/p/IMG_2041.jpg',
    expect.anything(),
    { idempotent: true },
  );
});

test('a file that isn’t a photo still opens with the phone', async () => {
  await render(
    <MediaThumb
      media={{
        ...photo,
        objectPath: 'ws/p/estimate.pdf',
        contentType: 'application/pdf',
        name: 'estimate.pdf',
      }}
    />,
  );
  await fireEvent.press(screen.getByTestId('media-thumb'));

  await waitFor(() => expect(openURL).toHaveBeenCalledWith('https://files.test/ws/p/estimate.pdf'));
  expect(screen.queryByTestId('photo-viewer')).toBeNull();
});

describe('on Android, where the photo follows the fingers itself', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
  });

  // What the responder system hands a gesture: where each finger is now, and where it was a moment ago.
  let clock = 0;
  const fingers = (now: [number, number][], before: [number, number][] = now) => {
    clock += 16;
    return {
      nativeEvent: { touches: now.map(([pageX, pageY]) => ({ pageX, pageY })) },
      touchHistory: {
        numberActiveTouches: now.length,
        indexOfSingleActiveTouch: 0,
        mostRecentTimeStamp: clock,
        touchBank: now.map(([x, y], i) => ({
          touchActive: true,
          startPageX: before[i]![0],
          startPageY: before[i]![1],
          startTimeStamp: clock - 16,
          currentPageX: x,
          currentPageY: y,
          currentTimeStamp: clock,
          previousPageX: before[i]![0],
          previousPageY: before[i]![1],
          previousTimeStamp: clock - 16,
        })),
      },
    };
  };

  async function openPhoto() {
    await render(<MediaThumb media={photo} />);
    await fireEvent.press(screen.getByTestId('media-thumb'));
    const area = await screen.findByTestId('photo-viewer-photo');
    await fireEvent(area, 'layout', { nativeEvent: { layout: { width: 400, height: 800 } } });
    return area;
  }
  const scaleNow = () => {
    const style = [screen.getByTestId('photo-viewer-zoom').props.style].flat(9);
    const transform = style.find((s) => s?.transform)?.transform as Record<string, number>[];
    return transform.find((t) => 'scale' in t)!.scale;
  };

  test('two fingers spreading zoom the photo in', async () => {
    const area = await openPhoto();
    expect(scaleNow()).toBe(1);
    await fireEvent(
      area,
      'responderGrant',
      fingers([
        [150, 400],
        [250, 400],
      ]),
    );
    await fireEvent(
      area,
      'responderMove',
      fingers(
        [
          [100, 400],
          [300, 400],
        ],
        [
          [150, 400],
          [250, 400],
        ],
      ),
    );
    expect(scaleNow()).toBe(2);
    await fireEvent(area, 'responderRelease', fingers([]));
    expect(scaleNow()).toBe(2);
  });

  // Longer than a single tap waits to be sure it isn't a double one, and than the zoom and swipe animations.
  const settle = () => act(() => new Promise<void>((done) => setTimeout(done, 450)));
  const tap = async (area: ReturnType<typeof screen.getByTestId>) => {
    await fireEvent(area, 'responderGrant', fingers([[200, 300]]));
    await fireEvent(area, 'responderRelease', fingers([]));
  };
  const dragDown = async (area: ReturnType<typeof screen.getByTestId>) => {
    await fireEvent(area, 'responderGrant', fingers([[200, 300]]));
    await fireEvent(area, 'responderMove', fingers([[200, 340]], [[200, 300]]));
    await fireEvent(area, 'responderMove', fingers([[200, 560]], [[200, 340]]));
    await fireEvent(area, 'responderRelease', fingers([]));
    await settle();
  };

  test('a single tap hides the buttons', async () => {
    const area = await openPhoto();
    await tap(area);
    await settle();
    expect(screen.queryByTestId('photo-viewer-close')).toBeNull();
  });

  test('dragging an unzoomed photo down puts it away', async () => {
    await dragDown(await openPhoto());
    expect(screen.queryByTestId('photo-viewer')).toBeNull();
  });

  test('a double tap zooms in, so a drag looks round the photo; another double tap zooms back out', async () => {
    const area = await openPhoto();
    await tap(area);
    await tap(area);
    await settle();
    // Two taps zoom rather than hiding the buttons.
    expect(screen.getByTestId('photo-viewer-close')).toBeTruthy();
    await dragDown(area);
    expect(screen.getByTestId('photo-viewer')).toBeTruthy();

    await tap(area);
    await tap(area);
    await settle();
    await dragDown(area);
    expect(screen.queryByTestId('photo-viewer')).toBeNull();
  });
});
