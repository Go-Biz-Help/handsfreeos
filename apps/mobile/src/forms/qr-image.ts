import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { qrPng } from './qr';

/**
 * Saving a form's QR code (M17): the code as a PNG in the phone's cache, handed to the phone's own share sheet. From
 * there it is Save Image on an iPhone, or Files, Drive, Photos, a printer or a message, whichever the person wants.
 * Nothing is kept: the cache is the phone's to clear, and the next save writes the file again.
 *
 * The share sheet rather than straight into the photo library, on purpose: saving to Photos directly would need the
 * app to ask for access to the person's photos (and on Android, a storage permission the app has none of), for one
 * picture they can put there themselves in one more tap.
 */
export async function saveQrImage(link: string, name: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('This phone can’t save or share files.');
  const file = new File(Paths.cache, `${name.replace(/[^a-z0-9-]+/gi, '-') || 'form'}-qr.png`);
  if (file.exists) file.delete();
  file.create();
  file.write(qrPng(link));
  await Sharing.shareAsync(file.uri, {
    mimeType: 'image/png',
    UTI: 'public.png',
    dialogTitle: 'Save the QR code',
  });
}
