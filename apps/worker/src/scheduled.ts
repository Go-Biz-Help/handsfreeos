import { eq, type SQL } from 'drizzle-orm';
import { HANDSFREEOS_DOMAIN } from '@hfos/core';
import {
  carrierHasDetails,
  conversationReopen,
  emailDomainRecord,
  emailDomainRecordReceiving,
  executeCommand,
  openHoursOf,
  registrationUpdateStatus,
  scheduleJob,
  workspaceMessaging,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { conversations, emailDomains, telephonyRegistrations } from '@hfos/db/schema';
import { accountJobs } from './account/delete';
import { BIN_JOBS, BIN_SWEEP_KEY, binJobs } from './bin/index';
import { addonJobs, ensureAddonSweep } from './addons/index';
import { ensureAddonVoting, roadmapJobs } from './addons/roadmap';
import { workspaceJobs } from './workspace/delete';
import { DIGEST_JOBS, DIGEST_PLAN_KEY, digestJobs } from './agency-digest';
import { handoffAlertDue } from './ai-team/escalation';
import { AI_PROVIDER_CHECK_JOB, AI_PROVIDER_CHECK_KEY, aiProviderCheck } from './ai/switch';
import { teammateJobs } from './ai-team/index';
import { ladderJob, SAFETY_JOBS, tellJob } from './safety/ladder';
import { CLEAR_SPOTS_KEY, nextSpotClearing, SPOT_JOBS, spotJobs } from './safety/spots';
import { alertUrgent, waitOf } from './attention/alerts';
import { ATTENTION_JOBS, ATTENTION_PLAN_KEY, attentionJobs } from './attention/index';
import { automationJobs } from './automations/index';
import { contactAiJobs } from './contact-ai/index';
import { appointmentNotice } from './booking/notices';
import { appointmentReminder } from './booking/reminders';
import { depositJobs } from './booking/deposit';
import { WINDOW_END_JOB, waitlistOfferExpire, waitlistOfferJob } from './booking/waitlist';
import { meetingSettingsCheck } from './meetings/settings';
import { appointmentTranscriptFetch, appointmentTranscriptWatch } from './meetings/transcripts';
import { appointmentMeetingSync } from './meetings/sync';
import { appointmentCalendarSync, calendarRefresh } from './calendar/sync';
import { reviewReplyPost, reviewsSync } from './reviews/sync';
import { CHAT_JOBS, chatUnreadFollowUp } from './chat/followup';
import { PORTAL_JOBS, portalUnreadNotice } from './portal/replies';
import {
  EMAIL_RECEIVING_CHECK_JOB,
  domainRecordInput,
  ownershipFound,
  lapsedMessage,
  receivingCheckKey,
  sharedAddress,
} from './handlers/email';
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
import { importJobs } from './telephony/imports';
import { phoneAccountJobs } from './telephony/account-switch';
import { rcsJobs } from './telephony/rcs';
import { META_JOBS, META_PLAN_KEY, metaJobs } from './social/jobs';
import type { JobContext, JobHandler, JobMap } from './jobs';
import { knowledgeDocumentJob } from './knowledge/document';
import { knowledgeScanJob } from './knowledge/scan';
import { READ_SITE_JOB, readSiteJob } from './ai-setup/read-site';
import { FIND_LOGO_JOB, findLogoJob, MAKE_LOGO_JOB, makeLogoJob } from './look/jobs';
import { mailboxSync } from './mailbox/sync';
import { scheduledTextJobs } from './messaging/scheduled';
import {
  UNSENT_FIRST_SWEEP_MS,
  UNSENT_JOBS,
  UNSENT_SWEEP_KEY,
  unsentJobs,
} from './messaging/unsent';
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
import {
  nextSpeechChargeAt,
  runSpeechCharge,
  SPEECH_CHARGE_KEY,
  SPEECH_JOBS,
} from './money/speech-usage';
import { NUMBER_MONTH_JOBS, NUMBER_MONTHS_KEY, runNumberMonths } from './money/number-months';
import { FOUNDING_EXPIRE_KEY, FOUNDING_JOBS, foundingJobs } from './founding/checkout';
import { RCS_BILLING_JOBS, RCS_RENEWALS_KEY, rcsBillingJobs } from './telephony/rcs-billing';
import { TEXTING_FEE_JOBS, TEXTING_MONTHS_KEY, textingFeeJobs } from './telephony/texting-fees';
import { opinlyJobs } from './opinly';
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

/** Rows removed per statement, the most statements one table gets per sweep, and the pause between them. */
const PURGE_BATCH = 5000;
const PURGE_ROUNDS = 40;
const PURGE_PAUSE_MS = 200;
/** A table with more to remove than one sweep takes carries on this much later. */
const PURGE_AGAIN_MS = 10 * 60_000;

/**
 * Up to PURGE_ROUNDS batches of `deleteBatch` (a delete of at most PURGE_BATCH rows `returning 1`), each its own
 * short transaction; true when rows are still left over.
 */
async function purgeInBatches(ctx: JobContext, deleteBatch: SQL): Promise<boolean> {
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, PURGE_PAUSE_MS));
    const [row] = await asWorker(ctx.db, {}, (tx) =>
      rows<{ deleted: number }>(
        tx,
        sql`with gone as (${deleteBatch}) select count(*)::int as deleted from gone`,
      ),
    );
    if ((row?.deleted ?? 0) < PURGE_BATCH) return false;
  }
  return true;
}

/**
 * Daily: provider webhooks are kept 30 days once handled (90 when they failed), finished jobs 30 days, and
 * handled outbox rows 7 days (their events stay; failed ones are kept for a person to look at). A batch at a
 * time, so no one transaction removes millions of rows.
 */
export const sweepDeliveries: JobHandler = async (ctx) => {
  const left = [
    await purgeInBatches(
      ctx,
      sql`delete from app.webhook_deliveries where id in (
            select id from app.webhook_deliveries
            where (status in ('done', 'ignored') and received_at < now() - interval '30 days')
               or (status = 'failed' and received_at < now() - interval '90 days')
            limit ${PURGE_BATCH})
          returning 1`,
    ),
    await purgeInBatches(
      ctx,
      sql`delete from app.scheduled_jobs where id in (
            select id from app.scheduled_jobs
            where status <> 'pending' and updated_at < now() - interval '30 days'
            limit ${PURGE_BATCH})
          returning 1`,
    ),
    await purgeInBatches(
      ctx,
      sql`delete from app.outbox where event_id in (
            select event_id from app.outbox
            where status = 'done' and updated_at < now() - interval '7 days'
            limit ${PURGE_BATCH})
          returning 1`,
    ),
  ];
  return { rescheduleAt: new Date(Date.now() + (left.some(Boolean) ? PURGE_AGAIN_MS : DAY)) };
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
  // A claim is verified once its token was found too (M19): a waiting one is looked at again every day.
  const found = await ownershipFound(services.email.domains, d);
  const proved = !!d.ownershipProvedAt || found === true || d.domain === HANDSFREEOS_DOMAIN;
  const records = state.dkimVerified && state.returnPathVerified;
  const passes = records && proved;
  if (passes === (d.status === 'verified')) return;
  await executeCommand(
    services.db,
    emailDomainRecord,
    {
      workspaceId: scope.workspaceId,
      emailDomainId: d.id,
      ...domainRecordInput(state),
      ...(found === undefined ? {} : { ownershipFound: found }),
      ...(records ? {} : { error: lapsedMessage(state, shared) }),
    },
    systemActor(scope),
    workerMeta(),
  );
}

/** One domain's own check (`checkEmailDomainJob`), one pending per domain. */
export const EMAIL_DOMAIN_CHECK_JOB = 'email_domain.check';
/** The day's domain checks spread over this long, by each domain's id. */
const EMAIL_DOMAIN_CHECK_SPREAD_MS = 60 * 60_000;

/**
 * Daily: every workspace domain the mail service knows is looked at again (Settings → Email promises it). Each
 * gets its own job, spread over the hour, so a thousand domains asked one at a time never hold one job (and the
 * jobs loop) for minutes, or outlast its lease.
 */
export const checkEmailDomains: JobHandler = async (ctx) => {
  await asWorker(ctx.db, {}, (tx) =>
    tx.execute(
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          select d.organization_id, d.workspace_id, ${EMAIL_DOMAIN_CHECK_JOB},
            'email-domain-check:' || d.email_domain_id::text,
            now() + (abs(hashtext(d.email_domain_id::text)::bigint) % ${EMAIL_DOMAIN_CHECK_SPREAD_MS}::bigint)
              * interval '1 millisecond',
            jsonb_build_object('emailDomainId', d.email_domain_id)
          from private.email_domains_to_check() d
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
    ),
  );
  // And every domain that receives mail (M19): its MX may have moved away, or come back.
  await asWorker(ctx.db, {}, (tx) =>
    tx.execute(
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          select d.organization_id, d.workspace_id, ${EMAIL_RECEIVING_CHECK_JOB},
            ${receivingCheckKey('')} || d.email_domain_id::text,
            now() + (abs(hashtext(d.email_domain_id::text)::bigint) % ${EMAIL_DOMAIN_CHECK_SPREAD_MS}::bigint)
              * interval '1 millisecond',
            jsonb_build_object('emailDomainId', d.email_domain_id)
          from private.email_receiving_to_check() d
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
    ),
  );
  return { rescheduleAt: new Date(Date.now() + DAY) };
};

/**
 * How long between MX looks while a receiving domain still waits on its DNS. Fifteen minutes, as for branded
 * domains: DNS changes take hours, and a check every minute would ask the same question a thousand times.
 */
const RECEIVING_WAIT_MS = 15 * 60_000;

/**
 * One receiving domain's MX, looked at again (M19). A pending domain turns on once its MX names Postmark, and one
 * that is on turns lapsed once its MX stops. A domain still waiting is looked at again in 15 minutes; the others
 * wait for the daily check.
 */
export const checkEmailReceivingJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const emailDomainId = String(ctx.job.payload['emailDomainId'] ?? '');
  const d = await asWorker(
    ctx.db,
    scope,
    async (tx) =>
      (
        await tx
          .select({ domain: emailDomains.domain, receiving: emailDomains.receiving })
          .from(emailDomains)
          .where(eq(emailDomains.id, emailDomainId))
      )[0],
  );
  // Removed, or turned off, while this waited.
  if (!d || d.receiving === 'off') return;
  const { output } = await executeCommand(
    ctx.db,
    emailDomainRecordReceiving,
    {
      workspaceId: scope.workspaceId,
      emailDomainId,
      mxFound: await ctx.email.domains.receives(d.domain),
    },
    systemActor(scope),
    workerMeta(),
  );
  if (output.receiving === 'pending')
    return { rescheduleAt: new Date(Date.now() + RECEIVING_WAIT_MS) };
};

/** The daily sweep that deletes old spam (M19). */
export const SPAM_SWEEP_JOB = 'email.spam_sweep';
/** How long Spam keeps a thread after its last message. */
const SPAM_KEEP_MS = 30 * DAY;
/** Threads deleted at a time; a full batch comes back in ten minutes for the rest. */
const SPAM_BATCH = 200;

/**
 * Spam is kept 30 days (M19): after that the thread and its messages are deleted, and the files they carried are
 * removed from storage. Moving a thread out of Spam is how to keep it.
 */
export const sweepSpam: JobHandler = async (ctx) => {
  const before = new Date(Date.now() - SPAM_KEEP_MS);
  const gone = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      conversation_id: string;
      workspace_id: string;
      media: { bucket?: string; objectPath?: string }[];
    }>(
      tx,
      sql`select conversation_id, workspace_id, media
          from private.delete_old_spam(${before.toISOString()}::timestamptz, ${SPAM_BATCH})`,
    ),
  );
  for (const g of gone)
    for (const m of g.media)
      // Only what inbound mail stored for that business, in its own folder.
      if (m.bucket && m.objectPath?.startsWith(`${g.workspace_id}/email/`))
        await ctx.store.remove(m.bucket, m.objectPath).catch((e: unknown) => {
          ctx.log.warn(
            { err: String(e), objectPath: m.objectPath },
            'a spam attachment could not be removed from storage',
          );
        });
  return {
    rescheduleAt: new Date(Date.now() + (gone.length === SPAM_BATCH ? PURGE_AGAIN_MS : DAY)),
  };
};

/**
 * The files of mail an owner removed with a departed person's address (M19, email_address.reassign). Only what
 * inbound mail stored for this business in its own email folder: a customer file sent as an attachment is the
 * customer's, and stays.
 */
export const removeEmailFiles: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const files = (ctx.job.payload['files'] ?? []) as { bucket?: string; objectPath?: string }[];
  for (const f of files)
    if (f.bucket === 'telephony' && f.objectPath?.startsWith(`${scope.workspaceId}/email/`))
      await ctx.store.remove(f.bucket, f.objectPath);
};

/** One domain, bound to its business. */
export const checkEmailDomainJob: JobHandler = async (ctx) => {
  const emailDomainId = String(ctx.job.payload['emailDomainId'] ?? '');
  try {
    await checkEmailDomain(ctx, tenantOf(ctx.scope), emailDomainId);
  } catch (e) {
    // The mail service or DNS not answering for one domain waits for tomorrow; the others go on.
    ctx.log.warn({ emailDomainId, err: errorMessage(e) }, 'email domain check failed');
  }
};

export const jobs: JobMap = {
  // Which AI answers: Claude's status page read every 5 minutes, and OpenAI while Claude is in trouble.
  [AI_PROVIDER_CHECK_JOB]: aiProviderCheck,
  // The AI's suggested answer to a support ticket, written in the background so nothing waits on it (M13).
  ...SUPPORT_JOBS,
  'conversation.unanswered_check': unansweredCheck,
  'registration.poll': registrationPoll,
  // Moving a number a business already owns to us: sending it, asking the carrier, calling it off (M17).
  ...portJobs,
  ...importJobs,
  ...phoneAccountJobs,
  // A business's RCS sender: connecting it, asking Twilio after it, letting it go (0103).
  ...rcsJobs,
  // A business's own domain: claiming it, watching for its DNS, and giving it back (M17).
  ...domainJobs,
  'conversation.unsnooze': unsnooze,
  'webhook_deliveries.sweep': sweepDeliveries,
  'email_domains.check': checkEmailDomains,
  [EMAIL_DOMAIN_CHECK_JOB]: checkEmailDomainJob,
  [EMAIL_RECEIVING_CHECK_JOB]: checkEmailReceivingJob,
  [SPAM_SWEEP_JOB]: sweepSpam,
  // The Deleted bin: emptied 30 days on, or at once on "Delete now" (bin/index.ts).
  ...binJobs,
  'email.remove_files': removeEmailFiles,
  'mailbox.sync': mailboxSync,
  'calendar.refresh': calendarRefresh,
  // What customers said in public: each connected place asked on a timer, and an answer posted back.
  'reviews.sync': reviewsSync,
  'review.reply_post': reviewReplyPost,
  'appointment.calendar_sync': appointmentCalendarSync,
  // A Zoom appointment's meeting, made, moved or deleted with it.
  'appointment.meeting_sync': appointmentMeetingSync,
  // A connected Zoom account's recording settings, read once a day.
  'meeting_connection.settings_check': meetingSettingsCheck,
  // A recorded Zoom call's transcript, fetched when Zoom says it's ready; and the check when none came.
  'appointment.transcript_fetch': appointmentTranscriptFetch,
  'appointment.transcript_watch': appointmentTranscriptWatch,
  'appointment.reminder': appointmentReminder,
  'appointment.notice': appointmentNotice,
  'waitlist.offer': waitlistOfferJob,
  // A time held while a customer pays a deposit, given back when nobody does (booking/deposit.ts).
  ...depositJobs,
  'waitlist.offer_expire': waitlistOfferExpire,
  // A wait ended once its window of time has passed, or its session has started or been cancelled: the same
  // command as an offer running out.
  [WINDOW_END_JOB]: waitlistOfferExpire,
  'knowledge.scan': knowledgeScanJob,
  'knowledge.document': knowledgeDocumentJob,
  // Quick setup: what the business's website says, for its screens to start from.
  [READ_SITE_JOB]: readSiteJob,
  // The business's logo: made from an upload, or found on its website.
  [MAKE_LOGO_JOB]: makeLogoJob,
  [FIND_LOGO_JOB]: findLogoJob,
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
  [PORTAL_JOBS.unreadNotice]: portalUnreadNotice,
  // Check-ins (round six): a missed check-out's ladder, and each text or email to someone outside (safety/).
  [SAFETY_JOBS.ladder]: ladderJob,
  [SAFETY_JOBS.tell]: tellJob,
  // Where a phone was during a check-in, cleared 30 days after it ended, nightly (round seven, safety/spots.ts).
  ...spotJobs,
  // The Action Center: the hourly plan and each business's sweep, exact-time rechecks, snoozes running out.
  ...attentionJobs,
  // Settings → Automations' own: re-engaging dead leads once a day (armed by the Action Center's hourly plan).
  ...automationJobs,
  // The AI keeping customers' tags and details up to date: a look after something happens, and a pass over the
  // whole list a person started (contact-ai/).
  ...contactAiJobs,
  // Payments: each connection's token kept alive (Square's lasts 30 days), and the hourly re-arm behind it, which
  // also clears away sign-ins nobody finished.
  ...paymentJobs,
  // Money: a refund carried out at the provider, with its own retries (money/refunds.ts).
  ...moneyJobs,
  // Founding seats (0093): a Checkout page made at Stripe, and the hourly sweep that gives back reservations
  // nobody took up or paid for (founding/checkout.ts).
  ...foundingJobs,
  // RCS (0104): a request's Stripe page, the hourly sweep for paid years that are up, and each renewal's charge
  // (telephony/rcs-billing.ts).
  ...rcsBillingJobs,
  // What registering for texting costs (0105): each fee collected, a page to pay one with another card, and the
  // hourly sweep for campaign months that have started (telephony/texting-fees.ts).
  ...textingFeeJobs,
  // Sign-ups and checkouts opened, sent to Opinly with retries of their own (opinly.ts).
  ...opinlyJobs,
  // Money: an invoice's message and its reminders, marking one overdue, an estimate's message, its nudge and
  // its expiry, a receipt and a payment that failed, a plan's cycle read back, and the hourly plan and each
  // business's sweep behind them all (money/jobs.ts).
  ...moneyDocumentJobs,
  ...RECONCILE_JOB_HANDLERS,
  ...RECHARGE_JOB_HANDLERS,
  // The AI's hearing and voice, billed from its running totals every quarter of an hour.
  [SPEECH_JOBS.charge]: runSpeechCharge,
  // Retired: the campaign's month went on the balance before the card paid it (telephony/texting-fees.ts). A row
  // an earlier build scheduled finishes here, once, without charging anything or coming back.
  'wallet.campaign_months': async () => undefined,
  // Each phone number's month, once per calendar month where the business is, checked daily.
  [NUMBER_MONTH_JOBS.charge]: runNumberMonths,
  // Money: a plan made to match at the provider — created, paused, resumed or cancelled there
  // (money/subscriptions.ts).
  ...planJobs,
  // Push notifications: a moment's push to each phone, and what Apple and Google said 15 minutes on (push/send.ts).
  ...pushJobs,
  // Calls through someone's own cell: a recorded call's words, once ready (telephony/cell.ts).
  ...cellJobs,
  // A text that waited for quiet hours to end goes then (messaging/scheduled.ts).
  ...scheduledTextJobs,
  // Texts and emails the worker gave up sending without saying so, marked "Not delivered" (messaging/unsent.ts).
  ...unsentJobs,
  // Phones: the nightly time-window sweep, one business at a time, and the daily receipts clean-up (housekeeping/).
  ...syncWindowJobs,
  ...receiptJobs,
  // Deleting an account: off each business, the profile anonymized, sessions ended and sign-in blocked (account/).
  ...accountJobs,
  ...workspaceJobs,
  // Add-ons: each one brought in line with its state in each business, the hourly sweep behind that, events
  // handed to the add-ons that subscribe, and each add-on's own jobs (addons/).
  ...addonJobs,
  // Voting on what's next: each week's vote closing, and picks that shipped (addons/roadmap.ts).
  ...roadmapJobs,
  // Facebook Messenger and Instagram: an ad looked up at Meta, and each business's Pages checked daily (social/).
  ...metaJobs,
};

/** Periodic jobs exist exactly once (their dedupe key keeps one pending row); the first run is an hour out. */
export async function ensureRecurringJobs(services: WorkerServices): Promise<void> {
  const runAt = new Date(Date.now() + 60 * 60_000);
  await asWorker(services.db, {}, async (tx) => {
    // Claude's status page, every 5 minutes, from a minute after the start: only with a backup to move to.
    if (services.aiSwitch)
      await scheduleJob(tx, {
        kind: AI_PROVIDER_CHECK_JOB,
        dedupeKey: AI_PROVIDER_CHECK_KEY,
        runAt: new Date(Date.now() + 60_000),
        payload: {},
        workspaceId: null,
        organizationId: null,
      });
    await scheduleJob(tx, {
      kind: 'webhook_deliveries.sweep',
      dedupeKey: 'sweep:webhook_deliveries',
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // Hourly, from a minute after the start: a text or email the worker gave up sending without saying so is
    // marked "Not delivered", so it can be sent again (messaging/unsent.ts).
    await scheduleJob(tx, {
      kind: UNSENT_JOBS.sweep,
      dedupeKey: UNSENT_SWEEP_KEY,
      runAt: new Date(Date.now() + UNSENT_FIRST_SWEEP_MS),
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
    // Spam older than 30 days goes, daily (M19).
    await scheduleJob(tx, {
      kind: SPAM_SWEEP_JOB,
      dedupeKey: 'sweep:spam',
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // What's been in the Deleted bin 30 days is emptied, daily (bin/index.ts).
    await scheduleJob(tx, {
      kind: BIN_JOBS.sweep,
      dedupeKey: BIN_SWEEP_KEY,
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
    // The AI's hearing and voice (Deepgram), every quarter of an hour: each business's running totals that are
    // due are charged at 1.5×. With the wallet off it does nothing, and the totals wait until it's on.
    await scheduleJob(tx, {
      kind: SPEECH_JOBS.charge,
      dedupeKey: SPEECH_CHARGE_KEY,
      runAt: nextSpeechChargeAt(Date.now()),
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // Phone numbers, once a day: each number's month charged once, by the calendar month where the business is.
    // With the wallet off it does nothing.
    await scheduleJob(tx, {
      kind: NUMBER_MONTH_JOBS.charge,
      dedupeKey: NUMBER_MONTHS_KEY,
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // Founding seats (0093), hourly: a reservation nobody took up or paid for goes back to the offer. Before
    // this ran, a seat approved for somebody who never came back was held for ever.
    await scheduleJob(tx, {
      kind: FOUNDING_JOBS.expire,
      dedupeKey: FOUNDING_EXPIRE_KEY,
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // RCS (0104), hourly: a paid year that is up is renewed, charged to the card its first payment kept.
    await scheduleJob(tx, {
      kind: RCS_BILLING_JOBS.renewals,
      dedupeKey: RCS_RENEWALS_KEY,
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // Texting (0105), hourly: an approved campaign's month that has started is charged to the card on file.
    await scheduleJob(tx, {
      kind: TEXTING_FEE_JOBS.months,
      dedupeKey: TEXTING_MONTHS_KEY,
      runAt,
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
    await scheduleJob(tx, {
      kind: SPOT_JOBS.clear,
      dedupeKey: CLEAR_SPOTS_KEY,
      runAt: nextSpotClearing(now),
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // Facebook and Instagram, daily: each business's Pages looked at with Meta (social/jobs.ts).
    await scheduleJob(tx, {
      kind: META_JOBS.plan,
      dedupeKey: META_PLAN_KEY,
      runAt,
      payload: {},
      workspaceId: null,
      organizationId: null,
    });
    // Add-ons, hourly: any move a business made that isn't finished and proved gets its reconcile again.
    await ensureAddonSweep(tx, runAt);
    // Voting on what's next: this week's close on Sunday at midnight Eastern, and a check for picks that shipped.
    await ensureAddonVoting(tx, Date.now());
  });
}
