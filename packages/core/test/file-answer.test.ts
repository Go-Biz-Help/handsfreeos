/**
 * Asking a customer for a file (20261018000400), on the local database: a qualifying question they answer by sending
 * something, like a photo or PDF of their electric bill.
 * - The AI teammate makes a link only for a file question, in the conversation it has, for its customer's lead: a
 *   video link that asks for a file, five files deep.
 * - The page starts an upload only for a photo or PDF of a size the link takes.
 * - What arrives is the customer's reply, a pending file on the lead, and the question's answer; the lead qualifies
 *   when it was the last thing missing, and `file.received` says who to tell. A second file adds to the answer.
 * - The worker's copy marks the file ready once, and puts it on the timeline.
 * - A photo they texted is saved the same way, once; a message with nothing to save says so.
 * - The teammate can't answer a file question in words; a person can.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { events, files, leads, messages, videoLinks } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { applyTeammatePatch, parseTeammateConfig } from '../src/ai-team/index';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  AiEmployeeActor,
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import { LeadQualification } from '../src/schemas/ai-team';
import {
  aiTeammateCreate,
  aiTeammateGet,
  aiTeammateSaveConfig,
  aiTeammateSetStatus,
  conversationHandToAi,
  fileFinishCopy,
  fileLinkCreate,
  leadCreate,
  leadRecordAnswers,
  leadSaveFileAnswer,
  messageReceive,
  organizationCreate,
  personCreate,
  videoLinkReceiveUpload,
  videoLinkStartUpload,
} from '../src/server';

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (channel: RequestMeta['channel'] = 'test'): RequestMeta => ({
  correlationId: randomUUID(),
  channel,
});
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());
const system = (): SystemActor => ({
  type: 'system',
  workspaceId: wsId,
  organizationId: orgId,
  onBehalfOf: null,
});
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(worker(), cmd, input, system(), meta('worker')).then((r) => r.output);
const ava = (over: Partial<AiEmployeeActor> = {}): AiEmployeeActor => ({
  type: 'ai_employee',
  workspaceId: wsId,
  organizationId: orgId,
  teammateId,
  teammateName: 'Ava',
  runId: null,
  conversationId,
  approvedBy: null,
  origin: null,
  test: false,
  ...over,
});
const asAva = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  over: Partial<AiEmployeeActor> = {},
) => executeCommand(worker(), cmd, input, ava(over), meta('ai_employee')).then((r) => r.output);

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

const MB = 1024 * 1024;
const randomE164 = () =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const BILL = 'Can you send a photo of your latest electric bill?';

let owner: TestUser;
let orgId: string;
let wsId: string;
let teammateId: string;
let businessNumber: string;
let personId: string;
let phone: string;
let conversationId: string;
let leadId: string;

const leadAnswers = async (id = leadId) => {
  const [l] = await admin().select().from(leads).where(eq(leads.id, id));
  return LeadQualification.parse(l!.qualification);
};

beforeAll(async () => {
  owner = await createTestUser('file-answer-owner', { fullName: 'Dale Owner' });
  const org = await run(
    organizationCreate,
    { businessName: 'Bright Solar', timezone: 'America/Chicago' },
    owner,
  );
  orgId = org.organizationId;
  wsId = org.workspaceId;
  businessNumber = randomE164();
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${wsId}, 'fake', ${`ACfile${randomUUID().slice(0, 8)}`}, 'active') returning id`,
  );
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${wsId}, ${account!.id}, ${`PNfile${randomUUID().slice(0, 8)}`}, ${businessNumber}, 'toll_free', 'active')
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${wsId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved', ${`HHfile${randomUUID().slice(0, 8)}`}, now())`,
  );
  teammateId = (
    await run(
      aiTeammateCreate,
      { workspaceId: wsId, preset: 'lead_responder', name: 'Ava', disclosure: 'when_asked' },
      owner,
    )
  ).teammateId;
  await run(aiTeammateSetStatus, { workspaceId: wsId, teammateId, status: 'training' }, owner);
  const got = await ask(aiTeammateGet, { workspaceId: wsId }, owner);
  await run(
    aiTeammateSaveConfig,
    {
      workspaceId: wsId,
      teammateId,
      baseRevision: got.teammate!.revision,
      config: applyTeammatePatch(parseTeammateConfig(got.teammate!.config), {
        qualify: {
          enabled: true,
          questions: [
            { id: 'owner', question: 'Do you own the home?', kind: 'yes_no', required: false },
            { id: 'bill', question: BILL, kind: 'file', notify: { kind: 'admins' } },
          ],
        },
      }),
    },
    owner,
  );
  phone = randomE164();
  personId = (
    await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Rosa', lastName: 'Delgado', phone, ignoreDuplicates: true },
      owner,
    )
  ).personId;
  const received = await sys(messageReceive, {
    workspaceId: wsId,
    provider: 'fake',
    providerMessageId: `SM${randomUUID()}`,
    from: phone,
    to: businessNumber,
    body: 'How much would solar panels save me?',
    occurredAt: new Date().toISOString(),
    reminderAfterMs: 86_400_000,
  });
  conversationId = received.conversationId;
  await run(conversationHandToAi, { workspaceId: wsId, conversationId }, owner);
  leadId = (await run(leadCreate, { workspaceId: wsId, title: 'Solar panels', personId }, owner))
    .leadId;
});
afterAll(closeTestDbs);

describe('asking for a file', () => {
  it('makes a link for a file question, on the customer’s lead, five files deep', async () => {
    const out = await asAva(fileLinkCreate, {
      workspaceId: wsId,
      conversationId,
      leadId,
      questionId: 'bill',
    });
    expect(out.path).toBe(`/v/${out.token}`);
    expect(out.maxUploads).toBe(5);
    const [row] = await admin().select().from(videoLinks).where(eq(videoLinks.id, out.videoLinkId));
    expect(row).toMatchObject({
      asksFor: 'file',
      leadId,
      questionId: 'bill',
      ask: BILL,
      createdBy: null,
      createdByTeammateId: teammateId,
      maxUploads: 5,
    });
  });

  it('only for a file question, and only in the conversation it has', async () => {
    const input = { workspaceId: wsId, conversationId, leadId };
    const words = await expectRule(
      () => asAva(fileLinkCreate, { ...input, questionId: 'owner' }),
      'not_a_file_question',
    );
    expect(words.message).toBe(
      '“Do you own the home?” isn’t a question that asks for a file. Change it to a file question in AI teammate → Qualify first.',
    );
    await expectRule(
      () => asAva(fileLinkCreate, { ...input, questionId: 'gone' }),
      'question_not_found',
    );
    await expectRule(
      () =>
        asAva(fileLinkCreate, { ...input, questionId: 'bill' }, { conversationId: randomUUID() }),
      'outside_its_conversation',
    );
  });
});

describe('sending a file through it', () => {
  let linkId: string;
  beforeAll(async () => {
    linkId = (
      await asAva(fileLinkCreate, {
        workspaceId: wsId,
        conversationId,
        leadId,
        questionId: 'bill',
      })
    ).videoLinkId;
  });
  const start = (over: Record<string, unknown> = {}) =>
    sys(videoLinkStartUpload, {
      workspaceId: wsId,
      videoLinkId: linkId,
      name: 'bill.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2 * MB,
      ...over,
    });
  const receive = (up: { uploadId: string; objectPath: string }, over = {}) =>
    sys(videoLinkReceiveUpload, {
      workspaceId: wsId,
      videoLinkId: linkId,
      uploadId: up.uploadId,
      objectPath: up.objectPath,
      name: 'bill.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2 * MB,
      ...over,
    });

  it('starts only for a photo or PDF it takes', async () => {
    const video = await expectRule(
      () => start({ name: 'clip.mov', contentType: 'video/quicktime' }),
      'not_a_file',
    );
    expect(video.message).toBe(
      '“clip.mov” isn’t a photo or a PDF. Pick a photo of it, take one now, or pick a PDF.',
    );
    const big = await expectRule(() => start({ sizeBytes: 30 * MB }), 'file_too_large');
    expect(big.message).toBe(
      'That file is 30 MB, and this link takes 25 MB at most. Take a photo of it instead, or send a smaller PDF.',
    );
    const up = await start();
    expect(up.objectPath).toBe(`${wsId}/messages/${up.uploadId}/file.pdf`);
  });

  it('files it as their reply, on the lead, as the answer, and the lead qualifies', async () => {
    const up = await start();
    const got = await receive(up);
    const [m] = await admin().select().from(messages).where(eq(messages.id, got.messageId));
    expect(m).toMatchObject({ direction: 'inbound', provider: 'file_link' });
    expect(m!.media[0]).toMatchObject({ contentType: 'application/pdf', via: 'file_link' });

    const onLead = await admin()
      .select()
      .from(files)
      .where(and(eq(files.recordType, 'lead'), eq(files.recordId, leadId)));
    expect(onLead).toHaveLength(1);
    expect(onLead[0]).toMatchObject({
      bucket: 'attachments',
      name: 'bill.pdf',
      status: 'pending',
      createdBy: null,
    });
    expect(onLead[0]!.objectPath).toBe(`${wsId}/lead/${leadId}/${onLead[0]!.id}/bill.pdf`);

    const q = await leadAnswers();
    expect(q.status).toBe('qualified');
    expect(q.answers['bill']).toMatchObject({
      question: BILL,
      answer: 'Sent “bill.pdf”',
      by: 'ai',
      files: [{ fileId: onLead[0]!.id, name: 'bill.pdf', messageId: got.messageId }],
    });

    const [received] = await admin()
      .select()
      .from(events)
      .where(and(eq(events.entityId, leadId), eq(events.eventType, 'file.received')));
    expect(received?.payload).toMatchObject({
      leadId,
      personId,
      conversationId,
      messageId: got.messageId,
      question: BILL,
      notify: { kind: 'admins' },
      via: 'file_link',
      files: [
        {
          fileId: onLead[0]!.id,
          from: { bucket: 'telephony', objectPath: up.objectPath },
          contentType: 'application/pdf',
        },
      ],
    });
    const qualified = await admin()
      .select()
      .from(events)
      .where(and(eq(events.entityId, leadId), eq(events.eventType, 'lead.qualified')));
    expect(qualified).toHaveLength(1);
  });

  it('adds a second file to the same answer', async () => {
    const up = await start({ name: 'page-2.jpg', contentType: 'image/jpeg' });
    await receive(up, { name: 'page-2.jpg', contentType: 'image/jpeg' });
    expect((await leadAnswers()).answers['bill']!.answer).toBe(
      'Sent 2 files: “bill.pdf” and “page-2.jpg”',
    );
    expect((await leadAnswers()).answers['bill']!.files).toHaveLength(2);
  });

  it('is marked ready once the worker has copied it, and put on the timeline once', async () => {
    const [f] = await admin()
      .select()
      .from(files)
      .where(
        and(eq(files.recordType, 'lead'), eq(files.recordId, leadId), eq(files.name, 'bill.pdf')),
      );
    expect(
      await sys(fileFinishCopy, { workspaceId: wsId, fileId: f!.id, sizeBytes: 2 * MB }),
    ).toEqual({ fileId: f!.id, ready: true });
    const [ready] = await admin().select().from(files).where(eq(files.id, f!.id));
    expect(ready).toMatchObject({ status: 'ready', sizeBytes: 2 * MB });
    await sys(fileFinishCopy, { workspaceId: wsId, fileId: f!.id, sizeBytes: 2 * MB });
    const attached = await admin()
      .select()
      .from(events)
      .where(and(eq(events.entityId, leadId), eq(events.eventType, 'file.attached')));
    expect(attached).toHaveLength(1);
  });
});

describe('a photo they texted', () => {
  let photoMessageId: string;
  let wordsMessageId: string;
  beforeAll(async () => {
    const send = async (body: string) =>
      (
        await sys(messageReceive, {
          workspaceId: wsId,
          provider: 'fake',
          providerMessageId: `SM${randomUUID()}`,
          from: phone,
          to: businessNumber,
          body,
          occurredAt: new Date().toISOString(),
          reminderAfterMs: 86_400_000,
        })
      ).messageId;
    photoMessageId = await send('Here’s the bill');
    await admin()
      .update(messages)
      .set({
        media: [
          {
            bucket: 'telephony',
            objectPath: `${wsId}/mms/${photoMessageId}/0.jpg`,
            contentType: 'image/jpeg',
            sizeBytes: 480_000,
            name: 'IMG_2201.jpg',
          },
        ],
      })
      .where(eq(messages.id, photoMessageId));
    wordsMessageId = await send('Thanks!');
  });

  it('goes on the lead as the answer, once', async () => {
    const input = { workspaceId: wsId, leadId, questionId: 'bill', messageId: photoMessageId };
    const saved = await asAva(leadSaveFileAnswer, input);
    expect(saved.duplicate).toBe(false);
    expect(saved.files.map((f) => f.name)).toEqual(['IMG_2201.jpg']);
    expect((await leadAnswers()).answers['bill']!.files.at(-1)).toMatchObject({
      name: 'IMG_2201.jpg',
      messageId: photoMessageId,
    });
    const again = await asAva(leadSaveFileAnswer, input);
    expect(again).toMatchObject({ duplicate: true, files: saved.files });
  });

  it('says so when a message has nothing to save', async () => {
    const err = await expectRule(
      () =>
        asAva(leadSaveFileAnswer, {
          workspaceId: wsId,
          leadId,
          questionId: 'bill',
          messageId: wordsMessageId,
        }),
      'no_file',
    );
    expect(err.message).toBe(
      'That message has no photo or PDF to save. Ask them to send it with the link, or to text a photo of it.',
    );
  });
});

describe('answering a file question in words', () => {
  it('is refused to the teammate, and open to a person', async () => {
    const input = {
      workspaceId: wsId,
      leadId,
      answers: [{ questionId: 'bill', answer: 'Dropped it at the office' }],
    };
    await expectRule(() => asAva(leadRecordAnswers, input), 'file_question');
    const out = await run(leadRecordAnswers, input, owner);
    expect(out.status).toBe('qualified');
    expect((await leadAnswers()).answers['bill']).toMatchObject({
      answer: 'Dropped it at the office',
      by: 'person',
      files: [],
    });
  });
});
