import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFfmpegConverter, needsConverting } from '../src/telephony/video';

/**
 * A video texted by MMS arrives as a carrier's 3GP, which neither Chrome nor an iPhone plays. The worker keeps it as
 * an MP4 instead. These run the real ffmpeg (on the worker's image, and installed on CI for this): a second of
 * H.263 in a 3GP, like the 54 KB one a phone sent on 1 October, goes in, and H.264 and AAC in an MP4 come out.
 */

const run = promisify(execFile);
const log = pino({ level: 'silent' });
let dir: string;
let carrierVideo: Buffer;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hfos-video-test-'));
  const path = join(dir, 'carrier.3gp');
  await run('ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'lavfi', '-i', 'testsrc=duration=1:size=176x144:rate=10'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'],
    ...['-c:v', 'h263', '-c:a', 'aac', '-ar', '8000', '-ac', '1', '-shortest', path],
  ]);
  carrierVideo = await readFile(path);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function streamsOf(video: Buffer): Promise<string[]> {
  const path = join(dir, `probe-${Math.random().toString(36).slice(2)}.mp4`);
  await writeFile(path, video);
  const { stdout } = await run('ffprobe', [
    ...['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path],
  ]);
  return stdout.trim().split('\n').sort();
}

describe('converting a texted video', () => {
  it('turns a carrier’s 3GP into an MP4 every browser and phone plays', async () => {
    const mp4 = await createFfmpegConverter({ log }).toMp4(carrierVideo);
    expect(mp4).not.toBeNull();
    // An MP4 begins with its `ftyp` box.
    expect(mp4!.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(await streamsOf(mp4!)).toEqual(['aac', 'h264']);
  });

  it('keeps the original when the file isn’t a video it can read', async () => {
    expect(
      await createFfmpegConverter({ log }).toMp4(Buffer.from('not a video at all')),
    ).toBeNull();
  });

  it('keeps the original when ffmpeg isn’t there', async () => {
    const missing = createFfmpegConverter({ log, ffmpeg: join(dir, 'no-such-ffmpeg') });
    expect(await missing.toMp4(carrierVideo)).toBeNull();
  });

  it('keeps the original when converting takes too long', async () => {
    const slow = createFfmpegConverter({ log, timeoutMs: 1 });
    expect(await slow.toMp4(carrierVideo)).toBeNull();
  });

  it('converts only videos that aren’t MP4 already', () => {
    expect(needsConverting('video/3gpp')).toBe(true);
    expect(needsConverting('video/quicktime')).toBe(true);
    expect(needsConverting('video/mp4')).toBe(false);
    expect(needsConverting('image/jpeg')).toBe(false);
  });
});
