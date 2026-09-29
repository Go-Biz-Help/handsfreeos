/**
 * M10 step 6b on the local database: calling customers through your own cell.
 * - **My cell phone:** a person sets their cell and HandsFreeOS asks the worker to call it from the business number;
 *   only the worker verifies; a different number takes the place of the one before; a few calls an hour and a day,
 *   however often the number changes; nobody else sees it.
 * - **call.connect_me:** needs a verified cell and the inbox; dials only numbers the business already has; one call
 *   through a cell at a time (pressing Call twice is the same call); online only from a phone, and a repeat runs once.
 * - **Where it lands:** a call nobody pressed 1 on never reaches the customer's conversation or timeline; one that
 *   connected reads "Dale called · 2:14"; and the statuses the app shows.
 * - **call.cancel_connect** (step 7): the person's own call, before the customer picks up; it ends at once so they can
 *   call again, asks the worker to hang up, and a customer whose phone already rang gets it filed as not answered.
 * - **Business caller ID on forwarded calls:** its own command, kept when routing is saved, shown in setup status.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  activities,
  calls,
  conversations,
  events,
  phoneNumbers,
  userPhones,
} from '@hfos/db/schema';
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
import { bridgeStatusOf, bridgeStatusWords } from '../src/messaging/bridge';
import {
  callCancelConnect,
  callConnectMe,
  callRecord,
  callUpdateStatus,
  conversationThread,
  organizationCreate,
  personArchive,
  personCreate,
  phoneNumberSetCallerId,
  phoneNumberSetRouting,
  phoneSetupStatus,
  registry,
  userPhoneRecordCall,
  userPhoneStartVerification,
  userPhoneVerify,
  VERIFY_CALLS_PER_DAY,
  VERIFY_CALLS_PER_HOUR,
} from '../src/server';

const MIN = 60_000;
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
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());
const system = (): SystemActor => ({ type: 'system', workspaceId: wsId, organizationId: orgId });
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(testDbs().worker.db, cmd, input, system(), meta()).then((r) => r.output);
/** A command from the phone: its own id and the moment it was done. */
const phoneMeta = (commandId: string, occurredAt = new Date()): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'mobile',
  commandId,
  occurredAt,
  sentAt: new Date(),
  confirmedAt: null,
  appVersion: '1.0.0',
});

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

const uniq = () => randomUUID().slice(0, 8);
let seq = 0;
/** A number nobody else in the local database holds. */
const nextPhone = (area = '512') =>
  `+1${area}${String(2000000 + ((Date.now() + seq++ * 7919) % 7999999)).padStart(7, '0')}`;
const MIKE = '+17135550142';

let dale: TestUser;
let marco: TestUser;
let priya: TestUser;
let outsider: TestUser;
let orgId: string;
let wsId: string;
let noNumberWs: string;
let numberId: string;
let businessNumber: string;
let mikeId: string;

const phonesOf = (u: TestUser) =>
  admin().select().from(userPhones).where(eq(userPhones.userId, u.id));
const requestsOf = (u: TestUser) =>
  admin()
    .select()
    .from(events)
    .where(
      and(eq(events.actorId, u.id), eq(events.eventType, 'user_phone.verification_requested')),
    );

/** A verified cell, the way the worker leaves one. */
async function verifiedCell(u: TestUser): Promise<string> {
  const phone = nextPhone();
  const { userPhoneId } = await run(userPhoneStartVerification, { workspaceId: wsId, phone }, u);
  await sys(userPhoneRecordCall, { workspaceId: wsId, userPhoneId });
  await sys(userPhoneVerify, { workspaceId: wsId, userPhoneId });
  return phone;
}

beforeAll(async () => {
  [dale, marco, priya, outsider] = await Promise.all([
    createTestUser('cell-dale', { fullName: 'Dale Owner' }),
    createTestUser('cell-marco', { fullName: 'Marco Member' }),
    createTestUser('cell-priya', { fullName: 'Priya Admin' }),
    createTestUser('cell-outsider'),
  ]);
  const org = await run(organizationCreate, { businessName: 'Cell Calls HVAC' }, dale);
  orgId = org.organizationId;
  wsId = org.workspaceId;
  noNumberWs = (await run(organizationCreate, { businessName: 'No Number Yet Co' }, outsider))
    .workspaceId;
  for (const [u, role] of [
    [marco, 'member'],
    [priya, 'admin'],
  ] as const)
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${u.id}, ${role})`,
    );
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${wsId}, 'fake', ${`ACcell${uniq()}`}, 'active') returning id`,
  );
  businessNumber = nextPhone('713');
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${wsId}, ${account!.id}, ${`PNcell${uniq()}`}, ${businessNumber}, 'toll_free', 'active') returning id`,
  );
  numberId = number!.id;
  mikeId = (
    await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Mike', lastName: 'Johnson', phone: '(713) 555-0142' },
      dale,
    )
  ).personId;
});
afterAll(closeTestDbs);

describe('my cell phone', () => {
  it('asks the worker to call the cell from the business number', async () => {
    const out = await run(
      userPhoneStartVerification,
      { workspaceId: wsId, phone: '(512) 555-0142' },
      marco,
    );
    expect(out).toMatchObject({
      e164: '+15125550142',
      status: 'calling',
      callerId: businessNumber,
    });
    const [row] = await phonesOf(marco);
    expect(row).toMatchObject({
      id: out.userPhoneId,
      e164: '+15125550142',
      verifiedAt: null,
      verificationCount: 0,
    });
    const asked = await requestsOf(marco);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      workspaceId: wsId,
      entityType: 'user_phone',
      entityId: out.userPhoneId,
    });
  });

  it('pressing Verify again straight away is the call already on its way, and nobody else sees the number', async () => {
    const again = await run(
      userPhoneStartVerification,
      { workspaceId: wsId, phone: '512-555-0142' },
      marco,
    );
    expect(again.status).toBe('calling');
    expect(await requestsOf(marco)).toHaveLength(1);
    const asOwner = await testDbs().api.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: dale.id, role: 'authenticated' })}, true)`,
      );
      await tx.execute(sql`set local role authenticated`);
      return rows(tx, sql`select id from app.user_phones where user_id = ${marco.id}`);
    });
    expect(asOwner).toHaveLength(0);
  });

  it('only the worker verifies; a verified cell answers "verified" and nothing rings', async () => {
    const [row] = await phonesOf(marco);
    const refused = await testDbs()
      .api.db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: marco.id, role: 'authenticated' })}, true)`,
        );
        await tx.execute(sql`set local role authenticated`);
        await tx.execute(sql`update app.user_phones set verified_at = now() where id = ${row!.id}`);
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(refused).toBeTruthy();
    expect(
      (await sys(userPhoneRecordCall, { workspaceId: wsId, userPhoneId: row!.id })).changed,
    ).toBe(true);
    expect(await sys(userPhoneVerify, { workspaceId: wsId, userPhoneId: row!.id })).toEqual({
      userPhoneId: row!.id,
      changed: true,
    });
    expect((await sys(userPhoneVerify, { workspaceId: wsId, userPhoneId: row!.id })).changed).toBe(
      false,
    );
    const [verified] = await phonesOf(marco);
    expect(verified!.verifiedAt).toBeInstanceOf(Date);
    expect(verified!.verificationCount).toBe(1);
    expect(verified!.lastVerificationAt).toBeInstanceOf(Date);
    const again = await run(
      userPhoneStartVerification,
      { workspaceId: wsId, phone: '+15125550142' },
      marco,
    );
    expect(again.status).toBe('verified');
    expect(await requestsOf(marco)).toHaveLength(1);
  });

  it('a different number takes the place of the one before, which is no longer verified', async () => {
    const out = await run(
      userPhoneStartVerification,
      { workspaceId: wsId, phone: '(512) 555-0199' },
      marco,
    );
    expect(out.status).toBe('calling');
    const list = await phonesOf(marco);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ e164: '+15125550199', verifiedAt: null });
  });

  it(`allows ${VERIFY_CALLS_PER_HOUR} calls an hour and ${VERIFY_CALLS_PER_DAY} a day, however often the number changes`, async () => {
    const hourly = await createTestUser('cell-hourly');
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${hourly.id}, 'member')`,
    );
    for (let i = 0; i < VERIFY_CALLS_PER_HOUR; i++)
      await run(userPhoneStartVerification, { workspaceId: wsId, phone: nextPhone() }, hourly);
    const refused = await expectHfos(
      () => run(userPhoneStartVerification, { workspaceId: wsId, phone: nextPhone() }, hourly),
      'rule_violation',
      'verification_limit',
    );
    expect(refused.disposition).toBe('final');
    expect(refused.message).toMatch(
      new RegExp(
        `^You’ve asked for ${VERIFY_CALLS_PER_HOUR} verification calls in the last hour\\. Try again in \\d+ minutes?\\.$`,
      ),
    );
    expect(refused.details).toMatchObject({ retryAfter: expect.any(String) });

    // Six earlier today, none in the last hour: the day's limit.
    const daily = await createTestUser('cell-daily');
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${daily.id}, 'member')`,
    );
    for (let i = 0; i < VERIFY_CALLS_PER_DAY; i++)
      await rows(
        admin(),
        sql`insert into app.events (organization_id, workspace_id, event_type, actor_type, actor_id, entity_type, entity_id, payload, correlation_id, created_at)
            values (${orgId}, ${wsId}, 'user_phone.verification_requested', 'human', ${daily.id}, 'user_phone', ${randomUUID()}, '{}'::jsonb, ${randomUUID()}, now() - interval '3 hours')`,
      );
    const day = await expectHfos(
      () => run(userPhoneStartVerification, { workspaceId: wsId, phone: nextPhone() }, daily),
      'rule_violation',
      'verification_limit',
    );
    expect(day.message).toContain('in the last 24 hours');
    expect(day.message).toMatch(/Try again in 2[01] hours\.$/);
  });

  it('refuses a business number, a business without one, and people outside the business', async () => {
    await expectHfos(
      () => run(userPhoneStartVerification, { workspaceId: wsId, phone: businessNumber }, dale),
      'validation',
    );
    await expectHfos(
      () =>
        run(userPhoneStartVerification, { workspaceId: noNumberWs, phone: nextPhone() }, outsider),
      'rule_violation',
      'no_number',
    );
    await expectHfos(
      () => run(userPhoneStartVerification, { workspaceId: wsId, phone: nextPhone() }, outsider),
      'not_found',
    );
  });

  it('needs signal on a phone', async () => {
    const late = await expectHfos(
      () =>
        executeCommand(
          api(),
          userPhoneStartVerification,
          { workspaceId: wsId, phone: nextPhone() },
          human(priya),
          phoneMeta(randomUUID(), new Date(Date.now() - 3 * MIN)),
        ),
      'rule_violation',
      'online_only',
    );
    expect(late.disposition).toBe('final');
    expect(registry.command('user_phone.start_verification')!.offline).toBe('online');
  });
});

describe('calling a customer through your own cell', () => {
  it('needs a verified cell first', async () => {
    const err = await expectHfos(
      () => run(callConnectMe, { workspaceId: wsId, personId: mikeId }, priya),
      'rule_violation',
      'no_verified_cell',
    );
    expect(err.message).toBe(
      'Verify your cell phone first, under My cell phone in Settings. HandsFreeOS rings it, then connects the customer.',
    );
  });

  it('files a call in the customer’s conversation, marked as through the cell, and asks the worker to ring it', async () => {
    const cell = await verifiedCell(dale);
    const out = await run(callConnectMe, { workspaceId: wsId, personId: mikeId }, dale);
    expect(out).toMatchObject({ to: MIKE, cell, callerId: businessNumber, duplicate: false });
    const [call] = await admin().select().from(calls).where(eq(calls.id, out.callId));
    expect(call).toMatchObject({
      conversationId: out.conversationId,
      personId: mikeId,
      direction: 'outbound',
      status: 'initiated',
      answeredVia: 'bridge',
      answeredByUserId: null,
      placedBy: dale.id,
      fromE164: businessNumber,
      toE164: MIKE,
      phoneNumberId: numberId,
    });
    const [started] = await admin()
      .select()
      .from(events)
      .where(and(eq(events.eventType, 'call.started'), eq(events.entityId, out.callId)));
    expect(started!.payload).toMatchObject({
      via: 'bridge',
      direction: 'outbound',
      personId: mikeId,
    });
    expect(bridgeStatusOf({ ...call!, answeredAt: call!.answeredAt })).toBe('calling_cell');

    // Pressing Call again while it rings is the same call; another customer waits until it ends.
    const again = await run(callConnectMe, { workspaceId: wsId, personId: mikeId }, dale);
    expect(again).toMatchObject({ callId: out.callId, duplicate: true });
    const pat = (
      await run(
        personCreate,
        { workspaceId: wsId, firstName: 'Pat', lastName: 'Rivera', phone: '(713) 555-0177' },
        dale,
      )
    ).personId;
    await expectHfos(
      () => run(callConnectMe, { workspaceId: wsId, personId: pat }, dale),
      'rule_violation',
      'bridge_busy',
    );
  });

  it('only dials a number the business already has', async () => {
    await verifiedCell(marco);
    const unknown = await expectHfos(
      () => run(callConnectMe, { workspaceId: wsId, toPhone: '(832) 555-0190' }, marco),
      'rule_violation',
      'unknown_number',
    );
    expect(unknown.disposition).toBe('final');
    // A number a customer has is fine, typed in or not.
    const byNumber = await run(
      callConnectMe,
      { workspaceId: wsId, toPhone: '713-555-0142' },
      marco,
    );
    expect(byNumber).toMatchObject({ to: MIKE, duplicate: false });
    await admin()
      .update(calls)
      .set({ status: 'canceled', endedAt: new Date() })
      .where(eq(calls.id, byNumber.callId));
    await expectHfos(
      () => run(callConnectMe, { workspaceId: wsId, toPhone: businessNumber }, marco),
      'rule_violation',
      'unknown_number',
    );
    const [marcoCell] = await phonesOf(marco);
    const selfCustomer = (
      await run(
        personCreate,
        {
          workspaceId: wsId,
          firstName: 'Marco',
          lastName: 'Himself',
          phone: marcoCell!.e164,
          ignoreDuplicates: true,
        },
        dale,
      )
    ).personId;
    await expectHfos(
      () => run(callConnectMe, { workspaceId: wsId, personId: selfCustomer }, marco),
      'rule_violation',
      'own_cell',
    );
    const archived = (
      await run(
        personCreate,
        { workspaceId: wsId, firstName: 'Gone', lastName: 'Away', phone: nextPhone('281') },
        dale,
      )
    ).personId;
    await run(personArchive, { workspaceId: wsId, personId: archived }, dale);
    await expectHfos(
      () => run(callConnectMe, { workspaceId: wsId, personId: archived }, marco),
      'rule_violation',
      'person_archived',
    );
    await expectHfos(
      () => run(callConnectMe, { workspaceId: wsId, personId: mikeId }, outsider),
      'not_found',
    );
  });

  it('a call nobody pressed 1 on never reaches the customer’s conversation or timeline', async () => {
    const [before] = await admin()
      .select()
      .from(calls)
      .where(and(eq(calls.placedBy, dale.id), eq(calls.status, 'initiated')));
    const providerSid = `CAcell${uniq()}`;
    await sys(callRecord, {
      workspaceId: wsId,
      providerSid,
      callId: before!.id,
      direction: 'outbound',
      from: businessNumber,
      to: MIKE,
    });
    const [conv] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, before!.conversationId!));
    // Dale's voicemail picked up and nobody pressed 1: the call to his cell ends.
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      providerSid,
      status: 'completed',
      durationSeconds: 21,
    });
    const [after] = await admin().select().from(calls).where(eq(calls.id, before!.id));
    expect(after).toMatchObject({ status: 'completed', activityId: null, answeredAt: null });
    expect(bridgeStatusOf(after!)).toBe('cell_unanswered');
    const [conv2] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, before!.conversationId!));
    expect(conv2!.lastPreview).toBe(conv!.lastPreview);
    expect(conv2!.lastMessageAt).toEqual(conv!.lastMessageAt);
    const types = (await admin().select().from(events).where(eq(events.entityId, before!.id))).map(
      (e) => e.eventType,
    );
    expect(types).toContain('call.bridge_unanswered');
    expect(types).not.toContain('call.missed');
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: before!.conversationId! },
      dale,
    );
    expect(thread.items.find((i) => i.id === before!.id)).toBeUndefined();
  });

  it('pressed and answered: “Dale called · 2:14”, on the timeline and in the thread', async () => {
    const out = await run(callConnectMe, { workspaceId: wsId, personId: mikeId }, dale);
    expect(out.duplicate).toBe(false);
    const providerSid = `CAcell${uniq()}`;
    await sys(callRecord, {
      workspaceId: wsId,
      providerSid,
      callId: out.callId,
      direction: 'outbound',
      from: businessNumber,
      to: MIKE,
    });
    const row = async () =>
      (await admin().select().from(calls).where(eq(calls.id, out.callId)))[0]!;
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      providerSid,
      status: 'ringing',
      answeredByUserId: dale.id,
    });
    expect(await row()).toMatchObject({ answeredAt: null, answeredByUserId: dale.id });
    expect(bridgeStatusOf(await row())).toBe('calling_customer');
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      providerSid,
      status: 'in_progress',
      answeredNumber: MIKE,
    });
    expect(bridgeStatusOf(await row())).toBe('connected');
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      providerSid,
      status: 'completed',
      durationSeconds: 134,
    });
    const done = await row();
    expect(bridgeStatusOf(done)).toBe('ended');
    const [entry] = await admin()
      .select()
      .from(activities)
      .where(eq(activities.id, done.activityId!));
    expect(entry).toMatchObject({
      kind: 'call',
      subtype: 'outbound',
      authorUserId: dale.id,
      personId: mikeId,
    });
    expect(entry!.meta).toMatchObject({ answeredVia: 'bridge', durationSeconds: 134 });
    const [conv] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, out.conversationId));
    expect(conv!.lastPreview).toBe('Call · 2:14');
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: out.conversationId },
      dale,
    );
    expect(thread.items.find((i) => i.id === out.callId)).toMatchObject({
      type: 'call',
      answeredVia: 'bridge',
      answeredBy: { id: dale.id },
      durationSeconds: 134,
      scheduledFor: null,
    });
  });

  it('works out the statuses the call sheet shows', () => {
    const facts = (status: string, answeredByUserId: string | null, answeredAt: string | null) => ({
      status,
      answeredVia: 'bridge',
      answeredByUserId,
      answeredAt,
    });
    const at = new Date().toISOString();
    expect(bridgeStatusOf({ ...facts('ringing', null, null), answeredVia: 'browser' })).toBeNull();
    expect(bridgeStatusOf(facts('initiated', null, null))).toBe('calling_cell');
    expect(bridgeStatusOf(facts('no_answer', null, null))).toBe('cell_unanswered');
    expect(bridgeStatusOf(facts('busy', null, null))).toBe('cell_unanswered');
    expect(bridgeStatusOf(facts('failed', null, null))).toBe('failed');
    expect(bridgeStatusOf(facts('no_answer', 'u', null))).toBe('customer_unanswered');
    expect(bridgeStatusOf(facts('busy', 'u', null))).toBe('customer_busy');
    expect(bridgeStatusOf(facts('completed', 'u', at))).toBe('ended');
    expect(bridgeStatusWords('calling_cell', 'Mike Johnson')).toBe('Calling your cell…');
    expect(bridgeStatusWords('calling_customer', 'Mike Johnson')).toBe('Calling Mike Johnson…');
    expect(bridgeStatusWords('connected', 'Mike Johnson')).toBe('Connected');
    expect(bridgeStatusWords('cell_unanswered', 'Mike Johnson')).toBe('You didn’t answer');
    expect(bridgeStatusWords('customer_unanswered', 'Mike Johnson')).toBe(
      'Mike Johnson didn’t answer',
    );
    expect(bridgeStatusWords('customer_busy', null)).toBe('The customer’s line is busy');
  });

  it('is online only from a phone, and the same command id runs once', async () => {
    const commandId = randomUUID();
    const once = await executeCommand(
      api(),
      callConnectMe,
      { workspaceId: wsId, personId: mikeId },
      human(marco),
      phoneMeta(commandId),
    );
    const twice = await executeCommand(
      api(),
      callConnectMe,
      { workspaceId: wsId, personId: mikeId },
      human(marco),
      phoneMeta(commandId),
    );
    expect(twice.output).toEqual(once.output);
    const placed = await admin()
      .select()
      .from(calls)
      .where(
        and(
          eq(calls.placedBy, marco.id),
          eq(calls.answeredVia, 'bridge'),
          eq(calls.status, 'initiated'),
        ),
      );
    expect(placed).toHaveLength(1);
    await expectHfos(
      () =>
        executeCommand(
          api(),
          callConnectMe,
          { workspaceId: wsId, personId: mikeId },
          human(marco),
          phoneMeta(randomUUID(), new Date(Date.now() - 5 * MIN)),
        ),
      'rule_violation',
      'online_only',
    );
    expect(registry.command('call.connect_me')!.offline).toBe('online');
  });
});

describe('cancelling a call through your own cell', () => {
  const eventsOf = async (callId: string) =>
    (await admin().select().from(events).where(eq(events.entityId, callId))).map(
      (e) => e.eventType,
    );
  const callRow = async (callId: string) =>
    (await admin().select().from(calls).where(eq(calls.id, callId)))[0]!;

  it('ends a call still ringing the cell at once, never reaching the customer, so they can call again', async () => {
    await verifiedCell(priya);
    const out = await run(callConnectMe, { workspaceId: wsId, personId: mikeId }, priya);
    const [conv] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, out.conversationId));
    // Someone else's call doesn't exist for them.
    await expectHfos(
      () => run(callCancelConnect, { workspaceId: wsId, callId: out.callId }, dale),
      'not_found',
    );
    expect(await run(callCancelConnect, { workspaceId: wsId, callId: out.callId }, priya)).toEqual({
      callId: out.callId,
      cancelled: true,
    });
    const done = await callRow(out.callId);
    expect(done).toMatchObject({ status: 'canceled', activityId: null, answeredAt: null });
    expect(done.endedAt).toBeInstanceOf(Date);
    expect(bridgeStatusOf(done)).toBe('cancelled');
    expect(bridgeStatusWords('cancelled', 'Mike Johnson')).toBe('Call cancelled');
    const types = await eventsOf(out.callId);
    expect(types).toContain('call.bridge_cancelled');
    expect(types).not.toContain('call.missed');
    expect(types).not.toContain('call.bridge_unanswered');
    const [conv2] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, out.conversationId));
    expect(conv2!.lastPreview).toBe(conv!.lastPreview);
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: out.conversationId },
      priya,
    );
    expect(thread.items.find((i) => i.id === out.callId)).toBeUndefined();
    // Pressing Cancel again changes nothing, and a new call goes straight away.
    expect(await run(callCancelConnect, { workspaceId: wsId, callId: out.callId }, priya)).toEqual({
      callId: out.callId,
      cancelled: false,
    });
    const again = await run(callConnectMe, { workspaceId: wsId, personId: mikeId }, priya);
    expect(again).toMatchObject({ duplicate: false });
    expect(again.callId).not.toBe(out.callId);
    await run(callCancelConnect, { workspaceId: wsId, callId: again.callId }, priya);
  });

  it('files a call the customer’s phone already rang for as not answered', async () => {
    const out = await run(callConnectMe, { workspaceId: wsId, personId: mikeId }, priya);
    const providerSid = `CAcancel${uniq()}`;
    await sys(callRecord, {
      workspaceId: wsId,
      providerSid,
      callId: out.callId,
      direction: 'outbound',
      from: businessNumber,
      to: MIKE,
    });
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      providerSid,
      status: 'ringing',
      answeredByUserId: priya.id,
    });
    expect(bridgeStatusOf(await callRow(out.callId))).toBe('calling_customer');
    await run(callCancelConnect, { workspaceId: wsId, callId: out.callId }, priya);
    const done = await callRow(out.callId);
    expect(bridgeStatusOf(done)).toBe('cancelled');
    const types = await eventsOf(out.callId);
    expect(types).toEqual(expect.arrayContaining(['call.bridge_cancelled', 'call.missed']));
    const [entry] = await admin()
      .select()
      .from(activities)
      .where(eq(activities.id, done.activityId!));
    expect(entry).toMatchObject({
      kind: 'call',
      subtype: 'outbound_missed',
      authorUserId: priya.id,
    });
    // The carrier's own report afterwards changes nothing.
    await sys(callUpdateStatus, { workspaceId: wsId, providerSid, status: 'canceled' });
    expect((await callRow(out.callId)).status).toBe('canceled');
  });

  it('refuses once the customer picked up: they hang up on their phone', async () => {
    const out = await run(callConnectMe, { workspaceId: wsId, personId: mikeId }, priya);
    const providerSid = `CAtalking${uniq()}`;
    await sys(callRecord, {
      workspaceId: wsId,
      providerSid,
      callId: out.callId,
      direction: 'outbound',
      from: businessNumber,
      to: MIKE,
    });
    await sys(callUpdateStatus, {
      workspaceId: wsId,
      providerSid,
      status: 'in_progress',
      answeredByUserId: priya.id,
      answeredNumber: MIKE,
    });
    const err = await expectHfos(
      () => run(callCancelConnect, { workspaceId: wsId, callId: out.callId }, priya),
      'rule_violation',
      'already_connected',
    );
    expect(err.message).toBe(
      'You’re already talking to Mike Johnson. Hang up on your phone to end the call.',
    );
    await sys(callUpdateStatus, { workspaceId: wsId, providerSid, status: 'completed' });
    expect(registry.command('call.cancel_connect')).toMatchObject({ offline: 'online', risk: 1 });
  });
});

describe('business caller ID on forwarded calls', () => {
  it('has its own command, stays when routing is saved, and shows in setup status', async () => {
    const status = () => ask(phoneSetupStatus, { workspaceId: wsId }, dale);
    expect((await status()).number!.routing.forwardedCallerId).toBe('customer');
    await expectHfos(
      () =>
        run(
          phoneNumberSetCallerId,
          { workspaceId: wsId, phoneNumberId: numberId, forwardedCallerId: 'business' },
          marco,
        ),
      'forbidden',
    );
    expect(
      await run(
        phoneNumberSetCallerId,
        { workspaceId: wsId, phoneNumberId: numberId, forwardedCallerId: 'business' },
        dale,
      ),
    ).toEqual({ phoneNumberId: numberId, forwardedCallerId: 'business' });
    await run(
      phoneNumberSetRouting,
      {
        workspaceId: wsId,
        phoneNumberId: numberId,
        routing: {
          forwarding: [{ e164: '(713) 555-0161', label: 'Dale’s cell', enabled: true }],
          ringSeconds: 20,
          voicemailEnabled: true,
          voicemailGreeting: null,
        },
      },
      dale,
    );
    expect((await status()).number!.routing).toMatchObject({
      forwardedCallerId: 'business',
      forwarding: [{ e164: '+17135550161' }],
    });
    const [row] = await admin().select().from(phoneNumbers).where(eq(phoneNumbers.id, numberId));
    expect(row!.routing.forwardedCallerId).toBe('business');
    // Saving the same again changes nothing and records nothing.
    const before = await admin()
      .select()
      .from(events)
      .where(
        and(eq(events.entityId, numberId), eq(events.eventType, 'phone_number.routing_updated')),
      );
    await run(
      phoneNumberSetCallerId,
      { workspaceId: wsId, phoneNumberId: numberId, forwardedCallerId: 'business' },
      dale,
    );
    const after = await admin()
      .select()
      .from(events)
      .where(
        and(eq(events.entityId, numberId), eq(events.eventType, 'phone_number.routing_updated')),
      );
    expect(after).toHaveLength(before.length);
  });
});
