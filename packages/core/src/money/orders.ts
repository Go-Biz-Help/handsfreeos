/**
 * Orders (product sellers, the owner's pick 2a; docs/selling-products.md): what a customer ordered, where it is
 * (New, Making it, Ready, Picked up or Delivered), whether it's picked up or delivered and on what day, and the
 * invoice made from it. A sent order form makes one; so does New order on Money → Orders.
 *
 * An order keeps its own copy of each line's name and price, as an invoice does, so repricing a product never
 * reprices an order already taken. Making the invoice copies the lines again.
 *
 * Browser-safe: the web, the server and the Assistant read an order the same way.
 */
import { z } from 'zod';
import { intlTimeZone } from '../intl/engine-zones';
import { money } from './format';

/** Money → Orders, on the web. */
export const ORDERS_TAB_LABEL = 'Orders';

export const ORDER_STATUSES = ['new', 'making', 'ready', 'done', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The steps an order goes through, in order. Cancelled is off to the side. */
export const ORDER_STEPS: readonly OrderStatus[] = ['new', 'making', 'ready', 'done'];

export const ORDER_FULFILMENTS = ['pickup', 'delivery'] as const;
export type OrderFulfilment = (typeof ORDER_FULFILMENTS)[number];

export const MAX_ORDER_LINES = 200;
export const MAX_ORDER_QUANTITY = 100_000;
/** $1,000,000 a line. */
export const MAX_ORDER_UNIT_CENTS = 100_000_000;
export const MAX_ORDER_NOTES = 4_000;

/** One thing ordered: "T-shirt (Adult 2XL)" × 5 at $14. */
export const OrderLine = z.object({
  /** The price-list product it came from; null for a line typed by hand or a form row of its own. */
  productId: z.uuid().nullable().default(null),
  /** The product's choices it was ordered in (Adult 2XL, Black), for counting stock by choice later. */
  choiceIds: z
    .array(z.string().regex(/^v_[a-z0-9]{8}$/))
    .max(3)
    .default(() => []),
  name: z
    .string()
    .trim()
    .min(1, 'Name each thing on the order.')
    .max(200, 'Keep a line’s name under 200 characters.'),
  quantity: z
    .int('Order whole numbers.')
    .min(1, 'Order at least one of each line, or take the line off.')
    .max(MAX_ORDER_QUANTITY, `Keep a line under ${MAX_ORDER_QUANTITY.toLocaleString('en-US')}.`),
  unitPriceCents: z
    .int()
    .min(0, 'A price can’t be below $0.')
    .max(MAX_ORDER_UNIT_CENTS, 'Keep a price under $1,000,000.'),
  taxable: z.boolean().default(true),
});
export type OrderLine = z.infer<typeof OrderLine>;
export type OrderLineInput = z.input<typeof OrderLine>;

export const OrderLines = z
  .array(OrderLine)
  .max(MAX_ORDER_LINES, `An order holds up to ${MAX_ORDER_LINES} lines.`);

type Priced = Pick<OrderLine, 'quantity' | 'unitPriceCents'>;

export const orderLineCents = (line: Priced): number => line.quantity * line.unitPriceCents;

export const orderTotalCents = (lines: readonly Priced[]): number =>
  lines.reduce((sum, l) => sum + orderLineCents(l), 0);

/** How many things in all: "24 items". */
export const orderItemCount = (lines: readonly Pick<OrderLine, 'quantity'>[]): number =>
  lines.reduce((sum, l) => sum + l.quantity, 0);

/** Still to make or hand over. */
export const isOpenOrder = (status: OrderStatus): boolean =>
  status === 'new' || status === 'making' || status === 'ready';

/** "#1004", the way the list, the page and the Assistant name an order. */
export const orderNumberWords = (n: number): string => `#${n}`;

/** What its status is called, which for Ready and done depends on whether it's picked up or delivered. */
export function orderStatusWords(
  status: OrderStatus,
  fulfilment: OrderFulfilment | null | undefined,
): string {
  switch (status) {
    case 'new':
      return 'New';
    case 'making':
      return 'Making it';
    case 'ready':
      return fulfilment === 'pickup'
        ? 'Ready for pickup'
        : fulfilment === 'delivery'
          ? 'Ready to deliver'
          : 'Ready';
    case 'done':
      return fulfilment === 'pickup'
        ? 'Picked up'
        : fulfilment === 'delivery'
          ? 'Delivered'
          : 'Done';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** The step after this one, or null once it's done or cancelled. */
export function nextOrderStatus(status: OrderStatus): OrderStatus | null {
  const at = ORDER_STEPS.indexOf(status);
  return at === -1 || at === ORDER_STEPS.length - 1 ? null : ORDER_STEPS[at + 1]!;
}

/** The button that moves it to `to`: "Start making it", "Mark ready", "Mark picked up". */
export function orderStepLabel(
  to: OrderStatus,
  fulfilment: OrderFulfilment | null | undefined,
): string {
  switch (to) {
    case 'new':
      return 'Back to new';
    case 'making':
      return 'Start making it';
    case 'ready':
      return 'Mark ready';
    case 'done':
      return fulfilment === 'pickup'
        ? 'Mark picked up'
        : fulfilment === 'delivery'
          ? 'Mark delivered'
          : 'Mark done';
    case 'cancelled':
      return 'Cancel the order';
  }
}

export const fulfilmentWords = (f: OrderFulfilment | null | undefined): string =>
  f === 'pickup' ? 'Pickup' : f === 'delivery' ? 'Delivery' : 'Pickup or delivery';

/**
 * Whether words a customer picked mean pickup or delivery: "Pickup", "I'll pick it up", "Delivery", "Ship it",
 * "Local drop-off". Null when they say neither.
 */
export function fulfilmentFromWords(text: string): OrderFulfilment | null {
  const t = text.toLowerCase();
  if (/\b(deliver(y|ed)?|ship(ping|ped)?|mail(ed)?|drop[\s-]?off|bring it)\b/.test(t))
    return 'delivery';
  if (/\b(pick[\s-]?(it\s+)?up|pickup|collect(ion)?|in[\s-](store|person)|curbside)\b/.test(t))
    return 'pickup';
  return null;
}

/** "Sat, Dec 5", for a day kept as YYYY-MM-DD: the day itself, whatever the time zone. */
export function orderDayWords(dueOn: string): string {
  const at = new Date(`${dueOn}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return dueOn;
  return at.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: intlTimeZone('UTC'),
  });
}

/** "Pickup Sat, Dec 5", "Delivery", "Due Sat, Dec 5", or null when neither is known. */
export function orderWhenWords(
  fulfilment: OrderFulfilment | null | undefined,
  dueOn: string | null | undefined,
): string | null {
  if (!fulfilment && !dueOn) return null;
  const how = fulfilment === 'pickup' ? 'Pickup' : fulfilment === 'delivery' ? 'Delivery' : 'Due';
  return dueOn ? `${how} ${orderDayWords(dueOn)}` : how;
}

/** Which orders Money → Orders shows, in its filter. */
export const ORDER_SHOW_WORDS = {
  open: 'Still to do',
  done: 'Picked up or delivered',
  cancelled: 'Cancelled',
  all: 'Every order',
} as const;

/** What an empty Orders list says. */
export function ordersEmpty(filtered: boolean): { title: string; body: string } {
  return filtered
    ? { title: 'No orders match', body: 'Try another search, or show every order.' }
    : {
        title: 'No orders yet',
        body: 'Orders customers send on an order form land here, and so does one you take with New order.',
      };
}

/** "T-shirt (Adult M) × 5, Mug × 2 and 3 more", short enough for a list row. */
export function orderSummary(
  lines: readonly Pick<OrderLine, 'name' | 'quantity'>[],
  show = 2,
): string {
  if (!lines.length) return 'Nothing on it yet';
  const shown = lines.slice(0, show).map((l) => `${l.name} × ${l.quantity}`);
  const more = lines.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/** "24 items · $312", or "24 items" when nothing on it has a price yet. */
export function orderSizeWords(lines: readonly Priced[]): string {
  const n = orderItemCount(lines);
  const items = `${n.toLocaleString('en-US')} ${n === 1 ? 'item' : 'items'}`;
  const total = orderTotalCents(lines);
  return total > 0 ? `${items} · ${money(total)}` : items;
}

/** The order's lines as an invoice's, each keeping the order's name and price. */
export function orderInvoiceLines(lines: readonly OrderLine[]): {
  productId: string | null;
  name: string;
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
}[] {
  return lines.map((l) => ({
    productId: l.productId,
    name: l.name,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    taxable: l.taxable,
  }));
}
