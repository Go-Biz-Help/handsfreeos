import { FILE_WORDS, type FileOut } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';
import { Linking } from 'react-native';

import { toast } from '@/components/ui/toast';
import { signedUrl } from '@/inbox/storage';

import { FileRows } from '../files';

/**
 * Opening a file on a record's Files tab. A photo (a scanned business card, say) opens over the screen, inside the
 * app; a PDF opens with the phone. Either comes from Storage by a link made for the signed-in person, never from a
 * page of the web app: the phone used to send people to one that doesn't exist.
 */

jest.mock('@/inbox/storage', () => ({
  signedUrl: jest.fn(
    async (bucket: string, path: string) => `https://files.test/${bucket}/${path}`,
  ),
}));
jest.mock('@/changes/hooks', () => ({ usePhotoProgress: () => null }));

const card: FileOut = {
  id: 'f1',
  recordType: 'person',
  recordId: 'p1',
  bucket: 'attachments',
  objectPath: 'ws/person/p1/f1/Business card front.jpg',
  name: 'Business card front.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 165_000,
  isImage: true,
  locked: false,
  uploadedBy: { id: 'u1', fullName: 'Dale' },
  createdAt: '2026-11-18T05:19:00.000Z',
};
const estimate: FileOut = {
  ...card,
  id: 'f2',
  objectPath: 'ws/person/p1/f2/Estimate.pdf',
  name: 'Estimate.pdf',
  mimeType: 'application/pdf',
  isImage: false,
};

const link = signedUrl as jest.MockedFunction<typeof signedUrl>;
let openURL: jest.SpyInstance;
let refused: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  refused = jest.spyOn(toast, 'error').mockImplementation(() => 0);
});

test('a photo opens over the screen, from Storage, and closes back to the list', async () => {
  await render(<FileRows files={[card, estimate]} online />);
  expect(screen.queryByTestId('photo-viewer')).toBeNull();

  await fireEvent.press(screen.getByTestId('file-row-f1'));
  expect(await screen.findByTestId('photo-viewer')).toBeTruthy();
  expect(link).toHaveBeenCalledWith('attachments', 'ws/person/p1/f1/Business card front.jpg');
  expect(screen.getByRole('image', { name: 'Business card front.jpg' })).toBeTruthy();
  // Nothing goes out to the browser, and so never to a page of the web app.
  expect(openURL).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByTestId('photo-viewer-close'));
  await waitFor(() => expect(screen.queryByTestId('photo-viewer')).toBeNull());
});

test('a file that isn’t a photo opens with the phone, by its own link', async () => {
  await render(<FileRows files={[card, estimate]} online />);
  await fireEvent.press(screen.getByTestId('file-row-f2'));
  await waitFor(() =>
    expect(openURL).toHaveBeenCalledWith(
      'https://files.test/attachments/ws/person/p1/f2/Estimate.pdf',
    ),
  );
  expect(screen.queryByTestId('photo-viewer')).toBeNull();
});

test('says why when Storage won’t hand it over, with signal and without', async () => {
  link.mockResolvedValue(null);
  const view = await render(<FileRows files={[card]} online />);
  await fireEvent.press(screen.getByTestId('file-row-f1'));
  await waitFor(() => expect(refused).toHaveBeenCalledWith(FILE_WORDS.wontOpen));
  expect(screen.queryByTestId('photo-viewer')).toBeNull();

  await view.rerender(<FileRows files={[card]} online={false} />);
  await fireEvent.press(screen.getByTestId('file-row-f1'));
  await waitFor(() => expect(refused).toHaveBeenLastCalledWith(FILE_WORDS.needsSignal));
  expect(openURL).not.toHaveBeenCalled();
});
