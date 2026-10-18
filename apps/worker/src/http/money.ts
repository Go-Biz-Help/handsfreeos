/**
 * The customer's own money pages, and the two payment providers' webhooks.
 *
 * **The customer's pages** (`/e/<token>` and `/i/<token>`, money/links.ts) are the M9 answer to a PDF: a
 * signed-out customer reads what they were quoted, approves it with their typed name or declines it, and pays
 * an invoice through the business's own Stripe or Square account. Everything runs as the system actor on the
 * `booking_page` channel — the existing name for "a customer on a public page of ours" — scoped by the
 * worker-only link lookups.
 *
 * Protection is the booking page's, minus the bot check: per-address rate limits, a honeypot on anything that
 * acts, POST for everything that changes anything (mail scanners open links — the M8 lesson), and `no-store`
 * with `no-referrer` on every answer. **There is deliberately no bot check on viewing or paying**: the token is
 * the secret, and the provider runs its own risk checks. A customer paying an invoice should not be asked to
 * prove they are a person.
 *
 * **Paying** is one route with two phases, because the two providers work differently and hiding that would
 * make Stripe's bank transfers impossible:
 * - Stripe (`client_confirm`): the first POST prepares a PaymentIntent and hands the browser its client secret;
 *   the browser confirms it; a second POST names the intent and we read it back from Stripe, so the answer is
 *   the provider's and not the page's.
 * - Square (`server_charge`): the browser tokenises the card and one POST charges it from here.
 * A declined card is a **200 with `status: 'failed'`** and plain words — a decline is an answer, not an error.
 *
 * **What these pages deliberately do not return**: a provider's or bank's own payment reference — neither
 * gives one we could show a customer reliably, so `reference` here is ours — and a structured city and state,
 * because `business.address` is the free-text block a business typed in Settings → Payments, returned verbatim
 * rather than parsed into parts nobody asked them for.
 *
 * **The webhooks** (`/webhooks/stripe`, `/webhooks/square`) are parsed from the exact bytes that arrived, so
 * the signature is checked over what was signed; the provider's own verifier does that (payments/provider.ts),
 * never anything written here. Only then is the event stored, deduplicated on the provider's event id, and
 * routed to its business by the account it happened in — `private.payment_connection_by_account`, which is
 * deliberately unfiltered by status, because a bank transfer settles days after a business disconnects. An
 * event for an account we have never heard of is a 200 and a drop: a provider that gets anything else retries
 * it for days.
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  acceptanceWording,
  APPROVE_LABEL,
  businessPostalAddress,
  DECLINE_LABEL,
  estimateAcceptOnline,
  estimateDeclineOnline,
  estimateRecordView,
  estimateSelect,
  estimateState,
  executeCommand,
  expiresAtOf,
  formatPhone,
  HfosError,
  invoiceRecordPayment,
  invoiceRecordView,
  invoiceSelect,
  invoiceStateOf,
  depositTermsOf,
  linesFor,
  linesOut,
  loadMoneySettings,
  money as moneyWords,
  moneyIso,
  PAY_LABEL,
  subscriptionRecordCard,
  TYPED_NAME_LABEL,
  type EstimateRow,
  type InvoiceRow,
  type MoneySettings,
  type MoneyTermsOut,
  type RequestMeta,
} from '@hfos/core/server';
import { and, eq } from 'drizzle-orm';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { paymentConnections, phoneNumbers, workspaces } from '@hfos/db/schema';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MONEY_LINK_PATH,
  resolveDocumentToken,
  type MoneyDocumentKind,
  type MoneyTokenResult,
} from '../money/links';
import { publicLookOf } from '../look/public';
import { publicOrigin } from '../hosting/origin';
import { paymentKindOf, WEBHOOK_MAX_BYTES } from '../money/webhook-events';
import {
  accountFor,
  paymentConnectionUsable,
  WEBHOOK_SECRET_SETTING,
  type PaymentConnectionRow,
} from '../payments/index';
import {
  declineWording,
  isPaymentProvider,
  PAYMENT_NAME,
  PaymentAuthError,
  PaymentError,
  type PaymentCapabilities,
  type PaymentMethodKind,
  type PaymentProviderName,
  type PaymentResult,
  type PaymentState,
} from '../payments/provider';
import { systemActor, type TenantScope } from '../services';
import { type PublicBusiness } from './booking';
import { header, parseBody, recordDelivery, type HttpDeps } from './common';
import { PARTNER_PAYOUT_ACCOUNT_KIND } from '../partners/payouts';

const MIN = 60_000;

// ---- Limits and options ----

export interface RateRule {
  readonly max: number;
  /** Milliseconds. */
  readonly timeWindow: number;
}

export interface MoneyLimits {
  /** A customer's own estimate or invoice page. */
  readonly read: RateRule;
  /** Approving, declining, and saying the page was opened. */
  readonly act: RateRule;
  /** Starting or taking a payment. */
  readonly pay: RateRule;
}

/** Per address: pages 30 a minute, answers 10 a minute, payments 8 per 10 minutes. */
export const MONEY_LIMITS: MoneyLimits = {
  read: { max: 30, timeWindow: MIN },
  act: { max: 10, timeWindow: MIN },
  pay: { max: 8, timeWindow: 10 * MIN },
};

export interface MoneyHttpOptions {
  /** Multiplies every limit; 10 outside production, where Playwright pays from one address. */
  readonly limitFactor?: number;
  /** Replaces limits outright (tests). */
  readonly limits?: Partial<MoneyLimits>;
}

function limitsFor(opts: MoneyHttpOptions): MoneyLimits {
  const factor = Math.max(1, Math.floor(opts.limitFactor ?? 1));
  const scaled = (r: RateRule): RateRule => ({ max: r.max * factor, timeWindow: r.timeWindow });
  return {
    read: opts.limits?.read ?? scaled(MONEY_LIMITS.read),
    act: opts.limits?.act ?? scaled(MONEY_LIMITS.act),
    pay: opts.limits?.pay ?? scaled(MONEY_LIMITS.pay),
  };
}

// ---- Errors the customer sees ----

const linkNotFound = () =>
  HfosError.notFound(
    'This link doesn’t work. Check that it matches the one we sent you, or contact the business.',
  );

const staleLink = (kind: MoneyDocumentKind, business: PublicBusiness) =>
  new HfosError(
    'rule_violation',
    410,
    `This link is out of date. Use the newest ${kind} we sent you.`,
    { business },
    'money_link_stale',
  );

/**
 * Anything wrong with the account behind a payment: never the provider's own words. The customer is told we
 * can't take it right now and how to reach a person; the business hears about the account separately.
 */
const cannotTakePayment = () =>
  HfosError.rule(
    'payment_unavailable',
    409,
    'We can’t take payments online right now. Call us and we’ll sort it out another way.',
  );

const providerRefused = () =>
  HfosError.rule(
    'payment_provider_error',
    502,
    'The payment company didn’t answer just now. Try again in a minute, or give us a call.',
  );

const meta = (): RequestMeta => ({
  correlationId: randomUUID(),
  causationId: null,
  channel: 'booking_page',
});

/** A filled honeypot is a bot: a plain 400, nothing saved. */
function refuseHoneypot(body: unknown): void {
  const website = (body as { website?: unknown } | null)?.website;
  if (typeof website === 'string' && website.trim() !== '')
    throw HfosError.validation([], 'That didn’t go through. Refresh the page and try again.');
}

// ---- Request bodies ----

const honeypot = { website: z.string().max(500).optional() };

const AcceptBody = z.object({
  name: z.string().trim().min(1, 'Type your name.').max(120),
  ...honeypot,
});
const DeclineBody = z.object({
  name: z.string().trim().min(1).max(120).nullable().default(null),
  reason: z.string().trim().max(1_000).nullable().default(null),
  ...honeypot,
});
/**
 * A card for a plan. The same two phases as paying, for the same reason: the first POST hands the browser a
 * session with the provider's own public keys (and, on this development server, the stand-in's page), the
 * browser turns a card into a token in the provider's own fields, and the second POST saves that token. **No
 * card number ever reaches us** — which is what keeps HandsFreeOS in the lightest PCI bracket.
 */
const PlanCardBody = z.object({
  /** One per Save press, so a doubled submit saves the same card once. */
  clientId: z.string().trim().min(8).max(64),
  /** The token the browser minted; absent on the first phase. */
  sourceToken: z.string().trim().min(1).max(4_000).nullable().default(null),
  ...honeypot,
});

const PayBody = z.object({
  /** One per Pay press: a retried or doubled submit takes the payment once. */
  clientId: z.string().trim().min(8).max(64),
  method: z.enum(['card', 'ach']).default('card'),
  /** Square: the Web Payments token the browser minted. */
  sourceToken: z.string().trim().min(1).max(4_000).nullable().default(null),
  /** Stripe, second phase: the intent the browser has just confirmed, read back from the provider. */
  providerPaymentId: z.string().trim().min(1).max(200).nullable().default(null),
  /** Left out, everything still owed. */
  amountCents: z.int().min(1).max(100_000_000_000).nullable().default(null),
  ...honeypot,
});

// ---- Reading a document as its customer sees it ----

/** What a business looks like on a customer's page: enough to recognise it and to reach a person. */
export interface PublicMoneyBusiness extends PublicBusiness {
  /**
   * Where the business is, as they wrote it in Settings → Payments (`money.businessAddress`) — the address
   * that belongs at the top of a document they send. Failing that, the address the onboarding setup asked for,
   * then the one they typed for "at our place" on a calendar, which is the same string the booking page already
   * shows customers. Null when they have given none (`businessPostalAddress`).
   */
  readonly address: string | null;
}

async function businessOf(
  tx: Tx,
  workspaceId: string,
  storageUrl: string | null | undefined,
): Promise<PublicMoneyBusiness> {
  const [w] = await tx
    .select({ name: workspaces.name, settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const [phone] = await tx
    .select({ e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.status, 'active')))
    .limit(1);
  return {
    name: w?.name ?? 'The business',
    phone: phone?.e164 ?? null,
    phoneDisplay: phone ? formatPhone(phone.e164) : null,
    look: publicLookOf(w?.settings, storageUrl),
    address: await businessPostalAddress(tx, workspaceId),
  };
}

const customerOf = (r: { first_name: string | null; last_name: string | null }) =>
  [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || 'Customer';

const totalsOf = (r: EstimateRow | InvoiceRow) => ({
  subtotalCents: Number(r.subtotal_cents),
  discountCents: Number(r.discount_cents),
  /** Set when the discount was asked for as a percentage, so the page can say "10% off". */
  discountPercentBp: r.discount_percent_bp,
  taxableBaseCents: Number(r.taxable_base_cents),
  taxCents: Number(r.tax_cents),
  taxRateBp: r.tax_rate_bp,
  taxLabel: r.tax_label,
  totalCents: Number(r.total_cents),
  currency: r.currency,
});

/**
 * The document discount as it was written — a share or an amount — in the same shape core gives a deposit, so
 * the page can say "10% off" and not only what came off. The two columns are exclusive by the same rule.
 */
const discountTermsOf = (r: EstimateRow | InvoiceRow): MoneyTermsOut =>
  r.discount_percent_bp !== null
    ? { kind: 'percent', percentBp: r.discount_percent_bp, amountCents: 0 }
    : Number(r.discount_cents) > 0
      ? { kind: 'amount', percentBp: 0, amountCents: Number(r.discount_cents) }
      : { kind: 'none', percentBp: 0, amountCents: 0 };

const deposit = (r: EstimateRow): number => {
  const total = Number(r.total_cents);
  if (r.deposit_cents !== null) return Math.min(Number(r.deposit_cents), total);
  if (r.deposit_percent_bp === null) return 0;
  return Math.min(Math.round((total * r.deposit_percent_bp) / 10_000), total);
};

/**
 * The number to quote on the phone about one payment or refund. **Ours, not the provider's**: neither Stripe
 * nor Square gives a reference we could show a customer reliably, and we store none of our own beyond the row.
 */
const referenceOf = (id: string): string => id.replace(/-/g, '').slice(0, 8).toUpperCase();

/** A business's time zone, so "good until" and "due" are read where the business is. */
async function timezoneOf(tx: Tx, workspaceId: string): Promise<string> {
  const [w] = await tx
    .select({ timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return w?.timezone ?? 'America/Chicago';
}

// ---- The two views ----

async function estimateView(deps: HttpDeps, scope: TenantScope, estimateId: string) {
  return asWorker(deps.httpDb, scope, async (tx) => {
    const [row] = await rows<EstimateRow>(tx, sql`${estimateSelect} where e.id = ${estimateId}`);
    // A draft was never sent, so no link to it was ever given out: it looks exactly like a missing one.
    if (!row || row.status === 'draft') throw linkNotFound();
    const tz = await timezoneOf(tx, scope.workspaceId);
    const lines = (await linesFor(tx, 'estimate', [row.id])).get(row.id) ?? [];
    const expiresAt = expiresAtOf(row.expires_on, tz);
    const state = estimateState(
      { status: row.status, expiresAt, viewedAt: moneyIso(row.first_viewed_at) },
      Date.now(),
    );
    const open = state === 'sent' || state === 'viewed';
    const business = await businessOf(tx, scope.workspaceId, deps.storageUrl);
    return {
      state: state as string,
      business,
      customer: {
        name: customerOf(row),
        email: row.person_email,
        phone: row.person_phone ? formatPhone(row.person_phone) : null,
      },
      estimate: {
        number: row.number,
        title: row.title,
        notes: row.notes,
        currency: row.currency,
        lines: linesOut(lines, Number(row.discount_cents)),
        totals: totalsOf(row),
        /** The discount as it was written, so the page can say "10% off" and not only the amount. */
        discount: discountTermsOf(row),
        /** What is asked for up front, as it was written ("25%"), beside the figure it comes to. */
        deposit: depositTermsOf(row),
        depositCents: deposit(row),
        expiresOn: row.expires_on,
        expiresAt,
        sentAt: moneyIso(row.sent_at),
      },
      answer: {
        canAccept: open,
        canDecline: open,
        /** Why it can't be answered — the page says so instead of showing a dead button. */
        reason: open
          ? null
          : state === 'expired'
            ? 'expired'
            : state === 'void'
              ? 'withdrawn'
              : 'answered',
        /**
         * The exact words that must sit above Approve, naming this estimate's own figure and this business:
         * the sentence is the evidence, and it is what the acceptance is recorded with.
         */
        wording: acceptanceWording(Number(row.total_cents), business.name),
        nameLabel: TYPED_NAME_LABEL,
        acceptLabel: APPROVE_LABEL,
        declineLabel: DECLINE_LABEL,
        acceptedAt: moneyIso(row.accepted_at),
        acceptedName: row.accepted_name,
        acceptedVia: row.accepted_via,
        declinedAt: moneyIso(row.declined_at),
        declinedReason: row.declined_reason,
      },
    };
  });
}

type PublicPayment = {
  id: string;
  amountCents: number;
  method: string;
  status: string;
  cardBrand: string | null;
  cardLast4: string | null;
  receivedAt: string | null;
  createdAt: string;
};

type PublicRefund = {
  id: string;
  amountCents: number;
  status: string;
  refundedAt: string | null;
};

/** What the account behind this invoice can take, and the public keys the browser needs to use it. */
interface PaySession {
  readonly provider: PaymentProviderName;
  readonly flow: 'client_confirm' | 'server_charge';
  /** Stripe's `pk_…`, Square's application id. Public, and safe on a customer's page. */
  readonly publishableKey: string;
  /** Stripe: the connected account the Elements session belongs to. Square: the merchant. */
  readonly accountId: string;
  /** Square: the location the Web Payments SDK charges at. */
  readonly locationId: string | null;
}

interface PayableAccount {
  readonly connection: PaymentConnectionRow;
  readonly session: PaySession;
  readonly methods: readonly PaymentMethodKind[];
}

/**
 * The account an invoice is paid into: the one it names, else the business's default. Deliberately strict —
 * only a connection that is signed in and usable can take money, and anything else reads to the customer as
 * "we can't take a payment right now", never as a provider error.
 */
async function payableAccount(
  deps: HttpDeps,
  tx: Tx,
  workspaceId: string,
  invoice: InvoiceRow,
  settings: MoneySettings,
): Promise<PayableAccount | null> {
  const list = await tx
    .select()
    .from(paymentConnections)
    .where(eq(paymentConnections.workspaceId, workspaceId));
  const chosen = invoice.connection_id
    ? list.find((c) => c.id === invoice.connection_id)
    : (list.find((c) => c.isDefault && paymentConnectionUsable(c)) ??
      list.find((c) => paymentConnectionUsable(c)));
  if (!chosen || !paymentConnectionUsable(chosen)) return null;
  if (!isPaymentProvider(chosen.provider)) return null;
  const provider = deps.payments.providers[chosen.provider];
  if (!provider?.configured) return null;
  const caps = (chosen.capabilities ?? {}) as Partial<PaymentCapabilities>;
  const methods: PaymentMethodKind[] = [];
  // Bank transfer leads: it is the cheap rail, and the business can switch it off.
  if (settings.bankTransfer && caps.bankTransfer === true) methods.push('ach');
  if (caps.card === true) methods.push('card');
  if (!methods.length) return null;
  return {
    connection: chosen,
    methods,
    session: {
      provider: chosen.provider,
      flow: provider.flow,
      publishableKey: provider.publishableKey,
      accountId: chosen.externalAccountId ?? '',
      locationId: chosen.locationId,
    },
  };
}

async function invoiceView(deps: HttpDeps, scope: TenantScope, invoiceId: string) {
  return asWorker(deps.httpDb, scope, async (tx) => {
    const [row] = await rows<InvoiceRow>(tx, sql`${invoiceSelect} where i.id = ${invoiceId}`);
    if (!row || row.status === 'draft') throw linkNotFound();
    const tz = await timezoneOf(tx, scope.workspaceId);
    const settings = await loadMoneySettings(tx, scope.workspaceId);
    const lines = (await linesFor(tx, 'invoice', [row.id])).get(row.id) ?? [];
    // The same word the business sees: a paid invoice whose money went back reads as refunded, never as owing.
    const state = invoiceStateOf(row, Date.now(), tz);
    // Only what the customer's own receipt needs: never a fee, a provider id or who recorded it.
    const paid = await rows<PublicPayment>(
      tx,
      sql`select p.id, p.amount_cents::float8 as "amountCents", p.method::text as method,
            p.status::text as status, p.card_brand as "cardBrand", p.card_last4 as "cardLast4",
            p.received_at as "receivedAt", p.created_at as "createdAt"
          from app.payments p
          where p.invoice_id = ${row.id} and p.status in ('processing', 'succeeded')
          order by p.created_at, p.id`,
    );
    // Money already given back, and the day it went: the figure on its own leaves a customer guessing.
    // Only the ones that landed, so this list and `amountRefundedCents` can never disagree.
    const given = await rows<PublicRefund>(
      tx,
      sql`select rf.id, rf.amount_cents::float8 as "amountCents", rf.status::text as status,
            rf.refunded_at as "refundedAt"
          from app.refunds rf
          where rf.invoice_id = ${row.id} and rf.status = 'succeeded'
          order by rf.refunded_at, rf.id`,
    );
    const owed = Number(row.balance_cents);
    const account =
      row.status === 'void' || owed <= 0
        ? null
        : await payableAccount(deps, tx, scope.workspaceId, row, settings);
    return {
      state: state as string,
      business: await businessOf(tx, scope.workspaceId, deps.storageUrl),
      customer: {
        name: customerOf(row),
        email: row.person_email,
        phone: row.person_phone ? formatPhone(row.person_phone) : null,
      },
      invoice: {
        number: row.number,
        title: row.title,
        notes: row.notes,
        currency: row.currency,
        /** What this invoice is for: a 'deposit' reads differently from the balance that follows it. */
        purpose: row.purpose,
        lines: linesOut(lines, Number(row.discount_cents)),
        totals: totalsOf(row),
        /** The discount as it was written, so the page can say "10% off" and not only the amount. */
        discount: discountTermsOf(row),
        dueOn: row.due_on,
        terms: row.terms,
        sentAt: moneyIso(row.sent_at),
        paidAt: moneyIso(row.paid_at),
        amountPaidCents: Number(row.amount_paid_cents),
        amountRefundedCents: Number(row.amount_refunded_cents),
        balanceCents: owed,
      },
      payments: paid.map((p) => ({
        amountCents: Number(p.amountCents),
        method: p.method,
        status: p.status,
        /** A payment's purpose is its invoice's: money against a deposit invoice is a deposit paid. */
        purpose: row.purpose,
        /** "Visa •••• 4242" on the receipt. Both null for a bank transfer, cash, or a provider that didn't say. */
        cardBrand: p.cardBrand,
        cardLast4: p.cardLast4,
        /** Ours, for the phone. The providers give no reference we could show reliably (see below). */
        reference: referenceOf(p.id),
        receivedAt: moneyIso(p.receivedAt),
        createdAt: moneyIso(p.createdAt)!,
      })),
      /** What has been given back, and when: the figure on its own leaves a customer guessing. */
      refunds: given.map((r) => ({
        amountCents: Number(r.amountCents),
        status: r.status,
        refundedAt: moneyIso(r.refundedAt),
        reference: referenceOf(r.id),
      })),
      pay: {
        canPay: !!account,
        /** Why not, when it can't be paid here: the page says so rather than offering a dead button. */
        reason:
          row.status === 'void' ? 'withdrawn' : owed <= 0 ? 'paid' : account ? null : 'no_account',
        amountCents: owed,
        payLabel: PAY_LABEL,
        methods: account?.methods ?? [],
        /** Public keys only: never a secret key, and never Square's access token. */
        session: account?.session ?? null,
      },
    };
  });
}

// ---- The customer's own plan page ----

interface PlanRow extends Record<string, unknown> {
  id: string;
  status: string;
  plan_name: string;
  price_cents: number;
  interval: string;
  interval_count: number;
  includes: unknown;
  connection_id: string | null;
  customer_ref: string | null;
  method_token: string | null;
  card_brand: string | null;
  card_last4: string | null;
  card_expiry_month: number | null;
  card_expiry_year: number | null;
  card_requested_at: Date | string | null;
  started_on: string | null;
  next_billing_on: string | null;
  first_name: string | null;
  last_name: string | null;
  person_email: string | null;
  person_phone: string | null;
}

const planSql = (subscriptionId: string) =>
  sql`select s.id, s.status::text as status, s.plan_name, s.price_cents::float8 as price_cents,
        s.interval::text as interval, s.interval_count, s.includes, s.connection_id,
        s.customer_ref, s.method_token, s.card_brand, s.card_last4,
        s.card_expiry_month, s.card_expiry_year, s.card_requested_at,
        s.started_on::text as started_on, s.next_billing_on::text as next_billing_on,
        pe.first_name, pe.last_name, pe.email::text as person_email, pe.phone as person_phone
      from app.subscriptions s
      left join app.people pe on pe.id = s.person_id
      where s.id = ${subscriptionId}`;

/**
 * The account a plan's card is saved on: the one it names, else the business's default. A plan is card-only —
 * Square has no other way to bill one, and Stripe Billing needs a card on the customer — so an account that
 * cannot take a card cannot take a plan either.
 */
async function planAccount(
  deps: HttpDeps,
  tx: Tx,
  workspaceId: string,
  plan: PlanRow,
): Promise<PayableAccount | null> {
  const list = await tx
    .select()
    .from(paymentConnections)
    .where(eq(paymentConnections.workspaceId, workspaceId));
  const chosen = plan.connection_id
    ? list.find((c) => c.id === plan.connection_id)
    : (list.find((c) => c.isDefault && paymentConnectionUsable(c)) ??
      list.find((c) => paymentConnectionUsable(c)));
  if (!chosen || !paymentConnectionUsable(chosen)) return null;
  if (!isPaymentProvider(chosen.provider)) return null;
  const provider = deps.payments.providers[chosen.provider];
  if (!provider?.configured) return null;
  const caps = (chosen.capabilities ?? {}) as Partial<PaymentCapabilities>;
  if (caps.card !== true) return null;
  return {
    connection: chosen,
    methods: ['card'],
    session: {
      provider: chosen.provider,
      flow: provider.flow,
      publishableKey: provider.publishableKey,
      accountId: chosen.externalAccountId ?? '',
      locationId: chosen.locationId,
    },
  };
}

/** "$29 a month", "$290 a year", "$149 every 3 months" — the same wording the business's own screens use. */
function planPriceLabel(cents: number, interval: string, count: number): string {
  const every =
    count === 1
      ? interval === 'year'
        ? 'a year'
        : interval === 'quarter'
          ? 'a quarter'
          : 'a month'
      : `every ${count} ${interval}s`;
  return `${moneyWords(cents)} ${every}`;
}

/** Where the plan stands, in the customer's own terms rather than ours. */
function planStanding(plan: PlanRow): 'waiting' | 'billing' | 'paused' | 'ended' {
  if (plan.status === 'cancelled') return 'ended';
  if (plan.status === 'paused') return 'paused';
  return plan.method_token ? 'billing' : 'waiting';
}

async function planView(deps: HttpDeps, scope: TenantScope, subscriptionId: string) {
  return asWorker(deps.httpDb, scope, async (tx) => {
    const [row] = await rows<PlanRow>(tx, planSql(subscriptionId));
    if (!row) throw linkNotFound();
    const standing = planStanding(row);
    const account =
      standing === 'ended' ? null : await planAccount(deps, tx, scope.workspaceId, row);
    const includes = Array.isArray(row.includes)
      ? row.includes.filter((x): x is string => typeof x === 'string')
      : [];
    return {
      standing,
      business: await businessOf(tx, scope.workspaceId, deps.storageUrl),
      customer: {
        name: customerOf(row),
        email: row.person_email,
        phone: row.person_phone ? formatPhone(row.person_phone) : null,
      },
      plan: {
        name: row.plan_name,
        priceCents: Number(row.price_cents),
        priceLabel: planPriceLabel(
          Number(row.price_cents),
          row.interval,
          Number(row.interval_count),
        ),
        interval: row.interval,
        intervalCount: Number(row.interval_count),
        includes,
        /** The day it first bills: the one the business set, else the day the card lands. */
        startsOn: row.started_on,
        nextBillingOn: row.next_billing_on,
      },
      /** As much of the card as anyone may ever see. Never the number, and never the provider's token. */
      card: row.method_token
        ? {
            brand: row.card_brand,
            last4: row.card_last4,
            expiryMonth: row.card_expiry_month === null ? null : Number(row.card_expiry_month),
            expiryYear: row.card_expiry_year === null ? null : Number(row.card_expiry_year),
          }
        : null,
      save: {
        canSave: !!account,
        /** Why not, when a card cannot go on it here: the page says so rather than offering a dead button. */
        reason: standing === 'ended' ? 'ended' : account ? null : 'no_account',
        /** Public keys only: never a secret key, and never the account's access token. */
        session: account?.session ?? null,
      },
    };
  });
}

// ---- Taking a payment ----

/** Everything a pay attempt needs, resolved once against the invoice the token named. */
interface PayContext {
  readonly invoice: InvoiceRow;
  readonly account: PayableAccount;
  readonly amountCents: number;
  readonly method: PaymentMethodKind;
  readonly idempotencyKey: string;
}

/** Either a payment to take, or one this press already made. */
type PayPlan =
  | { readonly kind: 'repeat'; readonly repeat: PayRepeat }
  | { readonly kind: 'take'; readonly take: PayContext };

/** A press we have already answered: the same payment, answered again rather than taken again. */
interface PayRepeat {
  readonly invoiceId: string;
  readonly paymentId: string;
  readonly status: PaymentState;
  readonly amountCents: number;
  readonly method: PaymentMethodKind;
  readonly failureCode: string | null;
}

function assertPayable(row: InvoiceRow): void {
  if (row.status === 'void')
    throw HfosError.rule(
      'invoice_voided',
      409,
      'This invoice was withdrawn, so it can’t be paid. Call us if you think you still owe something.',
    );
  if (Number(row.balance_cents) <= 0)
    throw HfosError.rule('invoice_settled', 409, 'This invoice is already paid. Thank you!');
}

export async function registerMoneyRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const opts = deps.money ?? {};
  const limits = limitsFor({
    ...opts,
    limitFactor: opts.limitFactor ?? deps.booking?.limitFactor,
  });
  const links = deps.moneyLinks;

  /**
   * The address this business's customers see: its own domain once one is serving (M17), ours otherwise.
   * Every page a customer is sent back to after paying is built on it, so nobody is bounced between two
   * names halfway through putting a card down.
   */
  const origin = (scope: TenantScope) =>
    asWorker(deps.httpDb, scope, (tx) => publicOrigin(tx, scope.workspaceId, links.webUrl));

  /** Checks one of the customer's links: 404 when it isn't one, 410 when a newer one replaced it. */
  async function linked(kind: MoneyDocumentKind, token: string) {
    const r: MoneyTokenResult = await resolveDocumentToken(deps.httpDb, links, kind, token);
    if (r.status === 'invalid') throw linkNotFound();
    if (r.status === 'stale') {
      const business = await asWorker(deps.httpDb, r.scope, (tx) =>
        businessOf(tx, r.scope.workspaceId, deps.storageUrl),
      );
      throw staleLink(kind, business);
    }
    return r;
  }

  /** What the provider was told, so a webhook and a dashboard both point back at the right invoice. */
  const metadataFor = (scope: TenantScope, invoice: InvoiceRow) => ({
    invoiceId: invoice.id,
    workspaceId: scope.workspaceId,
    ...(invoice.number ? { invoiceNumber: invoice.number } : {}),
  });

  /**
   * Writes what we know about the payment before and after the provider is called — the row, its idempotency
   * key and the unique index behind it are what stop a double-clicked button charging twice. The command moves
   * a payment forward only, so a callback that arrives first can never be undone by this.
   */
  async function record(
    scope: TenantScope,
    ctx: PayContext,
    over: {
      status: 'requires_payment' | 'processing' | 'succeeded' | 'failed';
      providerPaymentId?: string | null;
      providerStatus?: string | null;
      failureCode?: string | null;
      feeCents?: number | null;
      netCents?: number | null;
      receivedAt?: string | null;
      cardBrand?: string | null;
      cardLast4?: string | null;
    },
  ) {
    const { output } = await executeCommand(
      deps.httpDb,
      invoiceRecordPayment,
      {
        workspaceId: scope.workspaceId,
        invoiceId: ctx.invoice.id,
        amountCents: ctx.amountCents,
        method: ctx.method,
        provider: ctx.account.session.provider,
        connectionId: ctx.account.connection.id,
        idempotencyKey: ctx.idempotencyKey,
        providerPaymentId: over.providerPaymentId ?? null,
        providerStatus: over.providerStatus ?? null,
        status: over.status,
        failureCode: over.failureCode ?? null,
        feeCents: over.feeCents ?? null,
        netCents: over.netCents ?? null,
        receivedAt: over.receivedAt ?? null,
        // What the card was, where the provider said so — and nothing at all where it didn't.
        cardBrand: over.cardBrand ?? null,
        cardLast4: over.cardLast4 ?? null,
      },
      systemActor(scope),
      meta(),
    );
    return output;
  }

  /** A provider refusal never reaches the customer in the provider's words. */
  function refused(e: unknown, scope: TenantScope, connectionId: string): never {
    if (e instanceof PaymentAuthError) {
      deps.log.warn(
        { workspaceId: scope.workspaceId, connectionId, err: e.message },
        'a customer could not pay: the account’s sign-in is gone',
      );
      throw cannotTakePayment();
    }
    if (e instanceof PaymentError) {
      deps.log.warn(
        { workspaceId: scope.workspaceId, connectionId, code: e.code, err: e.message },
        'a customer’s payment was refused by the provider',
      );
      throw e.permanent ? cannotTakePayment() : providerRefused();
    }
    throw e;
  }

  const paymentOut = (result: PaymentResult, paymentId: string, ctx: PayContext) => ({
    paymentId,
    status: result.status,
    amountCents: result.amountCents,
    method: ctx.method,
    /** Plain words for a decline; never the provider's own message. */
    failureMessage: result.failureMessage,
    failureCode: result.failureCode,
    receivedAt: result.receivedAt,
  });

  await app.register(async (pub) => {
    await pub.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of tries from here. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    // Every answer on a customer's page: never cached, and the token never leaves in a Referer header.
    pub.addHook('onSend', async (_req, reply) => {
      void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    });

    // ---------- the estimate ----------
    pub.get<{ Params: { token: string } }>(
      '/public/estimate/:token',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const e = await linked('estimate', req.params.token);
        return estimateView(deps, e.scope, e.documentId);
      },
    );

    /**
     * The customer opened it. A POST, not the GET: mail scanners open links, and "opened, not answered" has to
     * be a fact rather than a guess. Only the first open is news.
     */
    pub.post<{ Params: { token: string } }>(
      '/public/estimate/:token/viewed',
      { config: { rateLimit: limits.act } },
      async (req) => {
        const e = await linked('estimate', req.params.token);
        const { output } = await executeCommand(
          deps.httpDb,
          estimateRecordView,
          { workspaceId: e.scope.workspaceId, documentId: e.documentId },
          systemActor(e.scope),
          meta(),
        );
        return { firstViewedAt: output.firstViewedAt, changed: output.changed };
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/estimate/:token/accept',
      { config: { rateLimit: limits.act } },
      async (req) => {
        refuseHoneypot(req.body);
        const body = parseBody(AcceptBody, req.body ?? {});
        const e = await linked('estimate', req.params.token);
        // The wording is ours, not the page's: what is recorded is what the customer had to have read, and it
        // is rendered here from this estimate's own figure and this business's name.
        const wording = await asWorker(deps.httpDb, e.scope, async (tx) => {
          const [found] = await rows<{ total_cents: number }>(
            tx,
            sql`select total_cents::float8 as total_cents from app.estimates where id = ${e.documentId}`,
          );
          if (!found) throw linkNotFound();
          const business = await businessOf(tx, e.scope.workspaceId, deps.storageUrl);
          return acceptanceWording(Number(found.total_cents), business.name);
        });
        const { output } = await executeCommand(
          deps.httpDb,
          estimateAcceptOnline,
          {
            workspaceId: e.scope.workspaceId,
            estimateId: e.documentId,
            name: body.name,
            wording,
          },
          systemActor(e.scope),
          meta(),
        );
        return {
          ...(await estimateView(deps, e.scope, e.documentId)),
          accepted: { at: output.acceptedAt, name: output.acceptedName },
        };
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/estimate/:token/decline',
      { config: { rateLimit: limits.act } },
      async (req) => {
        refuseHoneypot(req.body);
        const body = parseBody(DeclineBody, req.body ?? {});
        const e = await linked('estimate', req.params.token);
        await executeCommand(
          deps.httpDb,
          estimateDeclineOnline,
          {
            workspaceId: e.scope.workspaceId,
            estimateId: e.documentId,
            name: body.name,
            reason: body.reason,
          },
          systemActor(e.scope),
          meta(),
        );
        return estimateView(deps, e.scope, e.documentId);
      },
    );

    // ---------- the plan ----------
    pub.get<{ Params: { token: string } }>(
      '/public/plan/:token',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const p = await linked('plan', req.params.token);
        return planView(deps, p.scope, p.documentId);
      },
    );

    /**
     * Putting a card on a plan, in the two phases paying uses: no token yet hands the browser a session (and,
     * on this development server, the stand-in's own page); a token is saved at the provider against their
     * customer, and the plan goes live from there on its own.
     *
     * **A declined card is a 200 with `status: 'declined'`** and plain words. A decline is an answer, not a
     * failure state: the plan stays exactly where it was, waiting, and they can try another card.
     */
    pub.post<{ Params: { token: string } }>(
      '/public/plan/:token/card',
      { config: { rateLimit: limits.pay } },
      async (req) => {
        refuseHoneypot(req.body);
        const body = parseBody(PlanCardBody, req.body ?? {});
        const p = await linked('plan', req.params.token);
        const scope = p.scope;
        const found = await asWorker(deps.httpDb, scope, async (tx) => {
          const [row] = await rows<PlanRow>(tx, planSql(p.documentId));
          if (!row) throw linkNotFound();
          if (row.status === 'cancelled')
            throw HfosError.rule(
              'subscription_cancelled',
              409,
              'This plan has ended, so it can’t take a card. Call us if you’d like to start it again.',
            );
          const account = await planAccount(deps, tx, scope.workspaceId, row);
          if (!account) throw cannotTakePayment();
          // Read in the transaction that is already open rather than one of its own.
          return { row, account, origin: await publicOrigin(tx, scope.workspaceId, links.webUrl) };
        });
        const { row, account } = found;
        const api = deps.payments.providers[account.session.provider]!;
        // Back to the page they started on: their own domain when one is serving (M17).
        const returnUrl = `${found.origin}/${MONEY_LINK_PATH.plan}/${req.params.token}`;

        // Nothing to save yet: hand the browser what it needs to turn a card into a token.
        if (!body.sourceToken) {
          return {
            stage: 'prepared' as const,
            session: {
              ...account.session,
              /** The stand-in's own page; null with the real providers, which run in the browser. */
              hostedUrl: deps.payments.fake
                ? `${deps.publicUrl}/payments/fake/pay?provider=${encodeURIComponent(
                    account.session.provider,
                  )}&account=${encodeURIComponent(account.session.accountId)}&amount=${Math.max(
                    1,
                    Math.round(Number(row.price_cents)),
                  )}&methods=card&return=${encodeURIComponent(returnUrl)}`
                : null,
              returnUrl,
            },
            plan: await planView(deps, scope, row.id),
          };
        }

        let sealed;
        try {
          sealed = accountFor(deps.sealer, account.connection);
        } catch (e) {
          return refused(e, scope, account.connection.id);
        }
        try {
          // The provider's customer first: the card and the plan must hang off the same one.
          const customer = await api.ensureCustomer(sealed, {
            customerRef: row.customer_ref,
            name: customerOf(row),
            email: row.person_email,
            phone: row.person_phone,
            idempotencyKey: `plan-customer-${row.id}`,
          });
          const saved = await api.saveMethod(sealed, {
            customerRef: customer.customerRef,
            sourceToken: body.sourceToken,
            idempotencyKey: `plan-card-${row.id}-${body.clientId}`.slice(0, 64),
          });
          await executeCommand(
            deps.httpDb,
            subscriptionRecordCard,
            {
              workspaceId: scope.workspaceId,
              subscriptionId: row.id,
              provider: account.session.provider,
              connectionId: account.connection.id,
              customerRef: customer.customerRef,
              methodToken: saved.token,
              cardBrand: saved.brand,
              cardLast4: saved.last4,
              cardExpiryMonth: saved.expiryMonth,
              cardExpiryYear: saved.expiryYear,
            },
            systemActor(scope),
            meta(),
          );
          return {
            stage: 'saved' as const,
            status: 'saved' as const,
            plan: await planView(deps, scope, row.id),
          };
        } catch (e) {
          if (e instanceof HfosError) throw e;
          // A card the provider refuses is an answer for the customer, not an error for the business.
          if (e instanceof PaymentError && e.permanent) {
            deps.log.info(
              { workspaceId: scope.workspaceId, subscriptionId: row.id, code: e.code },
              'a card for a plan was refused',
            );
            return {
              stage: 'saved' as const,
              status: 'declined' as const,
              failureCode: e.code,
              failureMessage: declineWording(e.code),
              plan: await planView(deps, scope, row.id),
            };
          }
          return refused(e, scope, account.connection.id);
        }
      },
    );

    // ---------- the invoice ----------
    pub.get<{ Params: { token: string } }>(
      '/public/invoice/:token',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const i = await linked('invoice', req.params.token);
        return invoiceView(deps, i.scope, i.documentId);
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/invoice/:token/viewed',
      { config: { rateLimit: limits.act } },
      async (req) => {
        const i = await linked('invoice', req.params.token);
        const { output } = await executeCommand(
          deps.httpDb,
          invoiceRecordView,
          { workspaceId: i.scope.workspaceId, documentId: i.documentId },
          systemActor(i.scope),
          meta(),
        );
        return { firstViewedAt: output.firstViewedAt, changed: output.changed };
      },
    );

    /**
     * Paying. Stripe's first phase prepares the intent and answers `stage: 'prepared'`; its second phase names
     * that intent and reads it back. Square takes the browser's token and charges in one go. A decline comes
     * back here as a 200 with `status: 'failed'` and words the customer can act on.
     */
    pub.post<{ Params: { token: string } }>(
      '/public/invoice/:token/pay',
      { config: { rateLimit: limits.pay } },
      async (req) => {
        refuseHoneypot(req.body);
        const body = parseBody(PayBody, req.body ?? {});
        const i = await linked('invoice', req.params.token);
        const scope = i.scope;
        const plan: PayPlan = await asWorker(deps.httpDb, scope, async (tx) => {
          const [row] = await rows<InvoiceRow>(
            tx,
            sql`${invoiceSelect} where i.id = ${i.documentId}`,
          );
          if (!row || row.status === 'draft') throw linkNotFound();
          const idempotencyKey = `inv:${row.id}:${body.clientId}`.slice(0, 64);
          // This press has already been answered — a doubled submit, or the page sent again. The payment it
          // made is the answer; nothing is charged a second time, and no account is needed to say so.
          const [done] = await rows<{
            id: string;
            status: PaymentState;
            amount_cents: number;
            method: string;
            failure_code: string | null;
          }>(
            tx,
            sql`select p.id, p.status::text as status, p.amount_cents::float8 as amount_cents,
                  p.method::text as method, p.failure_code
                from app.payments p
                where p.workspace_id = ${scope.workspaceId} and p.invoice_id = ${row.id}
                  and p.idempotency_key = ${idempotencyKey} and p.status <> 'requires_payment'
                limit 1`,
          );
          if (done)
            return {
              kind: 'repeat',
              repeat: {
                invoiceId: row.id,
                paymentId: done.id,
                status: done.status,
                amountCents: Number(done.amount_cents),
                method: done.method as PaymentMethodKind,
                failureCode: done.failure_code,
              } satisfies PayRepeat,
            };
          const settings = await loadMoneySettings(tx, scope.workspaceId);
          const account = await payableAccount(deps, tx, scope.workspaceId, row, settings);
          if (!account) throw cannotTakePayment();
          // Second phase: the intent must be one we prepared for **this** invoice. Holding the link proves
          // nothing about a payment id typed into the body, so its own row is what proves it.
          if (body.providerPaymentId) {
            const [started] = await rows<{
              amount_cents: number;
              method: string;
              idempotency_key: string | null;
            }>(
              tx,
              sql`select p.amount_cents::float8 as amount_cents, p.method::text as method,
                    p.idempotency_key
                  from app.payments p
                  where p.invoice_id = ${row.id}
                    and p.provider_payment_id = ${body.providerPaymentId}
                  limit 1`,
            );
            if (!started)
              throw HfosError.rule(
                'payment_not_started',
                409,
                'We couldn’t find that payment. Start it again from this page.',
              );
            return {
              kind: 'take',
              take: {
                invoice: row,
                account,
                amountCents: Number(started.amount_cents),
                method: started.method as PaymentMethodKind,
                idempotencyKey: started.idempotency_key ?? idempotencyKey,
              } satisfies PayContext,
            };
          }
          assertPayable(row);
          const owed = Number(row.balance_cents);
          const amountCents = Math.min(body.amountCents ?? owed, owed);
          if (amountCents < 1)
            throw HfosError.rule(
              'invoice_settled',
              409,
              'This invoice is already paid. Thank you!',
            );
          const method: PaymentMethodKind = account.methods.includes(body.method)
            ? body.method
            : account.methods[0]!;
          return {
            kind: 'take',
            take: {
              invoice: row,
              account,
              amountCents,
              method,
              // Written on the payment row before the provider is called: one press, one charge.
              idempotencyKey,
            } satisfies PayContext,
          };
        });
        if (plan.kind === 'repeat') {
          const r = plan.repeat;
          return {
            stage: 'recorded' as const,
            payment: {
              paymentId: r.paymentId,
              status: r.status,
              amountCents: r.amountCents,
              method: r.method,
              failureCode: r.failureCode,
              failureMessage: r.status === 'failed' ? declineWording(r.failureCode) : null,
              receivedAt: null,
              repeat: true,
            },
            invoice: await invoiceView(deps, scope, r.invoiceId),
          };
        }
        const ctx = plan.take;
        const provider = deps.payments.providers[ctx.account.session.provider]!;
        let account;
        try {
          account = accountFor(deps.sealer, ctx.account.connection);
        } catch (e) {
          return refused(e, scope, ctx.account.connection.id);
        }
        const returnUrl = `${await origin(scope)}/${MONEY_LINK_PATH.invoice}/${req.params.token}`;

        /**
         * Nothing to act on yet: hand the browser a session. Stripe's makes the intent it will confirm — so
         * the row and its idempotency key are written first, before anything is created at the provider —
         * while Square's makes nothing at all, because the browser tokenises the card before we charge it.
         */
        if (!body.sourceToken && !body.providerPaymentId) {
          const clientConfirm = ctx.account.session.flow === 'client_confirm';
          const started = clientConfirm
            ? await record(scope, ctx, { status: 'requires_payment' })
            : null;
          let session;
          try {
            session = await provider.prepare(account, {
              amountCents: ctx.amountCents,
              methods: ctx.account.methods,
              idempotencyKey: ctx.idempotencyKey,
              description: ctx.invoice.number ? `Invoice ${ctx.invoice.number}` : 'Invoice',
              customerRef: null,
              hold: false,
              metadata: metadataFor(scope, ctx.invoice),
              returnUrl,
            });
          } catch (e) {
            return refused(e, scope, ctx.account.connection.id);
          }
          if (clientConfirm && session.providerPaymentId)
            await record(scope, ctx, {
              status: 'requires_payment',
              providerPaymentId: session.providerPaymentId,
            });
          return {
            stage: 'prepared' as const,
            payment: {
              paymentId: started?.paymentId ?? null,
              status: 'requires_payment' as const,
              amountCents: ctx.amountCents,
              method: ctx.method,
              flow: session.flow,
              publishableKey: session.publishableKey,
              accountId: session.accountId,
              locationId: session.locationId,
              clientSecret: session.clientSecret,
              providerPaymentId: session.providerPaymentId,
              methods: session.methods,
              /** The stand-in's own page; null with the real providers, which run in the browser. */
              hostedUrl: session.hostedUrl,
              returnUrl,
            },
            invoice: await invoiceView(deps, scope, ctx.invoice.id),
          };
        }

        let result: PaymentResult;
        try {
          result = body.providerPaymentId
            ? // Read the intent back from the provider: the answer is theirs, not the page's.
              await provider.confirmFromClient(account, body.providerPaymentId)
            : await (async () => {
                // The row is written before the card is charged: one press, one charge.
                await record(scope, ctx, { status: 'requires_payment' });
                return provider.charge(account, {
                  amountCents: ctx.amountCents,
                  method: ctx.method,
                  sourceToken: body.sourceToken,
                  idempotencyKey: ctx.idempotencyKey,
                  description: ctx.invoice.number ? `Invoice ${ctx.invoice.number}` : 'Invoice',
                  customerRef: null,
                  metadata: metadataFor(scope, ctx.invoice),
                });
              })();
        } catch (e) {
          if (e instanceof HfosError) throw e;
          return refused(e, scope, ctx.account.connection.id);
        }
        const settled = await record(scope, ctx, {
          status: result.status,
          providerPaymentId: result.providerPaymentId,
          providerStatus: result.providerStatus,
          failureCode: result.failureCode,
          feeCents: result.feeCents,
          netCents: result.netCents,
          receivedAt: result.receivedAt,
          cardBrand: result.cardBrand,
          cardLast4: result.cardLast4,
        });
        return {
          stage: 'recorded' as const,
          // A decline is an answer, not an error: 200, with words the customer can do something about.
          payment: paymentOut(result, settled.paymentId, ctx),
          invoice: await invoiceView(deps, scope, ctx.invoice.id),
        };
      },
    );
  });

  // ---------- the providers' webhooks ----------
  await app.register(async (hooks) => {
    // The raw body is what is signed: JSON stays the exact string that arrived.
    hooks.removeContentTypeParser(['application/json']);
    hooks.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: WEBHOOK_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );

    for (const name of ['stripe', 'square'] as const)
      hooks.post(`/webhooks/${name}`, { bodyLimit: WEBHOOK_MAX_BYTES }, async (req, reply) => {
        const provider = deps.payments.providers[name];
        const rawBody = typeof req.body === 'string' ? req.body : '';
        const url = `${deps.publicUrl}${req.url}`;
        const headers: Record<string, string | undefined> = {
          'stripe-signature': header(req, 'stripe-signature'),
          'x-square-hmacsha256-signature': header(req, 'x-square-hmacsha256-signature'),
        };
        // Not a forgery: with no secret to check against nothing can pass, and the log and the provider's own
        // delivery page say which setting is missing. "Invalid signature" hid that from Stripe for nine days.
        if (provider?.configured && !provider.webhooks.configured) {
          deps.log.error(
            { provider: name },
            `refused a payment webhook: ${WEBHOOK_SECRET_SETTING[name]} is not set on the worker`,
          );
          return reply
            .code(403)
            .type('text/plain; charset=utf-8')
            .send(
              `This server doesn’t have the signing secret for ${PAYMENT_NAME[name]}’s events yet.`,
            );
        }
        // The provider's own scheme, over the exact bytes and the URL they were signed against.
        if (!provider?.configured || !provider.webhooks.verify({ rawBody, headers, url })) {
          deps.log.warn({ provider: name }, 'rejected an unsigned or mis-signed payment webhook');
          return reply.code(403).type('text/plain').send('Invalid signature');
        }
        const event = provider.webhooks.parse(rawBody);
        if (!event) return reply.code(400).send({ received: false });
        const kind = paymentKindOf(name, event);
        // Something we don't act on: taken, and dropped. A provider retries anything else for days.
        if (!kind) {
          deps.log.debug({ provider: name, type: event.type }, 'a payment webhook we ignore');
          return reply.code(200).send({ received: true, ignored: true });
        }
        // Routed by the account it happened in, whether or not that account is still connected: a bank
        // transfer settles days after a business disconnects, and it still has to reach its invoice.
        const [route] = event.accountRef
          ? await asWorker(deps.httpDb, {}, (tx) =>
              rows<{ workspace_id: string; organization_id: string }>(
                tx,
                sql`select workspace_id, organization_id
                    from private.payment_connection_by_account(${name}, ${event.accountRef})
                    limit 1`,
              ),
            )
          : [];
        // A partner's own Stripe account, not a business's (the partners plan's stage 3): its changes are kept
        // for their payouts (partners/payouts.ts).
        const partner =
          !route && name === 'stripe' && kind === 'account.updated' && event.accountRef
            ? (
                await asWorker(deps.httpDb, {}, (tx) =>
                  rows<{ workspace_id: string; organization_id: string }>(
                    tx,
                    sql`select workspace_id, organization_id
                        from private.partner_payout_account_by_ref(${event.accountRef})`,
                  ),
                )
              )[0]
            : undefined;
        if (!route && !partner) {
          deps.log.info(
            { provider: name, type: event.type, accountRef: event.accountRef },
            'a payment webhook for an account nobody here has connected',
          );
          return reply.code(200).send({ received: true, ignored: true });
        }
        const to = (route ?? partner)!;
        await recordDelivery(deps, {
          provider: name,
          kind: route ? kind : PARTNER_PAYOUT_ACCOUNT_KIND,
          // The provider's own event id: a replay is stored once and handled once.
          dedupeKey: event.id,
          accountRef: event.accountRef,
          url,
          // The exact bytes are kept, not a re-serialised object: the processor reads them back with the
          // provider's own parser, so there is one place that knows what an event looks like.
          params: {
            id: event.id,
            type: event.type,
            accountRef: event.accountRef ?? '',
            createdAt: event.createdAt ?? '',
            body: rawBody,
          },
          workspaceId: to.workspace_id,
          organizationId: to.organization_id,
        });
        return reply.code(200).send({ received: true });
      });
  });
}
