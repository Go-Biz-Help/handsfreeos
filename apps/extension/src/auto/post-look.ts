/**
 * The background's half of a look at a post before its comment is drafted (docs/outreach.md, decision 166, from
 * 0.140.0; the tab's half is ../networks/post-look.ts). The runner has the post's own page open; the tab says what
 * the post shows (on every network from 0.144.0, decision 172):
 *
 * - **A photo's address**, fetched here from the network's own picture servers and nowhere else (`PICTURE_HOSTS`),
 *   with no cookies, and made small: a JPEG about 768 wide. A page can't read a picture from another server, and the
 *   background can only from the hosts the extension was given (each network's, in the manifest).
 * - **A video's frames**, as the tab drew them; with none, its poster or cover, fetched the same way.
 *
 * What comes of it goes with the draft's request (`hfos-draft`, core's `PostLook`) and is kept nowhere: not on the
 * computer, not in HandsFreeOS. Nothing here stops a comment: whatever doesn't work gives null, and the comment is
 * written from the post's words as it always was.
 */
import {
  POST_FRAME_WIDTH,
  POST_PHOTO_WIDTH,
  POST_PICTURE_CHARS,
  POST_PICTURES_MOST,
} from '@hfos/core/addons/outreach/comment-says';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { PostLook } from '@hfos/core/addons/outreach/today';
import type { PostLookAnswer, PostLookAsk } from '../messages';
import type { ProfileRef } from '../networks/facebook/types';

/** Meta's picture servers, for Instagram's and Threads' posts. */
const META_PICTURES = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/;

/**
 * Where each network keeps its posts' pictures: the only hosts one is fetched from. A network that isn't here is never
 * looked at (`looksAtPosts`), and its comments are written from the post's words. The manifest gives the extension
 * these hosts (scripts/build.mjs). Instagram's from 0.140.0 (decision 166), every other network's from 0.144.0
 * (decision 172): Alignable's only from its own addresses, so a picture it keeps anywhere else isn't looked at.
 */
const PICTURE_HOSTS: Partial<Record<Platform, RegExp>> = {
  instagram: META_PICTURES,
  threads: META_PICTURES,
  facebook: /(^|\.)fbcdn\.net$/,
  linkedin: /(^|\.)licdn\.com$/,
  x: /(^|\.)twimg\.com$/,
  alignable: /(^|\.)alignable\.com$/,
};

/** Whether a network's posts are looked at before a comment on one is drafted. */
export const looksAtPosts = (platform: Platform): boolean => platform in PICTURE_HOSTS;

/** The biggest picture file fetched: a photo is a few hundred KB, and nothing this big is one. */
const PICTURE_BYTES = 8 * 1024 * 1024;
const FETCH_MS = 15_000;

/** What the tab is asked for: a few frames at most, each small. */
export const LOOK_WANT: PostLookAsk['want'] = {
  most: POST_PICTURES_MOST,
  width: POST_FRAME_WIDTH,
  chars: POST_PICTURE_CHARS,
};

/** Bytes as base64, a piece at a time. */
function base64Of(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Makes a picture file a JPEG in base64, `width` wide at most and no bigger than `chars`; null when it can't. */
export type PictureMaker = (file: Blob, width: number, chars: number) => Promise<string | null>;

/** The background's own: decoded and drawn off screen, never shown. */
export const makeJpeg: PictureMaker = async (file, width, chars) => {
  const whole = await createImageBitmap(file);
  try {
    const scale = Math.min(1, width / (whole.width || width));
    const w = Math.max(1, Math.round(whole.width * scale));
    const h = Math.max(1, Math.round(whole.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const draw = canvas.getContext('2d');
    if (!draw) return null;
    draw.drawImage(whole, 0, 0, w, h);
    for (const quality of [0.72, 0.5, 0.35]) {
      const made = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      const jpeg = base64Of(new Uint8Array(await made.arrayBuffer()));
      if (jpeg.length <= chars) return jpeg;
    }
    return null;
  } finally {
    whole.close();
  }
};

/**
 * A post's picture from its address: fetched only from the network's own picture servers, over https, with no
 * cookies, then made small. Null for any other address, a file that isn't a picture, one too big, or a fetch that
 * didn't come.
 */
export async function pictureFrom(
  address: string,
  platform: Platform,
  width: number,
  make: PictureMaker = makeJpeg,
): Promise<string | null> {
  const hosts = PICTURE_HOSTS[platform];
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (!hosts || url.protocol !== 'https:' || !hosts.test(url.hostname.toLowerCase())) return null;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), FETCH_MS);
  try {
    const response = await fetch(url.href, {
      credentials: 'omit',
      redirect: 'error',
      signal: stop.signal,
    });
    if (!response.ok) return null;
    if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('image/'))
      return null;
    if (Number(response.headers.get('content-length') ?? 0) > PICTURE_BYTES) return null;
    const file = await response.blob();
    if (!file.size || file.size > PICTURE_BYTES) return null;
    return await make(file, width, POST_PICTURE_CHARS);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A JPEG in base64, as HandsFreeOS takes one (core's `PostLook`): anything else isn't sent. */
const isJpeg = (text: unknown): text is string =>
  typeof text === 'string' &&
  text.length >= 200 &&
  text.length <= POST_PICTURE_CHARS &&
  text.startsWith('/9j/');

/**
 * The post on the page the runner's tab shows, as anyone who opens it sees it: its picture, or frames of its video,
 * ready to go with its comment's draft. Null on a network that isn't looked at, a page that isn't that post, a post
 * with no picture, or anything that didn't work.
 */
export async function lookAtPost(
  runner: {
    readonly platform: Platform;
    readonly tab: { ask(message: PostLookAsk): Promise<PostLookAnswer> };
  },
  on: { readonly profile: ProfileRef; readonly postUrl: string },
  make: PictureMaker = makeJpeg,
): Promise<PostLook | null> {
  if (!looksAtPosts(runner.platform)) return null;
  try {
    const answer = await runner.tab.ask({
      type: 'hfos-post-look',
      profile: on.profile,
      postUrl: on.postUrl,
      want: LOOK_WANT,
    });
    const seen = answer.ok ? answer.seen : null;
    if (!seen) return null;
    if (seen.kind === 'photo') {
      const jpeg = await pictureFrom(seen.url, runner.platform, POST_PHOTO_WIDTH, make);
      return isJpeg(jpeg) ? { kind: 'photo', jpegs: [jpeg] } : null;
    }
    const frames = seen.jpegs.filter(isJpeg).slice(0, POST_PICTURES_MOST);
    if (frames.length) return { kind: 'video', jpegs: frames };
    const cover = seen.poster
      ? await pictureFrom(seen.poster, runner.platform, POST_FRAME_WIDTH, make)
      : null;
    return isJpeg(cover) ? { kind: 'video', jpegs: [cover] } : null;
  } catch {
    return null;
  }
}
