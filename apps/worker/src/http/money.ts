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
  ACCEPTANCE_WORDING,
  APPROVE_LABEL,
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
  invoiceState,
  linesFor,
  linesOut,
  loadMoneySettings,
  moneyIso,
  PAY_LABEL,
  TYPED_NAME_LABEL,
  type EstimateRow,
  type InvoiceRow,
  type MoneySettings,
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
import { paymentKindOf, WEBHOOK_MAX_BYTES } from '../money/webhook-events';
import { accountFor, paymentConnectionUsable, type PaymentConnectionRow } from '../payments/index';
import {
  declineWording,
  isPaymentProvider,
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
  HfosError.notFound('This link doesn’t work. Check that it matches the one we sent you.');

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
    'We can’t take a payment on this invoice right now. Please call us and we’ll sort it out.',
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
    throw HfosError.validation([], 'Please check the form and try again.');
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

/** The business behind the document: what a customer needs to recognise it and reach a person. */
async function businessOf(tx: Tx, workspaceId: string): Promise<PublicBusiness> {
  const [w] = await tx
    .select({ name: workspaces.name })
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
  };
}

const customerOf = (r: { first_name: string | null; last_name: string | null }) =>
  [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || 'Customer';

const totalsOf = (r: EstimateRow | InvoiceRow) => ({
  subtotalCents: Number(r.subtotal_cents),
  discountCents: Number(r.discount_cents),
  taxableBaseCents: Number(r.taxable_base_cents),
  taxCents: Number(r.tax_cents),
  taxRateBp: r.tax_rate_bp,
  taxLabel: r.tax_label,
  totalCents: Number(r.total_cents),
  currency: r.currency,
});

const deposit = (r: EstimateRow): number => {
  const total = Number(r.total_cents);
  if (r.deposit_cents !== null) return Math.min(Number(r.deposit_cents), total);
  if (r.deposit_percent_bp === null) return 0;
  return Math.min(Math.round((total * r.deposit_percent_bp) / 10_000), total);
};

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
    return {
      state: state as string,
      business: await businessOf(tx, scope.workspaceId),
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
        /** The exact words that must sit above Approve: what the acceptance is recorded with. */
        wording: ACCEPTANCE_WORDING,
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
  amountCents: number;
  method: string;
  status: string;
  receivedAt: string | null;
  createdAt: string;
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
    const state = invoiceState(
      {
        status: row.status,
        dueDate: row.due_on,
        timeZone: tz,
        balanceCents: Number(row.balance_cents),
        viewedAt: moneyIso(row.first_viewed_at),
        hasProcessingPayment: row.settling,
      },
      Date.now(),
    );
    // Only what the customer's own receipt needs: never a fee, a provider id or who recorded it.
    const paid = await rows<PublicPayment>(
      tx,
      sql`select p.amount_cents::float8 as "amountCents", p.method::text as method,
            p.status::text as status, p.received_at as "receivedAt", p.created_at as "createdAt"
          from app.payments p
          where p.invoice_id = ${row.id} and p.status in ('processing', 'succeeded')
          order by p.created_at, p.id`,
    );
    const owed = Number(row.balance_cents);
    const account =
      row.status === 'void' || owed <= 0
        ? null
        : await payableAccount(deps, tx, scope.workspaceId, row, settings);
    return {
      state: state as string,
      business: await businessOf(tx, scope.workspaceId),
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
        lines: linesOut(lines, Number(row.discount_cents)),
        totals: totalsOf(row),
        dueOn: row.due_on,
        terms: row.terms,
        sentAt: moneyIso(row.sent_at),
        paidAt: moneyIso(row.paid_at),
        amountPaidCents: Number(row.amount_paid_cents),
        amountRefundedCents: Number(row.amount_refunded_cents),
        balanceCents: owed,
      },
      payments: paid.map((p) => ({
        ...p,
        amountCents: Number(p.amountCents),
        receivedAt: moneyIso(p.receivedAt),
        createdAt: moneyIso(p.createdAt)!,
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
    throw HfosError.rule('invoice_voided', 409, 'This invoice was withdrawn. Please call us.');
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

  /** Checks one of the customer's links: 404 when it isn't one, 410 when a newer one replaced it. */
  async function linked(kind: MoneyDocumentKind, token: string) {
    const r: MoneyTokenResult = await resolveDocumentToken(deps.httpDb, links, kind, token);
    if (r.status === 'invalid') throw linkNotFound();
    if (r.status === 'stale') {
      const business = await asWorker(deps.httpDb, r.scope, (tx) =>
        businessOf(tx, r.scope.workspaceId),
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
        // The wording is ours, not the page's: what is recorded is what the customer had to have read.
        const { output } = await executeCommand(
          deps.httpDb,
          estimateAcceptOnline,
          {
            workspaceId: e.scope.workspaceId,
            estimateId: e.documentId,
            name: body.name,
            wording: ACCEPTANCE_WORDING,
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
        const returnUrl = `${links.webUrl}/${MONEY_LINK_PATH.invoice}/${req.params.token}`;

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
        if (!route) {
          deps.log.info(
            { provider: name, type: event.type, accountRef: event.accountRef },
            'a payment webhook for an account nobody here has connected',
          );
          return reply.code(200).send({ received: true, ignored: true });
        }
        await recordDelivery(deps, {
          provider: name,
          kind,
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
          workspaceId: route.workspace_id,
          organizationId: route.organization_id,
        });
        return reply.code(200).send({ received: true });
      });
  });
}
