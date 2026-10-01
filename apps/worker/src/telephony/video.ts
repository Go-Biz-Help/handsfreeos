import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';

/**
 * Videos texted to a business, made playable where the business looks at them.
 *
 * A video that comes by MMS is whatever the customer's phone and carrier squeezed it into, usually a 3GP with H.263
 * or AMR in it, and almost nothing plays that: not Chrome, not an iPhone. Kept as it came, it opens as a download.
 * So a video that isn't an MP4 is turned into one (H.264 and AAC, which every browser and phone plays) on its way
 * into storage. This makes it play, not sharper: what the carrier threw away is gone.
 *
 * When it can't be converted (ffmpeg missing, the file unreadable, too big or too slow) the original is kept as it
 * came, so a video is never lost to this.
 */
export interface VideoConverter {
  /** The video as an MP4, or null when it couldn't be converted and the original should be kept. */
  toMp4(video: Buffer): Promise<Buffer | null>;
}

/** Already plays everywhere it's opened: an MP4 is kept as it came. */
export function needsConverting(contentType: string): boolean {
  return contentType.startsWith('video/') && contentType !== 'video/mp4';
}

/**
 * The `telephony` bucket's limit (25 MB, messaging_core.sql). Past it a video is kept as it came, and an MP4 that
 * came out bigger is let go for the original.
 */
export const CONVERT_MOST_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 90_000;
/** What ffmpeg says when it fails, cut short for the log. */
const STDERR_KEEP = 2000;

/** ffmpeg, installed on the worker's image (apps/worker/Dockerfile) and, for its test, on CI. */
export function createFfmpegConverter(deps: {
  readonly log: Logger;
  /** The ffmpeg to run: `ffmpeg` on the PATH unless a test says otherwise. */
  readonly ffmpeg?: string;
  readonly timeoutMs?: number;
}): VideoConverter {
  const ffmpeg = deps.ffmpeg ?? 'ffmpeg';
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  return {
    async toMp4(video) {
      if (video.length === 0 || video.length > CONVERT_MOST_BYTES) return null;
      const dir = await mkdtemp(join(tmpdir(), 'hfos-video-'));
      try {
        const input = join(dir, 'in');
        const output = join(dir, 'out.mp4');
        await writeFile(input, video);
        const failed = await run(
          ffmpeg,
          [
            ...['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input],
            // The first picture and, when there is one, the first sound.
            ...['-map', '0:v:0', '-map', '0:a:0?'],
            ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'],
            // Two threads: the worker's machine has 512 MB and a shared CPU, and other work to do.
            ...['-threads', '2'],
            // H.264 in yuv420p wants even sides; a carrier's odd-sized video is trimmed by a pixel.
            ...['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'],
            ...['-c:a', 'aac', '-b:a', '128k'],
            // The index up front, so a player starts before the whole file has arrived.
            ...['-movflags', '+faststart', output],
          ],
          timeoutMs,
        );
        if (failed) {
          deps.log.warn(
            { reason: failed },
            'a texted video could not be converted; kept as it came',
          );
          return null;
        }
        const mp4 = await readFile(output);
        return mp4.length > CONVERT_MOST_BYTES ? null : mp4;
      } catch (e) {
        deps.log.warn({ err: e }, 'a texted video could not be converted; kept as it came');
        return null;
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/** Runs ffmpeg; null when it finished cleanly, otherwise why it didn't. */
function run(command: string, args: readonly string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_KEEP) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(e.message);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(null);
      else if (signal) resolve(`stopped after ${timeoutMs / 1000} s (${signal})`);
      else resolve(stderr.trim().slice(0, STDERR_KEEP) || `ffmpeg exited with ${code}`);
    });
  });
}

/**
 * The stand-in for tests and the seed: it "converts" by marking the bytes, so a test can tell the converted video
 * was the one stored, without ffmpeg. `unreadable` in the video plays the file ffmpeg can't read.
 */
export function createFakeVideoConverter(): VideoConverter & { readonly asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    async toMp4(video) {
      asked.push(video.length);
      if (video.includes('unreadable')) return null;
      return Buffer.concat([Buffer.from('fake-mp4:'), video]);
    },
  };
}
