/**
 * The one place a business is charged for usage (M16, "One funnel").
 *
 * Every text, call, phone number and AI request goes through `chargeUsage`. That is not tidiness: it is the only
 * way "at least one and a half times what it costs us" is a claim anybody can check. A second place that writes
 * `app.usage_ledger` is a second place the markup can be forgotten.
 *
 * **What it does, in order.** Read the live rate card; price the event with core's `priceEvent`, which rounds
 * once; insert one ledger row `on conflict do nothing`; and only if a row was actually made, and only if the
 * balance crossed a line on the way, say so. The order matters — a charge that was already counted must not
 * warn again, and a webhook arriving fifty times must produce one row and at most one warning.
 *
 * **Shadow mode.** With `WALLET_MODE=shadow` everything here runs and writes exactly as it will in anger, and
 * nothing warns and nothing is stopped. That is the point: a week of shadow is what proves the rate card
 * against a real business's real traffic before a single customer is charged a penny.
 *
 * **It never throws at the caller.** A wallet that cannot be read must not stop a text going out. Anything
 * unexpected in here is logged loudly and swallowed, and the charge is lost rather than the message. Losing a
 * penny is a smaller wrong than a business's customer never hearing back.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  priceEvent,
  SEED_CARD,
  isUsageKey,
  walletNoteCrossing,
  type RateCard,
  type UsageKey,
  type UsagePart,
  type UsageRate,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';

/** 100% in basis points, as everywhere else in the money core. */
const BP_SCALE = 10_000;
import type { Logger } from 'pino';
import type { TenantScope } from '../services';

/** What a ledger row is. Mirrors `app.usage_entry_kind`. */
export type UsageEntryKind = 'spend' | 'topup' | 'adjustment' | 'credit' | 'refund';
export type UsageCostSource = 'rate_card' | 'provider' | 'reconciled';

export interface ChargeInput {
  /** Almost always `spend`; the reconciler writes `adjustment` and support writes `credit`. */
  readonly kind?: UsageEntryKind;
  /** One part for a text or a call; four for an AI request, which is why this is a list. */
  readonly parts: readonly UsagePart[];
  /**
   * Derived in `packages/core/src/money/usage-keys.ts` and nowhere else. This is the whole of the protection
   * against billing one event twice, so it is required rather than defaulted.
   */
  readonly idempotencyKey: string;
  /** In words, for the statement: "Text to (512) 555-0134". */
  readonly subject: string;
  readonly entityType?: 'message' | 'call' | 'phone_number' | 'ai_usage' | 'assistant_run' | null;
  readonly entityId?: string | null;
  /** The provider's own id, kept so a reconciliation can find its way back to the event. */
  readonly providerRef?: string | null;
  readonly costSource?: UsageCostSource;
  /**
   * An amount the card did not work out. Only the nightly reconciliation uses these: there the carrier's own
   * number **is** the price basis, so there is nothing for `priceEvent` to price and `parts` is empty. Every
   * other caller leaves them alone and lets the card decide, which is what keeps the markup provable.
   */
  readonly amountCents?: number;
  readonly costCents?: number;
  /** When it happened, rather than when we heard about it: a status callback can be minutes late. */
  readonly occurredAt?: Date;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface Charged {
  /** False when this event had already been counted: the same webhook, the same sweep, the same retry. */
  readonly recorded: boolean;
  readonly amountCents: number;
  readonly costCents: number;
  /** What is left after it, from the row the trigger wrote. Null when nothing was recorded. */
  readonly balanceAfterCents: number | null;
  /** The line the balance crossed on the way down, if it crossed one. Only ever set on a fresh row. */
  readonly crossed: 'low' | 'empty' | null;
}

const NOTHING: Charged = {
  recorded: false,
  amountCents: 0,
  costCents: 0,
  balanceAfterCents: null,
  crossed: null,
};

export interface WalletDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly mode: 'off' | 'shadow' | 'on';
  readonly now?: () => number;
}

// ---- the card ----

/**
 * The live card, held for a minute. It is read on the path of every text and every AI request, and it changes
 * when somebody publishes a new version — which is a deliberate act, not an emergency. A minute is short enough
 * that a publish takes effect while you are still watching the page, and long enough that a busy worker is not
 * asking Postgres for the same fourteen rows a hundred times a second.
 */
const CARD_TTL_MS = 60_000;
let cached: { card: RateCard; at: number } | null = null;

/** Only for tests and for a publish that wants the next read to be fresh. */
export const forgetRateCard = (): void => {
  cached = null;
};

type RateRow = {
  key: string;
  unit: string;
  cost_micros: number | string;
  markup_bp: number;
  min_charge_cents: number;
  round_up_to: string;
  version: number;
};

/**
 * The card, from `platform.usage_rates_live`. A read that fails or comes back short falls through to core's
 * seeded card rather than to nothing: charging the seeded price is wrong by whatever the card was edited to,
 * and charging zero is wrong by the whole amount.
 */
export async function rateCard(deps: WalletDeps, scope: TenantScope): Promise<RateCard> {
  const now = deps.now?.() ?? Date.now();
  if (cached && now - cached.at < CARD_TTL_MS) return cached.card;
  const read = (t: Tx) =>
    rows<RateRow>(
      t,
      sql`select key, unit::text as unit, cost_micros, markup_bp, min_charge_cents,
            round_up_to::text as round_up_to, version
          from platform.usage_rates_live`,
    );
  try {
    const list = await asWorker(deps.db, scope, read);
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
    // A card with lines missing is worse than no card: it would charge nothing for whatever is absent. Core's
    // seeded card fills the gaps, which is at least a real price somebody wrote down.
    const card: RateCard = {
      version: version || SEED_CARD.version,
      rates: { ...SEED_CARD.rates, ...rates } as RateCard['rates'],
    };
    cached = { card, at: now };
    return card;
  } catch (e) {
    deps.log.error({ err: e }, 'could not read the rate card; using the seeded prices');
    return SEED_CARD;
  }
}

// ---- the funnel ----

/**
 * Charge one event. Returns what happened rather than throwing, so a caller can log it and get on with sending
 * the message. `recorded: false` means the event had already been counted, which is the ordinary case on a
 * retried webhook and is not a problem.
 */
export async function chargeUsage(
  deps: WalletDeps,
  scope: TenantScope,
  input: ChargeInput,
): Promise<Charged> {
  if (deps.mode === 'off') return NOTHING;
  try {
    return await record(deps, scope, input);
  } catch (e) {
    // Loudly, and then on with the day. A wallet that cannot be written must never stop a text being sent.
    //
    // This is also why the charge always opens its own transaction rather than joining the caller's, tempting
    // as that is for atomicity: Postgres marks a whole transaction failed after any error in it, so swallowing
    // one raised inside somebody else's would hand them back a transaction that can no longer do anything,
    // and the message they were sending would fail a step later for no visible reason.
    deps.log.error(
      { err: e, key: input.idempotencyKey, workspaceId: scope.workspaceId },
      'could not record usage; the charge is lost and the message is not',
    );
    return NOTHING;
  }
}

async function record(deps: WalletDeps, scope: TenantScope, input: ChargeInput): Promise<Charged> {
  const card = await rateCard(deps, scope);
  const priced =
    input.amountCents === undefined
      ? priceEvent(card, input.parts)
      : {
          amountCents: Math.max(0, Math.round(input.amountCents)),
          costCents: Math.max(0, Math.round(input.costCents ?? 0)),
          markupBp: markupRealised(input.amountCents, input.costCents ?? 0),
        };
  if (priced.amountCents === 0) return NOTHING;

  const kind = input.kind ?? 'spend';
  // Spend is negative; a credit or a top-up is positive. The database checks this too, and disagreeing with it
  // is a crash rather than a wrong sign on somebody's statement.
  const signed = kind === 'topup' || kind === 'credit' ? priced.amountCents : -priced.amountCents;
  const one = input.parts.length === 1 ? input.parts[0]! : null;
  const rate = one ? card.rates[one.key] : null;

  const insert = (t: Tx) =>
    rows<{ id: string; balance_after_cents: number | string }>(
      t,
      sql`insert into app.usage_ledger (
            workspace_id, organization_id, kind, amount_cents, cost_cents, markup_bp, rate_card_version,
            rate_key, quantity, unit, cost_source, subject, entity_type, entity_id, provider_ref,
            idempotency_key, meta, occurred_at)
          values (
            ${scope.workspaceId}, ${scope.organizationId}, ${kind}::app.usage_entry_kind, ${signed},
            ${priced.costCents}, ${priced.markupBp}, ${card.version},
            ${one?.key ?? null}, ${one ? one.quantity : null}, ${rate?.unit ?? null}::platform.usage_unit,
            ${input.costSource ?? 'rate_card'}::app.usage_cost_source,
            ${input.subject.slice(0, 300)}, ${input.entityType ?? null}, ${input.entityId ?? null},
            ${input.providerRef ?? null}, ${input.idempotencyKey},
            ${JSON.stringify(metaOf(input, card, priced.amountCents))}::jsonb,
            ${(input.occurredAt ?? new Date()).toISOString()}::timestamptz)
          on conflict (workspace_id, idempotency_key) do nothing
          returning id, balance_after_cents`,
    );
  const [row] = await asWorker(deps.db, scope, insert);
  // No row back: this event was already counted. Not a problem, and emphatically not a second warning.
  if (!row) return { ...NOTHING, amountCents: priced.amountCents, costCents: priced.costCents };

  const balanceAfter = Number(row.balance_after_cents);
  const before = balanceAfter - signed;
  // Nothing warns in shadow: the week is for measuring, and a business that hears from us about a balance it
  // was never told it had would rightly be confused.
  const crossed = deps.mode === 'on' ? await crossing(deps, scope, before, balanceAfter) : null;
  // Said once, from the one row that crossed the line. The charge itself is a plain insert on purpose — it
  // happens on every message — and this is the rare thing somebody acts on, so it goes through the kernel.
  if (crossed) await noteCrossing(deps, scope, crossed);
  return {
    recorded: true,
    amountCents: priced.amountCents,
    costCents: priced.costCents,
    balanceAfterCents: balanceAfter,
    crossed,
  };
}

/** Never lets a warning that could not be written stop the charge that was. */
async function noteCrossing(
  deps: WalletDeps,
  scope: TenantScope,
  crossed: 'low' | 'empty',
): Promise<void> {
  try {
    await executeCommand(
      deps.db,
      walletNoteCrossing,
      { workspaceId: scope.workspaceId, crossed },
      {
        type: 'system',
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
        onBehalfOf: null,
      },
      { correlationId: randomUUID(), causationId: null, channel: 'worker' },
    );
  } catch (e) {
    deps.log.error(
      { err: e, workspaceId: scope.workspaceId, crossed },
      'could not say the balance is low',
    );
  }
}

/**
 * An AI request's four buckets, and anything else with more than one part, cannot put one rate key on the row.
 * The parts go in `meta` instead, so a statement can still show what the request was made of.
 */
/** What a given charge actually realised over a given cost, in basis points. */
const markupRealised = (amountCents: number, costCents: number): number =>
  costCents > 0 ? Math.round((amountCents * BP_SCALE) / costCents) : 0;

function metaOf(input: ChargeInput, card: RateCard, amountCents: number): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...(input.meta ?? {}) };
  if (input.parts.length > 1)
    meta['parts'] = input.parts
      .filter((p) => p.quantity > 0)
      .map((p) => ({
        key: p.key,
        quantity: p.quantity,
        cents: priceEvent(card, [p]).amountCents,
      }));
  meta['charged_cents'] = amountCents;
  return meta;
}

/**
 * Which line the balance crossed on the way down, if any. Read from the wallet's own floor rather than a
 * constant, because the floor is the business's to choose. A balance that was already under the line does not
 * cross it again — that is what stops the third text of the morning sending a third warning.
 */
async function crossing(
  deps: WalletDeps,
  scope: TenantScope,
  before: number,
  after: number,
): Promise<'low' | 'empty' | null> {
  if (after >= before) return null;
  const [w] = await asWorker(deps.db, scope, (tx) =>
    rows<{ floor_cents: number | string }>(
      tx,
      sql`select floor_cents from app.usage_wallets where workspace_id = ${scope.workspaceId}`,
    ),
  );
  const floor = Number(w?.floor_cents ?? 0);
  if (before > 0 && after <= 0) return 'empty';
  if (before > floor && after <= floor) return 'low';
  return null;
}

// ---- reading it ----

export interface WalletState {
  readonly balanceCents: number;
  readonly floorCents: number;
  readonly overdraftCents: number;
  readonly autoTopup: boolean;
  readonly hasCard: boolean;
  readonly suspended: boolean;
}

/**
 * A business's wallet as the gates read it (step 9). Null when there is no wallet row at all, which is a
 * business that has never spent anything — and which every gate must treat as "fine", not as "empty".
 */
export async function walletState(
  deps: WalletDeps,
  scope: TenantScope,
): Promise<WalletState | null> {
  const [w] = await asWorker(deps.db, scope, (tx) =>
    rows<{
      balance_cents: number | string;
      floor_cents: number | string;
      overdraft_cents: number | string;
      auto_topup: boolean;
      has_card: boolean;
      suspended: boolean;
    }>(
      tx,
      sql`select balance_cents, floor_cents, overdraft_cents, auto_topup,
            method_token is not null as has_card, suspended_at is not null as suspended
          from app.usage_wallets where workspace_id = ${scope.workspaceId}`,
    ),
  );
  if (!w) return null;
  return {
    balanceCents: Number(w.balance_cents),
    floorCents: Number(w.floor_cents),
    overdraftCents: Number(w.overdraft_cents),
    autoTopup: w.auto_topup,
    hasCard: w.has_card,
    suspended: w.suspended,
  };
}

/** Opens a wallet for a business that has none, so the usage page has something to show before the first text. */
export async function openWallet(deps: WalletDeps, scope: TenantScope): Promise<void> {
  await asWorker(deps.db, scope, (tx: Tx) =>
    tx.execute(
      sql`insert into app.usage_wallets (workspace_id, organization_id)
          values (${scope.workspaceId}, ${scope.organizationId})
          on conflict (workspace_id) do nothing`,
    ),
  );
}

/** The keys a caller may name, re-exported so a capture site imports one module rather than two. */
export type { UsageKey, UsagePart };
