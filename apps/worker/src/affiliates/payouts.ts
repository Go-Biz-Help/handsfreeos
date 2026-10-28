/**
 * Paying affiliates (20261027014400, HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md part 4): the worker's half.
 *
 * Hourly, `affiliate_payouts.plan`, while staff have payouts on:
 *
 * 1. Asks Stripe again about the accounts that can't be paid yet of affiliates owed money
 *    (`private.affiliate_payout_accounts_to_check`): Stripe's word comes when they finish its form and come back to
 *    their page, and this catches the ones who didn't come back.
 * 2. Makes this month's payouts (`private.affiliate_payouts_build`): one for each affiliate owed at least $25 whose
 *    bank can take it, with the shares it pays tied to it.
 * 3. Sends each one not sent yet, and each held one whose bank can take it now (`private.affiliate_payouts_to_send`):
 *    a transfer from HandsFreeOS's own balance, once per payout and account by its key, so a retry never sends it
 *    twice. One Stripe won't take for them is held; one our balance can't cover waits for the next hour and staff
 *    are told in the log. Each one sent is told to its affiliate, once.
 *
 * A key of either mode pays only accounts made with that mode, so test payouts are only ever test money. There's no
 * business to run a command in, so the bookkeeping is the database's own functions, as counting clicks is.
 */
import { AFFILIATE_MIN_PAYOUT_CENTS, money, payoutMonthWords } from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import { affiliatePaidEmail } from '../emails/templates';
import type { JobContext, JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { PaymentError, type PayoutAccountState, type PlatformPayments } from '../payments/provider';

export const AFFILIATE_PAYOUT_JOBS = {
  /** Global, hourly: accounts to check, this month's payouts, and every payout to send. */
  plan: 'affiliate_payouts.plan',
} as const;

export const AFFILIATE_PAYOUT_PLAN_KEY = 'sweep:affiliate_payouts';

const HOUR = 3_600_000;

/** HandsFreeOS's own Stripe, which only Stripe can be. */
const platformOf = (ctx: { payments: JobContext['payments'] }): PlatformPayments | null => {
  const platform = ctx.payments.providers.stripe?.platform;
  return platform?.supported ? platform : null;
};

/** What Stripe says of an affiliate's account, kept. Answers whether it can be paid now. */
export const recordAffiliateAccount = (db: Db, affiliateId: string, state: PayoutAccountState) =>
  asWorker(db, {}, (tx) =>
    rows<{ ready: boolean }>(
      tx,
      sql`select private.affiliate_payout_account_record(${affiliateId}::uuid, ${state.accountRef},
            ${state.livemode}, ${state.detailsSubmitted}, ${state.payoutsEnabled}, ${state.transfersActive},
            ${state.disabledReason}, ${sql`array[${sql.join(
              state.due.map((d) => sql`${d}`),
              sql`, `,
            )}]::text[]`}) as ready`,
    ),
  ).then((r) => !!r[0]?.ready);

type ToSend = {
  payout_id: string;
  affiliate_id: string;
  amount_cents: number;
  month: string;
  status: 'sending' | 'held';
  account_ref: string;
  ready: boolean;
};

const record = (db: Db, payoutId: string, transferRef: string | null, accountRef: string | null) =>
  asWorker(db, {}, (tx) =>
    rows<{ changed: boolean }>(
      tx,
      sql`select private.affiliate_payout_record(${payoutId}::uuid, ${transferRef}, ${accountRef}) as changed`,
    ),
  ).then((r) => !!r[0]?.changed);

/** Sent: they hear how much, once. */
async function tellPaid(ctx: JobContext, p: ToSend, livemode: boolean): Promise<void> {
  const [claimed] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ ok: boolean }>(
      tx,
      sql`select private.affiliate_payout_claim_email(${p.payout_id}::uuid) as ok`,
    ),
  );
  if (!claimed?.ok) return;
  const [to] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ email: string; first_name: string }>(
      tx,
      sql`select email, first_name from private.affiliate_to_tell(${p.affiliate_id})`,
    ),
  );
  if (!to?.email) return;
  await ctx.mailer.send({
    to: to.email,
    ...affiliatePaidEmail({
      firstName: to.first_name,
      amount: money(Number(p.amount_cents)),
      month: payoutMonthWords(p.month),
      pageLink: `${ctx.webUrl}/affiliate`,
      test: !livemode,
    }),
  });
}

/** One payout: sent from our own balance, or held when Stripe won't take it for them. */
async function sendPayout(ctx: JobContext, platform: PlatformPayments, p: ToSend): Promise<void> {
  // Their bank can't take it yet: held, and sent once Stripe says it can.
  if (!p.ready) {
    if (p.status === 'sending') await record(ctx.db, p.payout_id, null, null);
    return;
  }
  try {
    const sent = await platform.payouts.transfer({
      accountRef: p.account_ref,
      amountCents: Number(p.amount_cents),
      sourceChargeRef: null,
      transferGroup: `affiliate-payout-${p.payout_id}`,
      description: `HandsFreeOS affiliate payout, ${payoutMonthWords(p.month)}`,
      metadata: { affiliate_id: p.affiliate_id, affiliate_payout_id: p.payout_id },
      idempotencyKey: `affiliate-payout:${p.payout_id}:${p.account_ref}`,
    });
    await record(ctx.db, p.payout_id, sent.transferRef, p.account_ref);
    await tellPaid(ctx, p, platform.livemode);
  } catch (e) {
    if (e instanceof PaymentError && e.permanent && e.code === 'balance_insufficient') {
      // Ours to fix, not theirs: it stays on its way, and goes once the balance covers it.
      ctx.log.error(
        { payoutId: p.payout_id, amountCents: p.amount_cents, err: e.message },
        'an affiliate payout waits: HandsFreeOS’s Stripe balance can’t cover it',
      );
      return;
    }
    if (e instanceof PaymentError && e.permanent) {
      ctx.log.warn(
        { payoutId: p.payout_id, code: e.code, err: e.message },
        'an affiliate payout is held: Stripe refused the transfer',
      );
      if (p.status === 'sending') await record(ctx.db, p.payout_id, null, null);
      return;
    }
    // Stripe didn't answer: the next hour tries again, with the same key.
    ctx.log.warn(
      { payoutId: p.payout_id, err: errorMessage(e) },
      'an affiliate payout could not be sent just now',
    );
  }
}

/** Hourly, for the whole server. */
export const planAffiliatePayouts: JobHandler = async (ctx) => {
  const again = { rescheduleAt: new Date(ctx.now + HOUR) };
  const platform = platformOf(ctx);
  if (!platform) return again;
  const livemode = platform.livemode;

  const toCheck = await asWorker(ctx.db, {}, (tx) =>
    rows<{ affiliate_id: string; account_ref: string }>(
      tx,
      sql`select affiliate_id, account_ref
          from private.affiliate_payout_accounts_to_check(${AFFILIATE_MIN_PAYOUT_CENTS}, ${livemode}, 50)`,
    ),
  );
  for (const a of toCheck) {
    try {
      await recordAffiliateAccount(
        ctx.db,
        a.affiliate_id,
        await platform.payouts.read(a.account_ref),
      );
    } catch (e) {
      // One account's trouble holds up nobody else's payout: it's asked again in six hours.
      ctx.log.warn(
        { affiliateId: a.affiliate_id, err: errorMessage(e) },
        'an affiliate’s Stripe account could not be read',
      );
    }
  }

  const built = await asWorker(ctx.db, {}, (tx) =>
    rows<{ payout_id: string }>(
      tx,
      sql`select payout_id from private.affiliate_payouts_build(${AFFILIATE_MIN_PAYOUT_CENTS}, ${livemode})`,
    ),
  );
  const toSend = await asWorker(ctx.db, {}, (tx) =>
    rows<ToSend>(
      tx,
      sql`select payout_id, affiliate_id, amount_cents, month::text as month, status, account_ref, ready
          from private.affiliate_payouts_to_send(${livemode}, 200)`,
    ),
  );
  for (const p of toSend) await sendPayout(ctx, platform, p);
  if (toCheck.length || built.length || toSend.length)
    ctx.log.info(
      { checked: toCheck.length, built: built.length, sent: toSend.length },
      'affiliate payouts',
    );
  return again;
};

export const affiliatePayoutJobs: JobMap = {
  [AFFILIATE_PAYOUT_JOBS.plan]: planAffiliatePayouts,
};
