/**
 * A look at a post before its comment is drafted (docs/outreach.md, decision 166; the owner's pick of 14 Nov 2026:
 * "the AI looks at the photo, or a frame of the video, before it comments"). Until 0.140.0 a comment was written
 * from a post's words alone, so one whose words lean on its picture or its video ("It be like that 😂") got a comment
 * about nothing in it, or none.
 *
 * In the tab, on the post's own page, in the post's own part of it (the site says which, `auto.postPart`):
 *
 * - **Which picture is the post's** (`postMediaIn`): the biggest picture or video drawn there. Never a small one (the
 *   faces beside names), and never one the site rules out (a tile that opens another post).
 * - **A photo** is handed back as its address only: the background fetches it from the network's own picture
 *   servers and makes it small (../auto/post-look.ts). Nothing is drawn here, as a page can't read a picture from
 *   another server.
 * - **A video** gives up to three frames, drawn here from the page's own player as it plays: where it is now, then
 *   two fifths and four fifths of the way through, and it's put back where it was. A player that can't be read
 *   (its file comes from another server) gives its poster's address instead, or the picture drawn over it.
 *
 * Nothing is pressed, nothing is shown, and nothing is kept: what this gives goes with the draft's request and is
 * gone. Anything that doesn't work gives null, and the comment is written from the words as before.
 */

/** What the runner wants of a post: how many pictures at most, how wide a frame, and how big each may be in base64. */
export interface LookWant {
  readonly most: number;
  readonly width: number;
  readonly chars: number;
}

/**
 * What the tab gives of a post: a photo's address; or a video's frames, with a picture's address to use in their
 * place when none could be drawn (`poster`).
 */
export type PostSeen =
  | { readonly kind: 'photo'; readonly url: string }
  | { readonly kind: 'video'; readonly jpegs: readonly string[]; readonly poster: string | null };

type Media = HTMLImageElement | HTMLVideoElement;

/** A post's own picture is never this small: faces beside names, icons and stickers are. */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
/** A frame this small as a JPEG is one colour: a black screen, or nothing drawn yet. */
const BLANK_CHARS = 3_500;
/** How long a player gets to have something to draw, and to get to a moment asked for. */
const LOADED_MS = 3_000;
const SEEK_MS = 4_000;

/** How big something is drawn; what its own attributes say when the page hasn't laid it out. */
function sizeOf(el: Element): { readonly width: number; readonly height: number } {
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };
  return {
    width: Number(el.getAttribute('width')) || 0,
    height: Number(el.getAttribute('height')) || 0,
  };
}

const bigEnough = (el: Element): boolean => {
  const { width, height } = sizeOf(el);
  return width >= MIN_WIDTH && height >= MIN_HEIGHT;
};

/** A picture's address, whole, when it's one a server gives (never one made up in the page). */
function addressOf(doc: Document, src: string | null | undefined): string | null {
  if (!src) return null;
  try {
    const url = new URL(src, doc.baseURI);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The post's own picture or video in its part of the page: the biggest one drawn there, a video before a picture of
 * the same size (its cover is drawn over it), the first of a few the same size (the one showing of several to swipe
 * through). Null with none big enough.
 */
export function postMediaIn(root: Element, skip: (el: Element) => boolean): Media | null {
  let best: { el: Media; area: number; video: boolean } | null = null;
  for (const el of root.querySelectorAll<Media>('video, img')) {
    if (!bigEnough(el) || skip(el)) continue;
    const { width, height } = sizeOf(el);
    const video = el.tagName === 'VIDEO';
    const area = width * height;
    if (!best || area > best.area * 1.05 || (video && !best.video && area >= best.area * 0.8))
      best = { el, area, video };
  }
  return best?.el ?? null;
}

/** One try at a frame: the JPEG, or why there's none. */
export type Frame = { readonly jpeg: string } | { readonly no: 'unready' | 'unreadable' | 'blank' };

/** Draws what a player shows now, as a JPEG in base64, `width` wide at most. */
export type FrameDrawer = (video: HTMLVideoElement, want: LookWant) => Frame;

/** The page's own drawing: a canvas, never shown. A player whose file is another server's can't be read. */
export const drawFrame: FrameDrawer = (video, want) => {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return { no: 'unready' };
  const scale = Math.min(1, want.width / video.videoWidth);
  const canvas = video.ownerDocument.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const draw = canvas.getContext('2d');
  if (!draw) return { no: 'unreadable' };
  try {
    draw.drawImage(video, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.72, 0.5, 0.35]) {
      const jpeg = canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? '';
      if (jpeg && jpeg.length <= want.chars)
        return jpeg.length < BLANK_CHARS ? { no: 'blank' } : { jpeg };
    }
    return { no: 'unreadable' };
  } catch {
    return { no: 'unreadable' };
  }
};

/** Waits for one of a player's events; false when it doesn't come. */
function once(video: HTMLVideoElement, event: string, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const heard = () => {
      clearTimeout(timer);
      done(true);
    };
    const timer = setTimeout(() => {
      video.removeEventListener(event, heard);
      done(false);
    }, ms);
    video.addEventListener(event, heard, { once: true });
  });
}

/** Moves a player to a moment; whether it got there. */
async function seekTo(video: HTMLVideoElement, at: number): Promise<boolean> {
  if (Math.abs(video.currentTime - at) < 0.05) return true;
  const there = once(video, 'seeked', SEEK_MS);
  try {
    video.currentTime = at;
  } catch {
    return false;
  }
  return there;
}

/**
 * Up to `most` frames of the page's own player: where it is now, then further through, and back where it was. None
 * from a player that can't be read, or that never had anything to draw.
 */
async function framesOf(
  video: HTMLVideoElement,
  want: LookWant,
  draw: FrameDrawer,
): Promise<string[]> {
  let first = draw(video, want);
  if ('no' in first && first.no === 'unready') {
    await once(video, 'loadeddata', LOADED_MS);
    first = draw(video, want);
  }
  // Another server's file can't be read at any moment, and one never loaded has no other moment to go to.
  if ('no' in first && first.no !== 'blank') return [];
  const frames = 'jpeg' in first ? [first.jpeg] : [];
  const length = video.duration;
  if (!Number.isFinite(length) || length < 3) return frames;
  const was = video.currentTime;
  const paused = video.paused;
  for (const part of [0.4, 0.8]) {
    if (frames.length >= want.most) break;
    if (!(await seekTo(video, length * part))) break;
    const frame = draw(video, want);
    if ('jpeg' in frame && !frames.includes(frame.jpeg)) frames.push(frame.jpeg);
  }
  await seekTo(video, was);
  // A player that was playing goes on playing: moving it may have stopped it.
  if (!paused && video.paused) void video.play().catch(() => undefined);
  return frames;
}

/**
 * The post as anyone who opens it sees it, from its own part of the page: its photo's address, or its video's frames.
 * Null when it has no picture big enough, or none that can be handed over.
 */
export async function seePost(
  root: Element,
  want: LookWant,
  options: { readonly skip?: (el: Element) => boolean; readonly draw?: FrameDrawer } = {},
): Promise<PostSeen | null> {
  const skip = options.skip ?? (() => false);
  const media = postMediaIn(root, skip);
  if (!media) return null;
  const doc = root.ownerDocument;
  if (media.tagName !== 'VIDEO') {
    const img = media as HTMLImageElement;
    const url = addressOf(doc, img.currentSrc || img.getAttribute('src'));
    return url ? { kind: 'photo', url } : null;
  }
  const video = media as HTMLVideoElement;
  const jpegs = await framesOf(video, want, options.draw ?? drawFrame).catch(() => []);
  if (jpegs.length) return { kind: 'video', jpegs: jpegs.slice(0, want.most), poster: null };
  // No frame: its poster, else the picture the page draws over it (its cover), the biggest left in the post's part.
  const cover = [...root.querySelectorAll<HTMLImageElement>('img')]
    .filter((img) => bigEnough(img) && !skip(img))
    .sort((a, b) => sizeOf(b).width * sizeOf(b).height - sizeOf(a).width * sizeOf(a).height)[0];
  const poster =
    addressOf(doc, video.getAttribute('poster')) ??
    addressOf(doc, cover ? cover.currentSrc || cover.getAttribute('src') : null);
  return poster ? { kind: 'video', jpegs: [], poster } : null;
}
