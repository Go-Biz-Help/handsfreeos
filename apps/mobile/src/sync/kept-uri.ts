import { keptStore } from './kept-store';

/**
 * A kept photo shown on screen while it waits to upload (the reply tray, a reply still waiting): read from the
 * person's kept files into a `data:` address, so it's never written to the phone as a plain file. The last few are
 * remembered, so a list scrolling doesn't read them again.
 */

const REMEMBERED = 12;
const remembered = new Map<string, string>();

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of any number of bytes, without building one huge string of characters first. */
export function base64Of(bytes: Uint8Array): string {
  const out: string[] = [];
  let line = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    line +=
      ALPHABET[a >> 2]! +
      ALPHABET[((a & 3) << 4) | (b >> 4)]! +
      (i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)]! : '=') +
      (i + 2 < bytes.length ? ALPHABET[c & 63]! : '=');
    if (line.length >= 8192) {
      out.push(line);
      line = '';
    }
  }
  out.push(line);
  return out.join('');
}

/** A kept photo as an address an image can show, or null when it isn't here (sent, or another person's). */
export function keptPhotoUri(userId: string, name: string, mimeType = 'image/jpeg'): string | null {
  const key = `${userId}/${name}`;
  const known = remembered.get(key);
  if (known) return known;
  const bytes = keptStore.current(userId)?.read(name);
  if (!bytes) return null;
  const uri = `data:${mimeType};base64,${base64Of(bytes)}`;
  remembered.set(key, uri);
  while (remembered.size > REMEMBERED) remembered.delete(remembered.keys().next().value!);
  return uri;
}

/** Forgets every remembered photo: the person's copy closed. */
export function forgetKeptPhotos(): void {
  remembered.clear();
}

keptStore.subscribe(() => {
  if (!keptStore.userId()) forgetKeptPhotos();
});
