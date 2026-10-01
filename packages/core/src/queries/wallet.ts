/**
 * What the usage page reads (M16, step 8): a business's balance, its settings, the card on it, and the
 * statement of everything it has been charged for.
 *
 * **What a business is never shown is what a thing cost us.** `cost_cents` and `markup_bp` are on every ledger
 * row and neither leaves this file: the statement says what was charged and what it was for. What we pay is
 * ours, and showing it would invite an argument about the markup on every line rather than about the price,
 * which is the number a business actually decides on.
 *
 * **And a business that is not on the wallet yet is shown nothing at all**, whatever its row says. That is not
 * a display nicety, it is the shadow week: while the worker is counting in `shadow`, every balance in the
 * system falls further below zero every day and nobody is being charged a penny. Showing that to a business
 * would be showing it a bill that does not exist. The same goes for a business its agency pays for (`agency`):
 * it never has a bill to be shown. Both queries check the stage first, so the answer is the
 * same wherever it is asked from — this page today, the phone tomorrow.
 */
import { rows, sql } from '@hfos/db/client';
import { defineQuery } from '../kernel/define';
import { walletSpeaks } from '../money/wallet-gate';
import { decodeCursor, encodeCursor } from '../kernel/pagination';
import {
  escalationCeilingCents,
  escalationWords,
  ESCALATION_MAX_MULTIPLE,
  isUsageKey,
  priceOf,
  SEED_CARD,
  type RateCard,
  type UsageKey,
  type UsageRate,
} from '../money/index';
import {
  UsagePricesInput,
  UsagePricesOutput,
  UsageStatementInput,
  UsageStatementOutput,
  WalletGetInput,
  WalletGetOutput,
} from '../schemas/wallet-queries';
import type { QueryContext } from '../kernel/types';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** The live card, or core's seeded one where a row is missing: never nothing, which would price at zero. */
async function liveCard(ctx: QueryContext): Promise<RateCard> {
  const list = await rows<{
    key: string;
    unit: string;
    cost_micros: number | string;
    markup_bp: number;
    min_charge_cents: number;
    round_up_to: string;
    version: number;
  }>(
    ctx.tx,
    sql`select key, unit::text as unit, cost_micros, markup_bp, min_charge_cents,
          round_up_to::text as round_up_to, version
        from platform.usage_rates_live`,
  );
  const rates: Record<string, UsageRate> = {};
  let version = 0;
  for (const r of list) {
    if (!isUsageKey(r.key)) continue;
    version = Math.max(version, r.version);
    rates[r.key] = {
      key: r.key,
      unit: r.unit as UsageRate['unit'],
      costMicros: Number(r.cost_micros),
      markupBp: r.markup_bp,
      minChargeCents: r.min_charge_cents,
      roundUpTo: r.round_up_to as UsageRate['roundUpTo'],
    };
  }
  return {
    version: version || SEED_CARD.version,
    rates: { ...SEED_CARD.rates, ...rates } as RateCard['rates'],
  };
}

export const walletGet = defineQuery({
  name: 'wallet.get',
  description:
    'A business’s balance and how it keeps itself topped up: what is left, the card on file, the settings, what it has spent lately, and why its top-up is the size it is.',
  input: WalletGetInput,
  output: WalletGetOutput,
  permission: 'money.read',
  scope: inWorkspace,
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const [w] = await rows<{
      stage: string;
      balance_cents: number | string;
      auto_topup: boolean;
      floor_cents: number | string;
      topup_cents: number | string;
      overdraft_cents: number | string;
      card_brand: string | null;
      card_last4: string | null;
      card_expiry_month: number | null;
      card_expiry_year: number | null;
      has_card: boolean;
      card_requested_at: Date | null;
      provider: string | null;
      // Raw SQL rows carry timestamps as text; each is read through new Date(), which takes either.
      suspended_at: Date | string | null;
      suspended_reason: string | null;
      recharges_in_window: number;
      escalation_step: number;
      paused_until: Date | null;
      workspace_created_at: Date | string;
      spent_30d_cents: number | string;
      spent_mtd_cents: number | string;
      pending_recharge_cents: number | string | null;
    }>(
      ctx.tx,
      sql`select w.stage::text as stage,
            w.balance_cents, w.auto_topup, w.floor_cents, w.topup_cents, w.overdraft_cents,
            w.card_brand, w.card_last4, w.card_expiry_month, w.card_expiry_year,
            w.method_token is not null as has_card, w.card_requested_at, w.provider::text as provider,
            w.suspended_at, w.suspended_reason, w.recharges_in_window, w.escalation_step, w.paused_until,
            ws.created_at as workspace_created_at,
            coalesce((select sum(abs(l.amount_cents)) from app.usage_ledger l
              where l.workspace_id = w.workspace_id and l.kind in ('spend', 'adjustment')
                and l.amount_cents < 0 and l.occurred_at > now() - interval '30 days'), 0) as spent_30d_cents,
            coalesce((select sum(abs(l.amount_cents)) from app.usage_ledger l
              where l.workspace_id = w.workspace_id and l.kind in ('spend', 'adjustment')
                and l.amount_cents < 0 and l.occurred_at >= date_trunc('month', now())), 0) as spent_mtd_cents,
            (select r.amount_cents from app.wallet_recharges r
              where r.workspace_id = w.workspace_id and r.status = 'pending' limit 1) as pending_recharge_cents
          from app.usage_wallets w
            join app.workspaces ws on ws.id = w.workspace_id
          where w.workspace_id = ${ws}`,
    );
    // A business that has never spent anything has no row, and one that is not on the wallet yet is told the
    // same thing for the same reason: nothing has happened here. "Nothing yet" rather than a scary zero.
    if (!w || !walletSpeaks(w.stage))
      return {
        opened: false,
        balanceCents: 0,
        autoTopup: true,
        floorCents: 1000,
        topupCents: 2500,
        overdraftCents: 1000,
        maxTopupCents: 2500 * ESCALATION_MAX_MULTIPLE,
        card: null,
        cardRequested: false,
        suspended: null,
        spent30dCents: 0,
        spentThisMonthCents: 0,
        pendingTopUpCents: null,
        escalation: null,
      };

    const topup = Number(w.topup_cents);
    const pending = w.pending_recharge_cents === null ? null : Number(w.pending_recharge_cents);
    return {
      opened: true,
      balanceCents: Number(w.balance_cents),
      autoTopup: w.auto_topup,
      floorCents: Number(w.floor_cents),
      topupCents: topup,
      overdraftCents: Number(w.overdraft_cents),
      maxTopupCents: escalationCeilingCents({
        topupCents: topup,
        spent30dCents: Number(w.spent_30d_cents),
        workspaceCreatedAt: new Date(w.workspace_created_at).getTime(),
        now: Date.now(),
      }),
      card: w.has_card
        ? {
            brand: w.card_brand,
            last4: w.card_last4,
            expiryMonth: w.card_expiry_month,
            expiryYear: w.card_expiry_year,
            provider: w.provider,
          }
        : null,
      cardRequested: w.card_requested_at !== null,
      suspended: w.suspended_at
        ? { at: new Date(w.suspended_at).toISOString(), reason: w.suspended_reason }
        : null,
      spent30dCents: Number(w.spent_30d_cents),
      spentThisMonthCents: Number(w.spent_mtd_cents),
      pendingTopUpCents: pending,
      /**
       * Why the top-up is the size it is, in the business's own numbers — and how to make it stop. A sentence
       * that only explains is a sentence that annoys, so the fix is in the same breath.
       */
      escalation:
        w.recharges_in_window > 1
          ? escalationWords({
              amountCents: pending ?? topup * 2 ** w.escalation_step,
              topupCents: topup,
              recharges: w.recharges_in_window,
              cappedBy: null,
            })
          : null,
    };
  },
});

export const usageStatement = defineQuery({
  name: 'usage.statement',
  description:
    'Everything a business has been charged for, newest first: what it was, what it cost them, and what was left after it. Never what it cost HandsFreeOS.',
  input: UsageStatementInput,
  output: UsageStatementOutput,
  permission: 'money.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    // Same rule as the balance, for the same reason: a shadow week fills this table with charges nobody is
    // making, and a business reading them would reasonably think it owed us the money.
    const [stage] = await rows<{ stage: string }>(
      ctx.tx,
      sql`select stage::text as stage from app.usage_wallets where workspace_id = ${ws}`,
    );
    if (!stage || !walletSpeaks(stage.stage)) return { items: [], nextCursor: null };
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const list = await rows<{
      id: string;
      kind: string;
      amount_cents: number | string;
      balance_after_cents: number | string;
      subject: string;
      rate_key: string | null;
      quantity: string | null;
      unit: string | null;
      entity_type: string | null;
      entity_id: string | null;
      occurred_at: Date | string;
      sort_key: string;
    }>(
      ctx.tx,
      sql`select id, kind::text as kind, amount_cents, balance_after_cents, subject, rate_key,
            quantity::text as quantity, unit::text as unit, entity_type, entity_id, occurred_at,
            to_char(occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as sort_key
          from app.usage_ledger
          where workspace_id = ${ws}
          ${input.since ? sql`and occurred_at >= ${input.since}::timestamptz` : sql``}
          ${input.until ? sql`and occurred_at < ${input.until}::timestamptz` : sql``}
          ${cursor ? sql`and (occurred_at, id) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)` : sql``}
          order by occurred_at desc, id desc
          limit ${input.limit + 1}`,
    );
    const page = list.slice(0, input.limit);
    const more = list.length > input.limit;
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind as 'spend' | 'topup' | 'adjustment' | 'credit' | 'refund',
        // Signed as the ledger holds it: negative is money out, positive is money in.
        amountCents: Number(r.amount_cents),
        balanceAfterCents: Number(r.balance_after_cents),
        subject: r.subject,
        rateKey: r.rate_key,
        quantity: r.quantity === null ? null : Number(r.quantity),
        unit: r.unit,
        entityType: r.entity_type,
        entityId: r.entity_id,
        occurredAt: new Date(r.occurred_at).toISOString(),
      })),
      nextCursor: more && last ? encodeCursor({ sort: last.sort_key, id: last.id }) : null,
    };
  },
});

export const usagePrices = defineQuery({
  name: 'usage.prices',
  description:
    'What things cost this business, in plain words: a text, a minute of talking, a phone number, an AI reply. The charged price only — never what HandsFreeOS pays.',
  input: UsagePricesInput,
  output: UsagePricesOutput,
  permission: 'money.read',
  scope: inWorkspace,
  async handler(ctx) {
    const card = await liveCard(ctx);
    /**
     * Not every key: the four AI token buckets mean nothing to a business, and a page listing "cache write,
     * $3.75 per million tokens" is a page nobody reads. AI is shown as what it buys — a reply — which is what
     * the plan says to display and roughly what one costs.
     */
    const say = (key: UsageKey, what: string, unit: string) => ({
      key,
      what,
      unit,
      cents: priceOf(card, key, 1).amountCents,
    });
    const aiReply =
      priceOf(card, 'ai.cache_read.mtok', 0.008).amountCents +
      priceOf(card, 'ai.input.mtok', 0.0012).amountCents +
      priceOf(card, 'ai.output.mtok', 0.0005).amountCents;
    /**
     * Speech costs a fraction of a cent a minute and is billed in running totals, so it's shown for ten of
     * something: one minute on its own would read as the floor rather than the price.
     */
    const tenOf = (key: UsageKey, what: string, unit: string) => ({
      key,
      what,
      unit,
      cents: priceOf(card, key, 10).amountCents,
    });
    return {
      version: card.version,
      items: [
        say('sms.outbound.segment', 'A text you send', 'each'),
        say('sms.inbound.segment', 'A text you receive', 'each'),
        say('mms.outbound.message', 'A picture you send', 'each'),
        say('mms.inbound.message', 'A picture you receive', 'each'),
        say('voice.outbound.minute', 'A minute of an outgoing call', 'a minute'),
        say('voice.inbound.local.minute', 'A minute of an incoming call', 'a minute'),
        say('voice.inbound.tollfree.minute', 'A minute on a toll-free number', 'a minute'),
        say('number.local.month', 'A phone number', 'a month'),
        say('number.tollfree.month', 'A toll-free number', 'a month'),
        { key: null, what: 'An AI reply', unit: 'about', cents: Math.max(1, aiReply) },
        tenOf('speech.live.minute', 'The AI listening on a call', 'for 10 minutes'),
        tenOf('speech.recording.minute', 'Talk turned into words', 'for 10 minutes'),
        tenOf('speech.voice.kchar', 'The AI speaking', 'for 10,000 characters'),
        // The carriers' fees for texting from a local number, passed on at what they cost us.
        say('a2p.brand.registration', 'Registering your business for texting', 'once'),
        say('a2p.campaign.vetting', 'The carriers reviewing your texts', 'each time'),
        say('a2p.campaign.month', 'Your texting registration, once approved', 'a month'),
        say('a2p.brand.vetting', 'An extra check for over 1,000 texts a month', 'once'),
      ],
    };
  },
});

export const walletQueries = [walletGet, usageStatement, usagePrices];
