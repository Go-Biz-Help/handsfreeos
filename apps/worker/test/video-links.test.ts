/**
 * The video link, end to end through the worker and the real local Storage (20261018000300): the page reads whose
 * link it is, starts an upload, sends the file straight to Storage on the link it was handed, and says it's done;
 * the video lands in the conversation as the customer's reply. What Storage measured is what's filed, a retry
 * files it once, and a file the link can't take is taken back out.
 */
import { ScriptedProvider, type AiRequest } from '@hfos/ai';
import {
  executeCommand,
  messageReceive,
  videoLinkCreate,
  type AssistantEvent,
  type SystemActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { messages } from '@hfos/db/schema';
import { closeTestDbs, signInTestUser, testDbs } from '@hfos/db/testing';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToolExecutor } from '../src/assistant/tools-write';
import { buildHttpServer } from '../src/http/server';
import { consentToAssistant } from './assistant-consent';
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
import { testTokenVerifier } from './finish-sign-in';

let w: World;
let token: string;
let conversationId: string;
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
  conversationId = output.conversationId;
  token = (
    await run(w, videoLinkCreate, {
      workspaceId: w.workspaceId,
      conversationId,
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

  it('never takes back a file this link didn’t hand out, like a photo the customer texted', async () => {
    // A photo that came in by text, in its message's folder: the page can name any folder when it's done.
    const messageId = randomUUID();
    const photo = `${w.workspaceId}/messages/${messageId}/0.jpg`;
    await w.s.store.upload('telephony', photo, Buffer.from('a photo of the unit'), 'image/jpeg');
    const done = await post(w, `/public/video/${token}/done`, {
      uploadId: messageId,
      objectPath: photo,
      name: 'clip.mp4',
    });
    expect(done.statusCode).toBe(400);
    expect(errorOf(done).rule).toBe('wrong_place');
    expect(await w.s.store.info('telephony', photo)).not.toBeNull();
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

describe('asking for a video through the Assistant', () => {
  it('shows the link once, whole, on the card after Confirm, and keeps only what it made', async () => {
    const ORIGIN = 'https://app.handsfreeos.test';
    const asked: AiRequest[] = [];
    const inner = new ScriptedProvider([
      {
        when: /ask rosa for a video/i,
        calls: () => [{ name: 'do_video_link_create', arguments: { conversationId } }],
        reply: () => 'It’s ready for your OK.',
      },
      { when: /what did that make/i, reply: () => 'A link for Rosa to send a video.' },
    ]);
    const httpDb = testDbs().worker.db;
    const server = await buildHttpServer({
      ...w.s,
      httpDb,
      verifyToken: testTokenVerifier(),
      webOrigins: ['http://localhost:3000'],
      assistant: {
        provider: {
          id: inner.id,
          model: inner.model,
          stream: (request, options) => {
            asked.push(request);
            return inner.stream(request, options);
          },
        },
        tools: createToolExecutor(httpDb, null, null, ORIGIN),
      },
    });
    try {
      await consentToAssistant(w.owner);
      const bearer = { authorization: `Bearer ${await signInTestUser(w.owner)}` };
      const ask = async (text: string, threadId?: string) => {
        const res = await server.inject({
          method: 'POST',
          url: '/v1/assistant/messages',
          headers: bearer,
          payload: { workspaceId: w.workspaceId, text, ...(threadId ? { threadId } : {}) },
        });
        expect(res.statusCode).toBe(200);
        return res.body
          .split('\n\n')
          .filter((chunk) => chunk.startsWith('data: '))
          .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantEvent);
      };

      const first = await ask('Ask Rosa for a video');
      const threadId = first[0]!.type === 'run' ? first[0]!.threadId : '';
      const card = first
        .flatMap((e) => (e.type === 'card' ? [e.card] : []))
        .find((c) => c.type === 'confirm');
      expect(card).toMatchObject({ tool: 'do_video_link_create' });
      const callId = card!.type === 'confirm' ? card!.toolCallId : '';

      // A screen's own command is found by its card, and runs on Confirm.
      const done = await server.inject({
        method: 'POST',
        url: `/v1/assistant/tool-calls/${callId}/confirm`,
        headers: bearer,
        payload: { workspaceId: w.workspaceId },
      });
      expect(done.statusCode).toBe(200);
      const { status, outcome } = done.json() as { status: string; outcome: string };
      expect(status).toBe('confirmed');
      expect(outcome).toMatch(/isn’t shown again/);
      const link = /https:\/\/app\.handsfreeos\.test\/v\/([\w-]+)$/.exec(outcome);
      expect(link).not.toBeNull();
      const made = link![1]!;
      // It's a real link: the customer's page knows it.
      expect((await get(w, `/public/video/${made}`)).statusCode).toBe(200);

      // Kept with the call for later questions: what it made, never the link or its key.
      const [kept] = await rows<{ result: Record<string, unknown> }>(
        admin(),
        sql`select result from app.assistant_tool_calls where id = ${callId}`,
      );
      expect(kept!.result).toMatchObject({
        command: 'video_link.create',
        outcome: expect.stringMatching(/isn’t kept/),
        answer: { videoLinkId: expect.any(String), maxUploads: 3 },
      });
      expect(JSON.stringify(kept!.result)).not.toContain(made);
      expect(JSON.stringify(kept!.result)).not.toContain('/v/');

      // The next question reads what it made, and still never the link.
      asked.length = 0;
      await ask('What did that make?', threadId);
      const history = JSON.stringify(asked[0]!.messages);
      expect(history).toContain((kept!.result['answer'] as { videoLinkId: string }).videoLinkId);
      expect(history).not.toContain(made);
    } finally {
      await server.close();
    }
  });
});
