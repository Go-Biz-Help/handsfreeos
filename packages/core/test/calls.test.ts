import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  callAttachRecording,
  callAttachTranscript,
  callRecord,
  callStart,
  callUpdateStatus,
  conversationGet,
  conversationThread,
  organizationCreate,
  personCreate,
  phoneNumberActivate,
  phoneNumberBuy,
  timelineList,
} from '../src/server';

const db = () => testDbs().api.db;
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
) => executeCommand(db(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(db(), q, input, human(u), meta());
const system = (): SystemActor => ({ type: 'system', workspaceId: wsId, organizationId: orgId });
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(testDbs().worker.db, cmd, input, system(), meta()).then((r) => r.output);

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect({ code: err.code, rule: err.rule }).toMatchObject({ code, ...(rule ? { rule } : {}) });
    return err;
  }
  throw new Error(`expected ${code}${rule ? ` (${rule})` : ''}, but the call succeeded`);
}

/** A random business number, so reruns never collide with a number still live in an old test workspace. */
const randomE164 = () =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const sid = () => `CAfake${randomUUID().slice(0, 8)}`;

const MIKE = '+17135550142';
const STRANGER = '+18325550190';

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let orgId: string;
let wsId: string;
let mikeId: string;
let noPhoneId: string;
let businessNumber: string;

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('call-owner'),
    createTestUser('call-member'),
    createTestUser('call-outsider'),
  ]);
  const org = await run(organizationCreate, { businessName: 'Calling Test Co' }, owner);
  orgId = org.organizationId;
  wsId = org.workspaceId;
  await run(organizationCreate, { businessName: 'Someone Else Co' }, outsider);
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
  mikeId = (
    await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Mike', lastName: 'Johnson', phone: '(713) 555-0142' },
      owner,
    )
  ).personId;
  noPhoneId = (
    await run(personCreate, { workspaceId: wsId, firstName: 'Pat', lastName: 'Rivera' }, owner)
  ).personId;
});
afterAll(closeTestDbs);

describe('calls', () => {
  it('need a business number first', async () => {
    await expectHfos(
      () => run(callStart, { workspaceId: wsId, personId: mikeId }, member),
      'rule_violation',
      'no_number',
    );
    businessNumber = randomE164();
    const { phoneNumberId } = await run(
      phoneNumberBuy,
      { workspaceId: wsId, e164: businessNumber, numberType: 'toll_free' },
      owner,
    );
    const [account] = await asWorker(
      testDbs().worker.db,
      { workspaceId: wsId, organizationId: orgId },
      (tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
            values (${wsId}, 'fake', ${`ACfake${randomUUID().slice(0, 8)}`}, 'active') returning id`,
        ),
    );
    await sys(phoneNumberActivate, {
      workspaceId: wsId,
      phoneNumberId,
      providerSid: `PNfake${randomUUID().slice(0, 8)}`,
      accountId: account!.id,
      capabilities: { sms: true, voice: true, mms: true },
    });
  });

  it('a teammate calls a customer from the browser; the worker connects and settles it', async () => {
    const started = await run(callStart, { workspaceId: wsId, personId: mikeId }, member);
    expect(started.to).toBe(MIKE);
    expect(started.params).toEqual({ To: MIKE, CallId: started.callId });
    const [row] = await rows<{
      direction: string;
      status: string;
      placed_by: string;
      from_e164: string;
      conversation_id: string;
    }>(
      admin(),
      sql`select direction::text, status::text, placed_by, from_e164, conversation_id from app.calls where id = ${started.callId}`,
    );
    expect(row).toMatchObject({
      direction: 'outbound',
      status: 'initiated',
      placed_by: member.id,
      from_e164: businessNumber,
      conversation_id: started.conversationId,
    });

    const callSid = sid();
    const link = {
      workspaceId: wsId,
      providerSid: callSid,
      direction: 'outbound',
      from: businessNumber,
      to: MIKE,
      callId: started.callId,
      status: 'in_progress',
    };
    expect(await sys(callRecord, link)).toMatchObject({ callId: started.callId, duplicate: false });
    expect((await sys(callRecord, link)).duplicate).toBe(true);
    // Mike picks up, they talk for 4:12, and a stale "ringing" arrives late.
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      callId: started.callId,
      status: 'in_progress',
      answeredNumber: MIKE,
    });
    expect(
      await sys(callUpdateStatus, {
        workspaceId: wsId,
        providerSid: callSid,
        status: 'completed',
        durationSeconds: 252,
      }),
    ).toMatchObject({ status: 'completed', changed: true });
    expect(
      await sys(callUpdateStatus, { workspaceId: wsId, providerSid: callSid, status: 'ringing' }),
    ).toMatchObject({ status: 'completed', changed: false });

    const got = await ask(
      conversationGet,
      { workspaceId: wsId, conversationId: started.conversationId },
      member,
    );
    expect(got.conversation.lastPreview).toBe('Call · 4:12');
    expect(got.conversation.awaitingReplySince).toBeNull();
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: started.conversationId, limit: 10 },
      member,
    );
    expect(thread.items.find((i) => i.type === 'call')).toMatchObject({
      direction: 'outbound',
      status: 'completed',
      durationSeconds: 252,
    });
    const timeline = await ask(
      timelineList,
      { workspaceId: wsId, recordType: 'person', recordId: mikeId, limit: 10 },
      member,
    );
    expect(timeline.items.find((e) => e.kind === 'call')).toMatchObject({
      subtype: 'outbound',
      // The worker settles the call, but the row credits the teammate who placed it.
      actor: expect.objectContaining({ id: member.id }),
      meta: expect.objectContaining({ direction: 'outbound', durationSeconds: 252 }),
    });
  });

  it('a missed call from an unknown number waits for a reply, then its voicemail and words arrive', async () => {
    const callSid = sid();
    const rec = await sys(callRecord, {
      workspaceId: wsId,
      providerSid: callSid,
      direction: 'inbound',
      from: STRANGER,
      to: businessNumber,
    });
    expect(rec.duplicate).toBe(false);
    // Twilio's own "in progress" (it is running our instructions) is not an answer.
    await sys(callUpdateStatus, { workspaceId: wsId, providerSid: callSid, status: 'in_progress' });
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      providerSid: callSid,
      status: 'completed',
      durationSeconds: 55,
    });
    let got = await ask(
      conversationGet,
      { workspaceId: wsId, conversationId: rec.conversationId! },
      member,
    );
    expect(got.conversation).toMatchObject({
      person: null,
      lastPreview: 'Missed call',
      unreadCount: 1,
      status: 'open',
    });
    expect(got.conversation.awaitingReplySince).not.toBeNull();

    await sys(callAttachRecording, {
      workspaceId: wsId,
      providerSid: callSid,
      recordingSid: 'REfakevoicemail',
      objectPath: `${wsId}/calls/${rec.callId}/voicemail.mp3`,
      seconds: 48,
    });
    await sys(callAttachTranscript, {
      workspaceId: wsId,
      providerSid: callSid,
      transcript: 'Hi, the AC is blowing warm air again. Please call me back.',
      status: 'completed',
    });
    got = await ask(
      conversationGet,
      { workspaceId: wsId, conversationId: rec.conversationId! },
      member,
    );
    expect(got.conversation.lastPreview).toBe(
      'Voicemail, 0:48: “Hi, the AC is blowing warm air again. Please call me back.”',
    );
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: rec.conversationId!, limit: 10 },
      member,
    );
    expect(thread.items[0]).toMatchObject({
      type: 'call',
      isVoicemail: true,
      hasRecording: true,
      transcript: 'Hi, the AC is blowing warm air again. Please call me back.',
    });
    const events = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where entity_id = ${rec.callId} order by created_at, event_type`,
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'call.received',
      'call.missed',
      'call.voicemail_left',
      'call.transcribed',
    ]);
  });

  it('a customer’s answered call and a missed one with a voicemail land on their timeline', async () => {
    const answered = sid();
    await sys(callRecord, {
      workspaceId: wsId,
      providerSid: answered,
      direction: 'inbound',
      from: MIKE,
      to: businessNumber,
    });
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      providerSid: answered,
      status: 'in_progress',
      answeredVia: 'browser',
      answeredByUserId: owner.id,
    });
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      providerSid: answered,
      status: 'completed',
      durationSeconds: 161,
    });

    const missed = sid();
    await sys(callRecord, {
      workspaceId: wsId,
      providerSid: missed,
      direction: 'inbound',
      from: MIKE,
      to: businessNumber,
    });
    await sys(callUpdateStatus, { workspaceId: wsId, providerSid: missed, status: 'no_answer' });
    await sys(callAttachRecording, {
      workspaceId: wsId,
      providerSid: missed,
      recordingSid: 'REfakemike',
      objectPath: `${wsId}/calls/voicemail-mike.mp3`,
      seconds: 32,
    });

    const timeline = await ask(
      timelineList,
      { workspaceId: wsId, recordType: 'person', recordId: mikeId, limit: 20 },
      member,
    );
    const calls = timeline.items.filter((e) => e.kind === 'call');
    expect(calls.map((e) => e.subtype)).toEqual(
      expect.arrayContaining(['answered', 'voicemail', 'outbound']),
    );
    expect(calls.find((e) => e.subtype === 'answered')?.meta).toMatchObject({
      answeredVia: 'browser',
      answeredByUserId: owner.id,
      durationSeconds: 161,
    });
    expect(calls.find((e) => e.subtype === 'voicemail')?.meta).toMatchObject({
      voicemail: true,
      recordingSeconds: 32,
    });
  });

  it('stay inside the workspace, and the worker’s side stays with the worker', async () => {
    await expectHfos(
      () => run(callStart, { workspaceId: wsId, personId: mikeId }, outsider),
      'not_found',
    );
    await expectHfos(
      () => run(callStart, { workspaceId: wsId, personId: noPhoneId }, owner),
      'rule_violation',
      'no_phone',
    );
    await expectHfos(
      () => run(callStart, { workspaceId: wsId, toPhone: businessNumber }, owner),
      'rule_violation',
      'own_number',
    );
    await expectHfos(
      () =>
        executeCommand(
          db(),
          callRecord,
          {
            workspaceId: wsId,
            providerSid: sid(),
            direction: 'inbound',
            from: STRANGER,
            to: businessNumber,
          },
          human(owner),
          meta(),
        ),
      'forbidden',
    );
    await expectHfos(
      () =>
        sys(callUpdateStatus, {
          workspaceId: wsId,
          providerSid: 'CAnobodyhome',
          status: 'completed',
        }),
      'not_found',
    );
  });
});
