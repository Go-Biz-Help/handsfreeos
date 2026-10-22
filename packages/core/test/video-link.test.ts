/**
 * Asking a customer for a video (20261018000300), on the local database:
 * - A person who can open the texts makes a link: a token shown once, kept only as its hash, a week long and three
 *   videos deep. Someone outside the business can't, and nobody can ask a customer who texted STOP.
 * - The worker's page starts an upload only for a video of a size the link takes, while the link lasts and has room,
 *   and names a folder under the message the video will be.
 * - The video arrives as the customer's reply: an inbound text with the video on it, unread, the thread open and
 *   waiting, the reminder set. Only in its own folder, and only once.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { conversations, events, messages, videoLinks } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand } from '../src/kernel/execute';
import type {
  AiEmployeeActor,
  CommandDef,
  HumanActor,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  messageReceive,
  organizationCreate,
  personCreate,
  personSetSmsConsent,
  videoLinkCreate,
  videoLinkReceiveUpload,
  videoLinkStartUpload,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const system = (): SystemActor => ({
  type: 'system',
  workspaceId: wsId,
  organizationId: orgId,
  onBehalfOf: null,
});
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(testDbs().worker.db, cmd, input, system(), meta()).then((r) => r.output);

async function expectRule(fn: () => Promise<unknown>, rule: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).rule).toBe(rule);
    return e as HfosError;
  }
  throw new Error(`expected ${rule}, but the call succeeded`);
}

const uniq = () => randomUUID().slice(0, 8);
const nextPhone = () =>
  `+1832${String(2000000 + ((Date.now() + Math.floor(Math.random() * 1e6)) % 7999999)).padStart(7, '0')}`;
const MARIA = '+17135550174';
const MB = 1024 * 1024;

let dale: TestUser;
let outsider: TestUser;
let orgId: string;
let wsId: string;
let mariaId: string;
let conversationId: string;

beforeAll(async () => {
  [dale, outsider] = await Promise.all([
    createTestUser('video-dale', { fullName: 'Dale Owner' }),
    createTestUser('video-outsider'),
  ]);
  const org = await run(
    organizationCreate,
    { businessName: 'Video Link HVAC', timezone: 'America/Chicago' },
    dale,
  );
  orgId = org.organizationId;
  wsId = org.workspaceId;
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${wsId}, 'fake', ${`ACvid${uniq()}`}, 'active') returning id`,
  );
  const businessNumber = nextPhone();
  await rows(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${wsId}, ${account!.id}, ${`PNvid${uniq()}`}, ${businessNumber}, 'toll_free', 'active')`,
  );
  mariaId = (
    await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Maria', lastName: 'Lopez', phone: MARIA },
      dale,
    )
  ).personId;
  // Maria texts first, which makes the thread.
  const received = await sys(messageReceive, {
    workspaceId: wsId,
    provider: 'fake',
    providerMessageId: `SMvid${uniq()}`,
    from: MARIA,
    to: businessNumber,
    body: 'The unit is making a grinding noise.',
  });
  conversationId = received.conversationId;
});
afterAll(closeTestDbs);

const linkRow = async (id: string) =>
  (await admin().select().from(videoLinks).where(eq(videoLinks.id, id)))[0]!;

describe('making a link', () => {
  it('gives the person the link once and keeps only its hash, for a week and three videos', async () => {
    const out = await run(videoLinkCreate, { workspaceId: wsId, conversationId }, dale);
    expect(out.path).toBe(`/v/${out.token}`);
    expect(out.token.length).toBeGreaterThanOrEqual(32);
    expect(out.maxUploads).toBe(3);
    const days = (new Date(out.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    const row = await linkRow(out.videoLinkId);
    expect(Buffer.from(row.tokenHash)).toEqual(createHash('sha256').update(out.token).digest());
    expect(row).toMatchObject({ conversationId, createdBy: dale.id, uploadsStarted: 0 });
  });

  it('is refused to someone outside the business', async () => {
    await expect(
      run(videoLinkCreate, { workspaceId: wsId, conversationId }, outsider),
    ).rejects.toThrow();
  });

  it('is refused for a customer who texted STOP, and says what would change it', async () => {
    await run(
      personSetSmsConsent,
      { workspaceId: wsId, personId: mariaId, consent: 'opted_out' },
      dale,
    );
    const err = await expectRule(
      () => run(videoLinkCreate, { workspaceId: wsId, conversationId }, dale),
      'opted_out',
    );
    expect(err.message).toBe(
      'Maria Lopez texted STOP, so no texts can go to them. They have to text START before you can ask for a video.',
    );
    await run(
      personSetSmsConsent,
      { workspaceId: wsId, personId: mariaId, consent: 'opted_in' },
      dale,
    );
  });

  it('lets the AI teammate make one only in the conversation it has', async () => {
    const ai = (conversation: string): AiEmployeeActor => ({
      type: 'ai_employee',
      workspaceId: wsId,
      organizationId: orgId,
      teammateId: randomUUID(),
      teammateName: 'Ava',
      runId: null,
      conversationId: conversation,
      approvedBy: null,
      origin: null,
      test: false,
    });
    const make = (actor: AiEmployeeActor) =>
      executeCommand(
        testDbs().worker.db,
        videoLinkCreate,
        { workspaceId: wsId, conversationId },
        actor,
        meta(),
      );
    await expectRule(() => make(ai(randomUUID())), 'outside_its_conversation');
    // Its own conversation, but a person has it (the whole way through: the worker's test).
    await expectRule(() => make(ai(conversationId)), 'not_handled_by_ai');
  });
});

describe('sending a video through it', () => {
  let linkId: string;
  beforeAll(async () => {
    linkId = (await run(videoLinkCreate, { workspaceId: wsId, conversationId }, dale)).videoLinkId;
  });
  const start = (over: Record<string, unknown> = {}) =>
    sys(videoLinkStartUpload, {
      workspaceId: wsId,
      videoLinkId: linkId,
      name: 'IMG_4410.MOV',
      contentType: 'video/quicktime',
      sizeBytes: 180 * MB,
      ...over,
    });

  it('starts only for a video it takes, and names a folder under the message it will be', async () => {
    const notVideo = await expectRule(
      () => start({ name: 'invoice.pdf', contentType: 'application/pdf' }),
      'not_a_video',
    );
    expect(notVideo.message).toBe('“invoice.pdf” isn’t a video. Pick a video, or record one.');
    const big = await expectRule(() => start({ sizeBytes: 300 * MB }), 'video_too_large');
    expect(big.message).toBe(
      'That video is 300 MB, and this link takes 250 MB at most. Trim it in your Photos app, or send a shorter one.',
    );
    const up = await start();
    expect(up.bucket).toBe('telephony');
    expect(up.objectPath).toBe(`${wsId}/messages/${up.uploadId}/video.mov`);
    expect((await linkRow(linkId)).uploadsStarted).toBe(1);
  });

  it('files the video as the customer’s reply, once, and only from its own folder', async () => {
    const up = await start();
    const receive = (over: Record<string, unknown> = {}) =>
      sys(videoLinkReceiveUpload, {
        workspaceId: wsId,
        videoLinkId: linkId,
        uploadId: up.uploadId,
        objectPath: up.objectPath,
        name: 'IMG_4410.MOV',
        contentType: 'video/quicktime',
        sizeBytes: 180 * MB,
        ...over,
      });
    await expectRule(
      () => receive({ objectPath: `${wsId}/messages/${randomUUID()}/video.mov` }),
      'wrong_place',
    );
    // Another message's folder, named as this upload's own: not an upload this link started.
    const other = randomUUID();
    await expectRule(
      () => receive({ uploadId: other, objectPath: `${wsId}/messages/${other}/0.jpg` }),
      'wrong_place',
    );
    await admin()
      .update(conversations)
      .set({ status: 'closed', unreadCount: 0, awaitingReplySince: null })
      .where(eq(conversations.id, conversationId));

    const got = await receive();
    expect(got).toEqual({ messageId: up.uploadId, conversationId, duplicate: false });
    const [m] = await admin().select().from(messages).where(eq(messages.id, got.messageId));
    expect(m).toMatchObject({
      direction: 'inbound',
      channel: 'sms',
      status: 'received',
      provider: 'video_link',
      fromAddress: MARIA,
      bodyText: null,
    });
    expect(m!.media).toEqual([
      {
        bucket: 'telephony',
        objectPath: up.objectPath,
        contentType: 'video/quicktime',
        sizeBytes: 180 * MB,
        name: 'IMG_4410.MOV',
        via: 'video_link',
      },
    ]);
    const [c] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(c).toMatchObject({ status: 'open', unreadCount: 1, lastPreview: 'Sent a video' });
    expect(c!.awaitingReplySince).toBeInstanceOf(Date);
    const [e] = await admin()
      .select()
      .from(events)
      .where(and(eq(events.entityId, got.messageId), eq(events.eventType, 'message.received')));
    expect(e?.payload).toMatchObject({ conversationId, via: 'video_link', mediaCount: 1 });
    expect((await linkRow(linkId)).uploadsReceived).toBe(1);

    // The page says done twice (a retry): the same video, filed once.
    expect(await receive()).toEqual({ messageId: up.uploadId, conversationId, duplicate: true });
    expect((await linkRow(linkId)).uploadsReceived).toBe(1);
  });

  it('takes three videos, and says so after', async () => {
    await admin().update(videoLinks).set({ uploadsReceived: 3 }).where(eq(videoLinks.id, linkId));
    const err = await expectRule(() => start(), 'link_full');
    expect(err.message).toBe(
      'You’ve sent 3 videos with this link, which is all it takes. To send more, ask Video Link HVAC for a new link.',
    );
  });

  it('stops after too many uploads that never finished', async () => {
    await admin()
      .update(videoLinks)
      .set({ uploadsReceived: 0, uploadsStarted: 10 })
      .where(eq(videoLinks.id, linkId));
    await expectRule(() => start(), 'too_many_starts');
  });

  it('runs out after its week', async () => {
    await admin()
      .update(videoLinks)
      .set({ uploadsStarted: 0, expiresAt: new Date('2026-09-20T15:00:00Z') })
      .where(eq(videoLinks.id, linkId));
    const err = await expectRule(() => start(), 'link_expired');
    expect(err.message).toBe(
      'This link ran out on September 20. Ask Video Link HVAC to send you a new one.',
    );
  });
});
