/**
 * The server-side money internals the commands and the queries share: loading a document and its lines, working
 * its totals out with the pure core, allocating a number from `app.document_counters`, the hash an acceptance is
 * kept with, and turning a row into what the API returns.
 *
 * The arithmetic itself is `../money/` (pure and browser-safe) — nothing here re-derives a total. What is here
 * is everything that needs a transaction.
 *
 * Three rules this file keeps for every caller:
 * - **A sent document is frozen.** The database guard says so too; these helpers refuse first, in plain words.
 * - **Nobody writes what an invoice has been paid.** `amount_paid_cents`, `amount_refunded_cents`, `paid_at` and
 *   the paid and partly-paid statuses are recounted by `private.money_roll_up_invoice()` whenever a payment or a
 *   refund lands. Commands here write payments; the invoice follows on its own. A refund is counted but never
 *   reopens it (0053): paid stays paid.
 * - **A number comes from the counter row, inside the send transaction.** `update … set next_number =
 *   next_number + 1 … returning` locks that business's counter for a few milliseconds, so two people sending at
 *   once can never land on the same number.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { estimateLines, invoiceLines } from '@hfos/db/schema';
import { uuidArray } from '../calendar/load';
import { addDays, localDateOf, startOfLocalDay } from '../calendar/engine/zoned';
import { HfosError } from '../errors';
import { scopeCan } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import {
  allocateDiscount,
  computeTotals,
  estimateState,
  formatDocumentNumber,
  invoiceState,
  lineAmountCents,
  lineSubtotalCents,
  moneySettingsOf,
  overdueFrom,
  type DepositTerms,
  type DocumentDiscount,
  type DocumentNumbering,
  type DocumentTotals,
  type EstimateStatus,
  type InvoiceState,
  type InvoiceStatus,
  type MoneySettings,
} from '../money/index';
import type { MoneyLineInput, MoneyTerms } from '../schemas/money';

export const DOCUMENT_COUNTER_KINDS = ['estimate', 'invoice'] as const;
export type DocumentKind = (typeof DOCUMENT_COUNTER_KINDS)[number];

const num = (v: number | string | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);
/**
 * A timestamp as the driver hands it back: a Date through Drizzle, a string from a raw query. `calendar/load`
 * already exports an `iso` of its own, so money's is named for what it is.
 */
export const moneyIso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;
/** The same, for a column that is never null. */
export const isoAt = (d: Date | string): string => new Date(d).toISOString();

// ---------- settings ----------

/** The business's money settings, every default filled in. */
export async function loadMoneySettings(tx: Tx, workspaceId: string): Promise<MoneySettings> {
  const [w] = await rows<{ settings: Record<string, unknown> | null }>(
    tx,
    sql`select settings from app.workspaces where id = ${workspaceId}`,
  );
  return moneySettingsOf(w?.settings ?? null);
}

/** The counters as they stand, which is what the next number really is (settings are the editable view). */
export async function countersOf(
  tx: Tx,
  workspaceId: string,
): Promise<Map<DocumentKind, DocumentNumbering>> {
  const list = await rows<{ kind: string; next_number: number; prefix: string; pad: number }>(
    tx,
    sql`select kind, next_number::float8 as next_number, prefix, pad
        from app.document_counters where workspace_id = ${workspaceId}`,
  );
  const out = new Map<DocumentKind, DocumentNumbering>();
  for (const r of list)
    if (r.kind === 'estimate' || r.kind === 'invoice')
      out.set(r.kind, { prefix: r.prefix, next: Number(r.next_number), pad: r.pad });
  return out;
}

/**
 * Takes the next number for this business and kind, inside the caller's transaction. The row is created from the
 * business's settings the first time, then locked and incremented; the number returned is the one this document
 * keeps for life, void or not.
 */
export async function allocateDocumentNumber(
  tx: Tx,
  workspaceId: string,
  kind: DocumentKind,
  settings: MoneySettings,
): Promise<{ number: string; counter: number }> {
  const start = settings.numbering[kind];
  await rows(
    tx,
    sql`insert into app.document_counters (workspace_id, kind, next_number, prefix, pad)
        values (${workspaceId}, ${kind}, ${start.next}, ${start.prefix}, ${start.pad})
        on conflict (workspace_id, kind) do nothing`,
  );
  const [row] = await rows<{ counter: number; prefix: string; pad: number }>(
    tx,
    sql`update app.document_counters set next_number = next_number + 1
        where workspace_id = ${workspaceId} and kind = ${kind}
        returning (next_number - 1)::float8 as counter, prefix, pad`,
  );
  if (!row) throw HfosError.internal();
  const counter = Number(row.counter);
  return { number: formatDocumentNumber(row.prefix, counter, row.pad), counter };
}

// ---------- totals ----------

/** A schema's terms object as the pure core's, with the figure the other kind left behind dropped. */
export function termsOf(t: MoneyTerms | undefined): DocumentDiscount & DepositTerms {
  if (!t || t.kind === 'none') return { kind: 'none' };
  return t.kind === 'percent'
    ? { kind: 'percent', percentBp: t.percentBp ?? 0 }
    : { kind: 'amount', amountCents: t.amountCents ?? 0 };
}

export interface DocumentDraft {
  readonly lines: readonly MoneyLineInput[];
  readonly totals: DocumentTotals;
  readonly discount: DocumentDiscount;
  readonly deposit: DepositTerms;
  readonly taxRateBp: number;
  readonly taxLabel: string;
}

/**
 * Everything a document's figures come to, from its lines and the business's tax rate. The rate and its name are
 * snapshotted onto the document, so a rate change next year never rewrites what a customer was shown.
 */
export function draftOf(
  lines: readonly MoneyLineInput[],
  settings: MoneySettings,
  opts: { discount?: MoneyTerms; deposit?: MoneyTerms; taxRateBp?: number; taxLabel?: string } = {},
): DocumentDraft {
  const discount = termsOf(opts.discount);
  const deposit = termsOf(opts.deposit);
  const taxRateBp = opts.taxRateBp ?? settings.tax.rateBp;
  const totals = computeTotals({
    lines: lines.map((l) => ({
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      discountCents: l.discountCents,
      taxable: l.taxable,
    })),
    discount,
    taxRateBp,
    deposit,
  });
  return {
    lines,
    totals,
    discount,
    deposit,
    taxRateBp,
    taxLabel: opts.taxLabel ?? settings.tax.name,
  };
}

/** The totals block as the two document tables store it. */
export function totalsColumns(d: DocumentDraft) {
  return {
    subtotalCents: d.totals.subtotalCents,
    discountCents: d.totals.discountCents,
    discountPercentBp: d.discount.kind === 'percent' ? (d.discount.percentBp ?? 0) : null,
    taxableBaseCents: d.totals.taxableBaseCents,
    taxCents: d.totals.taxCents,
    totalCents: d.totals.totalCents,
    taxRateBp: d.taxRateBp,
    taxLabel: d.taxLabel,
  };
}

/** What a deposit comes to on a document's total. */
export function depositColumns(d: DocumentDraft) {
  return {
    depositPercentBp: d.deposit.kind === 'percent' ? (d.deposit.percentBp ?? 0) : null,
    depositCents: d.deposit.kind === 'amount' ? (d.deposit.amountCents ?? 0) : null,
  };
}

/**
 * Writes a document's lines, wholesale: the old ones go and the new ones land in order. `discount_cents` is the
 * line's own discount as it was written, so the editor gets back exactly what it sent; its share of the document
 * discount is worked out again as the document is read (the totals are stored on the document itself).
 */
export async function writeLines(
  ctx: CommandContext,
  kind: DocumentKind,
  documentId: string,
  lines: readonly MoneyLineInput[],
): Promise<void> {
  const ws = ctx.scope.workspaceId!;
  if (kind === 'estimate')
    await ctx.tx.delete(estimateLines).where(eq(estimateLines.estimateId, documentId));
  else await ctx.tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, documentId));
  if (!lines.length) return;
  const values = lines.map((l, i) => ({
    workspaceId: ws,
    position: i,
    productId: l.productId ?? null,
    name: l.name,
    description: l.description ?? null,
    quantity: String(l.quantity),
    unitLabel: l.unitLabel,
    unitPriceCents: l.unitPriceCents,
    taxable: l.taxable,
    discountCents: Math.max(0, Math.round(l.discountCents)),
    amountCents: lineAmountCents(l.quantity, l.unitPriceCents),
  }));
  if (kind === 'estimate')
    await ctx.tx
      .insert(estimateLines)
      .values(values.map((v) => ({ ...v, estimateId: documentId })));
  else
    await ctx.tx.insert(invoiceLines).values(values.map((v) => ({ ...v, invoiceId: documentId })));
}

// ---------- the acceptance hash ----------

/**
 * A hash of exactly what was accepted: every line as it stood, and the totals. Kept with the acceptance, so a
 * business can show a year later that the document has not moved since the customer said yes.
 */
export function documentHash(
  lines: readonly {
    name: string;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    taxable: boolean;
  }[],
  totals: { subtotalCents: number; discountCents: number; taxCents: number; totalCents: number },
): string {
  const canonical = JSON.stringify({
    lines: lines.map((l) => [
      l.name,
      Math.round(l.quantity * 1000),
      l.unitPriceCents,
      l.discountCents,
      l.taxable,
    ]),
    totals: [totals.subtotalCents, totals.discountCents, totals.taxCents, totals.totalCents],
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------- reading ----------

/**
 * The revision an editor sends back so a save over someone else's is refused. There is no revision column: a
 * document's `updated_at` in milliseconds is one, and every save writes the header row, so it always moves.
 */
const ESTIMATE_REVISION = sql`(extract(epoch from e.updated_at) * 1000)::float8 as revision`;
const INVOICE_REVISION = sql`(extract(epoch from i.updated_at) * 1000)::float8 as revision`;

const PERSON_COLUMNS = sql`pe.id as person_id, pe.first_name, pe.last_name, pe.email::text as person_email,
  pe.phone as person_phone`;

export type MoneyLineRow = {
  id: string;
  document_id: string;
  position: number;
  product_id: string | null;
  name: string;
  description: string | null;
  quantity: string;
  unit_label: string;
  unit_price_cents: number;
  taxable: boolean;
  discount_cents: number;
  amount_cents: number;
};

export type EstimateRow = {
  id: string;
  public_ref: string;
  link_version: number;
  number: string | null;
  status: EstimateStatus;
  title: string | null;
  notes: string | null;
  lead_id: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  person_id: string;
  first_name: string | null;
  last_name: string | null;
  person_email: string | null;
  person_phone: string | null;
  subtotal_cents: number;
  discount_cents: number;
  discount_percent_bp: number | null;
  taxable_base_cents: number;
  tax_cents: number;
  total_cents: number;
  tax_rate_bp: number;
  tax_label: string | null;
  currency: string;
  deposit_percent_bp: number | null;
  deposit_cents: number | null;
  expires_on: string | null;
  sent_at: Date | string | null;
  first_viewed_at: Date | string | null;
  accepted_at: Date | string | null;
  accepted_via: string | null;
  accepted_by: string | null;
  accepted_by_name: string | null;
  accepted_name: string | null;
  accepted_wording: string | null;
  declined_at: Date | string | null;
  declined_reason: string | null;
  voided_at: Date | string | null;
  void_reason: string | null;
  created_at: Date | string;
  revision: number;
};

export type InvoiceRow = {
  id: string;
  public_ref: string;
  link_version: number;
  number: string | null;
  status: InvoiceStatus;
  purpose: string;
  origin: string;
  title: string | null;
  notes: string | null;
  lead_id: string | null;
  attendee_id: string | null;
  estimate_id: string | null;
  subscription_id: string | null;
  connection_id: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  person_id: string;
  first_name: string | null;
  last_name: string | null;
  person_email: string | null;
  person_phone: string | null;
  subtotal_cents: number;
  discount_cents: number;
  discount_percent_bp: number | null;
  taxable_base_cents: number;
  tax_cents: number;
  total_cents: number;
  tax_rate_bp: number;
  tax_label: string | null;
  currency: string;
  amount_paid_cents: number;
  amount_refunded_cents: number;
  balance_cents: number;
  due_on: string | null;
  terms: string | null;
  sent_at: Date | string | null;
  first_viewed_at: Date | string | null;
  paid_at: Date | string | null;
  voided_at: Date | string | null;
  void_reason: string | null;
  settling: boolean;
  created_at: Date | string;
  revision: number;
};

export type PaymentRow = {
  id: string;
  invoice_id: string;
  amount_cents: number;
  method: string;
  provider: string | null;
  connection_id: string | null;
  status: string;
  provider_status: string | null;
  failure_code: string | null;
  fee_cents: number | null;
  net_cents: number | null;
  received_at: Date | string | null;
  recorded_by: string | null;
  recorded_by_name: string | null;
  refunded_cents: number;
  card_brand: string | null;
  card_last4: string | null;
  created_at: Date | string;
};

export type RefundRow = {
  id: string;
  payment_id: string;
  invoice_id: string;
  amount_cents: number;
  reason: string | null;
  status: string;
  failure_code: string | null;
  refunded_at: Date | string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  created_at: Date | string;
};

export type SubscriptionRow = {
  id: string;
  public_ref: string;
  status: string;
  plan_id: string | null;
  plan_name: string;
  price_cents: number;
  interval: string;
  interval_count: number;
  taxable: boolean;
  includes: unknown;
  person_id: string;
  first_name: string | null;
  last_name: string | null;
  person_email: string | null;
  person_phone: string | null;
  lead_id: string | null;
  connection_id: string | null;
  provider: string | null;
  external_subscription_id: string | null;
  has_card: boolean;
  card_brand: string | null;
  card_last4: string | null;
  card_expiry_month: number | null;
  card_expiry_year: number | null;
  card_requested_at: Date | string | null;
  started_on: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  next_billing_on: string | null;
  paused_at: Date | string | null;
  cancelled_at: Date | string | null;
  cancel_reason: string | null;
  ended_on: string | null;
  failed_cycles: number;
  last_error: string | null;
  created_at: Date | string;
};

/** Everything an estimate row needs, ready for a `where` of the caller's own. */
export const estimateSelect = sql`
  select e.id, e.public_ref, e.link_version, e.number, e.status::text as status, e.title, e.notes,
    e.lead_id, e.assignee_user_id, coalesce(nullif(au.full_name, ''), au.email::text) as assignee_name,
    ${PERSON_COLUMNS},
    e.subtotal_cents::float8 as subtotal_cents, e.discount_cents::float8 as discount_cents,
    e.discount_percent_bp, e.taxable_base_cents::float8 as taxable_base_cents,
    e.tax_cents::float8 as tax_cents, e.total_cents::float8 as total_cents, e.tax_rate_bp, e.tax_label,
    e.currency::text as currency, e.deposit_percent_bp, e.deposit_cents::float8 as deposit_cents,
    e.expires_on::text as expires_on, e.sent_at, e.first_viewed_at, e.accepted_at, e.accepted_via,
    e.accepted_by, coalesce(nullif(cu.full_name, ''), cu.email::text) as accepted_by_name,
    e.accepted_name, e.accepted_wording, e.declined_at, e.declined_reason, e.voided_at, e.void_reason,
    e.created_at, ${ESTIMATE_REVISION}
  from app.estimates e
  left join app.people pe on pe.id = e.person_id
  left join app.users au on au.id = e.assignee_user_id
  left join app.users cu on cu.id = e.accepted_by`;

/** The same for an invoice, with whether a payment is on its way (never overdue while one is). */
export const invoiceSelect = sql`
  select i.id, i.public_ref, i.link_version, i.number, i.status::text as status,
    i.purpose::text as purpose, i.origin::text as origin, i.title, i.notes, i.lead_id, i.attendee_id,
    i.estimate_id, i.subscription_id, i.connection_id, i.assignee_user_id,
    coalesce(nullif(au.full_name, ''), au.email::text) as assignee_name,
    ${PERSON_COLUMNS},
    i.subtotal_cents::float8 as subtotal_cents, i.discount_cents::float8 as discount_cents,
    i.discount_percent_bp, i.taxable_base_cents::float8 as taxable_base_cents,
    i.tax_cents::float8 as tax_cents, i.total_cents::float8 as total_cents, i.tax_rate_bp, i.tax_label,
    i.currency::text as currency, i.amount_paid_cents::float8 as amount_paid_cents,
    i.amount_refunded_cents::float8 as amount_refunded_cents, i.balance_cents::float8 as balance_cents,
    i.due_on::text as due_on, i.terms, i.sent_at, i.first_viewed_at, i.paid_at, i.voided_at,
    i.void_reason,
    exists (select 1 from app.payments p where p.invoice_id = i.id and p.status = 'processing') as settling,
    i.created_at, ${INVOICE_REVISION}
  from app.invoices i
  left join app.people pe on pe.id = i.person_id
  left join app.users au on au.id = i.assignee_user_id`;

export const subscriptionSelect = sql`
  select s.id, s.public_ref, s.status::text as status, s.plan_id, s.plan_name,
    s.price_cents::float8 as price_cents, s.interval::text as interval, s.interval_count, s.taxable,
    s.includes, ${PERSON_COLUMNS}, s.lead_id, s.connection_id, s.provider::text as provider,
    s.external_subscription_id, (s.method_token is not null) as has_card, s.card_brand, s.card_last4,
    s.card_expiry_month, s.card_expiry_year, s.card_requested_at,
    s.started_on::text as started_on, s.current_period_start::text as current_period_start,
    s.current_period_end::text as current_period_end, s.next_billing_on::text as next_billing_on,
    s.paused_at, s.cancelled_at, s.cancel_reason, s.ended_on::text as ended_on, s.failed_cycles,
    s.last_error, s.created_at
  from app.subscriptions s
  left join app.people pe on pe.id = s.person_id`;

/** A document's lines, in order, by document id. */
export async function linesFor(
  tx: Tx,
  kind: DocumentKind,
  documentIds: readonly string[],
): Promise<Map<string, MoneyLineRow[]>> {
  const out = new Map<string, MoneyLineRow[]>();
  if (!documentIds.length) return out;
  const table = kind === 'estimate' ? sql`app.estimate_lines` : sql`app.invoice_lines`;
  const parent = kind === 'estimate' ? sql`estimate_id` : sql`invoice_id`;
  const list = await rows<MoneyLineRow>(
    tx,
    sql`select l.id, l.${parent} as document_id, l.position, l.product_id, l.name, l.description,
          l.quantity::text as quantity, l.unit_label, l.unit_price_cents::float8 as unit_price_cents,
          l.taxable, l.discount_cents::float8 as discount_cents, l.amount_cents::float8 as amount_cents
        from ${table} l
        where l.${parent} = any(${uuidArray(documentIds)})
        order by l.position, l.id`,
  );
  for (const r of list) {
    const bucket = out.get(r.document_id) ?? [];
    bucket.push(r);
    out.set(r.document_id, bucket);
  }
  return out;
}

export async function paymentsFor(
  tx: Tx,
  workspaceId: string,
  invoiceIds: readonly string[],
): Promise<PaymentRow[]> {
  if (!invoiceIds.length) return [];
  return rows<PaymentRow>(
    tx,
    sql`select p.id, p.invoice_id, p.amount_cents::float8 as amount_cents, p.method::text as method,
          p.provider::text as provider, p.connection_id, p.status::text as status, p.provider_status,
          p.failure_code, p.fee_cents::float8 as fee_cents, p.net_cents::float8 as net_cents,
          p.received_at, p.recorded_by, coalesce(nullif(u.full_name, ''), u.email::text) as recorded_by_name,
          coalesce((select sum(r.amount_cents) from app.refunds r
            where r.payment_id = p.id and r.status = 'succeeded'), 0)::float8 as refunded_cents,
          p.card_brand, p.card_last4, p.created_at
        from app.payments p
        left join app.users u on u.id = p.recorded_by
        where p.workspace_id = ${workspaceId}
          and p.invoice_id = any(${uuidArray(invoiceIds)})
        order by p.created_at desc, p.id desc`,
  );
}

export async function refundsFor(
  tx: Tx,
  workspaceId: string,
  invoiceIds: readonly string[],
): Promise<RefundRow[]> {
  if (!invoiceIds.length) return [];
  return rows<RefundRow>(
    tx,
    sql`select r.id, r.payment_id, r.invoice_id, r.amount_cents::float8 as amount_cents, r.reason,
          r.status::text as status, r.failure_code, r.refunded_at, r.requested_by,
          coalesce(nullif(u.full_name, ''), u.email::text) as requested_by_name, r.created_at
        from app.refunds r
        left join app.users u on u.id = r.requested_by
        where r.workspace_id = ${workspaceId}
          and r.invoice_id = any(${uuidArray(invoiceIds)})
        order by r.created_at desc, r.id desc`,
  );
}

// ---------- rows out ----------

const personOf = (r: {
  person_id: string;
  first_name: string | null;
  last_name: string | null;
  person_email: string | null;
  person_phone: string | null;
}) => ({
  id: r.person_id,
  fullName: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Someone',
  email: r.person_email,
  phone: r.person_phone,
});

const userOf = (id: string | null, name: string | null) =>
  id ? { id, fullName: name || 'Someone' } : null;

const totalsOf = (r: {
  subtotal_cents: number;
  discount_cents: number;
  discount_percent_bp: number | null;
  taxable_base_cents: number;
  tax_cents: number;
  total_cents: number;
  tax_rate_bp: number;
  tax_label: string | null;
  currency: string;
}) => ({
  subtotalCents: num(r.subtotal_cents),
  discountCents: num(r.discount_cents),
  discountPercentBp: r.discount_percent_bp,
  taxableBaseCents: num(r.taxable_base_cents),
  taxCents: num(r.tax_cents),
  taxRateBp: r.tax_rate_bp,
  taxLabel: r.tax_label,
  totalCents: num(r.total_cents),
  currency: r.currency,
});

/** The moment an estimate stops being good: the end of its last day where the business is. */
export const expiresAtOf = (expiresOn: string | null, timeZone: string): string | null =>
  expiresOn ? new Date(overdueFrom(expiresOn, timeZone)).toISOString() : null;

export function estimateOut(r: EstimateRow, now: number, timeZone: string) {
  const expiresAt = expiresAtOf(r.expires_on, timeZone);
  return {
    id: r.id,
    publicRef: r.public_ref,
    number: r.number,
    status: r.status,
    state: estimateState(
      { status: r.status, expiresAt, viewedAt: moneyIso(r.first_viewed_at) },
      now,
    ) as string,
    title: r.title,
    person: personOf(r),
    leadId: r.lead_id,
    assignee: userOf(r.assignee_user_id, r.assignee_name),
    totals: totalsOf(r),
    deposit: depositTermsOf(r),
    depositCents: depositOf(r),
    expiresOn: r.expires_on,
    sentAt: moneyIso(r.sent_at),
    firstViewedAt: moneyIso(r.first_viewed_at),
    acceptedAt: moneyIso(r.accepted_at),
    declinedAt: moneyIso(r.declined_at),
    voidedAt: moneyIso(r.voided_at),
    createdAt: isoAt(r.created_at),
  };
}

/**
 * The deposit as it was written: a share of the total, or an amount. The two columns are exclusive (0045's
 * check), so which one is set is the whole answer — a reader never has to work it back out of the figure, and
 * "25%" stays 25% across a reload even when the total moves.
 */
export function depositTermsOf(r: {
  deposit_percent_bp: number | null;
  deposit_cents: number | null;
}): { kind: 'none' | 'percent' | 'amount'; percentBp: number; amountCents: number } {
  if (r.deposit_percent_bp !== null)
    return { kind: 'percent', percentBp: r.deposit_percent_bp, amountCents: 0 };
  if (r.deposit_cents !== null)
    return { kind: 'amount', percentBp: 0, amountCents: num(r.deposit_cents) };
  return { kind: 'none', percentBp: 0, amountCents: 0 };
}

/** What the estimate asks for up front, as cents on its own total. */
export function depositOf(r: {
  deposit_percent_bp: number | null;
  deposit_cents: number | null;
  total_cents: number;
}): number {
  if (r.deposit_cents !== null) return Math.min(num(r.deposit_cents), num(r.total_cents));
  if (r.deposit_percent_bp === null) return 0;
  return Math.min(
    Math.round((num(r.total_cents) * r.deposit_percent_bp) / 10_000),
    num(r.total_cents),
  );
}

/**
 * Everything `invoiceStateOf` reads, for a query that lists invoices without the whole `invoiceSelect` (the
 * estimate's "invoices from this", a plan's cycles): the stored status, the due day, whether they opened it,
 * the money on it and whether a payment is on its way. Aliased on `app.invoices i`.
 */
export const invoiceStateColumns = sql`i.status::text as status, i.due_on::text as due_on,
  i.first_viewed_at, i.total_cents::float8 as total_cents, i.amount_paid_cents::float8 as amount_paid_cents,
  i.amount_refunded_cents::float8 as amount_refunded_cents, i.balance_cents::float8 as balance_cents,
  exists (select 1 from app.payments p where p.invoice_id = i.id and p.status = 'processing') as settling`;

export type InvoiceStateRow = Pick<
  InvoiceRow,
  | 'status'
  | 'due_on'
  | 'first_viewed_at'
  | 'total_cents'
  | 'amount_paid_cents'
  | 'amount_refunded_cents'
  | 'balance_cents'
  | 'settling'
>;

/**
 * What an invoice is called on screen, from its row — opened, paying, overdue, refunded — so every list that
 * shows one says the same word as the invoice's own page. The stored status alone would call a refunded
 * invoice "Paid".
 */
export function invoiceStateOf(r: InvoiceStateRow, now: number, timeZone: string): InvoiceState {
  return invoiceState(
    {
      status: r.status,
      dueDate: r.due_on,
      timeZone,
      balanceCents: num(r.balance_cents),
      viewedAt: moneyIso(r.first_viewed_at),
      hasProcessingPayment: r.settling,
      totalCents: num(r.total_cents),
      paidCents: num(r.amount_paid_cents),
      refundedCents: num(r.amount_refunded_cents),
    },
    now,
  );
}

export function invoiceOut(r: InvoiceRow, now: number, timeZone: string) {
  return {
    id: r.id,
    publicRef: r.public_ref,
    number: r.number,
    status: r.status,
    state: invoiceStateOf(r, now, timeZone) as string,
    purpose: r.purpose as never,
    origin: r.origin as never,
    title: r.title,
    person: personOf(r),
    leadId: r.lead_id,
    attendeeId: r.attendee_id,
    estimateId: r.estimate_id,
    subscriptionId: r.subscription_id,
    connectionId: r.connection_id,
    assignee: userOf(r.assignee_user_id, r.assignee_name),
    totals: totalsOf(r),
    amountPaidCents: num(r.amount_paid_cents),
    amountRefundedCents: num(r.amount_refunded_cents),
    balanceCents: num(r.balance_cents),
    dueOn: r.due_on,
    terms: r.terms,
    sentAt: moneyIso(r.sent_at),
    firstViewedAt: moneyIso(r.first_viewed_at),
    paidAt: moneyIso(r.paid_at),
    voidedAt: moneyIso(r.voided_at),
    createdAt: isoAt(r.created_at),
  };
}

/**
 * The lines as the API returns them: what was written, plus each line's share of the document discount, worked
 * out again here rather than stored, so what the editor sends is what it gets back.
 */
export function linesOut(lines: readonly MoneyLineRow[], documentDiscountCents: number) {
  const subtotals = lines.map((l) =>
    lineSubtotalCents({
      quantity: Number(l.quantity),
      unitPriceCents: num(l.unit_price_cents),
      discountCents: num(l.discount_cents),
    }),
  );
  const shares = allocateDiscount(subtotals, documentDiscountCents);
  return lines.map((l, i) => ({
    id: l.id,
    position: l.position,
    productId: l.product_id,
    name: l.name,
    description: l.description,
    quantity: Number(l.quantity),
    unitLabel: l.unit_label,
    unitPriceCents: num(l.unit_price_cents),
    taxable: l.taxable,
    discountCents: num(l.discount_cents),
    allocatedCents: shares[i] ?? 0,
    amountCents: num(l.amount_cents),
    netCents: (subtotals[i] ?? 0) - (shares[i] ?? 0),
  }));
}

/** The lines as a command needs them back for an edit or a copy. */
export function linesIn(lines: readonly MoneyLineRow[]): MoneyLineInput[] {
  return lines.map((l) => ({
    productId: l.product_id,
    name: l.name,
    description: l.description,
    quantity: Number(l.quantity),
    unitLabel: l.unit_label,
    unitPriceCents: num(l.unit_price_cents),
    taxable: l.taxable,
    discountCents: num(l.discount_cents),
  }));
}

export function paymentOut(r: PaymentRow) {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    amountCents: num(r.amount_cents),
    method: r.method as never,
    provider: (r.provider ?? null) as never,
    connectionId: r.connection_id,
    status: r.status as never,
    providerStatus: r.provider_status,
    failureCode: r.failure_code,
    feeCents: r.fee_cents === null ? null : num(r.fee_cents),
    netCents: r.net_cents === null ? null : num(r.net_cents),
    receivedAt: moneyIso(r.received_at),
    recordedBy: userOf(r.recorded_by, r.recorded_by_name),
    refundedCents: num(r.refunded_cents),
    cardBrand: r.card_brand,
    cardLast4: r.card_last4,
    createdAt: isoAt(r.created_at),
  };
}

export function refundOut(r: RefundRow) {
  return {
    id: r.id,
    paymentId: r.payment_id,
    invoiceId: r.invoice_id,
    amountCents: num(r.amount_cents),
    reason: r.reason,
    status: r.status as never,
    failureCode: r.failure_code,
    refundedAt: moneyIso(r.refunded_at),
    requestedBy: userOf(r.requested_by, r.requested_by_name),
    createdAt: isoAt(r.created_at),
  };
}

export function subscriptionOut(r: SubscriptionRow) {
  return {
    id: r.id,
    publicRef: r.public_ref,
    status: r.status as never,
    planId: r.plan_id,
    planName: r.plan_name,
    priceCents: num(r.price_cents),
    interval: r.interval as never,
    intervalCount: r.interval_count,
    taxable: r.taxable,
    includes: Array.isArray(r.includes) ? r.includes.filter((x) => typeof x === 'string') : [],
    person: personOf(r),
    leadId: r.lead_id,
    connectionId: r.connection_id,
    provider: (r.provider ?? null) as never,
    externalSubscriptionId: r.external_subscription_id,
    hasCard: !!r.has_card,
    cardBrand: r.card_brand,
    cardLast4: r.card_last4,
    cardExpiryMonth: r.card_expiry_month === null ? null : Number(r.card_expiry_month),
    cardExpiryYear: r.card_expiry_year === null ? null : Number(r.card_expiry_year),
    cardRequestedAt: moneyIso(r.card_requested_at),
    startedOn: r.started_on,
    currentPeriodStart: r.current_period_start,
    currentPeriodEnd: r.current_period_end,
    nextBillingOn: r.next_billing_on,
    pausedAt: moneyIso(r.paused_at),
    cancelledAt: moneyIso(r.cancelled_at),
    cancelReason: r.cancel_reason,
    endedOn: r.ended_on,
    failedCycles: r.failed_cycles,
    lastError: r.last_error,
    createdAt: isoAt(r.created_at),
  };
}

/** `lineOut` for one line with no document discount to share (a get always has the document's). */
export const lineOut = (l: MoneyLineRow) => linesOut([l], 0)[0]!;

// ---------- loading one document, locked ----------

export async function requireEstimate(ctx: CommandContext, id: string): Promise<EstimateRow> {
  const [row] = await rows<EstimateRow>(
    ctx.tx,
    sql`${estimateSelect} where e.workspace_id = ${ctx.scope.workspaceId!} and e.id = ${id}::uuid
        for no key update of e`,
  );
  if (!row) throw HfosError.notFound('That estimate isn’t there.');
  return row;
}

export async function requireInvoice(ctx: CommandContext, id: string): Promise<InvoiceRow> {
  const [row] = await rows<InvoiceRow>(
    ctx.tx,
    sql`${invoiceSelect} where i.workspace_id = ${ctx.scope.workspaceId!} and i.id = ${id}::uuid
        for no key update of i`,
  );
  if (!row) throw HfosError.notFound('That invoice isn’t there.');
  return row;
}

/** A document that has gone out keeps its number, its tax, its totals and its lines: void it and reissue. */
export function assertDraft(
  row: { status: string; sent_at: Date | string | null; voided_at: Date | string | null },
  what: 'estimate' | 'invoice',
): void {
  if (row.voided_at)
    throw HfosError.rule(
      'money_document_voided',
      409,
      `That ${what} was voided. Make a new one instead.`,
    );
  if (row.sent_at || row.status !== 'draft')
    throw HfosError.rule(
      'money_document_issued',
      409,
      `A sent ${what} keeps its number, its tax and its totals. Void it and reissue to change it.`,
    );
}

/**
 * How a refused draft save keeps the person's version (M10): drafts don't merge, since a document's lines and
 * totals only make sense together, so the phone makes theirs a new draft with this command and input.
 */
export interface KeepAsNewDraft {
  readonly command: 'estimate.create' | 'invoice.create';
  readonly input: Readonly<Record<string, unknown>>;
}

/** An input without the keys it left out. */
export const presentOnly = (input: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

/**
 * Someone else saved while this editor was open: their work is kept, and the editor reloads. The refusal says how
 * to keep this save's version as a new draft (`keepAsNewDraft`), which the phone does instead of losing it.
 */
export function assertRevision(
  row: { revision: number },
  baseRevision: number,
  keep?: KeepAsNewDraft,
): void {
  if (Math.round(Number(row.revision)) !== Math.round(baseRevision))
    throw new HfosError(
      'conflict',
      409,
      'Someone else saved this while you were editing. Reload to see their changes.',
      { revision: Math.round(Number(row.revision)), ...(keep ? { keepAsNewDraft: keep } : {}) },
      'document_conflict',
    );
}

// ---------- dates ----------

/** Today where the business is: a due date and an expiry belong to its day, not to UTC. */
export const businessToday = (timeZone: string, now: number = Date.now()): string =>
  localDateOf(now, timeZone);

/** `startOfLocalDay` re-exported under the name the commands read better with. */
export const localDayStart = startOfLocalDay;
export { addDays };

// ---------- who a person may bill (0106) ----------

/**
 * Someone who bills without managing money bills the customers they can already see money for: the ones they're on,
 * the leads they work, the visits they're staffed on (0050's rule, with 0104's customer arm). Said in words here,
 * before the database's own policy refuses the same write. Owners, admins and anyone else who manages money, and
 * the system, bill anyone.
 */
export async function requireBillable(
  ctx: CommandContext,
  doc: { personId: string; leadId?: string | null; attendeeId?: string | null },
): Promise<void> {
  if (ctx.actor.type !== 'human' || scopeCan(ctx.scope, 'money.manage')) return;
  const [ok] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select private.money_member_sees(${ctx.scope.workspaceId!}::uuid, ${doc.leadId ?? null}::uuid,
          ${doc.attendeeId ?? null}::uuid, ${doc.personId}::uuid) as ok`,
  );
  if (!ok?.ok)
    throw HfosError.rule(
      'money_not_your_customer',
      403,
      'You can bill the customers you’re on. Ask an owner or admin to add you to this customer.',
    );
}
