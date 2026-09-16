/**
 * Money's queries (M9): the catalogue, the estimate and invoice lists and pages, payments, plans, the
 * business's money summary, and the panel on a lead, a customer or a visit.
 *
 * **Every query applies the member rule in its own `where`, not just in RLS.** A member sees a document, its
 * lines, its payments and its refunds when they are staffed on the appointment it is linked to or they own the
 * lead it is linked to; a document tied to neither is owner business. The predicate is
 * `private.money_member_sees`, the same definer helper the RLS policies call, so a query layer can never widen
 * the rule and a missing clause can never leak. Owners and admins skip it entirely — they match the
 * money.manage policies and never pay for the lookup.
 *
 * `money.summary` and the plan queries are owners and admins only: a total of the whole business's receivables
 * is exactly what the member rule withholds, so it is refused rather than half-answered.
 */
import { and, asc, desc, eq, inArray, ne, sql as dsql } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { paymentConnections, subscriptions } from '@hfos/db/schema';
import { workspaceTimezone } from '../crm/records';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { decodeCursor, encodeCursor } from '../kernel/pagination';
import type { QueryContext } from '../kernel/types';
import { moneySettingsOf, numberPreview } from '../money/index';
import { hasWorkspacePermission } from '../permissions';
import {
  EstimateGetInput,
  EstimateGetOutput,
  EstimateListInput,
  EstimateListOutput,
  InvoiceGetInput,
  InvoiceGetOutput,
  InvoiceListInput,
  InvoiceListOutput,
  MoneyForRecordInput,
  MoneyForRecordOutput,
  MoneySettingsGetInput,
  MoneySettingsGetOutput,
  MoneySummaryInput,
  MoneySummaryOutput,
  PaymentConnectionListInput,
  PaymentConnectionListOutput,
  PaymentListInput,
  PaymentListOutput,
  PlanListInput,
  PlanListOutput,
  ProductListInput,
  ProductListOutput,
  SubscriptionGetInput,
  SubscriptionGetOutput,
  SubscriptionListInput,
  SubscriptionListOutput,
} from '../schemas/money';
import {
  countersOf,
  isoAt,
  moneyIso,
  estimateOut,
  estimateSelect,
  invoiceOut,
  invoiceSelect,
  linesFor,
  linesOut,
  paymentOut,
  paymentsFor,
  refundOut,
  refundsFor,
  subscriptionOut,
  subscriptionSelect,
  type DocumentKind,
  type EstimateRow,
  type InvoiceRow,
  type PaymentRow,
  type SubscriptionRow,
} from '../commands/money-shared';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Owners and admins manage money; anyone else with money.read is held to the jobs they are on. */
const isMember = (ctx: QueryContext): boolean =>
  !hasWorkspacePermission(ctx.scope.workspaceRole, 'money.manage');

/**
 * The member rule for an estimate, as this query's own `where`. Estimates have no booking, so a member's reach
 * on one is the lead they own.
 */
const estimateMemberClause = (ctx: QueryContext) =>
  isMember(ctx) ? sql` and private.money_member_sees(e.workspace_id, e.lead_id, null)` : sql``;

/** The same rule for an invoice, which also reaches the visit they worked. */
const invoiceMemberClause = (ctx: QueryContext) =>
  isMember(ctx)
    ? sql` and private.money_member_sees(i.workspace_id, i.lead_id, i.attendee_id)`
    : sql``;

const like = (search: string | undefined): string | null =>
  search?.trim() ? `%${search.trim().toLowerCase()}%` : null;

/**
 * A real Postgres array for `= any(...)`. Interpolating the list itself spreads it into one parameter each,
 * which Postgres reads as a row constructor and refuses ("op ANY/ALL (array) requires array on right side").
 * The knowledge queries have the same helper for the same reason.
 */
const textArray = (values: readonly string[]) =>
  sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

/** Lists are keyed on (created_at, id), newest first, as every other list here is. */
function cursorClause(cursor: string | undefined, alias: 'e' | 'i' | 'p' | 's') {
  const c = decodeCursor(cursor);
  if (!c) return sql``;
  const key =
    alias === 'e'
      ? sql`(e.created_at, e.id)`
      : alias === 'i'
        ? sql`(i.created_at, i.id)`
        : alias === 'p'
          ? sql`(p.created_at, p.id)`
          : sql`(s.created_at, s.id)`;
  return sql` and ${key} < (${c.sort}::timestamptz, ${c.id}::uuid)`;
}

function paged<T extends { id: string; created_at: Date | string }>(list: T[], limit: number) {
  const more = list.length > limit;
  const items = more ? list.slice(0, limit) : list;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: more && last ? encodeCursor({ sort: isoAt(last.created_at), id: last.id }) : null,
  };
}

// ---------- the catalogue ----------

export const productList = defineQuery({
  name: 'product.list',
  description:
    'The things a business sells: parts, work and charges, with their unit price, what a unit is called and whether it is taxed. Archived ones are left out unless you ask for them.',
  input: ProductListInput,
  output: ProductListOutput,
  permission: 'money.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const search = like(input.search);
    const list = await rows<{
      id: string;
      name: string;
      description: string | null;
      sku: string | null;
      kind: 'product' | 'service' | 'fee';
      unit_price_cents: number;
      unit_label: string;
      taxable: boolean;
      service_id: string | null;
      archived_at: Date | string | null;
    }>(
      ctx.tx,
      sql`select p.id, p.name, p.description, p.sku, p.kind::text as kind,
            p.unit_price_cents::float8 as unit_price_cents, p.unit_label, p.taxable, p.service_id, p.archived_at
          from app.products p
          where p.workspace_id = ${ctx.scope.workspaceId!}
            ${input.includeArchived ? sql`` : sql`and p.archived_at is null`}
            ${input.kind ? sql`and p.kind::text = ${input.kind}` : sql``}
            ${search ? sql`and (lower(p.name) like ${search} or lower(coalesce(p.sku, '')) like ${search})` : sql``}
          order by lower(p.name), p.id
          limit 500`,
    );
    return {
      products: list.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        sku: p.sku,
        kind: p.kind,
        unitPriceCents: Number(p.unit_price_cents),
        unitLabel: p.unit_label,
        taxable: p.taxable,
        serviceId: p.service_id,
        archivedAt: moneyIso(p.archived_at),
      })),
    };
  },
});

export const planList = defineQuery({
  name: 'plan.list',
  description:
    'The maintenance plans a business sells: what each costs, how often it bills and what it includes.',
  input: PlanListInput,
  output: PlanListOutput,
  permission: 'money.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const list = await rows<{
      id: string;
      name: string;
      description: string | null;
      price_cents: number;
      interval: 'month' | 'quarter' | 'year';
      interval_count: number;
      taxable: boolean;
      includes: unknown;
      archived_at: Date | string | null;
    }>(
      ctx.tx,
      sql`select pl.id, pl.name, pl.description, pl.price_cents::float8 as price_cents,
            pl.interval::text as interval, pl.interval_count, pl.taxable, pl.includes, pl.archived_at
          from app.plans pl
          where pl.workspace_id = ${ctx.scope.workspaceId!}
            ${input.includeArchived ? sql`` : sql`and pl.archived_at is null`}
          order by lower(pl.name), pl.id
          limit 200`,
    );
    return {
      plans: list.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        priceCents: Number(p.price_cents),
        interval: p.interval,
        intervalCount: p.interval_count,
        taxable: p.taxable,
        includes: Array.isArray(p.includes) ? p.includes.filter((x) => typeof x === 'string') : [],
        archivedAt: moneyIso(p.archived_at),
      })),
    };
  },
});

// ---------- connected accounts ----------

export const paymentConnectionList = defineQuery({
  name: 'payment_connection.list',
  description:
    'The payment accounts a business has connected, which one is the default, what each can do and how many plans still bill through it. Never a token: those columns are not granted to people at all.',
  input: PaymentConnectionListInput,
  output: PaymentConnectionListOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  async handler(ctx, input) {
    const where = [eq(paymentConnections.workspaceId, ctx.scope.workspaceId!)];
    if (input.environment) where.push(eq(paymentConnections.environment, input.environment));
    if (!input.includeDisconnected) where.push(ne(paymentConnections.status, 'disconnected'));
    // Named columns: `select *` would ask for the sealed token and be refused.
    const list = await ctx.tx
      .select({
        id: paymentConnections.id,
        provider: paymentConnections.provider,
        environment: paymentConnections.environment,
        status: paymentConnections.status,
        externalAccountId: paymentConnections.externalAccountId,
        locationId: paymentConnections.locationId,
        label: paymentConnections.label,
        displayName: paymentConnections.displayName,
        isDefault: paymentConnections.isDefault,
        capabilities: paymentConnections.capabilities,
        tokenExpiresAt: paymentConnections.tokenExpiresAt,
        failures: paymentConnections.failures,
        lastError: paymentConnections.lastError,
        disconnectedReason: paymentConnections.disconnectedReason,
        connectedAt: paymentConnections.connectedAt,
        disconnectedAt: paymentConnections.disconnectedAt,
      })
      .from(paymentConnections)
      .where(and(...where))
      .orderBy(desc(paymentConnections.isDefault), asc(paymentConnections.createdAt));
    const counts = await liveSubscriptionCounts(ctx.tx, ctx.scope.workspaceId!);
    return {
      connections: list.map((c) => ({
        id: c.id,
        provider: c.provider,
        environment: c.environment,
        status: c.status,
        externalAccountId: c.externalAccountId,
        locationId: c.locationId,
        label: c.label,
        displayName: c.displayName,
        isDefault: c.isDefault,
        capabilities: (c.capabilities ?? {}) as Record<string, unknown>,
        tokenExpiresAt: moneyIso(c.tokenExpiresAt),
        failures: c.failures,
        lastError: c.lastError,
        disconnectedReason: c.disconnectedReason as
          'person' | 'revoked' | 'deauthorized' | 'failed' | 'replaced' | null,
        connectedAt: moneyIso(c.connectedAt),
        disconnectedAt: moneyIso(c.disconnectedAt),
        liveSubscriptions: counts.get(c.id) ?? 0,
      })),
    };
  },
});

/** Plans still billing at the provider, per connection: what disconnecting one would leave unmanaged. */
async function liveSubscriptionCounts(tx: Tx, workspaceId: string): Promise<Map<string, number>> {
  const live = await tx
    .select({ connectionId: subscriptions.connectionId, n: dsql<number>`count(*)::int` })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, workspaceId),
        inArray(subscriptions.status, ['active', 'past_due', 'paused']),
      ),
    )
    .groupBy(subscriptions.connectionId);
  const out = new Map<string, number>();
  for (const r of live) if (r.connectionId) out.set(r.connectionId, Number(r.n));
  return out;
}

// ---------- estimates ----------

export const estimateList = defineQuery({
  name: 'estimate.list',
  description:
    'Estimates, newest first, with what each comes to and where it stands (opened, approved, declined, expired). A member sees the ones on the leads they own; owners and admins see them all.',
  input: EstimateListInput,
  output: EstimateListOutput,
  permission: 'money.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const search = like(input.search);
    const list = await rows<EstimateRow>(
      ctx.tx,
      sql`${estimateSelect}
          where e.workspace_id = ${ctx.scope.workspaceId!}
            ${input.status?.length ? sql`and e.status::text = any(${textArray(input.status)})` : sql``}
            ${input.openOnly ? sql`and e.status = 'sent'` : sql``}
            ${input.personId ? sql`and e.person_id = ${input.personId}::uuid` : sql``}
            ${input.leadId ? sql`and e.lead_id = ${input.leadId}::uuid` : sql``}
            ${search ? sql`and (lower(coalesce(e.number, '')) like ${search} or lower(coalesce(e.title, '')) like ${search} or lower(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')) like ${search})` : sql``}
            ${estimateMemberClause(ctx)}
            ${cursorClause(input.cursor, 'e')}
          order by e.created_at desc, e.id desc
          limit ${input.limit + 1}`,
    );
    const { items, nextCursor } = paged(list, input.limit);
    const now = Date.now();
    const tz = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
    return { estimates: items.map((r) => estimateOut(r, now, tz)), nextCursor };
  },
});

export const estimateGet = defineQuery({
  name: 'estimate.get',
  description:
    'One estimate: its lines, its totals, what the customer did with it (opened, approved with the name they typed, declined) and the invoices raised from it.',
  input: EstimateGetInput,
  output: EstimateGetOutput,
  permission: 'money.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [row] = await rows<EstimateRow>(
      ctx.tx,
      sql`${estimateSelect}
          where e.workspace_id = ${ctx.scope.workspaceId!} and e.id = ${input.estimateId}::uuid
            ${estimateMemberClause(ctx)}`,
    );
    if (!row) throw notThere('estimate');
    const lines = await linesFor(ctx.tx, 'estimate', [row.id]);
    const raised = await rows<{
      id: string;
      number: string | null;
      status: string;
      purpose: string;
      total_cents: number;
      balance_cents: number;
    }>(
      ctx.tx,
      sql`select i.id, i.number, i.status::text as status, i.purpose::text as purpose,
            i.total_cents::float8 as total_cents, i.balance_cents::float8 as balance_cents
          from app.invoices i
          where i.workspace_id = ${ctx.scope.workspaceId!} and i.estimate_id = ${row.id}::uuid
            ${invoiceMemberClause(ctx)}
          order by i.created_at desc, i.id desc`,
    );
    const now = Date.now();
    const tz = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
    return {
      estimate: {
        ...estimateOut(row, now, tz),
        notes: row.notes,
        revision: Math.round(Number(row.revision)),
        linkVersion: row.link_version,
        acceptedName: row.accepted_name,
        acceptedVia: (row.accepted_via as 'link' | 'staff' | null) ?? null,
        acceptedBy: row.accepted_by
          ? { id: row.accepted_by, fullName: row.accepted_by_name ?? 'Someone' }
          : null,
        acceptedWording: row.accepted_wording,
        declinedReason: row.declined_reason,
        voidReason: row.void_reason,
        lines: linesOut(lines.get(row.id) ?? [], Number(row.discount_cents)),
      },
      invoices: raised.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status as never,
        purpose: r.purpose as never,
        totalCents: Number(r.total_cents),
        balanceCents: Number(r.balance_cents),
      })),
    };
  },
});

// ---------- invoices ----------

export const invoiceList = defineQuery({
  name: 'invoice.list',
  description:
    'Invoices, newest first, with what is owed and where each stands — paying while a bank transfer settles, overdue once it is late. A member sees the ones for the visits they worked and the leads they own.',
  input: InvoiceListInput,
  output: InvoiceListOutput,
  permission: 'money.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const search = like(input.search);
    const list = await rows<InvoiceRow>(
      ctx.tx,
      sql`${invoiceSelect}
          where i.workspace_id = ${ctx.scope.workspaceId!}
            ${input.status?.length ? sql`and i.status::text = any(${textArray(input.status)})` : sql``}
            ${input.purpose?.length ? sql`and i.purpose::text = any(${textArray(input.purpose)})` : sql``}
            ${input.openOnly ? sql`and i.status in ('sent', 'partly_paid', 'overdue')` : sql``}
            ${input.personId ? sql`and i.person_id = ${input.personId}::uuid` : sql``}
            ${input.leadId ? sql`and i.lead_id = ${input.leadId}::uuid` : sql``}
            ${input.attendeeId ? sql`and i.attendee_id = ${input.attendeeId}::uuid` : sql``}
            ${input.subscriptionId ? sql`and i.subscription_id = ${input.subscriptionId}::uuid` : sql``}
            ${search ? sql`and (lower(coalesce(i.number, '')) like ${search} or lower(coalesce(i.title, '')) like ${search} or lower(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')) like ${search})` : sql``}
            ${invoiceMemberClause(ctx)}
            ${cursorClause(input.cursor, 'i')}
          order by i.created_at desc, i.id desc
          limit ${input.limit + 1}`,
    );
    const { items, nextCursor } = paged(list, input.limit);
    const now = Date.now();
    const tz = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
    return { invoices: items.map((r) => invoiceOut(r, now, tz)), nextCursor };
  },
});

export const invoiceGet = defineQuery({
  name: 'invoice.get',
  description:
    'One invoice: its lines, its totals, what has been paid and refunded, and every payment against it with its method and where it stands.',
  input: InvoiceGetInput,
  output: InvoiceGetOutput,
  permission: 'money.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [row] = await rows<InvoiceRow>(
      ctx.tx,
      sql`${invoiceSelect}
          where i.workspace_id = ${ctx.scope.workspaceId!} and i.id = ${input.invoiceId}::uuid
            ${invoiceMemberClause(ctx)}`,
    );
    if (!row) throw notThere('invoice');
    const lines = await linesFor(ctx.tx, 'invoice', [row.id]);
    const payments = await paymentsFor(ctx.tx, ctx.scope.workspaceId!, [row.id]);
    const refunds = await refundsFor(ctx.tx, ctx.scope.workspaceId!, [row.id]);
    const now = Date.now();
    const tz = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
    return {
      invoice: {
        ...invoiceOut(row, now, tz),
        notes: row.notes,
        revision: Math.round(Number(row.revision)),
        linkVersion: row.link_version,
        voidReason: row.void_reason,
        lines: linesOut(lines.get(row.id) ?? [], Number(row.discount_cents)),
      },
      payments: payments.map(paymentOut),
      refunds: refunds.map(refundOut),
    };
  },
});

export const paymentList = defineQuery({
  name: 'payment.list',
  description:
    'Payments, newest first: what was taken, how, where it stands and what it was refunded. A member sees the payments on the invoices they can see.',
  input: PaymentListInput,
  output: PaymentListOutput,
  permission: 'money.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const list = await rows<
      PaymentRow & {
        first_name: string | null;
        last_name: string | null;
        person_id: string | null;
        person_email: string | null;
        person_phone: string | null;
        invoice_number: string | null;
      }
    >(
      ctx.tx,
      sql`select p.id, p.invoice_id, p.amount_cents::float8 as amount_cents, p.method::text as method,
            p.provider::text as provider, p.connection_id, p.status::text as status, p.provider_status,
            p.failure_code, p.fee_cents::float8 as fee_cents, p.net_cents::float8 as net_cents,
            p.received_at, p.recorded_by, p.created_at,
            coalesce(nullif(u.full_name, ''), u.email::text) as recorded_by_name,
            coalesce((select sum(r.amount_cents) from app.refunds r
              where r.payment_id = p.id and r.status = 'succeeded'), 0)::float8 as refunded_cents,
            p.card_brand, p.card_last4,
            i.number as invoice_number, i.person_id, pe.first_name, pe.last_name,
            pe.email::text as person_email, pe.phone as person_phone
          from app.payments p
          join app.invoices i on i.id = p.invoice_id
          left join app.people pe on pe.id = i.person_id
          left join app.users u on u.id = p.recorded_by
          where p.workspace_id = ${ctx.scope.workspaceId!}
            ${input.invoiceId ? sql`and p.invoice_id = ${input.invoiceId}::uuid` : sql``}
            ${input.personId ? sql`and i.person_id = ${input.personId}::uuid` : sql``}
            ${input.status?.length ? sql`and p.status::text = any(${textArray(input.status)})` : sql``}
            ${input.method?.length ? sql`and p.method::text = any(${textArray(input.method)})` : sql``}
            ${input.succeededOnly ? sql`and p.status = 'succeeded'` : sql``}
            ${input.since ? sql`and p.created_at >= ${input.since}::timestamptz` : sql``}
            ${invoiceMemberClause(ctx)}
            ${cursorClause(input.cursor, 'p')}
          order by p.created_at desc, p.id desc
          limit ${input.limit + 1}`,
    );
    const { items, nextCursor } = paged(list, input.limit);
    return {
      payments: items.map((r) => ({
        ...paymentOut(r),
        invoiceNumber: r.invoice_number,
        person: r.person_id
          ? {
              id: r.person_id,
              fullName: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Someone',
              email: r.person_email,
              phone: r.person_phone,
            }
          : null,
      })),
      nextCursor,
    };
  },
});

// ---------- plans ----------

export const subscriptionList = defineQuery({
  name: 'subscription.list',
  description:
    'The maintenance plans customers are on: what each bills, when it next bills and where it stands. A plan is money a business is owed every month, so it is owners and admins only.',
  input: SubscriptionListInput,
  output: SubscriptionListOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  async handler(ctx, input) {
    const list = await rows<SubscriptionRow>(
      ctx.tx,
      sql`${subscriptionSelect}
          where s.workspace_id = ${ctx.scope.workspaceId!}
            ${input.status?.length ? sql`and s.status::text = any(${textArray(input.status)})` : sql``}
            ${input.personId ? sql`and s.person_id = ${input.personId}::uuid` : sql``}
            ${input.planId ? sql`and s.plan_id = ${input.planId}::uuid` : sql``}
            ${cursorClause(input.cursor, 's')}
          order by s.created_at desc, s.id desc
          limit ${input.limit + 1}`,
    );
    const { items, nextCursor } = paged(list, input.limit);
    return { subscriptions: items.map(subscriptionOut), nextCursor };
  },
});

export const subscriptionGet = defineQuery({
  name: 'subscription.get',
  description: 'One plan a customer is on, and the invoices its cycles have raised.',
  input: SubscriptionGetInput,
  output: SubscriptionGetOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [row] = await rows<SubscriptionRow>(
      ctx.tx,
      sql`${subscriptionSelect}
          where s.workspace_id = ${ctx.scope.workspaceId!} and s.id = ${input.subscriptionId}::uuid`,
    );
    if (!row) throw notThere('plan');
    const raised = await rows<{
      id: string;
      number: string | null;
      status: string;
      total_cents: number;
      balance_cents: number;
      due_on: string | null;
      created_at: Date | string;
    }>(
      ctx.tx,
      sql`select i.id, i.number, i.status::text as status, i.total_cents::float8 as total_cents,
            i.balance_cents::float8 as balance_cents, i.due_on::text as due_on, i.created_at
          from app.invoices i
          where i.workspace_id = ${ctx.scope.workspaceId!} and i.subscription_id = ${row.id}::uuid
          order by i.created_at desc, i.id desc
          limit 100`,
    );
    return {
      subscription: subscriptionOut(row),
      invoices: raised.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status as never,
        totalCents: Number(r.total_cents),
        balanceCents: Number(r.balance_cents),
        dueOn: r.due_on,
        createdAt: isoAt(r.created_at),
      })),
    };
  },
});

// ---------- the business's money ----------

export const moneySummary = defineQuery({
  name: 'money.summary',
  description:
    'What the business is owed, what is late, what is on its way, what it has collected lately, what is quoted and out, and what its plans bill each month. Owners and admins only: the whole business’s receivables are exactly what the member rule withholds.',
  input: MoneySummaryInput,
  output: MoneySummaryOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const since = new Date(Date.now() - input.days * 86_400_000).toISOString();
    const [r] = await rows<{
      outstanding_cents: number;
      outstanding_count: number;
      overdue_cents: number;
      overdue_count: number;
      settling_cents: number;
      collected_cents: number;
      refunded_cents: number;
      quoted_cents: number;
      quoted_count: number;
      active_plans: number;
      monthly_recurring_cents: number;
    }>(
      ctx.tx,
      sql`with open_invoices as (
            select i.id, i.balance_cents,
              (i.due_on is not null and i.due_on < current_date) as past_due,
              exists (select 1 from app.payments p where p.invoice_id = i.id and p.status = 'processing')
                as settling
            from app.invoices i
            where i.workspace_id = ${ws} and i.status in ('sent', 'partly_paid', 'overdue')
              and i.balance_cents > 0)
          select
            coalesce(sum(o.balance_cents), 0)::float8 as outstanding_cents,
            count(o.id)::int as outstanding_count,
            coalesce(sum(o.balance_cents) filter (where o.past_due and not o.settling), 0)::float8 as overdue_cents,
            count(o.id) filter (where o.past_due and not o.settling)::int as overdue_count,
            coalesce(sum(o.balance_cents) filter (where o.settling), 0)::float8 as settling_cents,
            (select coalesce(sum(p.amount_cents), 0) from app.payments p
              where p.workspace_id = ${ws} and p.status = 'succeeded'
                and p.received_at >= ${since}::timestamptz)::float8 as collected_cents,
            (select coalesce(sum(rf.amount_cents), 0) from app.refunds rf
              where rf.workspace_id = ${ws} and rf.status = 'succeeded'
                and rf.refunded_at >= ${since}::timestamptz)::float8 as refunded_cents,
            (select coalesce(sum(e.total_cents), 0) from app.estimates e
              where e.workspace_id = ${ws} and e.status = 'sent'
                and (e.expires_on is null or e.expires_on >= current_date))::float8 as quoted_cents,
            (select count(*) from app.estimates e
              where e.workspace_id = ${ws} and e.status = 'sent'
                and (e.expires_on is null or e.expires_on >= current_date))::int as quoted_count,
            (select count(*) from app.subscriptions s
              where s.workspace_id = ${ws} and s.status in ('active', 'past_due'))::int as active_plans,
            (select coalesce(sum(
                case s.interval when 'month' then s.price_cents / greatest(s.interval_count, 1)
                  when 'quarter' then s.price_cents / (3 * greatest(s.interval_count, 1))
                  else s.price_cents / (12 * greatest(s.interval_count, 1)) end), 0)
              from app.subscriptions s
              where s.workspace_id = ${ws} and s.status in ('active', 'past_due'))::float8
              as monthly_recurring_cents
          from open_invoices o`,
    );
    return {
      now: new Date().toISOString(),
      outstandingCents: Number(r?.outstanding_cents ?? 0),
      outstandingCount: Number(r?.outstanding_count ?? 0),
      overdueCents: Number(r?.overdue_cents ?? 0),
      overdueCount: Number(r?.overdue_count ?? 0),
      settlingCents: Number(r?.settling_cents ?? 0),
      collectedCents: Number(r?.collected_cents ?? 0),
      refundedCents: Number(r?.refunded_cents ?? 0),
      quotedCents: Number(r?.quoted_cents ?? 0),
      quotedCount: Number(r?.quoted_count ?? 0),
      activePlans: Number(r?.active_plans ?? 0),
      monthlyRecurringCents: Math.round(Number(r?.monthly_recurring_cents ?? 0)),
    };
  },
});

export const moneyForRecord = defineQuery({
  name: 'money.for_record',
  description:
    'The money on one lead, customer or visit: its estimates, its invoices and the plans that customer is on, with what is still owed and what has been collected. The member rule applies here too.',
  input: MoneyForRecordInput,
  output: MoneyForRecordOutput,
  permission: 'money.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const id = input.recordId;
    const estimateWhere =
      input.recordType === 'lead'
        ? sql`and e.lead_id = ${id}::uuid`
        : input.recordType === 'person'
          ? sql`and e.person_id = ${id}::uuid`
          : // A visit has no estimate of its own: an estimate is a lead's, not a booking's.
            sql`and false`;
    const invoiceWhere =
      input.recordType === 'lead'
        ? sql`and i.lead_id = ${id}::uuid`
        : input.recordType === 'person'
          ? sql`and i.person_id = ${id}::uuid`
          : sql`and i.attendee_id in (select a.id from app.appointment_attendees a
                where a.workspace_id = ${ws} and a.appointment_id = ${id}::uuid)`;
    const estimates = await rows<EstimateRow>(
      ctx.tx,
      sql`${estimateSelect}
          where e.workspace_id = ${ws} ${estimateWhere} ${estimateMemberClause(ctx)}
          order by e.created_at desc, e.id desc limit 50`,
    );
    const invoices = await rows<InvoiceRow>(
      ctx.tx,
      sql`${invoiceSelect}
          where i.workspace_id = ${ws} ${invoiceWhere} ${invoiceMemberClause(ctx)}
          order by i.created_at desc, i.id desc limit 50`,
    );
    // Plans are owners' and admins' business, like the accounts they bill through.
    const plans = isMember(ctx)
      ? []
      : await rows<SubscriptionRow>(
          ctx.tx,
          sql`${subscriptionSelect}
              where s.workspace_id = ${ws}
                ${
                  input.recordType === 'lead'
                    ? sql`and s.lead_id = ${id}::uuid`
                    : input.recordType === 'person'
                      ? sql`and s.person_id = ${id}::uuid`
                      : sql`and false`
                }
              order by s.created_at desc, s.id desc limit 50`,
        );
    const now = Date.now();
    const tz = await workspaceTimezone(ctx.tx, ws);
    const live = invoices.filter((i) => i.status !== 'void' && i.status !== 'draft');
    return {
      estimates: estimates.map((r) => estimateOut(r, now, tz)),
      invoices: invoices.map((r) => invoiceOut(r, now, tz)),
      subscriptions: plans.map(subscriptionOut),
      balanceCents: live.reduce((sum, i) => sum + Number(i.balance_cents), 0),
      collectedCents: live.reduce(
        (sum, i) => sum + Number(i.amount_paid_cents) - Number(i.amount_refunded_cents),
        0,
      ),
      quotedCents: estimates
        .filter((e) => e.status === 'sent')
        .reduce((sum, e) => sum + Number(e.total_cents), 0),
    };
  },
});

// ---------- settings ----------

export const moneySettingsGet = defineQuery({
  name: 'money.settings',
  description:
    'The money settings, every default filled in: the sales tax and what it is called, numbering with a live preview of the next number, terms and notes, how long an estimate stays good, the deposit and the reminders.',
  input: MoneySettingsGetInput,
  output: MoneySettingsGetOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const [w] = await rows<{ settings: Record<string, unknown> | null }>(
      ctx.tx,
      sql`select settings from app.workspaces where id = ${ws}`,
    );
    const settings = moneySettingsOf(w?.settings ?? null);
    // The counter row is the authority while a document is being sent; settings are the editable view of it.
    const counters = await countersOf(ctx.tx, ws);
    const preview = (kind: DocumentKind) =>
      numberPreview(counters.get(kind) ?? settings.numbering[kind]);
    return {
      settings,
      nextEstimateNumber: preview('estimate'),
      nextInvoiceNumber: preview('invoice'),
    };
  },
});

/** A document a member may not see does not exist for them: never a 403 that admits it is there. */
function notThere(what: 'estimate' | 'invoice' | 'plan'): HfosError {
  return HfosError.notFound(`That ${what} isn’t there.`);
}
