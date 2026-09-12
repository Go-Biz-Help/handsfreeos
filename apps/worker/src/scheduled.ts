import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  conversationReopen,
  executeCommand,
  formatPhone,
  registrationUpdateStatus,
  scheduleJob,
  workspaceMessaging,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { conversations, people, telephonyRegistrations, users } from '@hfos/db/schema';
import { unansweredEmail } from './emails/templates';
import { advanceRegistrations, managers } from './handlers/telephony';
import type { JobHandler, JobMap } from './jobs';
import { systemActor, tenantOf, workerMeta, type WorkerServices } from './services';
import { recordSystemEvent } from './system-event';
import { loadAccount } from './telephony/accounts';
import type { RegistrationKind } from './telephony/provider';

const localClock = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);

/** One email when a customer's message waits too long: to the assignee, or every owner and admin. */
export const unansweredCheck: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const conversationId = String(ctx.job.payload['conversationId'] ?? '');
  return asWorker(ctx.db, scope, async (tx) => {
    const [c] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!c || c.status !== 'open' || !c.awaitingReplySince) return;
    const m = await workspaceMessaging(tx, scope.workspaceId);
    const delayMs = ctx.reminderOverrideMs ?? m.settings.unansweredReminderMinutes * 60_000;
    if (delayMs <= 0) return;
    const dueAt = new Date(c.awaitingReplySince.getTime() + delayMs);
    if (dueAt.getTime() > Date.now() + 250) return { rescheduleAt: dueAt };
    const since = c.awaitingReplySince.toISOString();
    const already = await rows(
      tx,
      sql`select 1 from app.events
          where entity_type = 'conversation' and entity_id = ${c.id}
            and event_type = 'conversation.unanswered_alerted' and payload ->> 'awaitingSince' = ${since}
          limit 1`,
    );
    if (already.length > 0) return;

    const candidates = c.assigneeUserId
      ? await tx
          .select({
            id: users.id,
            email: users.email,
            full_name: users.fullName,
            settings: users.settings,
          })
          .from(users)
          .where(inArray(users.id, [c.assigneeUserId]))
      : await managers(tx, scope.workspaceId);
    const recipients = candidates.filter((u) => {
      const prefs = (u.settings as { notifications?: { unansweredEmail?: boolean } }).notifications;
      return prefs?.unansweredEmail !== false;
    });
    const [person] = c.personId
      ? await tx
          .select({ firstName: people.firstName, lastName: people.lastName })
          .from(people)
          .where(eq(people.id, c.personId))
      : [];
    const contact = c.channel === 'sms' ? formatPhone(c.counterpart) : c.counterpart;
    const customer = person ? `${person.firstName} ${person.lastName}`.trim() : contact;
    const firstName = person?.firstName || customer;
    const mail = unansweredEmail({
      customer,
      firstName,
      business: m.name,
      minutesWaiting: Math.max(
        1,
        Math.round((Date.now() - c.awaitingReplySince.getTime()) / 60_000),
      ),
      preview: c.lastPreview ?? '',
      receivedAt: localClock(c.awaitingReplySince, m.timezone),
      contact,
      link: `${ctx.webUrl}/app/w/${scope.workspaceId}/inbox/${c.id}`,
      assignedToYou: !!c.assigneeUserId,
    });
    for (const r of recipients) await ctx.mailer.send({ to: r.email, ...mail });
    await recordSystemEvent(tx, {
      type: 'conversation.unanswered_alerted',
      action: 'conversation.unanswered_check',
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'conversation',
      entityId: c.id,
      payload: { awaitingSince: since, recipients: recipients.length, _broadcast: false },
      after: { with: customer, emailed: recipients.map((r) => r.full_name || r.email) },
      correlationId: randomUUID(),
      causationId: ctx.job.id,
    });
  });
};

/** Asks the carrier where a registration stands; moves the chain on once a step is approved. */
export const registrationPoll: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const registrationId = String(ctx.job.payload['registrationId'] ?? '');
  const [reg, account] = await asWorker(
    ctx.db,
    scope,
    async (tx) =>
      [
        (
          await tx
            .select()
            .from(telephonyRegistrations)
            .where(eq(telephonyRegistrations.id, registrationId))
        )[0],
        await loadAccount(tx, scope.workspaceId, ctx.sealer),
      ] as const,
  );
  if (!reg || (reg.status !== 'submitted' && reg.status !== 'in_review')) return;
  if (!reg.providerSid) {
    await advanceRegistrations(ctx, scope);
    return;
  }
  if (!account) throw new Error('no telephony account for this workspace');
  const state = await ctx.telephony.fetchRegistration(account, {
    kind: reg.kind as RegistrationKind,
    providerSid: reg.providerSid,
  });
  const stillReviewing = state.status === 'submitted' || state.status === 'in_review';
  await executeCommand(
    ctx.db,
    registrationUpdateStatus,
    {
      workspaceId: scope.workspaceId,
      registrationId: reg.id,
      status: state.status,
      providerStatus: state.providerStatus,
      rejectionReason: state.rejectionReason,
      nextPollAt: stillReviewing
        ? new Date(Date.now() + ctx.registrationPollMs).toISOString()
        : null,
    },
    systemActor(scope),
    workerMeta(),
  );
  if (stillReviewing) return { rescheduleAt: new Date(Date.now() + ctx.registrationPollMs) };
  if (state.status === 'approved') await advanceRegistrations(ctx, scope);
};

/** A snoozed conversation's time came: back into the inbox. */
export const unsnooze: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const conversationId = String(ctx.job.payload['conversationId'] ?? '');
  const [c] = await asWorker(ctx.db, scope, (tx) =>
    tx.select().from(conversations).where(eq(conversations.id, conversationId)),
  );
  if (!c || c.status !== 'snoozed') return;
  if (c.snoozedUntil && c.snoozedUntil.getTime() > Date.now() + 250)
    return { rescheduleAt: c.snoozedUntil };
  await executeCommand(
    ctx.db,
    conversationReopen,
    { workspaceId: scope.workspaceId, conversationId: c.id },
    systemActor(scope),
    workerMeta(),
  );
};

const DAY = 86_400_000;

/** Daily: provider webhooks are kept 30 days once handled (90 when they failed), finished jobs 30 days. */
export const sweepDeliveries: JobHandler = async (ctx) => {
  await asWorker(ctx.db, {}, async (tx) => {
    await tx.execute(
      sql`delete from app.webhook_deliveries
          where (status in ('done', 'ignored') and received_at < now() - interval '30 days')
             or (status = 'failed' and received_at < now() - interval '90 days')`,
    );
    await tx.execute(
      sql`delete from app.scheduled_jobs where status <> 'pending' and updated_at < now() - interval '30 days'`,
    );
  });
  return { rescheduleAt: new Date(Date.now() + DAY) };
};

export const jobs: JobMap = {
  'conversation.unanswered_check': unansweredCheck,
  'registration.poll': registrationPoll,
  'conversation.unsnooze': unsnooze,
  'webhook_deliveries.sweep': sweepDeliveries,
};

/** Periodic jobs exist exactly once (their dedupe key keeps one pending row). */
export async function ensureRecurringJobs(services: WorkerServices): Promise<void> {
  await asWorker(services.db, {}, (tx) =>
    scheduleJob(tx, {
      kind: 'webhook_deliveries.sweep',
      dedupeKey: 'sweep:webhook_deliveries',
      runAt: new Date(Date.now() + 60 * 60_000),
      payload: {},
      workspaceId: null,
      organizationId: null,
    }),
  );
}
