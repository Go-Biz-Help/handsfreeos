/**
 * The video link, end to end through the worker and the real local Storage (20261018000200): the page reads whose
 * link it is, starts an upload, sends the file straight to Storage on the link it was handed, and says it's done;
 * the video lands in the conversation as the customer's reply. What Storage measured is what's filed, a retry
 * files it once, and a file the link can't take is taken back out.
 */
import {
  executeCommand,
  messageReceive,
  videoLinkCreate,
  type SystemActor,
} from '@hfos/core/server';
import { messages } from '@hfos/db/schema';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  errorOf,
  get,
  makeWorld,
  post,
  readyTexting,
  run,
  type World,
} from './booking-world';

let w: World;
let token: string;
const ROSA = '+17135550199';

const system = (): SystemActor => ({
  type: 'system',
  workspaceId: w.workspaceId,
  organizationId: w.organizationId,
  onBehalfOf: null,
});

/** What the customer's page does with the link it was handed: the file, straight to Storage. */
async function putFile(uploadUrl: string, bytes: Buffer, contentType: string) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType, 'x-upsert': 'false' },
    body: new Uint8Array(bytes),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  w = await makeWorld('vidlink');
  const number = await readyTexting(w);
  const { output } = await executeCommand(
    testDbs().worker.db,
    messageReceive,
    {
      workspaceId: w.workspaceId,
      provider: 'fake',
      providerMessageId: `SMvid${randomUUID().slice(0, 8)}`,
      from: ROSA,
      to: number,
      body: 'Water is coming out from under the unit.',
    },
    system(),
    { correlationId: randomUUID(), channel: 'test' },
  );
  token = (
    await run(w, videoLinkCreate, {
      workspaceId: w.workspaceId,
      conversationId: output.conversationId,
    })
  ).token;
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

describe('the customer’s page', () => {
  it('says whose link it is and that it takes a video, and knows no other link', async () => {
    const res = await get(w, `/public/video/${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ maxUploads: 3, received: 0, problem: null });
    expect(res.json().business).toMatch(/vidlink/);
    const unknown = await get(w, `/public/video/${'x'.repeat(32)}`);
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown).rule).toBe('link_not_found');
  });

  it('turns away a file that isn’t a video before anything goes up', async () => {
    const res = await post(w, `/public/video/${token}/start`, {
      name: 'quote.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2000,
    });
    expect(res.statusCode).toBe(415);
    expect(errorOf(res)).toMatchObject({
      rule: 'not_a_video',
      message: '“quote.pdf” isn’t a video. Pick a video, or record one.',
    });
  });

  it('sends a video straight to Storage and files it as the customer’s reply, once', async () => {
    const bytes = Buffer.from('a whole video, as the phone recorded it');
    const started = await post(w, `/public/video/${token}/start`, {
      name: 'IMG_7001.MOV',
      contentType: 'video/quicktime',
      sizeBytes: bytes.length,
    });
    expect(started.statusCode).toBe(200);
    const up = started.json() as { uploadId: string; objectPath: string; uploadUrl: string };
    expect(up.objectPath).toBe(`${w.workspaceId}/messages/${up.uploadId}/video.mov`);
    await putFile(up.uploadUrl, bytes, 'video/quicktime');

    const done = await post(w, `/public/video/${token}/done`, {
      uploadId: up.uploadId,
      objectPath: up.objectPath,
      name: 'IMG_7001.MOV',
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ sent: true, duplicate: false });
    const [m] = await admin().select().from(messages).where(eq(messages.id, up.uploadId));
    expect(m).toMatchObject({ direction: 'inbound', provider: 'video_link', fromAddress: ROSA });
    expect(m!.media).toEqual([
      {
        bucket: 'telephony',
        objectPath: up.objectPath,
        contentType: 'video/quicktime',
        sizeBytes: bytes.length,
        name: 'IMG_7001.MOV',
        via: 'video_link',
      },
    ]);
    expect(await w.s.store.download('telephony', up.objectPath)).toEqual(bytes);

    const again = await post(w, `/public/video/${token}/done`, {
      uploadId: up.uploadId,
      objectPath: up.objectPath,
      name: 'IMG_7001.MOV',
    });
    expect(again.json()).toEqual({ sent: true, duplicate: true });
    expect((await get(w, `/public/video/${token}`)).json()).toMatchObject({ received: 1 });
  });

  it('says so when the video never arrived, and only asks about its own folder', async () => {
    const started = await post(w, `/public/video/${token}/start`, {
      name: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 100,
    });
    const up = started.json() as { uploadId: string; objectPath: string };
    const missing = await post(w, `/public/video/${token}/done`, {
      uploadId: up.uploadId,
      objectPath: up.objectPath,
      name: 'clip.mp4',
    });
    expect(missing.statusCode).toBe(409);
    expect(errorOf(missing)).toMatchObject({
      rule: 'not_arrived',
      message: 'Your video didn’t arrive. Tap Try again to send it again.',
    });
    const elsewhere = await post(w, `/public/video/${token}/done`, {
      uploadId: up.uploadId,
      objectPath: `${w.workspaceId}/messages/${randomUUID()}/video.mp4`,
      name: 'clip.mp4',
    });
    expect(errorOf(elsewhere).rule).toBe('wrong_place');
  });

  it('files what Storage measured, and takes back a file that turned out not to be a video', async () => {
    const started = await post(w, `/public/video/${token}/start`, {
      name: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 100,
    });
    const up = started.json() as { uploadId: string; objectPath: string; uploadUrl: string };
    await putFile(up.uploadUrl, Buffer.from('<html>not a video</html>'), 'text/html');
    const done = await post(w, `/public/video/${token}/done`, {
      uploadId: up.uploadId,
      objectPath: up.objectPath,
      name: 'clip.mp4',
    });
    expect(done.statusCode).toBe(415);
    expect(errorOf(done).rule).toBe('not_a_video');
    expect(await w.s.store.info('telephony', up.objectPath)).toBeNull();
    expect(await admin().select().from(messages).where(eq(messages.id, up.uploadId))).toEqual([]);
  });

  it('ignores a robot that fills in the hidden box', async () => {
    const res = await post(w, `/public/video/${token}/start`, {
      name: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 100,
      website: 'http://spam.example',
    });
    expect(res.statusCode).toBe(404);
  });
});
