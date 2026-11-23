/**
 * Orders' queries (product sellers, the owner's pick 2a; docs/selling-products.md): the list on Money → Orders and
 * the calendar, and one order's page.
 *
 * Who sees an order is row security's: anyone in the business who can see its customer, while that customer isn't
 * in the Deleted bin. The invoice beside it is joined under the money rules, so a member
 * who can't see that invoice sees the order without it.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { decodeTimeCursor, encodeCursor } from '../kernel/pagination';
import {
  OrderLines,
  orderItemCount,
  type OrderFulfilment,
  type OrderStatus,
} from '../money/orders';
import {
  OrderGetOutput,
  OrderListInput,
  OrderListOutput,
  OrderRefInput,
  type OrderOut,
} from '../schemas/order';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export type OrderRow = {
  id: string;
  number: number;
  status: OrderStatus;
  open: boolean;
  fulfilment: OrderFulfilment | null;
  due_on: string | null;
  lines: unknown;
  total_cents: number | string;
  notes: string | null;
  person_id: string;
  person_name: string | null;
  form_id: string | null;
  form_name: string | null;
  form_response_id: string | null;
  invoice_id: string | null;
  inv_id: string | null;
  inv_number: string | null;
  inv_status: string | null;
  inv_total_cents: number | string | null;
  status_changed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  sort_key: string;
};

/** Every column an order's row carries, `o` the order. */
export const orderSelect = sql`select o.id, o.number, o.status::text as status, o.open, o.fulfilment,
    to_char(o.due_on, 'YYYY-MM-DD') as due_on, o.lines, o.total_cents::float8 as total_cents, o.notes,
    o.person_id,
    coalesce(nullif(btrim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')), ''),
      pe.email::text, pe.phone) as person_name,
    o.form_id, f.name as form_name, o.form_response_id, o.invoice_id,
    i.id as inv_id, i.number as inv_number, i.status::text as inv_status, i.total_cents::float8 as inv_total_cents,
    o.status_changed_at, o.created_at, o.updated_at,
    to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key
  from app.orders o
  join app.people pe on pe.id = o.person_id
  left join app.forms f on f.id = o.form_id
  left join app.invoices i on i.id = o.invoice_id`;

const iso = (v: Date | string): string => new Date(v).toISOString();

/** The lines as core reads them; a row someone wrote badly reads as no lines rather than failing the page. */
function linesOf(raw: unknown) {
  const parsed = OrderLines.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function orderOut(r: OrderRow): OrderOut {
  const lines = linesOf(r.lines);
  return {
    id: r.id,
    number: Number(r.number),
    status: r.status,
    open: r.open,
    fulfilment: r.fulfilment,
    dueOn: r.due_on,
    lines,
    totalCents: Number(r.total_cents),
    itemCount: orderItemCount(lines),
    notes: r.notes,
    person: { id: r.person_id, name: r.person_name?.trim() || 'A customer' },
    form: r.form_id && r.form_name ? { id: r.form_id, name: r.form_name } : null,
    formResponseId: r.form_response_id,
    invoiceId: r.invoice_id,
    invoice: r.inv_id
      ? {
          id: r.inv_id,
          number: r.inv_number,
          status: r.inv_status ?? 'draft',
          totalCents: Number(r.inv_total_cents ?? 0),
        }
      : null,
    statusChangedAt: r.status_changed_at ? iso(r.status_changed_at) : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** One order this request may see, or null. */
export async function loadOrder(tx: Tx, workspaceId: string, orderId: string) {
  const [row] = await rows<OrderRow>(
    tx,
    sql`${orderSelect} where o.workspace_id = ${workspaceId} and o.id = ${orderId}::uuid`,
  );
  return row ? orderOut(row) : null;
}

export const orderGone = (): HfosError =>
  HfosError.notFound(
    'That order isn’t there anymore, or its customer is in the Deleted bin. Refresh and try again.',
  );

const like = (search: string | undefined): string | null =>
  search?.trim() ? `%${search.trim().toLowerCase()}%` : null;

export const orderList = defineQuery({
  name: 'order.list',
  description:
    'Orders customers placed (product sellers), newest first: what is on each, its number, where it is (New, Making it, Ready, Picked up or Delivered, or Cancelled), pickup or delivery and on what day, and its invoice. Shows the ones still to make or hand over unless you ask for done, cancelled or all; narrow it to one customer, to pickup and delivery days in a range (the calendar), or by a number, a name or something on it.',
  input: OrderListInput,
  output: OrderListOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const search = like(input.search);
    const number = input.search ? /^#?\s*(\d{1,9})$/.exec(input.search.trim())?.[1] : undefined;
    const cursor = decodeTimeCursor(input.cursor);
    const list = await rows<OrderRow>(
      ctx.tx,
      sql`${orderSelect}
          where o.workspace_id = ${ws}
            ${
              input.show === 'open'
                ? sql`and o.open`
                : input.show === 'done'
                  ? sql`and o.status = 'done'`
                  : input.show === 'cancelled'
                    ? sql`and o.status = 'cancelled'`
                    : sql``
            }
            ${input.personId ? sql`and o.person_id = ${input.personId}::uuid` : sql``}
            ${input.dueFrom ? sql`and o.due_on >= ${input.dueFrom}::date` : sql``}
            ${input.dueTo ? sql`and o.due_on <= ${input.dueTo}::date` : sql``}
            ${
              number
                ? sql`and o.number = ${Number(number)}`
                : search
                  ? sql`and (lower(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')) like ${search}
                      or lower(coalesce(pe.email::text, '')) like ${search}
                      or lower(o.lines::text) like ${search}
                      or lower(coalesce(o.notes, '')) like ${search})`
                  : sql``
            }
            ${cursor ? sql`and (o.created_at, o.id) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)` : sql``}
          order by o.created_at desc, o.id desc
          limit ${input.limit + 1}`,
    );
    const more = list.length > input.limit;
    const items = more ? list.slice(0, input.limit) : list;
    const last = items[items.length - 1];
    const [count] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.orders o
          where o.workspace_id = ${ws} and o.open`,
    );
    return {
      orders: items.map(orderOut),
      nextCursor: more && last ? encodeCursor({ sort: last.sort_key, id: last.id }) : null,
      openCount: count?.n ?? 0,
    };
  },
});

export const orderGet = defineQuery({
  name: 'order.get',
  description:
    'One order: each thing on it with its choice, how many and the price, the total, where it is, pickup or delivery and the day, notes, the customer, the form it came from and the invoice made from it.',
  input: OrderRefInput,
  output: OrderGetOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const order = await loadOrder(ctx.tx, ctx.scope.workspaceId!, input.orderId);
    if (!order) throw orderGone();
    return { order };
  },
});

export const orderQueries = [orderList, orderGet] as const;
