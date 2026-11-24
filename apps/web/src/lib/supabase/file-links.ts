import { supabaseBrowser } from './client';

/** Signs short-lived links for files in one bucket: a link for each path, in the paths' order, or null. */
export type SignFileLinks = (
  bucket: string,
  objectPaths: string[],
  seconds: number,
) => Promise<(string | null)[]>;

/** How long a link lasts, and how long before it ends a kept one is asked for again. */
export const FILE_LINK_SECONDS = 3600;
const SPARE_MS = 5 * 60_000;
/** Storage signs at most 1,000 files a request; a screen's worth is far under this. */
const AT_ONCE = 100;

/** From the person's own storage session: they get a link only to a file they may read. */
const signWithStorage: SignFileLinks = async (bucket, objectPaths, seconds) => {
  const { data } = await supabaseBrowser().storage.from(bucket).createSignedUrls(objectPaths, seconds);
  return objectPaths.map((_, i) => data?.[i]?.signedUrl ?? null);
};

/**
 * Short-lived links to a person's files, kept while they last and asked for together.
 *
 * A list of pictures used to ask for a link a picture, every time it was drawn: 75 requests, about a second each in
 * line, for one open of the Content Creator's Calendar, which draws again whenever a post changes. And a new link is
 * a new address, so the browser fetched every picture again as well, about 8 MB (speed audit, Nov 2026). Here every
 * file asked for in the same turn is signed in one request, and a link is handed out again until five minutes before
 * it ends: the same address, so the browser shows the copy it has (storage lets it keep one for the hour).
 *
 * `fresh` skips the kept link, for something read for as long as it's used (a video being played).
 */
export function fileLinkKeeper(sign: SignFileLinks = signWithStorage, now: () => number = Date.now) {
  const kept = new Map<string, { url: Promise<string | null>; until: number }>();
  /** What's been asked for this turn, by bucket, waiting for the one request. */
  const asked = new Map<string, Map<string, (url: string | null) => void>>();

  const signAsked = () => {
    const batches = [...asked];
    asked.clear();
    for (const [bucket, waiting] of batches) {
      const all = [...waiting.keys()];
      for (let from = 0; from < all.length; from += AT_ONCE) {
        const paths = all.slice(from, from + AT_ONCE);
        const tell = (urls: (string | null)[]) =>
          paths.forEach((path, i) => waiting.get(path)!(urls[i] ?? null));
        sign(bucket, paths, FILE_LINK_SECONDS).then(tell, () => tell([]));
      }
    }
  };

  return function fileLink(bucket: string, objectPath: string, fresh = false) {
    const key = `${bucket}\n${objectPath}`;
    const have = kept.get(key);
    if (!fresh && have && have.until > now()) return have.url;
    const url = new Promise<string | null>((resolve) => {
      if (asked.size === 0) queueMicrotask(signAsked);
      const waiting = asked.get(bucket) ?? new Map<string, (url: string | null) => void>();
      asked.set(bucket, waiting);
      // The same file asked for twice in a turn (a fresh one beside a kept one) gets the one answer.
      const before = waiting.get(objectPath);
      waiting.set(objectPath, (made) => {
        before?.(made);
        resolve(made);
      });
    });
    kept.set(key, { url, until: now() + FILE_LINK_SECONDS * 1000 - SPARE_MS });
    // One that couldn't be made is asked for again next time.
    void url.then((made) => {
      if (!made && kept.get(key)?.url === url) kept.delete(key);
    });
    return url;
  };
}

/** This tab's links. */
export const fileLink = fileLinkKeeper();
