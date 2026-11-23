/**
 * Orders (product sellers, the owner's pick 2a; docs/selling-products.md): taking one by hand, changing what's on
 * it, moving it along (New, Making it, Ready, Picked up or Delivered, or Cancelled), and making its invoice. A sent
 * order form takes one too, through `insertOrder` (form_response.submit).
 *
 * An order keeps its own copy of each line's name and price, as an invoice does, so repricing a product never
 * reprices an order already taken; making the invoice copies them again. Nobody deletes an order: one taken by
 * mistake is cancelled. Row security decides who sees and changes one (anyone who can see its customer, and
 * records.write to change it); its number is the database's.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { orders } from '@hfos/db/schema';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { findChoice } from '../money/options';
import {
  fulfilmentWords,
  money,
  orderInvoiceLines,
  orderNumberWords,
  orderStatusWords,
  orderSummary,
  orderTotalCents,
  type OrderFulfilment,
  type OrderLine,
  type OrderStatus,
} from '../money/index';
import { InvoiceCreateInput } from '../schemas/money';
import {
  OrderCreateInput,
  OrderMakeInvoiceOutput,
  OrderRefInput,
  OrderSetStatusInput,
  OrderStateOutput,
  OrderUpdateInput,
} from '../schemas/order';
import { createInvoice } from './invoice';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Where an order came from, on its events. */
export type OrderVia = 'staff' | 'form';

/**
 * The lines as they're kept: a product that isn't this business's (or was deleted) leaves the line as typed, and a
 * choice that isn't one of its product's is dropped, so counting stock by choice later never reads a stranger's.
 */
async function keptLines(ctx: CommandContext, lines: readonly OrderLine[]): Promise<OrderLine[]> {
  const ids = [...new Set(lines.map((l) => l.productId).filter((id): id is string => !!id))];
  const products = ids.length
    ? await rows<{ id: string; options: unknown }>(
        ctx.tx,
        sql`select id, options from app.products
            where workspace_id = ${ctx.scope.workspaceId!}
              and id = any(array[${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )}]::uuid[])`,
      )
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  return lines.map((l) => {
    const product = l.productId ? byId.get(l.productId) : undefined;
    return {
      ...l,
      productId: product ? l.productId : null,
      choiceIds: product ? l.choiceIds.filter((c) => findChoice(product, c)) : [],
    };
  });
}

type OrderRowLite = {
  id: string;
  number: number;
  person_id: string;
  status: OrderStatus;
  fulfilment: OrderFulfilment | null;
  due_on: string | null;
  lines: OrderLine[];
  total_cents: number;
  notes: string | null;
  invoice_id: string | null;
};

/** The order, locked for this change; one this request can't see isn't there. */
async function lockOrder(ctx: CommandContext, orderId: string): Promise<OrderRowLite> {
  const [row] = await rows<OrderRowLite>(
    ctx.tx,
    sql`select o.id, o.number, o.person_id, o.status::text as status, o.fulfilment,
          to_char(o.due_on, 'YYYY-MM-DD') as due_on, o.lines, o.total_cents::float8 as total_cents, o.notes,
          o.invoice_id
        from app.orders o
        where o.workspace_id = ${ctx.scope.workspaceId!} and o.id = ${orderId}::uuid
        for update of o`,
  );
  if (!row)
    throw HfosError.notFound(
      'That order isn’t there anymore, or its customer is in the Deleted bin. Refresh and try again.',
    );
  return { ...row, number: Number(row.number), total_cents: Number(row.total_cents) };
}

const stateOut = (
  row: { id: string; number: number; status: OrderStatus; total_cents: number },
  changed: boolean,
) => ({
  orderId: row.id,
  number: row.number,
  status: row.status,
  totalCents: row.total_cents,
  changed,
});

/**
 * A new order, New. The person typing it, a sent form or the Assistant all come through here, and
 * `order.created` says which.
 */
export async function insertOrder(
  ctx: CommandContext,
  input: {
    personId: string;
    lines: readonly OrderLine[];
    fulfilment: OrderFulfilment | null;
    dueOn: string | null;
    notes: string | null;
    formId?: string | null;
    formResponseId?: string | null;
    invoiceId?: string | null;
  },
  via: OrderVia,
) {
  const ws = ctx.scope.workspaceId!;
  const lines = await keptLines(ctx, input.lines);
  const totalCents = orderTotalCents(lines);
  const [row] = await ctx.tx
    .insert(orders)
    .values({
      workspaceId: ws,
      personId: input.personId,
      fulfilment: input.fulfilment,
      dueOn: input.dueOn,
      lines: lines as never,
      totalCents,
      notes: input.notes,
      formId: input.formId ?? null,
      formResponseId: input.formResponseId ?? null,
      invoiceId: input.invoiceId ?? null,
      createdBy: userIdOf(ctx.actor),
    })
    .returning({ id: orders.id, number: orders.number });
  if (!row) throw HfosError.forbidden();
  await ctx.emit({
    type: 'order.created',
    entityType: 'order',
    entityId: row.id,
    payload: {
      orderId: row.id,
      personId: input.personId,
      number: row.number,
      status: 'new',
      totalCents,
      fulfilment: input.fulfilment,
      dueOn: input.dueOn,
      formId: input.formId ?? null,
      formResponseId: input.formResponseId ?? null,
      invoiceId: input.invoiceId ?? null,
      via,
    },
    after: {
      order: orderNumberWords(row.number),
      items: orderSummary(lines, 3),
      total: money(totalCents),
      ...(input.fulfilment ? { [fulfilmentWords(input.fulfilment)]: input.dueOn ?? 'No day yet' } : {}),
    },
  });
  return { id: row.id, number: row.number, status: 'new' as const, total_cents: totalCents };
}

export const orderCreate = defineCommand({
  name: 'order.create',
  description:
    'Take an order for a customer by hand (New order on Money → Orders): each thing they want with its choice, how many and the price, pickup or delivery and on what day, and notes. It starts as New and gets the business’s next order number.',
  risk: 1,
  input: OrderCreateInput,
  output: OrderStateOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['order.created'],
  async handler(ctx, input) {
    await requirePerson(ctx.tx, ctx.scope.workspaceId!, input.personId);
    const row = await insertOrder(ctx, input, 'staff');
    return stateOut(row, true);
  },
});

/** Done and cancelled orders keep what was on them. */
function assertLinesOpen(row: OrderRowLite): void {
  if (row.status === 'done' || row.status === 'cancelled')
    throw HfosError.rule(
      'order_closed',
      409,
      `Order ${orderNumberWords(row.number)} is ${orderStatusWords(row.status, row.fulfilment).toLowerCase()}, so what’s on it can’t change. Move it back to Ready first if something was missed.`,
    );
}

export const orderUpdate = defineCommand({
  name: 'order.update',
  description:
    'Change an order: what is on it (the lines are replaced whole, while it is still open), pickup or delivery, the day, or its notes. Something left out stays as it is.',
  risk: 1,
  input: OrderUpdateInput,
  output: OrderStateOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['order.updated'],
  async handler(ctx, input) {
    const before = await lockOrder(ctx, input.orderId);
    if (input.lines) assertLinesOpen(before);
    const lines = input.lines ? await keptLines(ctx, input.lines) : before.lines;
    const totalCents = orderTotalCents(lines);
    const set: Partial<typeof orders.$inferInsert> = {};
    const was: Record<string, unknown> = {};
    const now: Record<string, unknown> = {};
    if (input.lines && JSON.stringify(lines) !== JSON.stringify(before.lines)) {
      set.lines = lines as never;
      set.totalCents = totalCents;
      was['items'] = orderSummary(before.lines, 3);
      now['items'] = orderSummary(lines, 3);
      if (totalCents !== before.total_cents) {
        was['total'] = money(before.total_cents);
        now['total'] = money(totalCents);
      }
    }
    if (input.fulfilment !== undefined && input.fulfilment !== before.fulfilment) {
      set.fulfilment = input.fulfilment;
      was['pickup or delivery'] = fulfilmentWords(before.fulfilment);
      now['pickup or delivery'] = fulfilmentWords(input.fulfilment);
    }
    if (input.dueOn !== undefined && input.dueOn !== before.due_on) {
      set.dueOn = input.dueOn;
      was['day'] = before.due_on ?? 'None';
      now['day'] = input.dueOn ?? 'None';
    }
    if (input.notes !== undefined && (input.notes || null) !== before.notes) {
      set.notes = input.notes || null;
      was['notes'] = before.notes ?? '';
      now['notes'] = input.notes ?? '';
    }
    if (!Object.keys(set).length) return stateOut(before, false);
    await ctx.tx.update(orders).set(set).where(eq(orders.id, before.id));
    await ctx.emit({
      type: 'order.updated',
      entityType: 'order',
      entityId: before.id,
      payload: {
        orderId: before.id,
        personId: before.person_id,
        number: before.number,
        status: before.status,
        totalCents,
        changed: Object.keys(set),
      },
      before: { order: orderNumberWords(before.number), ...was },
      after: { order: orderNumberWords(before.number), ...now },
    });
    return stateOut({ ...before, total_cents: totalCents }, true);
  },
});

export const orderSetStatus = defineCommand({
  name: 'order.set_status',
  description:
    'Move an order along: New, Making it, Ready (for pickup, or to deliver), Picked up or Delivered, or Cancelled; or back a step. Nothing is sent to the customer.',
  risk: 1,
  input: OrderSetStatusInput,
  output: OrderStateOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['order.status_changed'],
  async handler(ctx, input) {
    const before = await lockOrder(ctx, input.orderId);
    if (before.status === input.status) return stateOut(before, false);
    await ctx.tx
      .update(orders)
      .set({
        status: input.status,
        statusChangedAt: new Date(),
        statusChangedBy: userIdOf(ctx.actor),
      })
      .where(eq(orders.id, before.id));
    await ctx.emit({
      type: 'order.status_changed',
      entityType: 'order',
      entityId: before.id,
      payload: {
        orderId: before.id,
        personId: before.person_id,
        number: before.number,
        from: before.status,
        status: input.status,
        fulfilment: before.fulfilment,
        dueOn: before.due_on,
      },
      before: {
        order: orderNumberWords(before.number),
        status: orderStatusWords(before.status, before.fulfilment),
      },
      after: {
        order: orderNumberWords(before.number),
        status: orderStatusWords(input.status, before.fulfilment),
      },
    });
    return stateOut({ ...before, status: input.status }, true);
  },
});

export const orderMakeInvoice = defineCommand({
  name: 'order.make_invoice',
  description:
    'Make the invoice for an order: a draft with each thing on the order at its price, for the order’s customer, linked to the order. It still needs sending (or marking paid) from the invoice. One invoice an order, unless that one was voided.',
  risk: 1,
  input: OrderRefInput,
  output: OrderMakeInvoiceOutput,
  permission: 'money.bill',
  scope: inWorkspace,
  emits: ['invoice.created', 'order.updated'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const order = await lockOrder(ctx, input.orderId);
    const name = orderNumberWords(order.number);
    if (order.status === 'cancelled')
      throw HfosError.rule(
        'order_cancelled',
        409,
        `Order ${name} is cancelled, so there’s nothing to bill. Move it back to New first if it’s going ahead after all.`,
      );
    if (order.invoice_id) {
      const [inv] = await rows<{ number: string | null; status: string }>(
        ctx.tx,
        sql`select number, status::text as status from app.invoices where id = ${order.invoice_id}`,
      );
      if (!inv || inv.status !== 'void')
        throw HfosError.rule(
          'order_invoiced',
          409,
          inv?.number
            ? `Order ${name} already has invoice ${inv.number}. Open it from the order to send it or change it.`
            : `Order ${name} already has an invoice. Open it from the order to send it or change it.`,
        );
    }
    if (!order.lines.length || orderTotalCents(order.lines) === 0)
      throw HfosError.rule(
        'order_unpriced',
        409,
        `Nothing on order ${name} has a price yet. Set a price on each line of the order, then make the invoice.`,
      );
    const invoice = await createInvoice(
      ctx,
      InvoiceCreateInput.parse({
        workspaceId: ws,
        personId: order.person_id,
        title: `Order ${name}`,
        lines: orderInvoiceLines(order.lines),
      }),
      userIdOf(ctx.actor),
    );
    const updated = await ctx.tx
      .update(orders)
      .set({ invoiceId: invoice.invoiceId })
      .where(eq(orders.id, order.id))
      .returning({ id: orders.id });
    if (!updated.length) throw HfosError.forbidden();
    await ctx.emit({
      type: 'order.updated',
      entityType: 'order',
      entityId: order.id,
      payload: {
        orderId: order.id,
        personId: order.person_id,
        number: order.number,
        status: order.status,
        totalCents: order.total_cents,
        invoiceId: invoice.invoiceId,
        changed: ['invoice_id'],
      },
      after: { order: name, invoice: `Draft for ${money(invoice.totalCents)}` },
    });
    return { orderId: order.id, invoiceId: invoice.invoiceId };
  },
});

export const orderCommands = [orderCreate, orderUpdate, orderSetStatus, orderMakeInvoice] as const;
