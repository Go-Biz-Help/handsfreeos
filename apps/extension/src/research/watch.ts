/**
 * Watching a standout video for AI Social Media Content Creator (docs/socialcontent.md, part 4, decision 9), in its
 * reading tab (./page.ts, research.js): the video's file is fetched from Instagram's own video servers, as the page
 * plays it, then a few frames are taken from it (JPEGs about 512 wide) and its sound is turned into a small WAV (8 kHz,
 * one channel, its first two minutes) for HandsFreeOS to hear. Nothing is shown or played aloud, and nothing is kept:
 * the background sends what this gives back to the worker, where the AI looks and listens.
 *
 * Only a file on Instagram's video servers is fetched (./instagram.ts `INSTAGRAM_VIDEO_HOSTS`), never another site.
 * When the tab can't fetch it (`blocked`), the background fetches it and hands the file in instead (`file`).
 */
import { frameTimes, INSTAGRAM_VIDEO_HOSTS } from './instagram';

export interface WatchAsk {
  readonly url: string;
  /** The file itself, base64, when the background fetched it. */
  readonly file?: string;
  /** Frames to take, at most, how wide, and how big each may be as base64. */
  readonly most: number;
  readonly width: number;
  readonly frameBytes: number;
  /** How much of its sound to send, and how big the file may be. */
  readonly soundSeconds: number;
  readonly fileBytes: number;
}

export type Watched =
  | {
      readonly ok: true;
      readonly seconds: number | null;
      readonly frames: readonly { readonly at: number; readonly jpeg: string }[];
      /** Its sound as a WAV, base64; null when it has none. */
      readonly sound: string | null;
    }
  | { readonly ok: false; readonly failure: string; readonly blocked?: boolean };

const SOUND_RATE = 8000;
const WAIT_MS = 20_000;

/** Waits for one of an element's events, or gives up. */
function once(target: EventTarget, event: string, ms: number): Promise<void> {
  return new Promise((done, failed) => {
    const timer = setTimeout(() => {
      target.removeEventListener(event, ok);
      failed(new Error(`no ${event}`));
    }, ms);
    const ok = () => {
      clearTimeout(timer);
      done();
    };
    target.addEventListener(event, ok, { once: true });
    target.addEventListener('error', () => failed(new Error('the video couldn’t play')), {
      once: true,
    });
  });
}

/** Bytes as base64, a piece at a time. */
export function base64Of(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Samples from -1 to 1 as a 16-bit WAV. */
export function wavOf(samples: Float32Array, rate: number): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, 'data');
  out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

/** Its sound, one channel at 8 kHz, its first `most` seconds, as a WAV; null when there's none to hear. */
async function soundOf(file: ArrayBuffer, most: number): Promise<string | null> {
  // Decoding in a context of this rate gives the sound at this rate.
  const decoded = await new OfflineAudioContext(1, 1, SOUND_RATE).decodeAudioData(file);
  const length = Math.min(decoded.length, Math.round(most * decoded.sampleRate));
  const mixed = new Float32Array(length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const channel = decoded.getChannelData(c);
    for (let i = 0; i < length; i++)
      mixed[i] = (mixed[i] ?? 0) + (channel[i] ?? 0) / decoded.numberOfChannels;
  }
  let loudest = 0;
  for (let i = 0; i < length; i++) loudest = Math.max(loudest, Math.abs(mixed[i] ?? 0));
  if (loudest < 0.002) return null;
  return base64Of(wavOf(mixed, decoded.sampleRate));
}

/** A frame as a JPEG, base64, smaller when it's too big; null when it can't be made small enough. */
function jpegOf(canvas: HTMLCanvasElement, most: number): string | null {
  for (const quality of [0.72, 0.5, 0.35]) {
    const jpeg = canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? '';
    if (jpeg && jpeg.length <= most) return jpeg;
  }
  return null;
}

export async function watchVideo(ask: WatchAsk): Promise<Watched> {
  let host: string;
  try {
    host = new URL(ask.url).hostname;
  } catch {
    return { ok: false, failure: 'Instagram didn’t give a video to watch.' };
  }
  if (!INSTAGRAM_VIDEO_HOSTS.test(host))
    return { ok: false, failure: 'Instagram didn’t give a video to watch.' };
  let file: ArrayBuffer;
  if (ask.file) {
    const text = atob(ask.file);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    file = bytes.buffer;
  } else
    try {
      const response = await fetch(ask.url, { credentials: 'omit' });
      if (!response.ok)
        return { ok: false, failure: `Instagram didn’t send the video (${response.status}).` };
      if (Number(response.headers.get('content-length') ?? 0) > ask.fileBytes)
        return { ok: false, failure: 'The video is too long to watch.' };
      file = await response.arrayBuffer();
    } catch {
      // Its servers didn't let the page fetch it: the background can.
      return { ok: false, failure: 'Instagram didn’t send the video.', blocked: true };
    }
  if (file.byteLength > ask.fileBytes)
    return { ok: false, failure: 'The video is too long to watch.' };

  const src = URL.createObjectURL(new Blob([file], { type: 'video/mp4' }));
  const video = document.createElement('video');
  try {
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.src = src;
    await once(video, 'loadeddata', WAIT_MS);
    const seconds = Number.isFinite(video.duration) ? video.duration : null;
    const scale = Math.min(1, ask.width / (video.videoWidth || ask.width));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((video.videoWidth || ask.width) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || ask.width) * scale));
    const draw = canvas.getContext('2d');
    if (!draw) return { ok: false, failure: 'The video couldn’t be looked at.' };
    const frames: { at: number; jpeg: string }[] = [];
    for (const at of frameTimes(seconds ?? 0, ask.most)) {
      if (Math.abs(video.currentTime - at) > 0.05) {
        video.currentTime = at;
        await once(video, 'seeked', WAIT_MS);
      }
      draw.drawImage(video, 0, 0, canvas.width, canvas.height);
      const jpeg = jpegOf(canvas, ask.frameBytes);
      if (jpeg) frames.push({ at, jpeg });
    }
    if (!frames.length) return { ok: false, failure: 'No frames could be taken from the video.' };
    // The file again for its sound: decoding takes the bytes it's given.
    const sound = await soundOf(file.slice(0), ask.soundSeconds).catch(() => null);
    return { ok: true, seconds, frames, sound };
  } catch (error) {
    return {
      ok: false,
      failure:
        error instanceof Error && /couldn’t play/.test(error.message)
          ? 'The video couldn’t play on the reading computer.'
          : 'The video took too long to load. It tries again later.',
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(src);
  }
}
