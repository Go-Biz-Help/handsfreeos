/**
 * M10 step 6b on the local database: "Send at 8:00 AM when quiet hours end".
 * - A person's text in quiet hours can wait for them to end: it sits in the conversation as scheduled (queued, with
 *   the moment it goes), reaches neither the timeline nor the preview yet, and a repeat is the same text.
 * - Outside quiet hours it just goes; only people choose it, only for texts, and never with "Send now" too.
 * - From the phone: quiet hours ask first ("Send now, or at 8:00 AM?"), and the answer holds it.
 * - Cancelling: it never goes and leaves the conversation; a text that went can't be cancelled.
 * - The worker's release: not before its time, again after quiet hours that came round again, refused (with the
 *   reason) when the customer opted out overnight, and otherwise it goes like any text, credited to its writer.
 * - A failed text tried again in quiet hours waits for them to end the same way, then goes in place of the attempt
 *   that failed, without a second line on the timeline. Cancelled, it goes back as it was: not delivered, with its
 *   reason, in its place in the thread, to be tried again.
 * - A failed text tried again shows when it went, by day at once or when quiet hours end: at the bottom of the
 *   thread, as the conversation's latest, and its timeline entry too once the carrier takes it.
 * - A held text refused when quiet hours ended never reached the timeline: tried again, by day or held once more,
 *   it gets its one entry and the conversation's preview when it goes. With no customer it still becomes the
 *   preview then, as a text that went before does.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { activities, conversations, events, messages } from '@hfos/db/schema';
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
  CANCELLED_TEXT,
  localMinutes,
  quietHoursEndAt,
  SCHEDULED_TEXT,
} from '../src/messaging/quiet-hours';
import {
  conversationThread,
  messageCancelScheduled,
  messageReleaseScheduled,
  messageRetry,
  messageSend,
  messageUpdateStatus,
  organizationCreate,
  personCreate,
  personSetSmsConsent,
  phoneUpdateSettings,
  registry,
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
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());
const system = (onBehalfOf: string | null = null): SystemActor => ({
  type: 'system',
  workspaceId: wsId,
  organizationId: orgId,
  onBehalfOf,
});
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(testDbs().worker.db, cmd, input, system(), meta()).then((r) => r.output);
const phoneMeta = (): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'mobile',
  commandId: randomUUID(),
  occurredAt: new Date(),
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

const TZ = 'America/Chicago';
const hhmm = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};
const uniq = () => randomUUID().slice(0, 8);
const nextPhone = () =>
  `+1832${String(2000000 + ((Date.now() + Math.floor(Math.random() * 1e6)) % 7999999)).padStart(7, '0')}`;

let dale: TestUser;
let marco: TestUser;
let outsider: TestUser;
let orgId: string;
let wsId: string;
let mikeId: string;

/** Quiet hours from an hour ago to an hour from now, where the business is (or off). */
async function quietNow(on: boolean) {
  const local = localMinutes(new Date(), TZ);
  const quietHours = on
    ? { enabled: true, start: hhmm(local - 60), end: hhmm(local + 60) }
    : { enabled: false, start: '20:00', end: '08:00' };
  await run(phoneUpdateSettings, { workspaceId: wsId, quietHours }, dale);
  return quietHours;
}

const messageRow = async (id: string) =>
  (await admin().select().from(messages).where(eq(messages.id, id)))[0]!;
const eventTypes = async (id: string) =>
  (await admin().select().from(events).where(eq(events.entityId, id))).map((e) => e.eventType);
const entriesOf = (messageId: string) =>
  admin()
    .select()
    .from(activities)
    .where(sql`${activities.meta}->>'messageId' = ${messageId}`);
const conversationOf = async (id: string) =>
  (await admin().select().from(conversations).where(eq(conversations.id, id)))[0]!;

beforeAll(async () => {
  [dale, marco, outsider] = await Promise.all([
    createTestUser('held-dale', { fullName: 'Dale Owner' }),
    createTestUser('held-marco', { fullName: 'Marco Member' }),
    createTestUser('held-outsider'),
  ]);
  const org = await run(
    organizationCreate,
    { businessName: 'Held Texts HVAC', timezone: TZ },
    dale,
  );
  orgId = org.organizationId;
  wsId = org.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${marco.id}, 'member')`,
  );
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${wsId}, 'fake', ${`AChold${uniq()}`}, 'active') returning id`,
  );
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${wsId}, ${account!.id}, ${`PNhold${uniq()}`}, ${nextPhone()}, 'toll_free', 'active') returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${wsId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved', ${`HHhold${uniq()}`}, now())`,
  );
  mikeId = (
    await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Maria', lastName: 'Lopez', phone: '(713) 555-0174' },
      dale,
    )
  ).personId;
});
afterAll(closeTestDbs);

describe('a text that waits for quiet hours to end', () => {
  it('sits in the conversation as scheduled, and reaches neither the timeline nor the preview yet', async () => {
    const quiet = await quietNow(true);
    const expected = quietHoursEndAt(quiet, TZ)!;
    const clientId = `held-${uniq()}`;
    const out = await run(
      messageSend,
      {
        workspaceId: wsId,
        personId: mikeId,
        body: 'Hi Maria, the new unit is ordered and gets here Friday. See you Monday at 8.',
        clientId,
        sendAfterQuietHours: true,
      },
      marco,
    );
    expect(out).toMatchObject({ status: 'queued', duplicate: false });
    expect(Math.abs(Date.parse(out.scheduledFor!) - expected.getTime())).toBeLessThan(60_000);
    const row = await messageRow(out.messageId);
    expect(row).toMatchObject({
      status: 'queued',
      errorCode: SCHEDULED_TEXT,
      activityId: null,
      sentBy: marco.id,
      clientId,
    });
    expect(row.occurredAt.toISOString()).toBe(out.scheduledFor);
    const types = await eventTypes(out.messageId);
    expect(types).toContain('message.scheduled');
    expect(types).not.toContain('message.queued');
    const [conv] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, out.conversationId));
    expect(conv).toMatchObject({ lastPreview: null, lastOutboundAt: null });
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: out.conversationId },
      dale,
    );
    expect(thread.items.find((i) => i.id === out.messageId)).toMatchObject({
      status: 'queued',
      scheduledFor: out.scheduledFor,
    });
    // Pressing Send again is the same text.
    const again = await run(
      messageSend,
      {
        workspaceId: wsId,
        personId: mikeId,
        body: 'Hi Maria, the new unit is ordered and gets here Friday. See you Monday at 8.',
        clientId,
        sendAfterQuietHours: true,
      },
      marco,
    );
    expect(again).toEqual({ ...out, duplicate: true });
  });

  it('goes now outside quiet hours; only people choose it, only for texts, and never with “Send now”', async () => {
    await quietNow(false);
    const out = await run(
      messageSend,
      { workspaceId: wsId, personId: mikeId, body: 'Daytime note', sendAfterQuietHours: true },
      marco,
    );
    expect(out.scheduledFor).toBeUndefined();
    expect(await eventTypes(out.messageId)).toContain('message.queued');
    await expectHfos(
      () =>
        executeCommand(
          testDbs().worker.db,
          messageSend,
          { workspaceId: wsId, personId: mikeId, body: 'Reminder', sendAfterQuietHours: true },
          system(),
          meta(),
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            toEmail: 'maria@example.com',
            channel: 'email',
            subject: 'Hi',
            body: 'Hi',
            sendAfterQuietHours: true,
          },
          marco,
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            personId: mikeId,
            body: 'Both',
            acknowledgeQuietHours: true,
            sendAfterQuietHours: true,
          },
          marco,
        ),
      'validation',
    );
  });

  it('from the phone, quiet hours ask first, and “Send at 8:00 AM” holds it', async () => {
    await quietNow(true);
    const input = { workspaceId: wsId, personId: mikeId, body: 'Written with no signal' };
    const asked = await expectHfos(
      () => executeCommand(api(), messageSend, input, human(dale), phoneMeta()),
      'rule_violation',
      'quiet_hours',
    );
    expect(asked.disposition).toBe('ask');
    const held = await executeCommand(
      api(),
      messageSend,
      { ...input, sendAfterQuietHours: true },
      human(dale),
      phoneMeta(),
    );
    expect(held.output.scheduledFor).toEqual(expect.any(String));
    expect(registry.command('message.cancel_scheduled')!.offline).toBe('anytime');
  });
});

describe('cancelling a text that waits', () => {
  it('never goes and leaves the conversation; a text that went can’t be cancelled', async () => {
    await quietNow(true);
    const held = await run(
      messageSend,
      { workspaceId: wsId, personId: mikeId, body: 'Cancel me', sendAfterQuietHours: true },
      marco,
    );
    // A teammate may cancel it too, like the Action Center's Cancel.
    expect(
      await run(messageCancelScheduled, { workspaceId: wsId, messageId: held.messageId }, dale),
    ).toEqual({
      messageId: held.messageId,
      changed: true,
      stays: false,
    });
    expect(
      (await run(messageCancelScheduled, { workspaceId: wsId, messageId: held.messageId }, marco))
        .changed,
    ).toBe(false);
    expect(await messageRow(held.messageId)).toMatchObject({
      status: 'queued',
      errorCode: CANCELLED_TEXT,
      errorMessage: 'Cancelled before it went.',
    });
    expect(await eventTypes(held.messageId)).toContain('message.schedule_cancelled');
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: held.conversationId },
      marco,
    );
    expect(thread.items.find((i) => i.id === held.messageId)).toBeUndefined();
    // The worker's release ends it there.
    expect(
      await sys(messageReleaseScheduled, { workspaceId: wsId, messageId: held.messageId }),
    ).toEqual({
      messageId: held.messageId,
      outcome: 'cancelled',
      retryAt: null,
    });
    expect((await messageRow(held.messageId)).status).toBe('failed');

    const sent = await run(
      messageSend,
      { workspaceId: wsId, personId: mikeId, body: 'Now', acknowledgeQuietHours: true },
      marco,
    );
    await expectHfos(
      () => run(messageCancelScheduled, { workspaceId: wsId, messageId: sent.messageId }, marco),
      'rule_violation',
      'not_scheduled',
    );
    await expectHfos(
      () => run(messageCancelScheduled, { workspaceId: wsId, messageId: sent.messageId }, outsider),
      'not_found',
    );
  });
});

describe('the worker’s release', () => {
  it('waits for its time, goes like any text credited to its writer, and only once', async () => {
    await quietNow(true);
    const held = await run(
      messageSend,
      { workspaceId: wsId, personId: mikeId, body: 'Morning text', sendAfterQuietHours: true },
      marco,
    );
    const early = await sys(messageReleaseScheduled, {
      workspaceId: wsId,
      messageId: held.messageId,
    });
    expect(early).toEqual({
      messageId: held.messageId,
      outcome: 'waiting',
      retryAt: held.scheduledFor,
    });
    // Its time came and quiet hours are over.
    await admin()
      .update(messages)
      .set({ occurredAt: new Date(Date.now() - 60_000) })
      .where(eq(messages.id, held.messageId));
    await quietNow(false);
    const out = await executeCommand(
      testDbs().worker.db,
      messageReleaseScheduled,
      { workspaceId: wsId, messageId: held.messageId },
      system(marco.id),
      meta(),
    );
    expect(out.output).toEqual({ messageId: held.messageId, outcome: 'sent', retryAt: null });
    const row = await messageRow(held.messageId);
    expect(row).toMatchObject({ status: 'queued', errorCode: null, sentBy: marco.id });
    expect(Date.now() - row.occurredAt.getTime()).toBeLessThan(30_000);
    const [queued] = await admin()
      .select()
      .from(events)
      .where(and(eq(events.entityId, held.messageId), eq(events.eventType, 'message.queued')));
    expect(queued!.payload).toMatchObject({ scheduled: true, channel: 'sms' });
    const [entry] = await admin()
      .select()
      .from(activities)
      .where(eq(activities.id, row.activityId!));
    expect(entry).toMatchObject({
      kind: 'sms',
      subtype: 'outbound',
      authorUserId: marco.id,
      body: 'Morning text',
    });
    const [conv] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, held.conversationId));
    expect(conv).toMatchObject({ lastPreview: 'Morning text', lastDirection: 'outbound' });
    expect(
      await sys(messageReleaseScheduled, { workspaceId: wsId, messageId: held.messageId }),
    ).toMatchObject({ outcome: 'gone' });
    expect(
      (
        await admin()
          .select()
          .from(events)
          .where(and(eq(events.entityId, held.messageId), eq(events.eventType, 'message.queued')))
      ).length,
    ).toBe(1);
  });

  it('waits again when quiet hours came round again, and says why when it can’t go', async () => {
    const quiet = await quietNow(true);
    const held = await run(
      messageSend,
      { workspaceId: wsId, personId: mikeId, body: 'Late again', sendAfterQuietHours: true },
      marco,
    );
    await admin()
      .update(messages)
      .set({ occurredAt: new Date(Date.now() - 60_000) })
      .where(eq(messages.id, held.messageId));
    const again = await sys(messageReleaseScheduled, {
      workspaceId: wsId,
      messageId: held.messageId,
    });
    expect(again.outcome).toBe('waiting');
    expect(
      Math.abs(Date.parse(again.retryAt!) - quietHoursEndAt(quiet, TZ)!.getTime()),
    ).toBeLessThan(60_000);
    expect((await messageRow(held.messageId)).occurredAt.toISOString()).toBe(again.retryAt);

    // Overnight the customer asked not to be texted: it doesn't go, and the thread says why.
    await admin()
      .update(messages)
      .set({ occurredAt: new Date(Date.now() - 60_000) })
      .where(eq(messages.id, held.messageId));
    await quietNow(false);
    await run(
      personSetSmsConsent,
      { workspaceId: wsId, personId: mikeId, consent: 'opted_out' },
      dale,
    );
    const refused = await sys(messageReleaseScheduled, {
      workspaceId: wsId,
      messageId: held.messageId,
    });
    expect(refused.outcome).toBe('refused');
    const row = await messageRow(held.messageId);
    expect(row).toMatchObject({
      status: 'failed',
      errorCode: 'opted_out',
      errorMessage: 'This customer texted STOP. They can text START to get texts again.',
      activityId: null,
    });
    expect(await eventTypes(held.messageId)).toContain('message.failed');
    await run(
      personSetSmsConsent,
      { workspaceId: wsId, personId: mikeId, consent: 'opted_in' },
      dale,
    );
  });
});

describe('a failed text tried again in quiet hours', () => {
  it('waits for them to end like a held text, then goes in place of the attempt that failed', async () => {
    await quietNow(false);
    const sent = await run(
      messageSend,
      { workspaceId: wsId, personId: mikeId, body: 'Your part came in today.' },
      marco,
    );
    // The carrier took it, then couldn't deliver it.
    await admin()
      .update(messages)
      .set({ providerMessageId: `SMfail${uniq()}` })
      .where(eq(messages.id, sent.messageId));
    await sys(messageUpdateStatus, {
      workspaceId: wsId,
      messageId: sent.messageId,
      status: 'undelivered',
      errorCode: '30003',
      errorMessage: 'The carrier turned it away.',
    });
    const failed = await messageRow(sent.messageId);
    expect(failed.status).toBe('undelivered');
    expect(failed.activityId).not.toBeNull();

    // Retry pressed at night: it doesn't go now.
    const quiet = await quietNow(true);
    const out = await run(messageRetry, { workspaceId: wsId, messageId: sent.messageId }, marco);
    expect(
      Math.abs(Date.parse(out.scheduledFor!) - quietHoursEndAt(quiet, TZ)!.getTime()),
    ).toBeLessThan(60_000);
    const held = await messageRow(sent.messageId);
    expect(held).toMatchObject({
      status: 'queued',
      errorCode: SCHEDULED_TEXT,
      errorMessage: null,
      activityId: failed.activityId,
    });
    expect(held.occurredAt.toISOString()).toBe(out.scheduledFor);
    const queuedEvents = async () =>
      admin()
        .select()
        .from(events)
        .where(and(eq(events.entityId, sent.messageId), eq(events.eventType, 'message.queued')));
    expect(await queuedEvents()).toHaveLength(1);
    expect(await eventTypes(sent.messageId)).toContain('message.scheduled');
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: sent.conversationId },
      marco,
    );
    expect(thread.items.find((i) => i.id === sent.messageId)).toMatchObject({
      status: 'queued',
      scheduledFor: out.scheduledFor,
    });
    expect(
      await sys(messageReleaseScheduled, { workspaceId: wsId, messageId: sent.messageId }),
    ).toMatchObject({ outcome: 'waiting', retryAt: out.scheduledFor });

    // Quiet hours are over: it goes, as a retry, still on the timeline once.
    await admin()
      .update(messages)
      .set({ occurredAt: new Date(Date.now() - 60_000) })
      .where(eq(messages.id, sent.messageId));
    await quietNow(false);
    expect(
      await sys(messageReleaseScheduled, { workspaceId: wsId, messageId: sent.messageId }),
    ).toMatchObject({ outcome: 'sent' });
    expect(await messageRow(sent.messageId)).toMatchObject({
      status: 'queued',
      errorCode: null,
      activityId: failed.activityId,
    });
    const queued = await queuedEvents();
    expect(queued).toHaveLength(2);
    expect(queued.map((e) => e.payload)).toContainEqual(
      expect.objectContaining({
        retry: true,
        replacesProviderMessageId: failed.providerMessageId,
      }),
    );
    const entries = await admin()
      .select()
      .from(activities)
      .where(sql`${activities.meta}->>'messageId' = ${sent.messageId}`);
    expect(entries).toHaveLength(1);

    // It went when quiet hours ended, so it shows then: as the conversation's latest, and on the timeline once the
    // carrier takes it.
    const went = await messageRow(sent.messageId);
    expect(Date.now() - went.occurredAt.getTime()).toBeLessThan(30_000);
    expect(await conversationOf(sent.conversationId)).toMatchObject({
      lastMessageAt: went.occurredAt,
      lastPreview: 'Your part came in today.',
    });
    await sys(messageUpdateStatus, {
      workspaceId: wsId,
      messageId: sent.messageId,
      providerMessageId: `SMretry${uniq()}`,
      replacesProviderMessageId: failed.providerMessageId,
      status: 'sending',
    });
    expect((await entriesOf(sent.messageId)).map((e) => e.occurredAt)).toEqual([went.occurredAt]);
  });

  it('goes now outside quiet hours, and shows when it went: at the bottom of the thread, as the latest', async () => {
    await quietNow(false);
    const { personId } = await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Ana', lastName: 'Diaz', phone: nextPhone() },
      dale,
    );
    const sent = await run(
      messageSend,
      { workspaceId: wsId, personId, body: 'Daytime retry' },
      marco,
    );
    await sys(messageUpdateStatus, {
      workspaceId: wsId,
      messageId: sent.messageId,
      status: 'failed',
      errorCode: '30008',
    });
    // It failed an hour ago, and another text went since.
    const hourAgo = new Date(Date.now() - 3_600_000);
    await admin()
      .update(messages)
      .set({ occurredAt: hourAgo })
      .where(eq(messages.id, sent.messageId));
    await admin()
      .update(activities)
      .set({ occurredAt: hourAgo })
      .where(sql`${activities.meta}->>'messageId' = ${sent.messageId}`);
    const later = await run(
      messageSend,
      { workspaceId: wsId, personId, body: 'We can come at 2.' },
      dale,
    );

    const out = await run(messageRetry, { workspaceId: wsId, messageId: sent.messageId }, marco);
    expect(out).toEqual({ messageId: sent.messageId });
    const row = await messageRow(sent.messageId);
    expect(row).toMatchObject({ status: 'queued', errorCode: null });
    // It goes now, so it shows now: at the bottom of the thread, and as the conversation's latest.
    expect(Date.now() - row.occurredAt.getTime()).toBeLessThan(30_000);
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: sent.conversationId },
      marco,
    );
    expect(thread.items.map((i) => i.id).slice(0, 2)).toEqual([sent.messageId, later.messageId]);
    expect(await conversationOf(sent.conversationId)).toMatchObject({
      lastMessageAt: row.occurredAt,
      lastOutboundAt: row.occurredAt,
      lastPreview: 'Daytime retry',
      lastDirection: 'outbound',
    });
    // Its one timeline entry moves there too, once the carrier takes it.
    expect((await entriesOf(sent.messageId)).map((e) => e.occurredAt)).toEqual([hourAgo]);
    await sys(messageUpdateStatus, {
      workspaceId: wsId,
      messageId: sent.messageId,
      providerMessageId: `SMretry${uniq()}`,
      status: 'sending',
    });
    expect((await entriesOf(sent.messageId)).map((e) => e.occurredAt)).toEqual([row.occurredAt]);
  });
});

describe('cancelling a failed text tried again in quiet hours', () => {
  it('puts it back as it was: not delivered, with its reason, in its place, to be tried again', async () => {
    await quietNow(false);
    const sent = await run(
      messageSend,
      { workspaceId: wsId, personId: mikeId, body: 'The part is on back order.' },
      marco,
    );
    await admin()
      .update(messages)
      .set({ providerMessageId: `SMfail${uniq()}` })
      .where(eq(messages.id, sent.messageId));
    await sys(messageUpdateStatus, {
      workspaceId: wsId,
      messageId: sent.messageId,
      status: 'undelivered',
      errorCode: '30003',
      errorMessage: 'The carrier turned it away.',
    });
    const failed = await messageRow(sent.messageId);
    await quietNow(true);
    await run(messageRetry, { workspaceId: wsId, messageId: sent.messageId }, marco);

    // A teammate cancels it.
    expect(
      await run(messageCancelScheduled, { workspaceId: wsId, messageId: sent.messageId }, dale),
    ).toEqual({ messageId: sent.messageId, changed: true, stays: true });
    const back = await messageRow(sent.messageId);
    expect(back).toMatchObject({
      status: 'undelivered',
      errorCode: '30003',
      errorMessage: 'The carrier turned it away.',
      activityId: failed.activityId,
      providerMessageId: failed.providerMessageId,
      failedAttempt: null,
    });
    expect(back.occurredAt.toISOString()).toBe(failed.occurredAt.toISOString());
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: sent.conversationId },
      marco,
    );
    expect(thread.items.find((i) => i.id === sent.messageId)).toMatchObject({
      status: 'undelivered',
      errorCode: '30003',
      scheduledFor: null,
    });
    // Its one timeline entry still says it didn't arrive, which is true again.
    const entries = await entriesOf(sent.messageId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.meta).toMatchObject({ status: 'undelivered' });

    // Cancel pressed again changes nothing, and doesn't claim it went.
    expect(
      await run(messageCancelScheduled, { workspaceId: wsId, messageId: sent.messageId }, marco),
    ).toEqual({ messageId: sent.messageId, changed: false, stays: true });
    // The worker's job, brought forward by the cancel, leaves it be.
    expect(
      await sys(messageReleaseScheduled, { workspaceId: wsId, messageId: sent.messageId }),
    ).toMatchObject({ outcome: 'gone' });
    expect(await messageRow(sent.messageId)).toMatchObject({
      status: 'undelivered',
      errorCode: '30003',
    });
    expect(await eventTypes(sent.messageId)).toContain('message.schedule_cancelled');
    // And it can be tried again.
    const again = await run(messageRetry, { workspaceId: wsId, messageId: sent.messageId }, marco);
    expect(again.scheduledFor).toEqual(expect.any(String));
  });
});

describe('a held text refused when quiet hours ended, tried again', () => {
  /** "Send at 8:00 AM", and overnight the customer texted STOP; by morning they texted START again. */
  async function refusedOvernight(body: string) {
    await quietNow(true);
    const held = await run(
      messageSend,
      { workspaceId: wsId, personId: mikeId, body, sendAfterQuietHours: true },
      marco,
    );
    await admin()
      .update(messages)
      .set({ occurredAt: new Date(Date.now() - 60_000) })
      .where(eq(messages.id, held.messageId));
    await quietNow(false);
    await run(
      personSetSmsConsent,
      { workspaceId: wsId, personId: mikeId, consent: 'opted_out' },
      dale,
    );
    expect(
      await sys(messageReleaseScheduled, { workspaceId: wsId, messageId: held.messageId }),
    ).toMatchObject({ outcome: 'refused' });
    await run(
      personSetSmsConsent,
      { workspaceId: wsId, personId: mikeId, consent: 'opted_in' },
      dale,
    );
    expect(await messageRow(held.messageId)).toMatchObject({
      status: 'failed',
      errorCode: 'opted_out',
      activityId: null,
    });
    return held;
  }

  it('by day, goes onto the timeline and becomes the conversation’s preview, once', async () => {
    const held = await refusedOvernight('Your estimate is ready.');
    const out = await run(messageRetry, { workspaceId: wsId, messageId: held.messageId }, dale);
    expect(out).toEqual({ messageId: held.messageId });
    const row = await messageRow(held.messageId);
    expect(row).toMatchObject({ status: 'queued', errorCode: null, sentBy: marco.id });
    expect(Date.now() - row.occurredAt.getTime()).toBeLessThan(30_000);
    const entries = await entriesOf(held.messageId);
    expect(entries).toHaveLength(1);
    // Sent now, by whoever pressed Retry.
    expect(entries[0]).toMatchObject({
      id: row.activityId,
      kind: 'sms',
      subtype: 'outbound',
      authorUserId: dale.id,
      body: 'Your estimate is ready.',
    });
    expect(entries[0]!.meta).not.toHaveProperty('scheduled');
    expect(await conversationOf(held.conversationId)).toMatchObject({
      lastPreview: 'Your estimate is ready.',
      lastDirection: 'outbound',
    });

    // It fails at the carrier and is tried again: still one entry.
    await sys(messageUpdateStatus, {
      workspaceId: wsId,
      messageId: held.messageId,
      status: 'failed',
      errorCode: '30008',
    });
    await run(messageRetry, { workspaceId: wsId, messageId: held.messageId }, dale);
    expect(await entriesOf(held.messageId)).toHaveLength(1);
    expect((await messageRow(held.messageId)).activityId).toBe(row.activityId);
  });

  it('in quiet hours, waits and gets them when it goes; cancelled first, it stays as it was', async () => {
    const held = await refusedOvernight('We can come Thursday instead.');
    await quietNow(true);
    const out = await run(messageRetry, { workspaceId: wsId, messageId: held.messageId }, dale);
    expect(out.scheduledFor).toEqual(expect.any(String));

    // Cancelled: refused with its reason, still in the thread.
    expect(
      await run(messageCancelScheduled, { workspaceId: wsId, messageId: held.messageId }, dale),
    ).toEqual({ messageId: held.messageId, changed: true, stays: true });
    expect(await messageRow(held.messageId)).toMatchObject({
      status: 'failed',
      errorCode: 'opted_out',
      errorMessage: 'This customer texted STOP. They can text START to get texts again.',
      activityId: null,
    });
    const thread = await ask(
      conversationThread,
      { workspaceId: wsId, conversationId: held.conversationId },
      marco,
    );
    expect(thread.items.find((i) => i.id === held.messageId)).toMatchObject({
      status: 'failed',
      scheduledFor: null,
    });

    // Tried again, it waits, then goes: onto the timeline and the preview, once.
    await run(messageRetry, { workspaceId: wsId, messageId: held.messageId }, dale);
    expect(await entriesOf(held.messageId)).toHaveLength(0);
    await admin()
      .update(messages)
      .set({ occurredAt: new Date(Date.now() - 60_000) })
      .where(eq(messages.id, held.messageId));
    await quietNow(false);
    expect(
      await sys(messageReleaseScheduled, { workspaceId: wsId, messageId: held.messageId }),
    ).toMatchObject({ outcome: 'sent' });
    const row = await messageRow(held.messageId);
    expect(row).toMatchObject({ status: 'queued', errorCode: null, failedAttempt: null });
    const entries = await entriesOf(held.messageId);
    expect(entries.map((e) => e.id)).toEqual([row.activityId]);
    expect(await conversationOf(held.conversationId)).toMatchObject({
      lastPreview: 'We can come Thursday instead.',
    });
    const [queued] = await admin()
      .select()
      .from(events)
      .where(and(eq(events.entityId, held.messageId), eq(events.eventType, 'message.queued')));
    expect(queued!.payload).toMatchObject({ scheduled: true, retry: true });
  });

  it('with no customer, by day, becomes the conversation’s preview, as a text that went before does', async () => {
    // A number nobody knows yet.
    const last4 = String(1000 + Math.floor(Math.random() * 8999));
    const toPhone = `(281) 555-${last4}`;
    const optedOut = (out: boolean) =>
      rows(
        admin(),
        sql`insert into app.opt_outs (workspace_id, counterpart_e164, opted_out, source)
            values (${wsId}, ${`+1281555${last4}`}, ${out}, 'manual')
            on conflict (workspace_id, counterpart_e164) do update set opted_out = excluded.opted_out`,
      );
    await quietNow(true);
    const held = await run(
      messageSend,
      { workspaceId: wsId, toPhone, body: 'Your quote is ready.', sendAfterQuietHours: true },
      marco,
    );
    await admin()
      .update(messages)
      .set({ occurredAt: new Date(Date.now() - 60_000) })
      .where(eq(messages.id, held.messageId));
    await quietNow(false);
    await optedOut(true);
    expect(
      await sys(messageReleaseScheduled, { workspaceId: wsId, messageId: held.messageId }),
    ).toMatchObject({ outcome: 'refused' });
    await optedOut(false);

    // Meanwhile another text went, and didn't arrive.
    const other = await run(
      messageSend,
      { workspaceId: wsId, toPhone, body: 'Running late, there by 10.' },
      marco,
    );
    await sys(messageUpdateStatus, {
      workspaceId: wsId,
      messageId: other.messageId,
      status: 'failed',
      errorCode: '30008',
    });
    expect(await conversationOf(held.conversationId)).toMatchObject({
      lastPreview: 'Running late, there by 10.',
    });

    // The refused one goes for the first time: it's the conversation's latest now.
    await run(messageRetry, { workspaceId: wsId, messageId: held.messageId }, dale);
    const row = await messageRow(held.messageId);
    expect(row).toMatchObject({ status: 'queued', errorCode: null, activityId: null });
    expect(Date.now() - row.occurredAt.getTime()).toBeLessThan(30_000);
    const conv = await conversationOf(held.conversationId);
    expect(conv).toMatchObject({ lastPreview: 'Your quote is ready.', lastDirection: 'outbound' });
    expect(Date.now() - conv.lastOutboundAt!.getTime()).toBeLessThan(30_000);

    // The other went before: tried again, it goes now too, so it's the latest again.
    await run(messageRetry, { workspaceId: wsId, messageId: other.messageId }, dale);
    expect((await conversationOf(held.conversationId)).lastPreview).toBe(
      'Running late, there by 10.',
    );
  });
});
