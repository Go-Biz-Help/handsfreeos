/**
 * M10 step 6b, the worker: a text held until quiet hours end ("Send at 8:00 AM").
 * - It waits: the job is due when quiet hours end, and nothing goes to the carrier before then.
 * - It goes then, through the same sender as every text, credited to the person who wrote it.
 * - Cancelled, the job runs at once and the text ends there, never reaching the carrier.
 * - A failed text tried again in quiet hours, then cancelled, goes back as it was, and the job leaves it be.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  executeCommand,
  localMinutes,
  messageCancelScheduled,
  messageRetry,
  messageSend,
  messageUpdateStatus,
  organizationCreate,
  personCreate,
  phoneNumberBuy,
  phoneUpdateSettings,
  quietHoursEndAt,
  type HumanActor,
  type SystemActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { activities, messages } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { processJobs } from '../src/jobs';
import { SCHEDULED_TEXT_JOBS, scheduledTextJobKey } from '../src/messaging/scheduled';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-held-${process.pid}`;
const TZ = 'America/Chicago';
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const hhmm = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};
const tollFree = () =>
  `+1833${String(100 + Math.floor(Math.random() * 899))}${String(1001 + Math.floor(Math.random() * 8998))}`;

let dale: TestUser;
let marco: TestUser;
let workspaceId: string;
let organizationId: string;
let mariaId: string;
let s: TestServices;

async function reserve(): Promise<void> {
  for (const table of ['outbox', 'webhook_deliveries', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${workspaceId}`,
    );
}

async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await reserve();
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const passes = [
      await processOnce({ ...d, handlers }),
      await processDeliveries({ ...d, processors }),
      await processJobs({ ...d, jobs }),
    ];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select event_type as what, last_error from app.outbox
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'
            union all select kind, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
  }
  throw new Error('the worker did not finish in time');
}

async function quiet(on: boolean) {
  const local = localMinutes(new Date(), TZ);
  const quietHours = on
    ? { enabled: true, start: hhmm(local - 60), end: hhmm(local + 60) }
    : { enabled: false, start: '20:00', end: '08:00' };
  await executeCommand(
    api(),
    phoneUpdateSettings,
    { workspaceId, quietHours },
    actor(dale),
    meta(),
  );
  return quietHours;
}

const heldJob = async (messageId: string) =>
  (
    await rows<{ id: string; run_at: Date; status: string }>(
      admin(),
      sql`select id, run_at, status from app.scheduled_jobs
          where kind = ${SCHEDULED_TEXT_JOBS.send} and dedupe_key = ${scheduledTextJobKey(messageId)}
          order by created_at desc limit 1`,
    )
  )[0];

beforeAll(async () => {
  [dale, marco] = await Promise.all([
    createTestUser('heldw-dale', { fullName: 'Dale Owner' }),
    createTestUser('heldw-marco', { fullName: 'Marco Member' }),
  ]);
  ({ workspaceId, organizationId } = (
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Held Worker HVAC', timezone: TZ },
      actor(dale),
      meta(),
    )
  ).output);
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${marco.id}, 'member')`,
  );
  s = testServices();
  const { phoneNumberId } = (
    await executeCommand(
      api(),
      phoneNumberBuy,
      { workspaceId, e164: tollFree(), numberType: 'toll_free' },
      actor(dale),
      meta(),
    )
  ).output;
  await drain();
  // Texting approved.
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        select workspace_id, account_id, id, 'toll_free_verification', 'approved', ${`HHheld${randomUUID().slice(0, 8)}`}, now()
        from app.phone_numbers where id = ${phoneNumberId}`,
  );
  mariaId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId, firstName: 'Maria', lastName: 'Lopez', phone: '(713) 555-0174' },
      actor(dale),
      meta(),
    )
  ).output.personId;
});
afterAll(closeTestDbs);

describe('a text held until quiet hours end', () => {
  it('waits for the end of quiet hours, then goes through the sender, credited to its writer', async () => {
    const window = await quiet(true);
    const body = 'Hi Maria, the new unit is ordered and gets here Friday. See you Monday at 8.';
    const held = (
      await executeCommand(
        api(),
        messageSend,
        { workspaceId, personId: mariaId, body, sendAfterQuietHours: true },
        actor(marco),
        meta(),
      )
    ).output;
    const sentBefore = s.telephony.sent.length;
    await drain();
    const job = await heldJob(held.messageId);
    expect(job).toMatchObject({ status: 'pending' });
    expect(
      Math.abs(new Date(job!.run_at).getTime() - quietHoursEndAt(window, TZ)!.getTime()),
    ).toBeLessThan(60_000);
    expect(s.telephony.sent).toHaveLength(sentBefore);

    // Morning: quiet hours are over and the job is due.
    await quiet(false);
    await admin()
      .update(messages)
      .set({ occurredAt: new Date(Date.now() - 1000) })
      .where(eq(messages.id, held.messageId));
    await rows(admin(), sql`update app.scheduled_jobs set run_at = now() where id = ${job!.id}`);
    await drain();
    expect(s.telephony.sent).toHaveLength(sentBefore + 1);
    expect(s.telephony.sent.at(-1)).toMatchObject({ to: '+17135550174', body });
    const [row] = await admin().select().from(messages).where(eq(messages.id, held.messageId));
    expect(row).toMatchObject({ errorCode: null, sentBy: marco.id });
    expect(row!.providerMessageId).toBeTruthy();
    const [entry] = await admin()
      .select()
      .from(activities)
      .where(eq(activities.id, row!.activityId!));
    expect(entry).toMatchObject({ subtype: 'outbound', authorUserId: marco.id });
    expect((await heldJob(held.messageId))!.status).toBe('done');
  });

  it('cancelled, the job runs at once and the text ends without reaching the carrier', async () => {
    await quiet(true);
    const held = (
      await executeCommand(
        api(),
        messageSend,
        { workspaceId, personId: mariaId, body: 'Never mind', sendAfterQuietHours: true },
        actor(marco),
        meta(),
      )
    ).output;
    await drain();
    const sentBefore = s.telephony.sent.length;
    await executeCommand(
      api(),
      messageCancelScheduled,
      { workspaceId, messageId: held.messageId },
      actor(marco),
      meta(),
    );
    await drain();
    const [row] = await admin().select().from(messages).where(eq(messages.id, held.messageId));
    expect(row).toMatchObject({
      status: 'failed',
      errorCode: 'cancelled',
      providerMessageId: null,
    });
    expect(s.telephony.sent).toHaveLength(sentBefore);
    expect((await heldJob(held.messageId))!.status).toBe('done');
    await quiet(false);
  });

  it('a failed text tried again and then cancelled goes back as it was, and the job leaves it be', async () => {
    await quiet(false);
    const sent = (
      await executeCommand(
        api(),
        messageSend,
        { workspaceId, personId: mariaId, body: 'Your filter came in.' },
        actor(marco),
        meta(),
      )
    ).output;
    await drain();
    // The carrier took it, then couldn't deliver it.
    const system: SystemActor = { type: 'system', workspaceId, organizationId, onBehalfOf: null };
    await executeCommand(
      testDbs().worker.db,
      messageUpdateStatus,
      {
        workspaceId,
        messageId: sent.messageId,
        status: 'undelivered',
        errorCode: '30003',
        errorMessage: 'The carrier turned it away.',
      },
      system,
      meta(),
    );
    const [failed] = await admin().select().from(messages).where(eq(messages.id, sent.messageId));
    expect(failed!.providerMessageId).toBeTruthy();

    // Retry pressed at night, then cancelled.
    await quiet(true);
    await executeCommand(
      api(),
      messageRetry,
      { workspaceId, messageId: sent.messageId },
      actor(marco),
      meta(),
    );
    await drain();
    expect((await heldJob(sent.messageId))!.status).toBe('pending');
    const sentBefore = s.telephony.sent.length;
    await executeCommand(
      api(),
      messageCancelScheduled,
      { workspaceId, messageId: sent.messageId },
      actor(dale),
      meta(),
    );
    await drain();
    const [row] = await admin().select().from(messages).where(eq(messages.id, sent.messageId));
    expect(row).toMatchObject({
      status: 'undelivered',
      errorCode: '30003',
      errorMessage: 'The carrier turned it away.',
      providerMessageId: failed!.providerMessageId,
      activityId: failed!.activityId,
      failedAttempt: null,
    });
    expect(row!.occurredAt.toISOString()).toBe(failed!.occurredAt.toISOString());
    expect(s.telephony.sent).toHaveLength(sentBefore);
    expect((await heldJob(sent.messageId))!.status).toBe('done');
    await quiet(false);
  });
});
