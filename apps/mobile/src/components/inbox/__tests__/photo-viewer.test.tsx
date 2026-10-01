import type { MediaShape } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Sharing from 'expo-sharing';
import * as React from 'react';
import { Linking } from 'react-native';

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
