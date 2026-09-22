import { eq } from 'drizzle-orm';
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
import { conversations, emailDomains, telephonyRegistrations } from '@hfos/db/schema';
import { accountJobs } from './account/delete';
import { workspaceJobs } from './workspace/delete';
import { DIGEST_JOBS, DIGEST_PLAN_KEY, digestJobs } from './agency-digest';
import { handoffAlertDue } from './ai-team/escalation';
import { teammateJobs } from './ai-team/index';
import { alertUrgent, waitOf } from './attention/alerts';
import { ATTENTION_JOBS, ATTENTION_PLAN_KEY, attentionJobs } from './attention/index';
import { appointmentNotice } from './booking/notices';
import { appointmentReminder } from './booking/reminders';
import { depositJobs } from './booking/deposit';
import { waitlistOfferExpire, waitlistOfferJob } from './booking/waitlist';
import { appointmentCalendarSync, calendarRefresh } from './calendar/sync';
import { reviewReplyPost, reviewsSync } from './reviews/sync';
import { CHAT_JOBS, chatUnreadFollowUp } from './chat/followup';
import { domainRecordInput, lapsedMessage, sharedAddress } from './handlers/email';
import {
  nextReceiptCleanUp,
  RECEIPT_JOBS,
  RECEIPTS_CLEAN_UP_KEY,
  receiptJobs,
} from './housekeeping/receipts';
import {
  nextSweepNight,
  SYNC_WINDOW_JOBS,
  SYNC_WINDOW_PLAN_KEY,
  syncWindowJobs,
} from './housekeeping/sync-window';
import { advanceRegistrations } from './handlers/telephony';
import { DOMAIN_SWEEP, domainJobs } from './hosting/domains';
import { portJobs } from './telephony/ports';
import type { JobHandler, JobMap } from './jobs';
import { knowledgeDocumentJob } from './knowledge/document';
import { knowledgeScanJob } from './knowledge/scan';
import { mailboxSync } from './mailbox/sync';
import { scheduledTextJobs } from './messaging/scheduled';
import { moneyDocumentJobs, MONEY_JOBS, MONEY_PLAN_KEY } from './money/jobs';
import {
  nextReconcileAt,
  RECONCILE_JOBS,
  RECONCILE_JOB_HANDLERS,
  RECONCILE_PLAN_KEY,
} from './money/reconcile';
import {
  nextWalletPlanAt,
  RECHARGE_JOBS,
  RECHARGE_JOB_HANDLERS,
  RECHARGE_PLAN_KEY,
} from './money/recharge';
import { moneyJobs } from './money/refunds';
import { planJobs } from './money/subscriptions';
import { pushJobs } from './push/send';
import { SUPPORT_JOBS } from './support/draft';
import { errorMessage } from './outbox';
import { PAYMENT_JOBS, PAYMENT_PLAN_KEY, paymentJobs } from './payments/refresh';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from './services';
import { loadAccount } from './telephony/accounts';
import { cellJobs } from './telephony/cell';
import type { RegistrationKind } from './telephony/provider';
import { workflowJobs } from './workflows/index';
import { templateJobs } from './workflows/templates';

/**
 * When a customer's message has waited too long. It keeps its own timing — the business's reply threshold, and 15
 * minutes of open hours from a hand-off the AI teammate made instead (ai-team/escalation.ts keeps this job pending
 * for it, once per hand-off; its customer's own waiting time doesn't count) — and then hands over to the Action
 * Center's one urgent sender (attention/alerts.ts), which picks the recipients, writes the email and records
 * `conversation.unanswered_alerted`. So a wait that is also an attention item never brings two emails.
 */
export const unansweredCheck: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const conversationId = String(ctx.job.payload['conversationId'] ?? '');
  const due = await asWorker(ctx.db, scope, async (tx) => {
    const [c] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!c || c.status !== 'open') return null;
    const handedOff = c.handledBy === 'person' && c.needsPersonSince !== null && !c.takenOverBy;
    const { waitingSince } = waitOf(c);
    if (!waitingSince) return null;
    const m = await workspaceMessaging(tx, scope.workspaceId);
    const delayMs = ctx.reminderOverrideMs ?? m.settings.unansweredReminderMinutes * 60_000;
    if (delayMs <= 0) return null;
    return handedOff
      ? new Date(
          handoffAlertDue(
            c.needsPersonSince!,
            openHoursOf(m.rawSettings),
            m.timezone || 'UTC',
            ctx.reminderOverrideMs,
          ),
        )
      : new Date(waitingSince.getTime() + delayMs);
  });
  if (!due) return;
  if (due.getTime() > Date.now() + 250) return { rescheduleAt: due };
  const result = await alertUrgent(
    ctx,
    scope,
    { conversationId },
    { now: Date.now(), causationId: ctx.job.id },
  );
  if (result.status === 'wait') return { rescheduleAt: new Date(result.at) };
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
  // The AI's suggested answer to a support ticket, written in the background so nothing waits on it (M13).
  ...SUPPORT_JOBS,
  'conversation.unanswered_check': unansweredCheck,
  'registration.poll': registrationPoll,
  // Moving a number a business already owns to us: sending it, asking the carrier, calling it off (M17).
  ...portJobs,
  // A business's own domain: claiming it, watching for its DNS, and giving it back (M17).
  ...domainJobs,
  'conversation.unsnooze': unsnooze,
  'webhook_deliveries.sweep': sweepDeliveries,
  'email_domains.check': checkEmailDomains,
  'mailbox.sync': mailboxSync,
  'calendar.refresh': calendarRefresh,
  // What customers said in public: each connected place asked on a timer, and an answer posted back.
  'reviews.sync': reviewsSync,
  'review.reply_post': reviewReplyPost,
  'appointment.calendar_sync': appointmentCalendarSync,
  'appointment.reminder': appointmentReminder,
  'appointment.notice': appointmentNotice,
  'waitlist.offer': waitlistOfferJob,
  // A time held while a customer pays a deposit, given back when nobody does (booking/deposit.ts).
  ...depositJobs,
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
  // The Action Center: the hourly plan and each business's sweep, exact-time rechecks, snoozes running out.
  ...attentionJobs,
  // Payments: each connection's token kept alive (Square's lasts 30 days), and the hourly re-arm behind it.
  ...paymentJobs,
  // Money: a refund carried out at the provider, with its own retries (money/refunds.ts).
  ...moneyJobs,
  // Money: an invoice's message and its reminders, marking one overdue, an estimate's message, its nudge and
  // its expiry, a receipt and a payment that failed, a plan's cycle read back, and the hourly plan and each
  // business's sweep behind them all (money/jobs.ts).
  ...moneyDocumentJobs,
  ...RECONCILE_JOB_HANDLERS,
  ...RECHARGE_JOB_HANDLERS,
  // Money: a plan made to match at the provider — created, paused, resumed or cancelled there
  // (money/subscriptions.ts).
  ...planJobs,
  // Push notifications: a moment's push to each phone, and what Apple and Google said 15 minutes on (push/send.ts).
  ...pushJobs,
  // Calls through someone's own cell: a recorded call's words, once ready (telephony/cell.ts).
  ...cellJobs,
  // A text that waited for quiet hours to end goes then (messaging/scheduled.ts).
  ...scheduledTextJobs,
  // Phones: the nightly time-window sweep, one business at a time, and the daily receipts clean-up (housekeeping/).
  ...syncWindowJobs,
  ...receiptJobs,
  // Deleting an account: off each business, the profile anonymized, sessions ended and sign-in blocked (account/).
  ...accountJobs,
  ...workspaceJobs,
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
    // A business's own domain, looked at daily in case it has stopped working (M17).
    await scheduleJob(tx, {
      kind: DOMAIN_SWEEP,
      dedupeKey: 'check:branded_domains',
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
    await scheduleJob(tx, {
      kind: ATTENTION_JOBS.plan,
      dedupeKey: ATTENTION_PLAN_KEY,
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // The re-arm behind the per-connection token refresh: a job that exhausted its retries would otherwise end
    // a business's payments silently thirty days later.
    await scheduleJob(tx, {
      kind: PAYMENT_JOBS.plan,
      dedupeKey: PAYMENT_PLAN_KEY,
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // Money: every business's hourly sweep, which re-arms the reminders, overdue marks, expiries and plan
    // cycles that should be waiting — including for a job that exhausted its retries (money/jobs.ts).
    await scheduleJob(tx, {
      kind: MONEY_JOBS.plan,
      dedupeKey: MONEY_PLAN_KEY,
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // The usage wallet's nightly true-up (M16): each business's day of carrier records against what we
    // charged for it. Armed whatever WALLET_MODE says, because a shadow week with nothing to check it against
    // proves nothing — and with the wallet off there is no ledger to correct, so the pass finds nothing to do.
    await scheduleJob(tx, {
      kind: RECONCILE_JOBS.plan,
      dedupeKey: RECONCILE_PLAN_KEY,
      runAt: nextReconcileAt(Date.now()),
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // The wallet's hourly sweep (M16): the safety net behind a lost `wallet.low` and a job that exhausted its
    // retries. It does nothing at all unless WALLET_MODE is on, so arming it costs nothing before then.
    await scheduleJob(tx, {
      kind: RECHARGE_JOBS.plan,
      dedupeKey: RECHARGE_PLAN_KEY,
      runAt: nextWalletPlanAt(Date.now()),
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // Phones (M10), at night: each business's time-window sweep planned, and old command receipts removed.
    const now = Date.now();
    await scheduleJob(tx, {
      kind: SYNC_WINDOW_JOBS.plan,
      dedupeKey: SYNC_WINDOW_PLAN_KEY,
      runAt: nextSweepNight(now),
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    await scheduleJob(tx, {
      kind: RECEIPT_JOBS.cleanUp,
      dedupeKey: RECEIPTS_CLEAN_UP_KEY,
      runAt: nextReceiptCleanUp(now),
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
  });
}
