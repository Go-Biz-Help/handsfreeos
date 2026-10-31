/**
 * The money jobs (M9 step 6): what HandsFreeOS does about a document once a person has stopped looking at it.
 *
 * Every job here **re-reads its subject when it runs**, the way the appointment reminders do (booking/
 * reminders.ts). Nothing is cancelled, deleted or cleaned up when an invoice is paid or an estimate is
 * answered: the job wakes at its time, reads the document as it is now, and records why it did nothing. That
 * is the only shape that survives a payment landing, a void, a settings change and a retry all at once.
 *
 * - **`invoice.message`** — the message that goes with an invoice (`sent`), and every rung of the business's
 *   reminder ladder (`before_3`, `on_due`, `after_7`, …). They stop the moment the invoice is paid, voided or
 *   settling, and each rung's outcome is written into `invoices.reminder_state`, so it is sent exactly once.
 * - **`invoice.mark_overdue`** — the end of the due day where the business is, plus the Action Center's grace
 *   day, and **never while a payment is `processing`**: a bank transfer takes days to settle, and an invoice
 *   that is paying is not late.
 * - **`estimate.message`** — the estimate itself (`sent`), and the one nudge a business can set (`nudge`).
 * - **`estimate.expire`** — once it has stopped being good. It is reissued, never chased.
 * - **`subscription.cycle`** — what the provider's own engine doesn't tell us: the plan read back, a cycle
 *   recorded, and a plan whose charge failed marked `past_due`.
 * - **`payment.message`** — the receipt, and the message for a payment that didn't go through where nobody
 *   was watching.
 * - **`money.plan`** (global, hourly) arms **`money.sweep`** (one per business, hourly, spread by the
 *   business's id), which re-arms every document job that should be waiting — the safety net for a job that
 *   exhausted its retries, a business whose reminder schedule changed, and documents from before all this.
 *
 * Sending goes through **booking/deliver.ts**, the path every other customer message takes: the person's own
 * consent, quiet hours, the business's texting readiness, and a fixed client id per document and rung, so a
 * retried job sends once. A text quiet hours catch **waits for them to end** — one message per thing, rather
 * than an email now and a text later.
 */
import { randomUUID } from 'node:crypto';
import {
  attentionSettingsOf,
  estimateExpire as estimateExpireCommand,
  executeCommand,
  invoiceMarkOverdue,
  localDateOf,
  localInstant,
  moneySettingsOf,
  overdueFrom,
  reminderSchedule,
  scheduleJob,
  subscriptionRecordCycle,
  uuidArray,
  workspaceMessaging,
  type MoneySettings,
  type PaymentMethod,
  type ReminderStep,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import {
  clientIdFor,
  quietEndAt,
  reachOf,
  sendEmail,
  sendText,
  wasSent,
  type Reach,
} from '../booking/deliver';
import { businessOf } from '../booking/visit';
import { invoicePaidEmail } from '../emails/templates';
import type { EventHandler, HandlerContext } from '../handlers/types';
import type { JobHandler, JobMap, JobResult } from '../jobs';
import { errorMessage } from '../outbox';
import { accountByExternalId } from '../payments/index';
import {
  isPaymentProvider,
  PaymentAuthError,
  PaymentError,
  type PaymentProviderName,
} from '../payments/provider';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import { recordSystemEvent } from '../system-event';
import { estimateUrlFor, invoiceUrlFor } from './links';
import {
  estimateNudgeEmail,
  estimateNudgeText,
  estimateSentEmail,
  estimateSentText,
  INVOICE_SENT_KEY,
  invoiceReminderEmail,
  invoiceReminderText,
  invoiceSentEmail,
  invoiceSentText,
  paymentFailedEmail,
  paymentFailedText,
  receiptEmail,
  receiptText,
  reminderKeyOf,
  reminderOffsetOf,
  type MoneyBusiness,
} from './messages';
import { subscriptionOutcomeOf } from './webhook-events';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * The money jobs this step owns. `payment.refund` lives beside them in money/refunds.ts (step 5's), and every
 * kind here starts with one of the prefixes money/test-routes.ts drives, so a spec never waits on real time.
 */
export const MONEY_JOBS = {
  /** An invoice's own message, and each rung of the reminder ladder. */
  invoiceMessage: 'invoice.message',
  invoiceOverdue: 'invoice.mark_overdue',
  /** An estimate's own message, and the one nudge. */
  estimateMessage: 'estimate.message',
  estimateExpire: 'estimate.expire',
  /** A receipt, and a payment that didn't go through. */
  paymentMessage: 'payment.message',
  subscriptionCycle: 'subscription.cycle',
  /** One per business, hourly: everything that should be waiting, is. */
  sweep: 'money.sweep',
  /** Global and hourly: every business has its sweep. */
  plan: 'money.plan',
} as const;

export const MONEY_PLAN_KEY = 'plan:money';

export const invoiceMessageKey = (invoiceId: string, key: string): string =>
  `money-invoice:${invoiceId}:${key}`;
export const invoiceOverdueKey = (invoiceId: string): string => `money-overdue:${invoiceId}`;
export const estimateMessageKey = (estimateId: string, key: string): string =>
  `money-estimate:${estimateId}:${key}`;
export const estimateExpireKey = (estimateId: string): string => `money-expire:${estimateId}`;
export const subscriptionCycleKey = (subscriptionId: string): string =>
  `money-cycle:${subscriptionId}`;
export const paymentMessageKey = (paymentId: string, key: string): string =>
  `money-payment:${paymentId}:${key}`;
export const moneySweepKey = (workspaceId: string): string => `money-sweep:${workspaceId}`;

/** The estimate's own message, and the one nudge after it. */
export const ESTIMATE_SENT_KEY = 'sent';
export const ESTIMATE_NUDGE_KEY = 'nudge';
/** A payment's two messages. */
export const RECEIPT_KEY = 'receipt';
export const PAYMENT_FAILED_KEY = 'failed';

/** The event that records the one nudge, so it is never sent twice and never armed again. */
const NUDGED_EVENT = 'estimate.nudged';
/** The marker that keeps a retried handler from sending the team's "you've been paid" twice. */
const PAID_EMAILED = 'invoice.team_emailed';

/**
 * The local time of day every money message goes out. Nine in the morning where the business is: past quiet
 * hours everywhere in the US, and early enough that a customer can do something about it the same day.
 */
export const MONEY_SEND_AT = '09:00';

/**
 * A message whose moment passed longer ago than this is never sent. Without it, an invoice sent (or seeded)
 * with a due date weeks past would fire its whole ladder at once, and the customer would get four texts in a
 * second about one bill.
 */
const TOO_LATE_MS = 12 * HOUR;
/** A rung held back while a bank transfer settles looks again a day later. */
const SETTLING_WAIT_MS = DAY;
/** How often one business is swept, and how far the first sweep of a new business is spread. */
const SWEEP_EVERY_MS = HOUR;
/** Businesses per statement in the hourly plan (three parameters each). */
const PLAN_CHUNK = 2000;

const jobMeta = (jobId: string): RequestMeta => workerMeta(null, jobId);

// ---------------------------------------------------------------------------
// Arming
//
// One SQL statement per kind of job, over either the whole business (the hourly sweep) or one document (the
// event that changed it). Both paths run the same statement, so a document armed by its own event and one
// armed by the sweep can never be armed differently.
// ---------------------------------------------------------------------------

/** An invoice that is out and still owed something. */
const openInvoice = (scope: TenantScope, only: string | null) => sql`
  i.workspace_id = ${scope.workspaceId}::uuid
  and i.status in ('sent', 'partly_paid', 'overdue')
  and i.sent_at is not null and i.voided_at is null and i.balance_cents > 0
  and (${only}::uuid is null or i.id = ${only}::uuid)`;

/**
 * An invoice brought from another CRM is quiet: HandsFreeOS never chases it.
 *
 * Chris's call (2026-09-19), and the reason is the overlap. A business moving in keeps its old system running
 * while the history catches up, and that system is still sending its own reminders about the same unpaid
 * bills. Chasing from both ends would have a customer told twice, by two systems, about one bill — the kind
 * of thing they remember about a business.
 *
 * Only the *outbound* chasing stops. The invoice still turns overdue, still shows as owed, and still appears
 * in what needs attention: the business sees everything, the customer hears nothing.
 */
const notImported = sql`coalesce(i.reminder_state ->> 'imported', '') <> 'quiet'`;
/** The same for an estimate: the nudge and the expiry warning are messages to the customer as well. */
const notImportedEstimate = sql`coalesce(e.reminder_state ->> 'imported', '') <> 'quiet'`;

/** An estimate that is out and unanswered. */
const openEstimate = (scope: TenantScope, only: string | null) => sql`
  e.workspace_id = ${scope.workspaceId}::uuid and e.status = 'sent'
  and e.sent_at is not null and e.voided_at is null
  and (${only}::uuid is null or e.id = ${only}::uuid)`;

/** One pending job per kind and key; a `failed` one is replaced, because the index only counts pending rows. */
const keepOne = () =>
  sql`on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`;

/** How far back a moment can be and still be worth arming. */
const notLongPast = () => sql`now() - ${`${TOO_LATE_MS} milliseconds`}::interval`;

/**
 * The reminder ladder for every open invoice (or one of them). A rung already sent or skipped is left alone,
 * and a rung whose moment is long past is not armed at all.
 */
export async function armInvoiceReminders(
  tx: Tx,
  scope: TenantScope,
  timeZone: string,
  schedule: readonly ReminderStep[],
  only: string | null,
): Promise<void> {
  for (const step of schedule) {
    const key = reminderKeyOf(step);
    const at = sql`((i.due_on + ${reminderOffsetOf(step)}::int) + ${MONEY_SEND_AT}::time)
        at time zone ${timeZone}`;
    await tx.execute(
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          select ${scope.organizationId}::uuid, i.workspace_id, ${MONEY_JOBS.invoiceMessage},
            ${'money-invoice:'}::text || i.id::text || ':' || ${key}::text,
            greatest(now(), ${at}),
            jsonb_build_object('invoiceId', i.id, 'key', ${key}::text)
          from app.invoices i
          where ${openInvoice(scope, only)}
            and ${notImported}
            and i.due_on is not null
            and ${at} > ${notLongPast()}
            and coalesce(i.reminder_state #>> array['reminders', ${key}::text, 'status'], '')
                not in ('sent', 'skipped')
          ${keepOne()}`,
    );
  }
}

/**
 * The overdue mark: the end of the due day where the business is, plus the grace the Action Center gives an
 * unpaid invoice before it opens a card, so the status and the card turn over together.
 */
export async function armInvoiceOverdue(
  tx: Tx,
  scope: TenantScope,
  timeZone: string,
  graceDays: number,
  only: string | null,
): Promise<void> {
  const at = sql`((i.due_on + 1 + ${graceDays}::int)::timestamp) at time zone ${timeZone}`;
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        select ${scope.organizationId}::uuid, i.workspace_id, ${MONEY_JOBS.invoiceOverdue},
          ${'money-overdue:'}::text || i.id::text, greatest(now(), ${at}),
          jsonb_build_object('invoiceId', i.id)
        from app.invoices i
        where ${openInvoice(scope, only)}
          and i.status <> 'overdue' and i.due_on is not null
          and not exists (select 1 from app.payments p
            where p.invoice_id = i.id and p.status = 'processing')
        ${keepOne()}`,
  );
}

/** When an estimate stops being good: the end of its last good day where the business is. */
const expiresAtSql = (timeZone: string) =>
  sql`((e.expires_on + 1)::timestamp) at time zone ${timeZone}`;

export async function armEstimateExpiry(
  tx: Tx,
  scope: TenantScope,
  timeZone: string,
  only: string | null,
): Promise<void> {
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        select ${scope.organizationId}::uuid, e.workspace_id, ${MONEY_JOBS.estimateExpire},
          ${'money-expire:'}::text || e.id::text, greatest(now(), ${expiresAtSql(timeZone)}),
          jsonb_build_object('estimateId', e.id)
        from app.estimates e
        where ${openEstimate(scope, only)} and ${notImportedEstimate} and e.expires_on is not null
        ${keepOne()}`,
  );
}

/**
 * The one nudge, a set number of days after the estimate went out. Never after it has stopped being good (a
 * settings warning says so too), and never twice — an `estimate.nudged` event is the record that it went.
 */
export async function armEstimateNudge(
  tx: Tx,
  scope: TenantScope,
  timeZone: string,
  afterDays: number | null,
  only: string | null,
): Promise<void> {
  if (afterDays === null) return;
  const at = sql`(((e.sent_at at time zone ${timeZone})::date + ${afterDays}::int)
      + ${MONEY_SEND_AT}::time) at time zone ${timeZone}`;
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        select ${scope.organizationId}::uuid, e.workspace_id, ${MONEY_JOBS.estimateMessage},
          ${'money-estimate:'}::text || e.id::text || ':' || ${ESTIMATE_NUDGE_KEY}::text,
          greatest(now(), ${at}),
          jsonb_build_object('estimateId', e.id, 'key', ${ESTIMATE_NUDGE_KEY}::text)
        from app.estimates e
        where ${openEstimate(scope, only)}
          and ${notImportedEstimate}
          and ${at} > ${notLongPast()}
          and (e.expires_on is null or ${at} < ${expiresAtSql(timeZone)})
          and not exists (select 1 from app.events ev
            where ev.workspace_id = e.workspace_id and ev.entity_type = 'estimate'
              and ev.entity_id = e.id and ev.event_type = ${NUDGED_EVENT})
        ${keepOne()}`,
  );
}

/**
 * Reading a plan back from the provider: the day after it bills, so the provider's own engine has had its go
 * first. A plan the provider hasn't told us about yet is read back at once by the event that started it.
 */
export async function armSubscriptionCycles(
  tx: Tx,
  scope: TenantScope,
  timeZone: string,
  only: string | null,
): Promise<void> {
  const at = sql`(((s.next_billing_on + 1) + ${MONEY_SEND_AT}::time) at time zone ${timeZone})`;
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        select ${scope.organizationId}::uuid, s.workspace_id, ${MONEY_JOBS.subscriptionCycle},
          ${'money-cycle:'}::text || s.id::text, greatest(now(), ${at}),
          jsonb_build_object('subscriptionId', s.id)
        from app.subscriptions s
        where s.workspace_id = ${scope.workspaceId}::uuid
          and s.status in ('active', 'past_due')
          and s.external_subscription_id is not null and s.next_billing_on is not null
          and (${only}::uuid is null or s.id = ${only}::uuid)
        ${keepOne()}`,
  );
}

/** One message queued for now: a document's own, or a payment's. */
async function armNow(
  tx: Tx,
  scope: TenantScope,
  kind: string,
  dedupeKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await scheduleJob(
    tx,
    {
      kind,
      dedupeKey,
      runAt: new Date(),
      payload,
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
}

/** Everything one business should have waiting, or everything one document should. */
export async function armBusinessMoney(
  tx: Tx,
  scope: TenantScope,
  only: { invoiceId?: string; estimateId?: string; subscriptionId?: string } = {},
): Promise<void> {
  const m = await workspaceMessaging(tx, scope.workspaceId);
  const timeZone = m.timezone || 'UTC';
  const settings = moneySettingsOf(m.rawSettings);
  const grace = attentionSettingsOf(m.rawSettings).money.invoiceOverdueDays;
  const everything = !only.invoiceId && !only.estimateId && !only.subscriptionId;
  if (everything || only.invoiceId) {
    const one = only.invoiceId ?? null;
    await armInvoiceReminders(tx, scope, timeZone, reminderSchedule(settings), one);
    await armInvoiceOverdue(tx, scope, timeZone, grace, one);
  }
  if (everything || only.estimateId) {
    const one = only.estimateId ?? null;
    await armEstimateExpiry(tx, scope, timeZone, one);
    await armEstimateNudge(tx, scope, timeZone, settings.reminders.estimateAfterDays, one);
  }
  if (everything || only.subscriptionId)
    await armSubscriptionCycles(tx, scope, timeZone, only.subscriptionId ?? null);
}

// ---------------------------------------------------------------------------
// What every message needs
// ---------------------------------------------------------------------------

interface Person extends Record<string, unknown> {
  first_name: string;
  phone: string | null;
  email: string | null;
  consent: 'unknown' | 'opted_in' | 'opted_out';
}

/** Everything a money message is written from, read in one go inside the business's scope. */
export interface MessageWorld {
  readonly person: Person;
  readonly business: MoneyBusiness;
  readonly reach: Reach;
  readonly timeZone: string;
  /** When quiet hours end, or null when it isn't quiet hours. */
  readonly quietEnd: number | null;
  readonly settings: MoneySettings;
}

export async function messageWorld(
  tx: Tx,
  s: WorkerServices,
  scope: TenantScope,
  personId: string,
  now: number,
): Promise<MessageWorld | null> {
  // A customer deleted (in the Deleted bin, or gone with only the name their bills keep) hears nothing more.
  const [person] = await rows<Person>(
    tx,
    sql`select first_name, phone_e164 as phone, email::text as email, sms_consent::text as consent
        from app.people where id = ${personId} and bin_item_id is null and erased_at is null`,
  );
  if (!person) return null;
  const m = await workspaceMessaging(tx, scope.workspaceId);
  const timeZone = m.timezone || 'UTC';
  const business = await businessOf(tx, s, scope.workspaceId, null);
  return {
    person,
    business: { name: business.name, phoneDisplay: business.phoneDisplay },
    // A money document has no consent box of its own the way an online booking does, so the person's own
    // consent decides — a text unless they said STOP, exactly as the Action Center's own messages work.
    reach: await reachOf(
      tx,
      scope.workspaceId,
      { phone: person.phone, email: person.email, smsOk: true, personConsent: person.consent },
      { text: true, email: true },
    ),
    timeZone,
    quietEnd: quietEndAt(m.settings.quietHours, timeZone, now),
    settings: moneySettingsOf(m.rawSettings),
  };
}

/** What sending one message came to. */
export type Delivery =
  | { readonly status: 'sent'; readonly channel: 'sms' | 'email'; readonly messageId: string }
  /** Quiet hours: the text waits for them to end. */
  | { readonly status: 'held'; readonly until: number }
  | { readonly status: 'skipped'; readonly reason: string };

/**
 * One message out, by the rules every customer message follows: a text when they can have one and it isn't
 * quiet hours, email when a text can't go, and nothing at all when neither can. The `clientId` is fixed for
 * the document and rung, so a retried job sends once.
 */
export async function deliver(
  s: WorkerServices,
  scope: TenantScope,
  world: MessageWorld,
  content: { text: string; email: { subject: string; body: string } },
  clientId: string,
  meta: RequestMeta,
): Promise<Delivery> {
  let textWhy = world.reach.text;
  if (textWhy === null) {
    if (world.quietEnd !== null) return { status: 'held', until: world.quietEnd };
    const sent = await sendText(s, scope, world.person.phone!, content.text, clientId, meta);
    if (wasSent(sent)) return { status: 'sent', channel: 'sms', messageId: sent.messageId };
    textWhy = sent.refused;
  }
  if (world.reach.email === null) {
    const sent = await sendEmail(s, scope, world.person.email!, content.email, clientId, meta);
    if (wasSent(sent)) return { status: 'sent', channel: 'email', messageId: sent.messageId };
    return { status: 'skipped', reason: sent.refused };
  }
  return { status: 'skipped', reason: textWhy === 'opted_out' ? 'opted_out' : 'no_contact' };
}

// ---------------------------------------------------------------------------
// Local days
// ---------------------------------------------------------------------------

/** A local date `days` on from `day` (`2026-09-25` plus 3). */
function addLocalDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/**
 * A timestamp column as milliseconds. A raw `select` hands back a Date from some drivers and a string from
 * others, so nothing here assumes which; null and anything unreadable come back as null.
 */
function instantOf(value: Date | string | null): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** The moment one rung is due: its offset from the due day, at nine where the business is. */
function rungDueAt(step: ReminderStep, dueOn: string, timeZone: string): number {
  return localInstant(addLocalDays(dueOn, reminderOffsetOf(step)), MONEY_SEND_AT, timeZone);
}

// ---------------------------------------------------------------------------
// An invoice's message, and its reminders
// ---------------------------------------------------------------------------

interface InvoiceRow extends Record<string, unknown> {
  id: string;
  number: string | null;
  title: string | null;
  status: string;
  total_cents: number;
  balance_cents: number;
  due_on: string | null;
  person_id: string;
  voided_at: Date | string | null;
  reminder_state: unknown;
  settling: boolean;
}

const invoiceSql = (scope: TenantScope, invoiceId: string) => sql`
  select i.id, i.number, i.title, i.status::text as status,
    i.total_cents::float8 as total_cents, i.balance_cents::float8 as balance_cents,
    i.due_on::text as due_on, i.person_id, i.voided_at, i.reminder_state,
    exists (select 1 from app.payments p where p.invoice_id = i.id and p.status = 'processing')
      as settling
  from app.invoices i
  where i.workspace_id = ${scope.workspaceId} and i.id = ${invoiceId}`;

/** What one rung has already come to, from `invoices.reminder_state`. */
function rungStatus(state: unknown, key: string): string | null {
  const reminders = (state as { reminders?: Record<string, { status?: unknown }> } | null)
    ?.reminders;
  const status = reminders?.[key]?.status;
  return typeof status === 'string' ? status : null;
}

interface RungRecord {
  readonly status: 'scheduled' | 'sent' | 'skipped';
  readonly channel?: 'sms' | 'email' | null;
  readonly reason?: string | null;
  readonly messageId?: string | null;
  readonly dueAt?: number | null;
}

/**
 * The rung's outcome, into `invoices.reminder_state`. The worker owns that column — a database guard keeps
 * people out of it — so it is written here rather than through a command of its own.
 */
async function recordRung(
  s: WorkerServices,
  scope: TenantScope,
  invoiceId: string,
  key: string,
  r: RungRecord,
): Promise<void> {
  const entry = {
    status: r.status,
    channel: r.channel ?? null,
    reason: r.reason ?? null,
    messageId: r.messageId ?? null,
    dueAt: r.dueAt ? new Date(r.dueAt).toISOString() : null,
    at: new Date().toISOString(),
  };
  await asWorker(s.db, scope, (tx) =>
    tx.execute(
      sql`update app.invoices
          set reminder_state = jsonb_set(
            case when jsonb_typeof(reminder_state -> 'reminders') = 'object' then reminder_state
                 else coalesce(reminder_state, '{}'::jsonb) || jsonb_build_object('reminders', '{}'::jsonb)
            end,
            array['reminders', ${key}], ${JSON.stringify(entry)}::jsonb, true)
          where workspace_id = ${scope.workspaceId} and id = ${invoiceId}`,
    ),
  );
}

/** `invoice.message`: the invoice's own message, or one rung of the ladder. */
export const invoiceMessageJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const invoiceId = String(ctx.job.payload['invoiceId'] ?? '');
  const key = String(ctx.job.payload['key'] ?? '');
  if (!invoiceId || !key) return;
  const now = ctx.now;
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [invoice] = await rows<InvoiceRow>(tx, invoiceSql(scope, invoiceId));
    if (!invoice) return null;
    const world = await messageWorld(tx, ctx, scope, invoice.person_id, now);
    if (!world) return null;
    return { invoice, world, url: await invoiceUrlFor(tx, ctx.moneyLinks, invoiceId) };
  });
  if (!found) return;
  const { invoice, world, url } = found;
  const note = (r: RungRecord) => recordRung(ctx, scope, invoiceId, key, r);

  // Already answered for this rung (a retry, or a job re-armed after one was lost): nothing to do.
  const already = rungStatus(invoice.reminder_state, key);
  if (already === 'sent' || already === 'skipped') return;
  if (invoice.voided_at) return note({ status: 'skipped', reason: 'voided' });
  if (Number(invoice.balance_cents) <= 0 || invoice.status === 'paid')
    return note({ status: 'skipped', reason: 'paid' });

  const first = key === INVOICE_SENT_KEY;
  const step = first
    ? null
    : reminderSchedule(world.settings).find((s) => reminderKeyOf(s) === key);
  if (!first) {
    // The business changed its schedule after this was armed.
    if (!step || !invoice.due_on) return note({ status: 'skipped', reason: 'off' });
    const due = rungDueAt(step, invoice.due_on, world.timeZone);
    if (due > now + 250) return { rescheduleAt: new Date(due) };
    if (due < now - TOO_LATE_MS) return note({ status: 'skipped', reason: 'too_late' });
    // A bank transfer on its way is paying, not late: the rung waits until we know either way.
    if (invoice.settling) {
      await note({ status: 'scheduled', reason: 'settling', dueAt: now + SETTLING_WAIT_MS });
      return { rescheduleAt: new Date(now + SETTLING_WAIT_MS) };
    }
  }
  if (!url) return note({ status: 'skipped', reason: 'no_link' });

  const base = {
    business: world.business,
    firstName: world.person.first_name.trim(),
    number: invoice.number,
    title: invoice.title,
    totalCents: Number(invoice.total_cents),
    balanceCents: Number(invoice.balance_cents),
    dueOn: invoice.due_on,
    timeZone: world.timeZone,
    now,
    url,
    first: world.reach.firstText,
  };
  const content = step
    ? {
        text: invoiceReminderText({ ...base, step }),
        email: invoiceReminderEmail({ ...base, step }),
      }
    : { text: invoiceSentText(base), email: invoiceSentEmail(base) };
  const out = await deliver(
    ctx,
    scope,
    world,
    content,
    clientIdFor('money-invoice', invoiceId, key),
    jobMeta(ctx.job.id),
  );
  if (out.status === 'held') {
    await note({ status: 'scheduled', channel: 'sms', reason: 'quiet_hours', dueAt: out.until });
    return { rescheduleAt: new Date(out.until) };
  }
  if (out.status === 'skipped') return note({ status: 'skipped', reason: out.reason });
  await note({ status: 'sent', channel: out.channel, messageId: out.messageId });
};

// ---------------------------------------------------------------------------
// Marking an invoice overdue
// ---------------------------------------------------------------------------

/** `invoice.mark_overdue`: at the end of the due day where the business is, plus its grace day. */
export const invoiceOverdueJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const invoiceId = String(ctx.job.payload['invoiceId'] ?? '');
  if (!invoiceId) return;
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [invoice] = await rows<InvoiceRow>(tx, invoiceSql(scope, invoiceId));
    if (!invoice) return null;
    const m = await workspaceMessaging(tx, scope.workspaceId);
    return {
      invoice,
      timeZone: m.timezone || 'UTC',
      graceDays: attentionSettingsOf(m.rawSettings).money.invoiceOverdueDays,
    };
  });
  if (!found) return;
  const { invoice, timeZone, graceDays } = found;
  if (invoice.voided_at || !invoice.due_on) return;
  if (invoice.status !== 'sent' && invoice.status !== 'partly_paid') return;
  if (Number(invoice.balance_cents) <= 0) return;
  // Never while a payment is on its way: the command agrees, and this saves the call.
  if (invoice.settling) return { rescheduleAt: new Date(ctx.now + SETTLING_WAIT_MS) };
  // Whole days where the business is, as the job was armed: a day the clocks change is 23 or 25 hours long.
  const markAt = overdueFrom(addLocalDays(invoice.due_on, graceDays), timeZone);
  if (markAt > ctx.now + 250) return { rescheduleAt: new Date(markAt) };

  const { output } = await executeCommand(
    ctx.db,
    invoiceMarkOverdue,
    { workspaceId: scope.workspaceId, invoiceId },
    systemActor(scope),
    jobMeta(ctx.job.id),
  );
  // Settling since we read it: look again tomorrow. Anything else is settled either way, and the hourly
  // sweep arms a fresh job if the facts change.
  if (!output.changed && output.skipped === 'settling')
    return { rescheduleAt: new Date(ctx.now + SETTLING_WAIT_MS) };
};

// ---------------------------------------------------------------------------
// An estimate's message, its nudge, and its expiry
// ---------------------------------------------------------------------------

interface EstimateRow extends Record<string, unknown> {
  id: string;
  number: string | null;
  title: string | null;
  status: string;
  total_cents: number;
  expires_on: string | null;
  sent_at: Date | string | null;
  person_id: string;
  voided_at: Date | string | null;
}

const estimateSql = (scope: TenantScope, estimateId: string) => sql`
  select e.id, e.number, e.title, e.status::text as status, e.total_cents::float8 as total_cents,
    e.expires_on::text as expires_on, e.sent_at, e.person_id, e.voided_at
  from app.estimates e
  where e.workspace_id = ${scope.workspaceId} and e.id = ${estimateId}`;

/** `estimate.message`: the estimate itself, or the one nudge after it. */
export const estimateMessageJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const estimateId = String(ctx.job.payload['estimateId'] ?? '');
  const key = String(ctx.job.payload['key'] ?? '');
  if (!estimateId || !key) return;
  const now = ctx.now;
  const nudge = key === ESTIMATE_NUDGE_KEY;
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [estimate] = await rows<EstimateRow>(tx, estimateSql(scope, estimateId));
    if (!estimate) return null;
    const [nudged] = await rows(
      tx,
      sql`select 1 from app.events where workspace_id = ${scope.workspaceId}
          and entity_type = 'estimate' and entity_id = ${estimateId}
          and event_type = ${NUDGED_EVENT} limit 1`,
    );
    const world = await messageWorld(tx, ctx, scope, estimate.person_id, now);
    if (!world) return null;
    return {
      estimate,
      world,
      alreadyNudged: !!nudged,
      url: await estimateUrlFor(tx, ctx.moneyLinks, estimateId),
    };
  });
  if (!found) return;
  const { estimate, world, url } = found;
  // Answered, expired, voided or reissued: an estimate is never chased once it has stopped being open.
  if (estimate.status !== 'sent' || estimate.voided_at || !url) return;
  if (nudge) {
    const sentAt = instantOf(estimate.sent_at);
    if (found.alreadyNudged || sentAt === null) return;
    const days = world.settings.reminders.estimateAfterDays;
    if (days === null) return;
    const sentOn = localDateOf(sentAt, world.timeZone);
    const due = localInstant(addLocalDays(sentOn, days), MONEY_SEND_AT, world.timeZone);
    if (due > now + 250) return { rescheduleAt: new Date(due) };
    if (due < now - TOO_LATE_MS) return;
    // It stopped being good after the nudge was armed: reissuing beats chasing.
    if (estimate.expires_on && now >= overdueFrom(estimate.expires_on, world.timeZone)) return;
  }

  const base = {
    business: world.business,
    firstName: world.person.first_name.trim(),
    number: estimate.number,
    title: estimate.title,
    totalCents: Number(estimate.total_cents),
    expiresOn: estimate.expires_on,
    timeZone: world.timeZone,
    now,
    url,
    first: world.reach.firstText,
  };
  const content = nudge
    ? { text: estimateNudgeText(base), email: estimateNudgeEmail(base) }
    : { text: estimateSentText(base), email: estimateSentEmail(base) };
  const out = await deliver(
    ctx,
    scope,
    world,
    content,
    clientIdFor('money-estimate', estimateId, key),
    jobMeta(ctx.job.id),
  );
  if (out.status === 'held') return { rescheduleAt: new Date(out.until) };
  if (!nudge) return;
  // One nudge per estimate, however it went: the record is what stops a second one being armed.
  await asWorker(ctx.db, scope, (tx) =>
    recordSystemEvent(tx, {
      type: NUDGED_EVENT,
      action: 'estimate.nudge',
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'estimate',
      entityId: estimateId,
      payload: {
        estimateId,
        outcome: out.status,
        channel: out.status === 'sent' ? out.channel : null,
        reason: out.status === 'skipped' ? out.reason : null,
        _broadcast: false,
      },
      after: { estimate: estimate.number ?? estimateId, nudge: out.status },
      correlationId: randomUUID(),
      causationId: ctx.job.id,
    }),
  );
};

/** `estimate.expire`: it stayed good until its day and nobody answered. */
export const estimateExpireJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const estimateId = String(ctx.job.payload['estimateId'] ?? '');
  if (!estimateId) return;
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [estimate] = await rows<EstimateRow>(tx, estimateSql(scope, estimateId));
    if (!estimate) return null;
    const m = await workspaceMessaging(tx, scope.workspaceId);
    return { estimate, timeZone: m.timezone || 'UTC' };
  });
  if (!found) return;
  const { estimate, timeZone } = found;
  if (estimate.status !== 'sent' || !estimate.expires_on) return;
  const at = overdueFrom(estimate.expires_on, timeZone);
  if (at > ctx.now + 250) return { rescheduleAt: new Date(at) };
  await executeCommand(
    ctx.db,
    estimateExpireCommand,
    { workspaceId: scope.workspaceId, estimateId },
    systemActor(scope),
    jobMeta(ctx.job.id),
  );
};

// ---------------------------------------------------------------------------
// What a payment brings the customer
// ---------------------------------------------------------------------------

interface PaymentRow extends Record<string, unknown> {
  id: string;
  invoice_id: string;
  amount_cents: number;
  method: string;
  status: string;
  received_at: Date | string | null;
  number: string | null;
  balance_cents: number;
  person_id: string;
}

/** `payment.message`: the receipt, or a payment that didn't go through. */
export const paymentMessageJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const paymentId = String(ctx.job.payload['paymentId'] ?? '');
  const key = String(ctx.job.payload['key'] ?? '');
  if (!paymentId || (key !== RECEIPT_KEY && key !== PAYMENT_FAILED_KEY)) return;
  const now = ctx.now;
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [payment] = await rows<PaymentRow>(
      tx,
      sql`select p.id, p.invoice_id, p.amount_cents::float8 as amount_cents, p.method::text as method,
            p.status::text as status, p.received_at, i.number,
            i.balance_cents::float8 as balance_cents, i.person_id
          from app.payments p join app.invoices i on i.id = p.invoice_id
          where p.workspace_id = ${scope.workspaceId} and p.id = ${paymentId}`,
    );
    if (!payment) return null;
    const world = await messageWorld(tx, ctx, scope, payment.person_id, now);
    if (!world) return null;
    return { payment, world, url: await invoiceUrlFor(tx, ctx.moneyLinks, payment.invoice_id) };
  });
  if (!found) return;
  const { payment, world, url } = found;
  // The payment moved on since (a returned transfer that settled after all): the other message covers it.
  if (payment.status !== (key === RECEIPT_KEY ? 'succeeded' : 'failed')) return;
  if (!url) return;

  const base = {
    business: world.business,
    firstName: world.person.first_name.trim(),
    number: payment.number,
    amountCents: Number(payment.amount_cents),
    balanceCents: Number(payment.balance_cents),
    method: payment.method as PaymentMethod,
    receivedAt: instantOf(payment.received_at),
    timeZone: world.timeZone,
    now,
    url,
    first: world.reach.firstText,
  };
  const content =
    key === RECEIPT_KEY
      ? { text: receiptText(base), email: receiptEmail(base) }
      : { text: paymentFailedText(base), email: paymentFailedEmail(base) };
  const out = await deliver(
    ctx,
    scope,
    world,
    content,
    clientIdFor('money-payment', paymentId, key),
    jobMeta(ctx.job.id),
  );
  if (out.status === 'held') return { rescheduleAt: new Date(out.until) };
};

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

interface SubscriptionRow extends Record<string, unknown> {
  id: string;
  status: string;
  provider: string | null;
  external_subscription_id: string | null;
  external_account_id: string | null;
  current_period_start: string | null;
  next_billing_on: string | null;
}

const asDate = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

/**
 * `subscription.cycle`: the plan read back from the provider, and what it says written down — a cycle billed,
 * a charge that failed (which marks the plan `past_due`), or a plan that ended there. The provider's engine
 * runs the billing, the retries and the card updater; this is the part it can't do, which is keeping our own
 * mirror honest when a webhook never arrives.
 */
export const subscriptionCycleJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const subscriptionId = String(ctx.job.payload['subscriptionId'] ?? '');
  if (!subscriptionId) return;
  const [plan] = await asWorker(ctx.db, scope, (tx) =>
    rows<SubscriptionRow>(
      tx,
      sql`select s.id, s.status::text as status, s.provider::text as provider,
            s.external_subscription_id, pc.external_account_id,
            s.current_period_start::text as current_period_start,
            s.next_billing_on::text as next_billing_on
          from app.subscriptions s
          left join app.payment_connections pc on pc.id = s.connection_id
          where s.workspace_id = ${scope.workspaceId} and s.id = ${subscriptionId}`,
    ),
  );
  // Paused, cancelled, unmanaged, a draft, or never started at the provider: nothing to read back.
  if (!plan || (plan.status !== 'active' && plan.status !== 'past_due')) return;
  if (!plan.external_subscription_id || !plan.provider) return;
  if (!isPaymentProvider(plan.provider)) return;
  const provider: PaymentProviderName = plan.provider;
  const later = (ms: number): JobResult => ({ rescheduleAt: new Date(ctx.now + ms) });
  const meta = jobMeta(ctx.job.id);

  const found = plan.external_account_id
    ? await accountByExternalId(
        ctx.db,
        scope,
        { provider, externalAccountId: plan.external_account_id },
        ctx.sealer,
      )
    : null;
  // The account it bills through is gone. The plan keeps billing at the provider, so say so plainly rather
  // than let our own mirror drift: reconnecting the same account picks it up again.
  if (!found) {
    await executeCommand(
      ctx.db,
      subscriptionRecordCycle,
      {
        workspaceId: scope.workspaceId,
        subscriptionId,
        outcome: 'unmanaged' as const,
        message:
          'The account this plan bills through isn’t connected any more, so HandsFreeOS can’t follow it. Reconnect it, or cancel the plan at the provider.',
      },
      systemActor(scope),
      meta,
    );
    return;
  }

  let state;
  try {
    state = await ctx.payments.providers[provider].subscriptions.get(found.account, {
      providerSubscriptionId: plan.external_subscription_id,
    });
  } catch (e) {
    if (e instanceof PaymentAuthError) {
      // The sign-in needs renewing, and payments/refresh.ts owns that. Look again once it has had its go.
      ctx.log.warn({ subscriptionId, provider }, 'a plan could not be read back: reconnect needed');
      return later(6 * HOUR);
    }
    if (e instanceof PaymentError && e.permanent) {
      ctx.log.warn(
        { subscriptionId, provider, err: errorMessage(e) },
        'a plan could not be read back',
      );
      return later(DAY);
    }
    throw e;
  }

  const outcome = subscriptionOutcomeOf(state.providerStatus);
  if (!outcome) return later(DAY);
  const periodStart = asDate(state.currentPeriodStart);
  const periodEnd = asDate(state.currentPeriodEnd);
  // A period that has moved on since we last looked is a cycle the provider billed without telling us.
  const billed =
    outcome === 'activated' &&
    !!periodStart &&
    (!plan.current_period_start || periodStart > plan.current_period_start);
  await executeCommand(
    ctx.db,
    subscriptionRecordCycle,
    {
      workspaceId: scope.workspaceId,
      subscriptionId,
      outcome: billed ? ('billed' as const) : outcome,
      externalSubscriptionId: state.providerSubscriptionId,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      nextBillingOn: outcome === 'ended' ? null : periodEnd,
      endedOn: outcome === 'ended' ? asDate(state.cancelAt ?? state.currentPeriodEnd) : null,
      message:
        outcome === 'failed'
          ? 'The card on this plan was refused when the provider billed it.'
          : outcome === 'ended'
            ? 'Ended at the provider.'
            : null,
    },
    systemActor(scope),
    meta,
  );
  if (outcome === 'ended') return;
  // The next look: a day after it bills again. The day is taken as UTC, which can be a few hours out either
  // way — that is fine for a safety net, and the hourly sweep arms the exact local moment if this job is gone.
  const next = periodEnd ?? plan.next_billing_on;
  return later(next ? Math.max(DAY, Date.parse(`${next}T00:00:00Z`) + DAY - ctx.now) : DAY);
};

// ---------------------------------------------------------------------------
// The hourly plan, and each business's sweep
// ---------------------------------------------------------------------------

/** Hourly, for the whole server: every business has its money sweep waiting, spread over the hour. */
export const planMoney: JobHandler = async (ctx) => {
  await asWorker(ctx.db, {}, async (tx) => {
    const list = await rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select workspace_id, organization_id from private.workspace_timezones()`,
    );
    const from = new Date(ctx.now).toISOString();
    for (let i = 0; i < list.length; i += PLAN_CHUNK) {
      const chunk = list.slice(i, i + PLAN_CHUNK);
      const keys = chunk.map((b) => sql`${moneySweepKey(b.workspace_id)}`);
      await tx.execute(
        sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
            select b.org, b.ws, ${MONEY_JOBS.sweep}, b.key,
              ${from}::timestamptz
                + (abs(hashtext(b.ws::text)::bigint) % ${SWEEP_EVERY_MS}::bigint)
                  * interval '1 millisecond',
              '{}'::jsonb
            from unnest(${uuidArray(chunk.map((b) => b.workspace_id))},
              ${uuidArray(chunk.map((b) => b.organization_id))},
              array[${sql.join(keys, sql`, `)}]::text[]) as b(ws, org, key)
            ${keepOne()}`,
      );
    }
  });
  return { rescheduleAt: new Date(ctx.now + HOUR) };
};

/** One business, hourly: everything that should be waiting, is. */
export const sweepMoney: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [ws] = await rows<{ id: string }>(
      tx,
      sql`select id from app.workspaces where id = ${scope.workspaceId}`,
    );
    if (!ws) return false;
    await armBusinessMoney(tx, scope);
    return true;
  });
  // The business is gone, and its jobs go with it.
  if (!found) return;
  return { rescheduleAt: new Date(ctx.now + SWEEP_EVERY_MS) };
};

// ---------------------------------------------------------------------------
// What the events arm
// ---------------------------------------------------------------------------

const payloadOf = (ctx: HandlerContext): Record<string, unknown> =>
  (ctx.event.payload ?? {}) as Record<string, unknown>;

const idIn = (p: Record<string, unknown>, field: string, fallback: string | null): string | null =>
  typeof p[field] === 'string' && p[field] ? (p[field] as string) : fallback;

/** An estimate went out: its message now, then the nudge and the expiry at their own times. */
export const onEstimateSent: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const estimateId = ctx.event.entityId;
  if (!estimateId) return;
  await armNow(
    ctx.tx,
    scope,
    MONEY_JOBS.estimateMessage,
    estimateMessageKey(estimateId, ESTIMATE_SENT_KEY),
    { estimateId, key: ESTIMATE_SENT_KEY },
  );
  await armBusinessMoney(ctx.tx, scope, { estimateId });
};

/**
 * An invoice went out: its message now, then the ladder and the overdue mark. **Sent with no channels means
 * nobody is messaged** — the deposit at booking is issued while the customer is on the page paying it, and a
 * text saying "here's your invoice" at that moment would be the second time they heard it. The ladder is
 * still armed: it is about what is owed, not about how the document travelled.
 */
export const onInvoiceSent: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const invoiceId = ctx.event.entityId;
  if (!invoiceId) return;
  const asked = payloadOf(ctx)['channels'];
  if (!Array.isArray(asked) || asked.length > 0)
    await armNow(
      ctx.tx,
      scope,
      MONEY_JOBS.invoiceMessage,
      invoiceMessageKey(invoiceId, INVOICE_SENT_KEY),
      { invoiceId, key: INVOICE_SENT_KEY },
    );
  await armBusinessMoney(ctx.tx, scope, { invoiceId });
};

/**
 * An invoice changed: a part payment landed, a refund went back, the document was edited. The rungs it still
 * needs are armed again — one already sent or skipped stays as it is, and a paid or voided invoice arms
 * nothing at all.
 */
export const onInvoiceChanged: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const invoiceId = idIn(payloadOf(ctx), 'invoiceId', ctx.event.entityId);
  if (!invoiceId) return;
  await armBusinessMoney(ctx.tx, scope, { invoiceId });
};

/** A payment landed: the customer gets their receipt. */
export const onPaymentRecorded: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = payloadOf(ctx);
  const paymentId = idIn(p, 'paymentId', ctx.event.entityId);
  if (!paymentId || p['status'] !== 'succeeded') return;
  await armNow(
    ctx.tx,
    scope,
    MONEY_JOBS.paymentMessage,
    paymentMessageKey(paymentId, RECEIPT_KEY),
    { paymentId, key: RECEIPT_KEY },
  );
};

/**
 * A payment didn't go through. A card refused on the customer's own page says so on the page, in the same
 * request — telling them again by text would be the second time they hear it. The two nobody is watching do
 * get a message: a bank transfer the bank sent back days later, and a plan's card refused at the provider.
 */
export const onPaymentFailed: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const paymentId = idIn(payloadOf(ctx), 'paymentId', ctx.event.entityId);
  if (!paymentId) return;
  const [row] = await rows<{ method: string; on_a_plan: boolean }>(
    ctx.tx,
    sql`select p.method::text as method, (i.subscription_id is not null) as on_a_plan
        from app.payments p join app.invoices i on i.id = p.invoice_id
        where p.workspace_id = ${scope.workspaceId} and p.id = ${paymentId}`,
  );
  if (!row || (row.method !== 'ach' && !row.on_a_plan)) return;
  await armNow(
    ctx.tx,
    scope,
    MONEY_JOBS.paymentMessage,
    paymentMessageKey(paymentId, PAYMENT_FAILED_KEY),
    { paymentId, key: PAYMENT_FAILED_KEY },
  );
};

/** A plan started or came back: read it back from the provider now, then at each cycle. */
export const onSubscriptionLive: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const subscriptionId = ctx.event.entityId;
  if (!subscriptionId) return;
  await armNow(ctx.tx, scope, MONEY_JOBS.subscriptionCycle, subscriptionCycleKey(subscriptionId), {
    subscriptionId,
  });
};

// ---------------------------------------------------------------------------
// "You've been paid"
// ---------------------------------------------------------------------------

interface PaidRecipient extends Record<string, unknown> {
  id: string;
  email: string;
  settings: Record<string, unknown>;
}

/** On unless the person turned it off (users.settings.notifications.paymentEmail). */
const wantsPaidEmail = (u: PaidRecipient) =>
  (u.settings as { notifications?: { paymentEmail?: boolean } }).notifications?.paymentEmail !==
  false;

/**
 * An invoice was settled: a short email to whoever is on it and to the owners and admins, who are the people
 * allowed to see money at all. One per invoice — the marker event is caused by the `invoice.paid` it answers,
 * so a retried handler finds it and stops.
 */
export const onInvoicePaid: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const invoiceId = ctx.event.entityId;
  if (!invoiceId) return;
  const [done] = await rows(
    ctx.tx,
    sql`select 1 from app.events where causation_id = ${ctx.event.id}
        and event_type = ${PAID_EMAILED} limit 1`,
  );
  if (done) return;
  const [invoice] = await rows<{
    number: string | null;
    title: string | null;
    total_cents: number;
    assignee_user_id: string | null;
    customer: string;
    method: string | null;
    amount_cents: number | null;
  }>(
    ctx.tx,
    sql`select i.number, i.title, i.total_cents::float8 as total_cents, i.assignee_user_id,
          trim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')) as customer,
          (select p.method::text from app.payments p
            where p.invoice_id = i.id and p.status = 'succeeded'
            order by p.received_at desc nulls last, p.created_at desc limit 1) as method,
          (select p.amount_cents::float8 from app.payments p
            where p.invoice_id = i.id and p.status = 'succeeded'
            order by p.received_at desc nulls last, p.created_at desc limit 1) as amount_cents
        from app.invoices i join app.people pe on pe.id = i.person_id
        where i.workspace_id = ${scope.workspaceId} and i.id = ${invoiceId}`,
  );
  if (!invoice) return;
  const people = (
    await rows<PaidRecipient>(
      ctx.tx,
      // Whoever manages the business's money (0106: owners and admins unless it says otherwise), and whoever the
      // invoice is assigned to. Someone the business keeps from money isn't told what came in.
      sql`select u.id, u.email::text as email, u.settings
          from app.users u
          join app.workspace_memberships wm on wm.user_id = u.id
          join app.workspace_access wa on wa.user_id = wm.user_id and wa.workspace_id = wm.workspace_id
          where wm.workspace_id = ${scope.workspaceId}
            and (wa.manages_money or u.id = ${invoice.assignee_user_id}::uuid)
          order by u.email`,
    )
  ).filter(wantsPaidEmail);
  if (people.length === 0) return;

  const mail = invoicePaidEmail({
    customer: invoice.customer || 'A customer',
    invoice: invoice.number,
    title: invoice.title,
    amountCents: Number(invoice.amount_cents ?? invoice.total_cents),
    totalCents: Number(invoice.total_cents),
    method: invoice.method,
    link: `${ctx.webUrl}/app/w/${scope.workspaceId}/money/invoices/${invoiceId}`,
  });
  let sent = 0;
  for (const person of people)
    try {
      await ctx.mailer.send({ to: person.email, ...mail });
      sent++;
    } catch (e) {
      ctx.log.warn(
        { err: errorMessage(e), userId: person.id, invoiceId },
        'could not tell someone the invoice was paid',
      );
    }
  if (sent === 0) return;
  await recordSystemEvent(ctx.tx, {
    type: PAID_EMAILED,
    action: 'invoice.team_emailed',
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    entityType: 'invoice',
    entityId: invoiceId,
    payload: { invoiceId, userIds: people.map((p) => p.id), _broadcast: false },
    after: { invoice: invoice.number ?? invoiceId, emailed: people.map((p) => p.email) },
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
  });
};

/** Job kind → handler, for scheduled.ts's jobs map. */
export const moneyDocumentJobs: JobMap = {
  [MONEY_JOBS.invoiceMessage]: invoiceMessageJob,
  [MONEY_JOBS.invoiceOverdue]: invoiceOverdueJob,
  [MONEY_JOBS.estimateMessage]: estimateMessageJob,
  [MONEY_JOBS.estimateExpire]: estimateExpireJob,
  [MONEY_JOBS.paymentMessage]: paymentMessageJob,
  [MONEY_JOBS.subscriptionCycle]: subscriptionCycleJob,
  [MONEY_JOBS.sweep]: sweepMoney,
  [MONEY_JOBS.plan]: planMoney,
};
