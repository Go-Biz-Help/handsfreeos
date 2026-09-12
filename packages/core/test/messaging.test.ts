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
import { formatClock, localMinutes, quietHoursState } from '../src/messaging/quiet-hours';
import { messagePreview, smsKeyword, smsSegments } from '../src/messaging/sms';
import { readiness } from '../src/messaging/store';
import {
  conversationAssign,
  conversationClose,
  conversationGet,
  conversationLinkPerson,
  conversationMarkRead,
  conversationMarkUnread,
  conversationOpen,
  conversationSnooze,
  conversationThread,
  inboxList,
  inboxSummary,
  messageGet,
  messageReceive,
  messageRetry,
  messageSend,
  messageUpdateStatus,
  organizationCreate,
  personCreate,
  personSetSmsConsent,
  phoneNumberActivate,
  phoneNumberBuy,
  phoneNumberSetRouting,
  phoneSetupStatus,
  phoneUpdateSettings,
  registrationSubmit,
  registrationUpdateStatus,
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
const hhmm = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

const MIKE = '+17135550142';
const UNKNOWN = '+18325550190';
const business = {
  legalName: 'Messaging Test LLC',
  businessType: 'llc',
  ein: '12-3456789',
  website: 'https://example.com',
  address: { line1: '4410 Westpark Dr', city: 'Houston', state: 'tx', postalCode: '77027' },
  contact: {
    firstName: 'Dale',
    lastName: 'Ramsey',
    email: 'dale@example.com',
    phone: '(713) 555-0161',
  },
  useCase: 'customer_care',
  messageSamples: ['Hi Mike, this is Lone Star HVAC. Marco is on the way. Reply STOP to opt out.'],
  optInDescription:
    'Customers give us their cell number when they book a visit and agree to texts about it.',
  monthlyVolume: 'under_1000',
};

let owner: TestUser;
let adminUser: TestUser;
let member: TestUser;
let outsider: TestUser;
let orgId: string;
let wsId: string;
let mikeId: string;
let patId: string;
let numberId: string;
let businessNumber: string;
let mikeConversation: string;
let unknownConversation: string;

beforeAll(async () => {
  [owner, adminUser, member, outsider] = await Promise.all([
    createTestUser('msg-owner'),
    createTestUser('msg-admin'),
    createTestUser('msg-member'),
    createTestUser('msg-outsider'),
  ]);
  const org = await run(
    organizationCreate,
    { businessName: 'Texting Test Co', organizationName: 'Texting Agency' },
    owner,
  );
  orgId = org.organizationId;
  wsId = org.workspaceId;
  await run(organizationCreate, { businessName: 'Someone Else Co' }, outsider);
  for (const [u, role] of [
    [adminUser, 'admin'],
    [member, 'member'],
  ] as const)
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${u.id}, ${role})`,
    );
  mikeId = (
    await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Mike', lastName: 'Johnson', phone: '(713) 555-0142' },
      owner,
    )
  ).personId;
  patId = (
    await run(personCreate, { workspaceId: wsId, firstName: 'Pat', lastName: 'Rivera' }, owner)
  ).personId;
});
afterAll(closeTestDbs);

describe('texting rules that run in the browser too', () => {
  it('counts segments the way carriers do', () => {
    expect(smsSegments('a'.repeat(160))).toMatchObject({ encoding: 'gsm7', segments: 1 });
    expect(smsSegments('a'.repeat(161))).toMatchObject({
      encoding: 'gsm7',
      segments: 2,
      perSegment: 153,
    });
    expect(smsSegments('{}'.repeat(40)).units).toBe(160);
    expect(smsSegments('Café ☀'.repeat(12))).toMatchObject({ encoding: 'ucs2', segments: 2 });
    expect(smsSegments('')).toMatchObject({ segments: 0 });
  });

  it('recognises carrier keywords only when they are the whole text', () => {
    expect(smsKeyword('Stop.')).toBe('stop');
    expect(smsKeyword(' unsubscribe ')).toBe('stop');
    expect(smsKeyword('Yes')).toBe('start');
    expect(smsKeyword('HELP')).toBe('help');
    expect(smsKeyword('Stop by tomorrow?')).toBeNull();
    expect(messagePreview('', 2)).toBe('Sent 2 photos');
  });

  it('works out quiet hours in the business’s time zone, across midnight', () => {
    const window = { enabled: true, start: '20:00', end: '08:00' };
    // 02:30 UTC is 21:30 in Chicago during daylight time.
    expect(quietHoursState(window, 'America/Chicago', new Date('2026-09-11T02:30:00Z'))).toEqual({
      quiet: true,
      localTime: '21:30',
      endsAt: '08:00',
    });
    expect(quietHoursState(window, 'America/Chicago', new Date('2026-09-11T18:00:00Z')).quiet).toBe(
      false,
    );
    expect(quietHoursState({ ...window, enabled: false }, 'America/Chicago').quiet).toBe(false);
    expect(formatClock('20:00')).toBe('8:00 PM');
    expect(formatClock('00:15')).toBe('12:15 AM');
  });

  it('knows when texting is ready', () => {
    const tollFree = { status: 'active', numberType: 'toll_free' };
    const local = { status: 'active', numberType: 'local' };
    expect(readiness(null, []).nextStep).toBe('buy_number');
    expect(readiness({ ...tollFree, status: 'provisioning' }, []).nextStep).toBe('provisioning');
    expect(readiness(tollFree, [])).toEqual({
      voiceReady: true,
      messagingReady: false,
      nextStep: 'submit_registration',
    });
    expect(
      readiness(tollFree, [{ kind: 'toll_free_verification', status: 'approved' }]).messagingReady,
    ).toBe(true);
    const chain = ['a2p_customer_profile', 'a2p_trust_product', 'a2p_brand', 'a2p_campaign'];
    expect(
      readiness(
        local,
        chain.map((kind) => ({ kind, status: 'approved' })),
      ).nextStep,
    ).toBe('ready');
    expect(
      readiness(
        local,
        chain.map((kind, i) => ({ kind, status: i === 3 ? 'in_review' : 'approved' })),
      ).nextStep,
    ).toBe('awaiting_approval');
    expect(readiness(local, [{ kind: 'a2p_brand', status: 'rejected' }]).nextStep).toBe('rejected');
  });
});

describe('the business number and carrier approval', () => {
  it('only owners and admins buy a number, and a workspace has one', async () => {
    businessNumber = randomE164();
    await expectHfos(
      () =>
        run(
          phoneNumberBuy,
          { workspaceId: wsId, e164: businessNumber, numberType: 'toll_free' },
          member,
        ),
      'forbidden',
    );
    numberId = (
      await run(
        phoneNumberBuy,
        { workspaceId: wsId, e164: businessNumber, numberType: 'toll_free' },
        owner,
      )
    ).phoneNumberId;
    const status = await ask(phoneSetupStatus, { workspaceId: wsId }, owner);
    expect(status).toMatchObject({ nextStep: 'provisioning', voiceReady: false, canManage: true });
    expect(status.number?.status).toBe('provisioning');
    expect((await ask(phoneSetupStatus, { workspaceId: wsId }, member)).canManage).toBe(false);
    await expectHfos(
      () =>
        run(
          phoneNumberBuy,
          { workspaceId: wsId, e164: randomE164(), numberType: 'local' },
          adminUser,
        ),
      'rule_violation',
      'number_exists',
    );
    // People cannot pose as the worker.
    await expectHfos(
      () =>
        executeCommand(
          db(),
          phoneNumberActivate,
          {
            workspaceId: wsId,
            phoneNumberId: numberId,
            providerSid: 'PNfake',
            accountId: randomUUID(),
          },
          human(owner),
          meta(),
        ),
      'forbidden',
    );
  });

  it('calls work once the worker activates the number; texting waits for the carriers', async () => {
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
      phoneNumberId: numberId,
      providerSid: `PNfake${randomUUID().slice(0, 8)}`,
      accountId: account!.id,
      capabilities: { sms: true, voice: true, mms: true },
    });
    const status = await ask(phoneSetupStatus, { workspaceId: wsId }, owner);
    expect(status).toMatchObject({
      nextStep: 'submit_registration',
      voiceReady: true,
      messagingReady: false,
      accountStatus: 'active',
    });
    await run(
      phoneUpdateSettings,
      { workspaceId: wsId, quietHours: { enabled: false, start: '20:00', end: '08:00' } },
      owner,
    );
    await expectHfos(
      () => run(messageSend, { workspaceId: wsId, personId: mikeId, body: 'Hi Mike' }, member),
      'rule_violation',
      'messaging_not_ready',
    );
  });

  it('a registration matches the number type and stays in review until the carrier answers', async () => {
    // Local numbers need two example texts before the number type is even checked.
    await expectHfos(
      () => run(registrationSubmit, { workspaceId: wsId, kind: 'a2p_10dlc', business }, owner),
      'validation',
    );
    const twoSamples = {
      ...business,
      messageSamples: [
        ...business.messageSamples,
        'Hi Mike, your estimate is ready. Reply with questions or STOP to opt out.',
      ],
    };
    await expectHfos(
      () =>
        run(
          registrationSubmit,
          { workspaceId: wsId, kind: 'a2p_10dlc', business: twoSamples },
          owner,
        ),
      'rule_violation',
      'registration_kind_mismatch',
    );
    await expectHfos(
      () =>
        run(
          registrationSubmit,
          {
            workspaceId: wsId,
            kind: 'toll_free_verification',
            business: { ...business, ein: null },
          },
          owner,
        ),
      'validation',
    );
    const { registrationIds } = await run(
      registrationSubmit,
      { workspaceId: wsId, kind: 'toll_free_verification', business },
      owner,
    );
    expect(registrationIds).toHaveLength(1);
    const registrationId = registrationIds[0]!;
    expect((await ask(phoneSetupStatus, { workspaceId: wsId }, owner)).nextStep).toBe(
      'awaiting_approval',
    );
    await expectHfos(
      () =>
        run(
          registrationSubmit,
          { workspaceId: wsId, kind: 'toll_free_verification', business },
          owner,
        ),
      'rule_violation',
      'registration_in_review',
    );
    const rejected = await sys(registrationUpdateStatus, {
      workspaceId: wsId,
      registrationId,
      status: 'rejected',
      rejectionReason: 'Opt-in is not shown on the website.',
    });
    expect(rejected.changed).toBe(true);
    const afterReject = await ask(phoneSetupStatus, { workspaceId: wsId }, owner);
    expect(afterReject.nextStep).toBe('rejected');
    expect(afterReject.registrations[0]?.rejectionReason).toBe(
      'Opt-in is not shown on the website.',
    );
    const again = await run(
      registrationSubmit,
      {
        workspaceId: wsId,
        kind: 'toll_free_verification',
        business: { ...business, website: 'https://example.com/texts' },
      },
      owner,
    );
    expect(again.registrationIds).toEqual([registrationId]);
    await sys(registrationUpdateStatus, { workspaceId: wsId, registrationId, status: 'approved' });
    const ready = await ask(phoneSetupStatus, { workspaceId: wsId }, member);
    expect(ready).toMatchObject({ nextStep: 'ready', messagingReady: true });
    expect(ready.registrations[0]?.rejectionReason).toBeNull();
    await expectHfos(
      () =>
        run(
          registrationSubmit,
          { workspaceId: wsId, kind: 'toll_free_verification', business },
          owner,
        ),
      'rule_violation',
      'registration_approved',
    );
    const events = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where entity_id = ${registrationId} order by created_at`,
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'registration.submitted',
      'registration.status_changed',
      'registration.submitted',
      'registration.status_changed',
    ]);
  });

  it('up to three phones ring with the browsers, never the business number itself', async () => {
    const phone = (e164: string, label: string) => ({ e164, label, enabled: true });
    const routing = (forwarding: object[]) => ({
      workspaceId: wsId,
      phoneNumberId: numberId,
      routing: {
        forwarding,
        ringSeconds: 20,
        voicemailEnabled: true,
        voicemailGreeting: 'Leave a message.',
      },
    });
    await expectHfos(
      () =>
        run(
          phoneNumberSetRouting,
          routing(
            ['(713) 555-0101', '(713) 555-0102', '(713) 555-0103', '(713) 555-0104'].map((p, i) =>
              phone(p, `P${i}`),
            ),
          ),
          owner,
        ),
      'validation',
    );
    await expectHfos(
      () => run(phoneNumberSetRouting, routing([phone(businessNumber, 'Loop')]), owner),
      'validation',
    );
    await run(
      phoneNumberSetRouting,
      routing([phone('(713) 555-0161', 'Dale’s cell'), phone('713.555.0102', 'Office')]),
      owner,
    );
    const status = await ask(phoneSetupStatus, { workspaceId: wsId }, member);
    expect(status.number?.routing.forwarding.map((f) => f.e164)).toEqual([
      '+17135550161',
      '+17135550102',
    ]);
    expect(status.settings).toMatchObject({
      quietHours: { enabled: false },
      unansweredReminderMinutes: 10,
    });
  });
});

describe('texts in and out', () => {
  let firstMessage: string;

  it('a teammate texts a customer: queued once, on their timeline, with the event recorded', async () => {
    const sent = await run(
      messageSend,
      {
        workspaceId: wsId,
        personId: mikeId,
        body: 'Hi Mike, your estimate is ready.',
        clientId: 'c-1',
      },
      member,
    );
    expect(sent).toMatchObject({ status: 'queued', duplicate: false });
    firstMessage = sent.messageId;
    mikeConversation = sent.conversationId;
    const twice = await run(
      messageSend,
      {
        workspaceId: wsId,
        conversationId: mikeConversation,
        body: 'Hi Mike, your estimate is ready.',
        clientId: 'c-1',
      },
      member,
    );
    expect(twice).toMatchObject({ messageId: firstMessage, duplicate: true });
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: mikeConversation },
      owner,
    );
    expect(thread.items).toHaveLength(1);
    expect(thread.items[0]).toMatchObject({
      type: 'message',
      direction: 'outbound',
      status: 'queued',
      body: 'Hi Mike, your estimate is ready.',
      sentBy: { id: member.id },
    });
    const timeline = await ask(
      timelineList,
      { workspaceId: wsId, recordType: 'person', recordId: mikeId },
      owner,
    );
    expect(timeline.items[0]).toMatchObject({ kind: 'sms', subtype: 'outbound' });
    const [event] = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where entity_id = ${firstMessage}`,
    );
    expect(event?.event_type).toBe('message.queued');
  });

  it('delivery status only moves forward', async () => {
    const step = (status: string) =>
      sys(messageUpdateStatus, {
        workspaceId: wsId,
        messageId: firstMessage,
        providerMessageId: 'SMfake-first',
        status,
      });
    expect(await step('sent')).toMatchObject({ status: 'sent', changed: true });
    expect(await step('delivered')).toMatchObject({ status: 'delivered', changed: true });
    expect(await step('sent')).toMatchObject({ status: 'delivered', changed: false });
    const byProviderId = await sys(messageUpdateStatus, {
      workspaceId: wsId,
      providerMessageId: 'SMfake-first',
      status: 'delivered',
    });
    expect(byProviderId.changed).toBe(false);
    const { message } = await ask(
      messageGet,
      { workspaceId: wsId, messageId: firstMessage },
      member,
    );
    expect(message.status).toBe('delivered');
    expect(message.deliveredAt).not.toBeNull();
  });

  it('an unknown number texts in: a new conversation, unread, a reminder scheduled, replays ignored', async () => {
    const providerMessageId = `SMfake-${randomUUID()}`;
    const input = {
      workspaceId: wsId,
      provider: 'fake',
      providerMessageId,
      from: UNKNOWN,
      to: businessNumber,
      body: 'Do you do gutter cleaning?',
    };
    const first = await sys(messageReceive, input);
    expect(first).toMatchObject({ duplicate: false, keyword: null });
    unknownConversation = first.conversationId;
    const replay = await sys(messageReceive, input);
    expect(replay).toMatchObject({ duplicate: true, messageId: first.messageId });
    const { items } = await ask(inboxList, { workspaceId: wsId, box: 'unassigned' }, member);
    const row = items.find((c) => c.id === unknownConversation)!;
    expect(row).toMatchObject({
      person: null,
      unreadCount: 1,
      lastDirection: 'inbound',
      counterpartDisplay: '(832) 555-0190',
    });
    expect(row.awaitingReplySince).not.toBeNull();
    const jobs = await rows<{ run_at: Date }>(
      admin(),
      sql`select run_at from app.scheduled_jobs where dedupe_key = ${`unanswered:${unknownConversation}`} and status = 'pending'`,
    );
    expect(jobs).toHaveLength(1);
  });

  it('a text from a known customer lands in their conversation and on their timeline', async () => {
    const got = await sys(messageReceive, {
      workspaceId: wsId,
      provider: 'fake',
      providerMessageId: `SMfake-${randomUUID()}`,
      from: MIKE,
      to: businessNumber,
      body: 'Thanks! Can someone come out today?',
    });
    expect(got.conversationId).toBe(mikeConversation);
    const timeline = await ask(
      timelineList,
      { workspaceId: wsId, recordType: 'person', recordId: mikeId },
      member,
    );
    expect(timeline.items[0]).toMatchObject({
      kind: 'sms',
      subtype: 'inbound',
      body: 'Thanks! Can someone come out today?',
    });
    const detail = await ask(
      conversationGet,
      { workspaceId: wsId, conversationId: mikeConversation },
      member,
    );
    expect(detail.conversation).toMatchObject({
      unreadCount: 1,
      lastDirection: 'inbound',
      person: { id: mikeId, fullName: 'Mike Johnson' },
    });
    expect(detail.canText).toEqual({ ok: true, reason: null });
    const summary = await ask(inboxSummary, { workspaceId: wsId }, owner);
    expect(summary.unread.all).toBe(2);
    expect(summary.waitingThresholdMinutes).toBe(10);
  });

  it('STOP opts the customer out until they text START', async () => {
    const text = (body: string) =>
      sys(messageReceive, {
        workspaceId: wsId,
        provider: 'fake',
        providerMessageId: `SMfake-${randomUUID()}`,
        from: MIKE,
        to: businessNumber,
        body,
      });
    expect((await text('Stop')).keyword).toBe('stop');
    const [consent] = await rows<{ sms_consent: string }>(
      admin(),
      sql`select sms_consent::text as sms_consent from app.people where id = ${mikeId}`,
    );
    expect(consent?.sms_consent).toBe('opted_out');
    await expectHfos(
      () =>
        run(
          messageSend,
          { workspaceId: wsId, conversationId: mikeConversation, body: 'Hello?' },
          member,
        ),
      'rule_violation',
      'opted_out',
    );
    expect(
      (await ask(conversationGet, { workspaceId: wsId, conversationId: mikeConversation }, member))
        .canText,
    ).toEqual({
      ok: false,
      reason: 'opted_out',
    });
    expect((await text('START')).keyword).toBe('start');
    const sent = await run(
      messageSend,
      { workspaceId: wsId, conversationId: mikeConversation, body: 'Welcome back!' },
      member,
    );
    expect(sent.status).toBe('queued');
  });

  it('quiet hours ask people to confirm and always stop automated texts', async () => {
    const local = localMinutes(new Date(), 'America/Chicago');
    await run(
      phoneUpdateSettings,
      {
        workspaceId: wsId,
        quietHours: { enabled: true, start: hhmm(local - 60), end: hhmm(local + 60) },
      },
      owner,
    );
    const quiet = await expectHfos(
      () =>
        run(
          messageSend,
          { workspaceId: wsId, conversationId: mikeConversation, body: 'Late note' },
          member,
        ),
      'rule_violation',
      'quiet_hours',
    );
    expect(quiet.details).toMatchObject({ endsAt: hhmm(local + 60) });
    const ok = await run(
      messageSend,
      {
        workspaceId: wsId,
        conversationId: mikeConversation,
        body: 'Late note',
        acknowledgeQuietHours: true,
      },
      member,
    );
    expect(ok.status).toBe('queued');
    await expectHfos(
      () =>
        sys(messageSend, {
          workspaceId: wsId,
          conversationId: mikeConversation,
          body: 'Reminder',
          acknowledgeQuietHours: true,
        }),
      'rule_violation',
      'quiet_hours',
    );
    await run(
      phoneUpdateSettings,
      { workspaceId: wsId, quietHours: { enabled: false, start: '20:00', end: '08:00' } },
      owner,
    );
  });

  it('a failed text can be sent again; a carrier STOP report opts the number out', async () => {
    const other = '+17135550177';
    const sent = await run(
      messageSend,
      { workspaceId: wsId, toPhone: '(713) 555-0177', body: 'Your technician is on the way.' },
      member,
    );
    await sys(messageUpdateStatus, {
      workspaceId: wsId,
      messageId: sent.messageId,
      status: 'failed',
      errorCode: '30006',
      errorMessage: 'Landline',
    });
    await expectHfos(
      () => run(messageRetry, { workspaceId: wsId, messageId: firstMessage }, member),
      'rule_violation',
      'message_not_failed',
    );
    await run(messageRetry, { workspaceId: wsId, messageId: sent.messageId }, member);
    expect(
      (await ask(messageGet, { workspaceId: wsId, messageId: sent.messageId }, member)).message,
    ).toMatchObject({
      status: 'queued',
      errorCode: null,
    });
    await sys(messageUpdateStatus, {
      workspaceId: wsId,
      messageId: sent.messageId,
      status: 'failed',
      errorCode: '21610',
    });
    const [opt] = await rows<{ opted_out: boolean; source: string }>(
      admin(),
      sql`select opted_out, source::text as source from app.opt_outs where workspace_id = ${wsId} and counterpart_e164 = ${other}`,
    );
    expect(opt).toEqual({ opted_out: true, source: 'carrier_error' });
    await expectHfos(
      () => run(messageSend, { workspaceId: wsId, toPhone: other, body: 'Again' }, member),
      'rule_violation',
      'opted_out',
    );
  });

  it('attachments must be finished uploads in this workspace', async () => {
    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            conversationId: mikeConversation,
            body: 'Photo',
            attachmentFileIds: [randomUUID()],
          },
          member,
        ),
      'validation',
    );
  });
});

describe('working the inbox', () => {
  it('assign, snooze, close; a new text brings the conversation back', async () => {
    const receive = (body: string) =>
      sys(messageReceive, {
        workspaceId: wsId,
        provider: 'fake',
        providerMessageId: `SMfake-${randomUUID()}`,
        from: UNKNOWN,
        to: businessNumber,
        body,
      });
    await run(
      conversationAssign,
      { workspaceId: wsId, conversationId: unknownConversation, assigneeUserId: member.id },
      owner,
    );
    const mine = await ask(inboxList, { workspaceId: wsId, box: 'mine' }, member);
    expect(mine.items.map((c) => c.id)).toContain(unknownConversation);
    await expectHfos(
      () =>
        run(
          conversationAssign,
          { workspaceId: wsId, conversationId: unknownConversation, assigneeUserId: outsider.id },
          owner,
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          conversationSnooze,
          {
            workspaceId: wsId,
            conversationId: unknownConversation,
            until: new Date(Date.now() - 60_000).toISOString(),
          },
          member,
        ),
      'validation',
    );
    await run(
      conversationSnooze,
      {
        workspaceId: wsId,
        conversationId: unknownConversation,
        until: new Date(Date.now() + 3_600_000).toISOString(),
      },
      member,
    );
    const open = await ask(inboxList, { workspaceId: wsId }, member);
    expect(open.items.map((c) => c.id)).not.toContain(unknownConversation);
    const snoozed = await ask(inboxList, { workspaceId: wsId, status: 'snoozed' }, member);
    expect(snoozed.items.map((c) => c.id)).toContain(unknownConversation);
    await receive('Hello? Still need that quote.');
    const back = await ask(
      conversationGet,
      { workspaceId: wsId, conversationId: unknownConversation },
      member,
    );
    expect(back.conversation).toMatchObject({
      status: 'open',
      snoozedUntil: null,
      unreadCount: 2,
      assignee: { id: member.id },
    });
    await run(
      conversationClose,
      { workspaceId: wsId, conversationId: unknownConversation },
      member,
    );
    expect(
      (
        await ask(
          conversationGet,
          { workspaceId: wsId, conversationId: unknownConversation },
          member,
        )
      ).conversation.status,
    ).toBe('closed');
    await receive('One more thing');
    expect(
      (
        await ask(
          conversationGet,
          { workspaceId: wsId, conversationId: unknownConversation },
          member,
        )
      ).conversation.status,
    ).toBe('open');
  });

  it('marks read and unread for the whole team', async () => {
    await run(
      conversationMarkRead,
      { workspaceId: wsId, conversationId: unknownConversation },
      member,
    );
    expect(
      (
        await ask(
          conversationGet,
          { workspaceId: wsId, conversationId: unknownConversation },
          owner,
        )
      ).conversation.unreadCount,
    ).toBe(0);
    await run(
      conversationMarkUnread,
      { workspaceId: wsId, conversationId: unknownConversation },
      owner,
    );
    expect(
      (
        await ask(
          conversationGet,
          { workspaceId: wsId, conversationId: unknownConversation },
          member,
        )
      ).conversation.unreadCount,
    ).toBe(1);
  });

  it('links an unknown number to a customer, who gains the number', async () => {
    const linked = await run(
      conversationLinkPerson,
      { workspaceId: wsId, conversationId: unknownConversation, personId: patId },
      member,
    );
    expect(linked).toEqual({
      conversationId: unknownConversation,
      personId: patId,
      phoneAdded: true,
    });
    const detail = await ask(
      conversationGet,
      { workspaceId: wsId, conversationId: unknownConversation },
      member,
    );
    expect(detail.person).toMatchObject({ id: patId, fullName: 'Pat Rivera', phoneE164: UNKNOWN });
    const [event] = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where entity_id = ${unknownConversation} and event_type = 'conversation.linked'`,
    );
    expect(event).toBeDefined();
  });

  it('people record a customer’s texting choice by hand', async () => {
    expect(
      (
        await run(
          personSetSmsConsent,
          { workspaceId: wsId, personId: patId, consent: 'opted_out' },
          member,
        )
      ).consent,
    ).toBe('opted_out');
    expect(
      (
        await ask(
          conversationGet,
          { workspaceId: wsId, conversationId: unknownConversation },
          member,
        )
      ).canText.reason,
    ).toBe('opted_out');
    await run(
      personSetSmsConsent,
      { workspaceId: wsId, personId: patId, consent: 'opted_in' },
      member,
    );
    expect(
      (
        await ask(
          conversationGet,
          { workspaceId: wsId, conversationId: unknownConversation },
          member,
        )
      ).canText.ok,
    ).toBe(true);
  });

  it('opens a customer’s conversation, and says why when it cannot', async () => {
    expect(
      await run(conversationOpen, { workspaceId: wsId, personId: mikeId, channel: 'sms' }, member),
    ).toEqual({
      conversationId: mikeConversation,
      created: false,
    });
    const nobody = (
      await run(personCreate, { workspaceId: wsId, firstName: 'No', lastName: 'Phone' }, owner)
    ).personId;
    await expectHfos(
      () => run(conversationOpen, { workspaceId: wsId, personId: nobody, channel: 'sms' }, member),
      'rule_violation',
      'no_phone',
    );
  });

  it('filters, searches and pages the list', async () => {
    const first = await ask(inboxList, { workspaceId: wsId, limit: 1 }, member);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await ask(
      inboxList,
      { workspaceId: wsId, limit: 1, cursor: first.nextCursor },
      member,
    );
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    const byName = await ask(inboxList, { workspaceId: wsId, q: 'mike' }, member);
    expect(byName.items.map((c) => c.id)).toEqual([mikeConversation]);
    const byDigits = await ask(inboxList, { workspaceId: wsId, q: '555-0190' }, member);
    expect(byDigits.items.map((c) => c.id)).toEqual([unknownConversation]);
    expect((await ask(inboxList, { workspaceId: wsId, channel: 'email' }, member)).items).toEqual(
      [],
    );
  });

  it('keeps other workspaces and worker-only commands out of reach', async () => {
    await expectHfos(() => ask(inboxList, { workspaceId: wsId }, outsider), 'not_found');
    await expectHfos(
      () =>
        ask(conversationThread, { workspaceId: wsId, conversationId: mikeConversation }, outsider),
      'not_found',
    );
    await expectHfos(
      () =>
        run(
          messageReceive,
          {
            workspaceId: wsId,
            provider: 'fake',
            providerMessageId: 'SMfake-x',
            from: MIKE,
            to: businessNumber,
            body: 'hi',
          },
          member,
        ),
      'forbidden',
    );
  });
});
