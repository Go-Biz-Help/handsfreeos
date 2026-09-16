/**
 * M10 step 6b on the local database: "Send at 8:00 AM when quiet hours end".
 * - A person's text in quiet hours can wait for them to end: it sits in the conversation as scheduled (queued, with
 *   the moment it goes), reaches neither the timeline nor the preview yet, and a repeat is the same text.
 * - Outside quiet hours it just goes; only people choose it, only for texts, and never with "Send now" too.
 * - From the phone: quiet hours ask first ("Send now, or at 8:00 AM?"), and the answer holds it.
 * - Cancelling: it never goes and leaves the conversation; a text that went can't be cancelled.
 * - The worker's release: not before its time, again after quiet hours that came round again, refused (with the
 *   reason) when the customer opted out overnight, and otherwise it goes like any text, credited to its writer.
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
  messageSend,
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
