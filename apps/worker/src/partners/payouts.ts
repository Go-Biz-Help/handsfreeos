/**
 * Paying partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3): the worker's half.
 *
 * Hourly, `partner_payouts.plan` asks which businesses' month hasn't been worked out yet, in their own time zone
 * (`private.partner_payouts_due`), and works each one out (`partner.payout_build`). Then it arms a job for every
 * payout with something left to do (`private.partner_payouts_unfinished`): a card to charge, now or at its next try,
 * or partners to pay, a held one once their account can take it.
 *
 * `partner_payouts.charge` charges the business's card on HandsFreeOS's own Stripe account, once per try by its key
 * (`partner-payout:<payout>:<try>`), and writes down what came back (`partner.payout_record_charge`), which decides
 * when a declined card is tried again. **A decline is an answer, not an exception**, as the wallet's top-ups have
 * it: only a Stripe that didn't answer throws, and the job's own retries try the same key again.
 * `partner_payouts.pay` then sends each partner their part by a transfer tied to the charge, once per line and
 * account by its key; one Stripe won't take for them yet is held, and sent once their account can take it.
 *
 * Nothing is charged for a business staff haven't opened payouts for: the build refuses, and a payout whose
 * business was closed since, or whose card was taken off, stops at its next try.
 */
import {
  executeCommand,
  formatUtcDate,
  money,
  partnerPayoutBuild,
  partnerPayoutRecordAccount,
  partnerPayoutRecordCharge,
  partnerPayoutRecordTransfer,
  payoutMonthWords,
  PAYOUT_WORDS,
  scheduleJob,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import { sendEmail } from '../booking/deliver';
import type { EmailText } from '../booking/messages';
import type { DeliveryProcessor, ProcessorMap } from '../deliveries';
import { partnerPayoutDeclinedEmail } from '../emails/templates';
import { managers } from '../handlers/telephony';
import type { EventHandler } from '../handlers/types';
import type { JobContext, JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import {
  PaymentError,
  PlatformUnsupportedError,
  type PayoutAccountState,
  type PlatformPayments,
} from '../payments/provider';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

export const PAYOUT_JOBS = {
  /** Global, hourly: whose month is due, and every payout with something left to do. */
  plan: 'partner_payouts.plan',
  /** One payout: charge the business's card. */
  charge: 'partner_payouts.charge',
  /** One charged payout: send each partner their part. */
  pay: 'partner_payouts.pay',
} as const;

export const PAYOUT_PLAN_KEY = 'sweep:partner_payouts';

/** The webhook delivery kind a partner's Stripe account event is stored under (http/money.ts). */
export const PARTNER_PAYOUT_ACCOUNT_KIND = 'partner_payout_account';

const HOUR = 3_600_000;

/** HandsFreeOS's own Stripe, which only Stripe can be: Square acts only as a seller. */
const platformOf = (ctx: { payments: JobContext['payments'] }): PlatformPayments | null => {
  const platform = ctx.payments.providers.stripe?.platform;
  return platform?.supported ? platform : null;
};

/** One job a payout, however often the plan asks: a pending one is left as it is. */
const arm = (tx: Tx, kind: string, payoutId: string, scope: TenantScope) =>
  scheduleJob(tx, {
    kind,
    dedupeKey: `${kind}:${payoutId}`,
    runAt: new Date(),
    payload: { payoutId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });

/** Hourly, for the whole server. */
export const planPartnerPayouts: JobHandler = async (ctx) => {
  const again = { rescheduleAt: new Date(ctx.now + HOUR) };
  const platform = platformOf(ctx);
  if (!platform) return again;
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string; month: string }>(
      tx,
      sql`select workspace_id, organization_id, month::text as month from private.partner_payouts_due(200)`,
    ),
  );
  for (const d of due) {
    const scope = { workspaceId: d.workspace_id, organizationId: d.organization_id };
    try {
      await executeCommand(
        ctx.db,
        partnerPayoutBuild,
        { workspaceId: scope.workspaceId, month: d.month, livemode: platform.livemode },
        systemActor(scope),
        workerMeta(),
      );
    } catch (e) {
      // One business's trouble never holds up the rest: its month is still due, so it's tried next hour.
      ctx.log.error(
        { err: errorMessage(e), workspaceId: scope.workspaceId },
        'a partner payout could not be worked out',
      );
    }
  }
  const unfinished = await asWorker(ctx.db, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string; payout_id: string; status: string }>(
      tx,
      sql`select * from private.partner_payouts_unfinished(500)`,
    ),
  );
  for (const u of unfinished) {
    const scope = { workspaceId: u.workspace_id, organizationId: u.organization_id };
    await asWorker(ctx.db, scope, (tx) =>
      arm(tx, u.status === 'charging' ? PAYOUT_JOBS.charge : PAYOUT_JOBS.pay, u.payout_id, scope),
    );
  }
  if (due.length || unfinished.length)
    ctx.log.info({ due: due.length, unfinished: unfinished.length }, 'partner payouts');
  return again;
};

type ChargeRow = {
  id: string;
  status: string;
  attempts: number;
  next_try_at: Date | string | null;
  charge_cents: string | number;
  month: string;
  livemode: boolean;
  opened: boolean;
  method_token: string | null;
  customer_ref: string | null;
  card_brand: string | null;
  card_last4: string | null;
  business: string;
};

/** One payout's card, tried once. Safe to run again: only a payout still charging, and due, is charged. */
export const chargePartnerPayout: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const payoutId = String(ctx.job.payload['payoutId'] ?? '');
  if (!payoutId) return;
  const [p] = await asWorker(ctx.db, scope, (tx) =>
    rows<ChargeRow>(
      tx,
      sql`select p.id, p.status, p.attempts, p.next_try_at, p.charge_cents, p.month::text as month, p.livemode,
            b.opened_at is not null as opened, b.method_token, b.customer_ref, b.card_brand, b.card_last4,
            w.name as business
          from app.partner_payouts p
          join app.workspaces w on w.id = p.workspace_id
          left join app.partner_payout_billing b on b.workspace_id = p.workspace_id
          where p.workspace_id = ${scope.workspaceId} and p.id = ${payoutId}::uuid`,
    ),
  );
  if (!p || p.status !== 'charging') return;
  if (p.next_try_at && new Date(p.next_try_at).getTime() > ctx.now)
    return { rescheduleAt: new Date(p.next_try_at) };

  const attempt = p.attempts + 1;
  const record = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      partnerPayoutRecordCharge,
      { workspaceId: scope.workspaceId, payoutId, attempt, ...input },
      systemActor(scope),
      workerMeta(),
    );
  if (!p.opened) return void (await record({ outcome: 'stopped', stoppedBy: 'closed' }));
  if (!p.method_token) return void (await record({ outcome: 'stopped', stoppedBy: 'no_card' }));

  const platform = platformOf(ctx);
  if (!platform) return { rescheduleAt: new Date(ctx.now + HOUR) };
  if (platform.livemode !== p.livemode) {
    // Worked out with the other kind of key: live money is never charged for test payments, nor test for live.
    ctx.log.error(
      { payoutId, payoutLive: p.livemode, keyLive: platform.livemode },
      'a partner payout was worked out with the other kind of Stripe key, so it is not charged',
    );
    return;
  }

  let result;
  try {
    result = await platform.charge({
      amountCents: Number(p.charge_cents),
      method: 'card',
      sourceToken: p.method_token,
      customerRef: p.customer_ref,
      description: `Partner payouts for ${p.business}, ${payoutMonthWords(p.month)}`,
      metadata: {
        workspace_id: scope.workspaceId,
        partner_payout_id: payoutId,
        attempt: String(attempt),
      },
      // One charge a try, however often the job runs: a retry asks Stripe the same question again.
      idempotencyKey: `partner-payout:${payoutId}:${attempt}`,
    });
  } catch (e) {
    // Our own request refused, not the card: ours to fix, so it isn't spent as one of the business's tries.
    if (e instanceof PlatformUnsupportedError || (e instanceof PaymentError && e.permanent)) {
      ctx.log.error(
        { payoutId, err: errorMessage(e) },
        'a partner payout could not be charged: Stripe refused our own request',
      );
      return { rescheduleAt: new Date(ctx.now + HOUR) };
    }
    throw e;
  }

  if (result.status === 'succeeded') {
    await record({
      outcome: 'succeeded',
      paymentRef: result.providerPaymentId,
      chargeRef: result.chargeRef ?? null,
      cardBrand: result.cardBrand ?? p.card_brand,
      cardLast4: result.cardLast4 ?? p.card_last4,
    });
    await asWorker(ctx.db, scope, (tx) => arm(tx, PAYOUT_JOBS.pay, payoutId, scope));
    return;
  }
  // Anything but succeeded is the card saying no, as the wallet's top-ups have it: a card answers there and then,
  // and asking again under the same key a day later could charge it twice.
  await record({
    outcome: 'declined',
    paymentRef: result.providerPaymentId || null,
    failureCode: result.failureCode,
    failureMessage: result.failureMessage,
    cardBrand: p.card_brand,
    cardLast4: p.card_last4,
  });
};

type LineRow = {
  id: string;
  account_ref: string;
  amount_cents: string | number;
  status: string;
  /** Their account as it is now, which a held line is sent to. Null once the partner was deleted for good. */
  current_ref: string | null;
  ready: boolean | null;
};

/** Each partner's part of a charged payout, sent. Safe to run again: a line is sent once per account by its key. */
export const payPartnerPayout: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const payoutId = String(ctx.job.payload['payoutId'] ?? '');
  if (!payoutId) return;
  const [p] = await asWorker(ctx.db, scope, (tx) =>
    rows<{ status: string; charge_ref: string | null; month: string; business: string }>(
      tx,
      sql`select p.status, p.charge_ref, p.month::text as month, w.name as business
          from app.partner_payouts p join app.workspaces w on w.id = p.workspace_id
          where p.workspace_id = ${scope.workspaceId} and p.id = ${payoutId}::uuid`,
    ),
  );
  if (!p || p.status !== 'paying') return;
  const platform = platformOf(ctx);
  if (!platform) return { rescheduleAt: new Date(ctx.now + HOUR) };
  if (!p.charge_ref) {
    ctx.log.error({ payoutId }, 'a charged partner payout has no charge to send transfers from');
    return;
  }
  const lines = await asWorker(ctx.db, scope, (tx) =>
    rows<LineRow>(
      tx,
      sql`select l.id, l.account_ref, l.amount_cents, l.status, a.account_ref as current_ref,
            a.payouts_enabled and a.transfers_active as ready
          from app.partner_payout_lines l
          left join app.partner_payout_accounts a on a.partner_id = l.partner_id
          where l.workspace_id = ${scope.workspaceId} and l.payout_id = ${payoutId}::uuid
            and l.status in ('pending', 'held')
          order by l.created_at, l.id`,
    ),
  );
  const record = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      partnerPayoutRecordTransfer,
      { workspaceId: scope.workspaceId, ...input },
      systemActor(scope),
      workerMeta(),
    );
  for (const l of lines) {
    const accountRef = l.current_ref ?? l.account_ref;
    // Their account can't take it yet: held, and sent once Stripe says it can (the plan arms this job again).
    if (l.current_ref && !l.ready) {
      if (l.status === 'pending')
        await record({ lineId: l.id, outcome: 'held', heldReason: PAYOUT_WORDS.heldReason });
      continue;
    }
    try {
      const sent = await platform.payouts.transfer({
        accountRef,
        amountCents: Number(l.amount_cents),
        sourceChargeRef: p.charge_ref,
        transferGroup: `partner-payout-${payoutId}`,
        description: `Partner share from ${p.business}, ${payoutMonthWords(p.month)}`,
        metadata: {
          workspace_id: scope.workspaceId,
          partner_payout_id: payoutId,
          partner_payout_line_id: l.id,
        },
        idempotencyKey: `partner-payout-line:${l.id}:${accountRef}`,
      });
      await record({
        lineId: l.id,
        outcome: 'paid',
        transferRef: sent.transferRef,
        accountRef: accountRef === l.account_ref ? null : accountRef,
      });
    } catch (e) {
      if (e instanceof PaymentError && e.permanent) {
        // Stripe wouldn't take it for them: in plain words on the statement, and Stripe's own in the log.
        ctx.log.warn(
          { payoutId, lineId: l.id, code: e.code, err: e.message },
          'a partner payout line is held: Stripe refused the transfer',
        );
        if (l.status === 'pending')
          await record({ lineId: l.id, outcome: 'held', heldReason: PAYOUT_WORDS.heldReason });
        continue;
      }
      // Stripe didn't answer: the job tries again, and the lines already sent are found by their keys.
      throw e;
    }
  }
};

/** What Stripe says of a partner's account, written down. */
export const recordPayoutAccount = (
  db: Db,
  scope: TenantScope,
  partnerId: string,
  state: PayoutAccountState,
) =>
  executeCommand(
    db,
    partnerPayoutRecordAccount,
    {
      workspaceId: scope.workspaceId,
      partnerId,
      accountRef: state.accountRef,
      livemode: state.livemode,
      detailsSubmitted: state.detailsSubmitted,
      payoutsEnabled: state.payoutsEnabled,
      transfersActive: state.transfersActive,
      disabledReason: state.disabledReason,
      due: [...state.due],
    },
    systemActor(scope),
    workerMeta(),
  ).then((r) => r.output);

/**
 * Stripe's `account.updated` (or `capability.updated`) for a partner's account, routed here by http/money.ts. The
 * account is read back from Stripe rather than from the event, so a capability event says as much as an account one.
 */
export const onPartnerPayoutAccountEvent: DeliveryProcessor = async (ctx) => {
  const p = (ctx.delivery.params ?? {}) as Record<string, unknown>;
  const accountRef = typeof p['accountRef'] === 'string' ? p['accountRef'] : '';
  const platform = platformOf(ctx);
  if (!accountRef || !platform) return 'ignored';
  const scope = tenantOf({
    workspaceId: ctx.delivery.workspaceId,
    organizationId: ctx.delivery.organizationId,
  });
  const [a] = await asWorker(ctx.db, scope, (tx) =>
    rows<{ partner_id: string }>(
      tx,
      sql`select partner_id from app.partner_payout_accounts
          where workspace_id = ${scope.workspaceId} and account_ref = ${accountRef}`,
    ),
  );
  if (!a) return 'ignored';
  await recordPayoutAccount(ctx.db, scope, a.partner_id, await platform.payouts.read(accountRef));
};

/** What the payout's email says of it: its business, its month and its charge. */
async function payoutFor(tx: Tx, scope: TenantScope, payoutId: string) {
  const [p] = await rows<{ business: string; month: string; charge_cents: string | number }>(
    tx,
    sql`select w.name as business, p.month::text as month, p.charge_cents
        from app.partner_payouts p join app.workspaces w on w.id = p.workspace_id
        where p.workspace_id = ${scope.workspaceId} and p.id = ${payoutId}::uuid`,
  );
  return p ?? null;
}

/** A new card: a payout waiting to try the card again tries it now, rather than at the next hourly look. */
export const onPartnerPayoutCardSaved: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const waiting = await rows<{ id: string }>(
    ctx.tx,
    sql`select id from app.partner_payouts
        where workspace_id = ${scope.workspaceId} and status = 'charging'
          and (next_try_at is null or next_try_at <= now())`,
  );
  for (const p of waiting) await arm(ctx.tx, PAYOUT_JOBS.charge, p.id, scope);
};

/** A declined card, or a payout given up on for the month: the owners and admins hear, with where to fix it. */
export const onPartnerPayoutDeclined: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const e = ctx.event.payload as {
    payoutId?: string;
    nextTryAt?: string | null;
    failureMessage?: string | null;
  };
  if (!e.payoutId) return;
  const p = await payoutFor(ctx.tx, scope, e.payoutId);
  if (!p) return;
  const mail = partnerPayoutDeclinedEmail({
    business: p.business,
    amount: money(Number(p.charge_cents)),
    month: payoutMonthWords(p.month),
    reason: e.failureMessage ?? PAYOUT_WORDS.declined,
    retryOn:
      ctx.event.eventType === 'partner.payout_declined' && e.nextTryAt
        ? `on ${formatUtcDate(new Date(e.nextTryAt))}`
        : null,
    link: `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/partners`,
  });
  for (const m of await managers(ctx.tx, scope.workspaceId))
    await ctx.mailer.send({ to: m.email, ...mail });
};

export function partnerPaidEmail(input: {
  business: string;
  firstName: string;
  amount: string;
  month: string;
  /** Made with Stripe's test keys: no real money moved. */
  test: boolean;
}): EmailText {
  return {
    subject: input.test
      ? `Test: ${input.business} paid you ${input.amount}`
      : `${input.business} paid you ${input.amount}`,
    body: [
      `Hi ${input.firstName || 'there'},`,
      '',
      `${input.business} paid you ${input.amount}, your share for the clients you sent, in its ${input.month} payout.`,
      '',
      input.test
        ? 'This was a test, so no real money moved.'
        : 'Stripe sends it to your bank, usually within a few business days. You’ll see it on your partner page, and on your Stripe page.',
    ].join('\n'),
  };
}

/** A partner was paid: they hear from the business, in their conversation with it. */
export const onPartnerPayoutLinePaid: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const e = ctx.event.payload as { lineId?: string; amountCents?: number };
  if (!e.lineId) return;
  const [l] = await rows<{
    first_name: string | null;
    email: string | null;
    business: string;
    month: string;
    livemode: boolean;
    amount_cents: string | number;
  }>(
    ctx.tx,
    sql`select pp.first_name, pp.email::text as email, w.name as business, p.month::text as month, p.livemode,
          l.amount_cents
        from app.partner_payout_lines l
        join app.partner_payouts p on p.id = l.payout_id
        join app.workspaces w on w.id = l.workspace_id
        join app.partners pa on pa.id = l.partner_id
        join app.people pp on pp.id = pa.person_id
        where l.workspace_id = ${scope.workspaceId} and l.id = ${e.lineId}::uuid
          and pp.erased_at is null`,
  );
  if (!l?.email) return;
  const sent = await sendEmail(
    ctx,
    scope,
    l.email,
    partnerPaidEmail({
      business: l.business,
      firstName: l.first_name ?? '',
      amount: money(Number(l.amount_cents)),
      month: payoutMonthWords(l.month),
      test: !l.livemode,
    }),
    `partner-paid:${e.lineId}`,
    workerMeta(ctx.event.correlationId, ctx.event.id),
  );
  if ('refused' in sent)
    ctx.log.warn({ lineId: e.lineId, why: sent.refused }, 'partner paid email not sent');
};

export const partnerPayoutJobs: JobMap = {
  [PAYOUT_JOBS.plan]: planPartnerPayouts,
  [PAYOUT_JOBS.charge]: chargePartnerPayout,
  [PAYOUT_JOBS.pay]: payPartnerPayout,
};

export const partnerPayoutProcessors: ProcessorMap = {
  [`stripe:${PARTNER_PAYOUT_ACCOUNT_KIND}`]: onPartnerPayoutAccountEvent,
};
