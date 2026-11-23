/**
 * Orders (product sellers, the owner's pick 2a; docs/selling-products.md): what goes in and comes out of the order
 * commands and queries. The rules and words are core's money/orders.ts.
 */
import { z } from 'zod';
import {
  MAX_ORDER_NOTES,
  ORDER_FULFILMENTS,
  ORDER_STATUSES,
  OrderLine,
  OrderLines,
} from '../money/orders';
import { isoDateTime, uuid } from './common';

const status = z.enum(ORDER_STATUSES);
const fulfilment = z.enum(ORDER_FULFILMENTS, { error: 'Pick pickup or delivery.' });
const day = z.iso.date({ error: 'Pick a day.' });
const notes = z
  .string()
  .trim()
  .max(
    MAX_ORDER_NOTES,
    `Keep the notes under ${MAX_ORDER_NOTES.toLocaleString('en-US')} characters.`,
  );
const lines = OrderLines.min(1, 'Add at least one thing to the order.');

export const OrderCreateInput = z.object({
  workspaceId: uuid,
  personId: uuid,
  lines,
  fulfilment: fulfilment.nullable().default(null),
  /** The day it's picked up or delivered: on the calendar. */
  dueOn: day.nullable().default(null),
  notes: notes.nullable().default(null),
});

/** Left out keeps it; null clears it. Lines are replaced whole. */
export const OrderUpdateInput = z.object({
  workspaceId: uuid,
  orderId: uuid,
  lines: lines.optional(),
  fulfilment: fulfilment.nullable().optional(),
  dueOn: day.nullable().optional(),
  notes: notes.nullable().optional(),
});

export const OrderSetStatusInput = z.object({
  workspaceId: uuid,
  orderId: uuid,
  status,
});

export const OrderRefInput = z.object({ workspaceId: uuid, orderId: uuid });

/** What a change to an order hands back. */
export const OrderStateOutput = z.object({
  orderId: uuid,
  number: z.int(),
  status,
  totalCents: z.number(),
  changed: z.boolean(),
});

export const OrderMakeInvoiceOutput = z.object({
  orderId: uuid,
  invoiceId: uuid,
});

/** Which orders a list shows: still to make or hand over (the default), done, cancelled, or every one. */
export const ORDER_LIST_SHOWS = ['open', 'done', 'cancelled', 'all'] as const;

export const OrderListInput = z.object({
  workspaceId: uuid,
  show: z.enum(ORDER_LIST_SHOWS).default('open'),
  personId: uuid.optional(),
  /** Picked up or delivered on these days, both counted: the calendar's range. */
  dueFrom: day.optional(),
  dueTo: day.optional(),
  /** A number ("1004" or "#1004"), a customer's name, or something on it. */
  search: z.string().trim().max(120).optional(),
  limit: z.int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
});

const orderLineOut = OrderLine.extend({ productId: uuid.nullable() });

export const OrderOut = z.object({
  id: uuid,
  number: z.int(),
  status,
  open: z.boolean(),
  fulfilment: fulfilment.nullable(),
  dueOn: z.string().nullable(),
  lines: z.array(orderLineOut),
  totalCents: z.number(),
  itemCount: z.int(),
  notes: z.string().nullable(),
  person: z.object({ id: uuid, name: z.string() }),
  form: z.object({ id: uuid, name: z.string() }).nullable(),
  formResponseId: uuid.nullable(),
  /** The invoice made from it, whether or not this person may see it. */
  invoiceId: uuid.nullable(),
  /** That invoice, for whoever may see it. */
  invoice: z
    .object({
      id: uuid,
      number: z.string().nullable(),
      status: z.string(),
      totalCents: z.number(),
    })
    .nullable(),
  statusChangedAt: isoDateTime.nullable(),
  /**
   * What it took off stock when it was picked up or delivered (empty before, and after it's moved back): each count by
   * product and choice ('' for a product counted as a whole), how many, and how many were left just after.
   */
  stockTaken: z
    .array(
      z.object({
        productId: z.string(),
        choiceId: z.string(),
        quantity: z.number(),
        left: z.number(),
      }),
    )
    .default([]),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type OrderOut = z.infer<typeof OrderOut>;

export const OrderListOutput = z.object({
  orders: z.array(OrderOut),
  nextCursor: z.string().nullable(),
  /** How many are still to make or hand over, whatever the list shows: the tab's count. */
  openCount: z.int(),
});

/** One order. What they answered on the form that made it is the form's own response (form.response_get). */
export const OrderGetOutput = z.object({ order: OrderOut });
