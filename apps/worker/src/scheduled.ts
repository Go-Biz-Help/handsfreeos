import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  carrierHasDetails,
  conversationReopen,
  emailDomainRecord,
  executeCommand,
  openHoursOf,
  registrationUpdateStatus,
  scheduleJob,
  workspaceMessaging,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  conversations,
  emailDomains,
  people,
  telephonyRegistrations,
  users,
} from '@hfos/db/schema';
import { DIGEST_JOBS, DIGEST_PLAN_KEY, digestJobs } from './agency-digest';
import { handoffAlertDue } from './ai-team/escalation';
import { teammateJobs } from './ai-team/index';
import { appointmentNotice } from './booking/notices';
import { appointmentReminder } from './booking/reminders';
import { waitlistOfferExpire, waitlistOfferJob } from './booking/waitlist';
import { appointmentCalendarSync, calendarRefresh } from './calendar/sync';
import { CHAT_JOBS, chatUnreadFollowUp } from './chat/followup';
import { conversationContact } from './chat/store';
import { unansweredEmail } from './emails/templates';
import { domainRecordInput, lapsedMessage, sharedAddress } from './handlers/email';
import { advanceRegistrations, managers } from './handlers/telephony';
import type { JobHandler, JobMap } from './jobs';
import { knowledgeDocumentJob } from './knowledge/document';
import { knowledgeScanJob } from './knowledge/scan';
import { mailboxSync } from './mailbox/sync';
import { errorMessage } from './outbox';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from './services';
import { recordSystemEvent } from './system-event';
import { loadAccount } from './telephony/accounts';
import type { RegistrationKind } from './telephony/provider';
import { workflowJobs } from './workflows/index';
import { templateJobs } from './workflows/templates';

const localClock = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);

/**
 * One email when a customer's message waits too long: to the assignee, or every owner and admin. A conversation
 * the AI teammate handed to a person waits 15 minutes of open hours from the hand-off instead (ai-team/escalation.ts
 * keeps this job pending for it), once per hand-off; its customer's own waiting time doesn't count.
 */
export const unansweredCheck: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const conversationId = String(ctx.job.payload['conversationId'] ?? '');
  return asWorker(ctx.db, scope, async (tx) => {
    const [c] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!c || c.status !== 'open') return;
    const handedOff = c.handledBy === 'person' && c.needsPersonSince !== null && !c.takenOverBy;
    const waitingSince = c.awaitingReplySince ?? (handedOff ? c.needsPersonSince : null);
    if (!waitingSince) return;
    const m = await workspaceMessaging(tx, scope.workspaceId);
    const delayMs = ctx.reminderOverrideMs ?? m.settings.unansweredReminderMinutes * 60_000;
    if (delayMs <= 0) return;
    const dueAt = handedOff
      ? new Date(
          handoffAlertDue(
            c.needsPersonSince!,
            openHoursOf(m.rawSettings),
            m.timezone || 'UTC',
            ctx.reminderOverrideMs,
          ),
        )
      : new Date(waitingSince.getTime() + delayMs);
    if (dueAt.getTime() > Date.now() + 250) return { rescheduleAt: dueAt };
    // One alert per message waiting, or per hand-off.
    const since = (handedOff ? c.needsPersonSince! : waitingSince).toISOString();
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
    const contact = await conversationContact(tx, c);
    const customer = person ? `${person.firstName} ${person.lastName}`.trim() : contact;
    const firstName = person?.firstName || customer;
    const [latest] = await rows<{ photos: number }>(
      tx,
      sql`select coalesce(jsonb_array_length(media), 0)::int as photos from app.messages
          where conversation_id = ${c.id} and direction = 'inbound'
          order by occurred_at desc limit 1`,
    );
    const mail = unansweredEmail({
      customer,
      firstName,
      business: m.name,
      minutesWaiting: Math.max(1, Math.round((Date.now() - waitingSince.getTime()) / 60_000)),
      preview: c.lastPreview ?? '',
      receivedAt: localClock(waitingSince, m.timezone),
      contact,
      link: `${ctx.webUrl}/app/w/${scope.workspaceId}/inbox/${c.id}`,
      assignedToYou: !!c.assigneeUserId,
      photos: latest?.photos ?? 0,
      channel: c.channel,
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
  // Details the carrier hasn't got (never sent, or sent again by people): send those instead of asking about
  // the old request, which would only repeat its old answer.
  if (!carrierHasDetails(reg)) {
    await advanceRegistrations(ctx, scope);
    return;
  }
  if (!account) throw new Error('no telephony account for this workspace');
  const state = await ctx.telephony.fetchRegistration(account, {
    kind: reg.kind as RegistrationKind,
    providerSid: reg.providerSid!,
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

/**
 * One workspace domain, looked at again: a pending (or failed) one whose records now pass turns verified; a
 * verified one whose records are gone moves to failed, and its mail goes out from the shared address until they
 * are back. Anything else is no news and writes nothing. The owners hear about both changes (handlers/email).
 */
export async function checkEmailDomain(
  services: WorkerServices,
  scope: TenantScope,
  emailDomainId: string,
): Promise<void> {
  const [d, shared] = await asWorker(
    services.db,
    scope,
    async (tx) =>
      [
        (await tx.select().from(emailDomains).where(eq(emailDomains.id, emailDomainId)))[0],
        await sharedAddress(tx, scope.workspaceId),
      ] as const,
  );
  if (!d?.providerDomainId) return;
  const state = await services.email.domains.verify(d.providerDomainId);
  const passes = state.dkimVerified && state.returnPathVerified;
  if (passes === (d.status === 'verified')) return;
  await executeCommand(
    services.db,
    emailDomainRecord,
    {
      workspaceId: scope.workspaceId,
      emailDomainId: d.id,
      ...domainRecordInput(state),
      ...(passes ? {} : { error: lapsedMessage(state, shared) }),
    },
    systemActor(scope),
    workerMeta(),
  );
}

/** Daily: every workspace domain the mail service knows is looked at again (Settings → Email promises it). */
export const checkEmailDomains: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{ email_domain_id: string; workspace_id: string; organization_id: string }>(
      tx,
      sql`select email_domain_id, workspace_id, organization_id from private.email_domains_to_check()`,
    ),
  );
  for (const d of due)
    try {
      await checkEmailDomain(
        ctx,
        { workspaceId: d.workspace_id, organizationId: d.organization_id },
        d.email_domain_id,
      );
    } catch (e) {
      // The mail service or DNS not answering for one domain waits for tomorrow; the others go on.
      ctx.log.warn(
        { emailDomainId: d.email_domain_id, err: errorMessage(e) },
        'email domain check failed',
      );
    }
  return { rescheduleAt: new Date(Date.now() + DAY) };
};

export const jobs: JobMap = {
  'conversation.unanswered_check': unansweredCheck,
  'registration.poll': registrationPoll,
  'conversation.unsnooze': unsnooze,
  'webhook_deliveries.sweep': sweepDeliveries,
  'email_domains.check': checkEmailDomains,
  'mailbox.sync': mailboxSync,
  'calendar.refresh': calendarRefresh,
  'appointment.calendar_sync': appointmentCalendarSync,
  'appointment.reminder': appointmentReminder,
  'appointment.notice': appointmentNotice,
  'waitlist.offer': waitlistOfferJob,
  'waitlist.offer_expire': waitlistOfferExpire,
  'knowledge.scan': knowledgeScanJob,
  'knowledge.document': knowledgeDocumentJob,
  // Workflows: each run's cursor, schedules, date triggers, releasing held runs, pruning old step logs.
  ...workflowJobs,
  // The agency's pushes: a template or knowledge pack into one business each.
  ...templateJobs,
  // The daily agency digest: planning, and each organization's email.
  ...digestJobs,
  // The AI teammate: replies, first messages, nudges, drafts quiet hours held back or nobody decided, and
  // hand-off lines quiet hours held back.
  ...teammateJobs,
  // The website chat: a reply still unread after 10 minutes goes by email or text.
  [CHAT_JOBS.unreadFollowUp]: chatUnreadFollowUp,
};

/** Periodic jobs exist exactly once (their dedupe key keeps one pending row); the first run is an hour out. */
export async function ensureRecurringJobs(services: WorkerServices): Promise<void> {
  const runAt = new Date(Date.now() + 60 * 60_000);
  await asWorker(services.db, {}, async (tx) => {
    await scheduleJob(tx, {
      kind: 'webhook_deliveries.sweep',
      dedupeKey: 'sweep:webhook_deliveries',
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    await scheduleJob(tx, {
      kind: 'email_domains.check',
      dedupeKey: 'check:email_domains',
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    await scheduleJob(tx, {
      kind: DIGEST_JOBS.plan,
      dedupeKey: DIGEST_PLAN_KEY,
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
  });
}
