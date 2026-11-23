/**
 * Stock counts (product sellers, pick 4a; docs/selling-products.md "Stock"): how many of a product are on hand, as a
 * whole (mugs) or by one of its options (each size of a T-shirt, each color of a tumbler). An order takes its lines
 * off when it's picked up or delivered, and puts them back if it's moved back; the database does that
 * (`private.orders_take_stock`) and keeps what it took on the order. A business can set a number to hear at.
 *
 * Browser-safe and shared: Settings → Payments → Products, the product picker, the order page, `product.create` /
 * `product.update`, the Assistant and the worker's push read stock with these.
 */
import { z } from 'zod';
import { productOptionsOf, type ProductOptionRow } from './options';

/** The most, or least, one count may say. */
export const MAX_STOCK_COUNT = 1_000_000;

/** What a product keeps about its stock, when it's counted. `counts` is by choice id, '' for the whole product. */
export interface ProductStock {
  readonly optionId: string | null;
  readonly lowAt: number | null;
  readonly counts: Readonly<Record<string, number>>;
}

const count = z
  .int('Use a whole number.')
  .min(-MAX_STOCK_COUNT, 'That’s too far below zero.')
  .max(MAX_STOCK_COUNT, 'Keep a count under a million.');

/**
 * Stock as `product.create` and `product.update` take it, by names so it can go with new options in one save:
 * `countBy` is an option's name (null counts the product as a whole), and each count names its choice (left out or ''
 * for the whole product). Only the counts sent change; the others stay as they are.
 */
export const StockInput = z.object({
  countBy: z.string().trim().min(1).max(40).nullable().default(null),
  lowAt: z
    .int('Use a whole number.')
    .min(0, 'Use 0 or more.')
    .max(MAX_STOCK_COUNT)
    .nullable()
    .default(null),
  counts: z
    .array(z.object({ choice: z.string().trim().max(60).default(''), onHand: count }))
    .max(40)
    .default([]),
});
export type StockInput = z.output<typeof StockInput>;

export interface ResolvedStock {
  readonly optionId: string | null;
  readonly lowAt: number | null;
  readonly counts: readonly { readonly choiceId: string; readonly onHand: number }[];
}

/**
 * Stock as it'll be kept, against the product's options after the save, or the refusal in words: an option or a
 * choice it names that the product doesn't have.
 */
export function resolveStock(
  productName: string,
  input: StockInput,
  options: readonly ProductOptionRow[],
): { stock: ResolvedStock } | { problem: { path: string; message: string } } {
  const by = input.countBy
    ? options.find((o) => o.name.toLowerCase() === input.countBy!.toLowerCase())
    : null;
  if (input.countBy && !by)
    return {
      problem: {
        path: 'stock.countBy',
        message: `${productName} has no option called ${input.countBy} to count stock by. Count it as a whole, or by ${
          options.length ? options.map((o) => o.name).join(' or ') : 'an option you add first'
        }.`,
      },
    };
  const counts: { choiceId: string; onHand: number }[] = [];
  for (const c of input.counts) {
    if (!by) {
      if (c.choice)
        return {
          problem: {
            path: 'stock.counts',
            message: `${productName} is counted as a whole, so a count can’t be for ${c.choice}. Count it by an option first.`,
          },
        };
      counts.push({ choiceId: '', onHand: c.onHand });
      continue;
    }
    const choice = by.choices.find((x) => x.label.toLowerCase() === c.choice.toLowerCase());
    if (!choice)
      return {
        problem: {
          path: 'stock.counts',
          message: c.choice
            ? `${by.name} on ${productName} has no ${c.choice}. Pick one of ${by.choices.map((x) => x.label).join(', ')}.`
            : `${productName} is counted by ${by.name}, so say which ${by.name.toLowerCase()} each count is for.`,
        },
      };
    counts.push({ choiceId: choice.id, onHand: c.onHand });
  }
  // The last count for a choice wins, as when a box is typed in twice.
  const byChoice = new Map(counts.map((c) => [c.choiceId, c]));
  return {
    stock: { optionId: by?.id ?? null, lowAt: input.lowAt, counts: [...byChoice.values()] },
  };
}

/** One row of a product's stock: the whole product, or one choice of the option it's counted by. */
export interface StockRow {
  readonly choiceId: string;
  /** The choice's label, or null for the whole product. */
  readonly label: string | null;
  readonly onHand: number;
}

/** What a product's stock shows, in the option's order; a choice nobody counted yet is 0. */
export function stockRows(product: {
  readonly options?: unknown;
  readonly stock: ProductStock | null;
}): StockRow[] {
  const stock = product.stock;
  if (!stock) return [];
  const option = stock.optionId
    ? productOptionsOf(product).find((o) => o.id === stock.optionId)
    : null;
  if (!option) return [{ choiceId: '', label: null, onHand: stock.counts[''] ?? 0 }];
  return option.choices.map((c) => ({
    choiceId: c.id,
    label: c.label,
    onHand: stock.counts[c.id] ?? 0,
  }));
}

export type StockState = 'ok' | 'low' | 'out';

/** Out at 0 or below, low at or under the number to hear at, else fine. */
export const stockState = (onHand: number, lowAt: number | null): StockState =>
  onHand <= 0 ? 'out' : lowAt !== null && onHand <= lowAt ? 'low' : 'ok';

/** "12 on hand", "2 left", "Out", "3 more went out than counted". */
export function stockWords(onHand: number, lowAt: number | null): string {
  if (onHand < 0) return `Out · ${-onHand} more went out than counted`;
  if (onHand === 0) return 'Out';
  return stockState(onHand, lowAt) === 'low' ? `${onHand} left` : `${onHand} on hand`;
}

/** The chip's short word in the picker: "3 left", "Out", or nothing when there's plenty. */
export function stockChipWords(onHand: number, lowAt: number | null): string | null {
  const state = stockState(onHand, lowAt);
  return state === 'out' ? 'Out' : state === 'low' ? `${onHand} left` : null;
}

/**
 * The products list's line: "38 on hand", or "38 on hand · 2 sizes low · 1 out" when counted by an option. Null when
 * it isn't counted.
 */
export function stockSummary(product: {
  readonly options?: unknown;
  readonly stock: ProductStock | null;
}): string | null {
  const stock = product.stock;
  if (!stock) return null;
  const rows = stockRows(product);
  const total = rows.reduce((n, r) => n + Math.max(0, r.onHand), 0);
  if (rows.length === 1 && rows[0]!.label === null) return stockWords(rows[0]!.onHand, stock.lowAt);
  const option = productOptionsOf(product).find((o) => o.id === stock.optionId);
  const noun = (option?.name ?? 'choice').toLowerCase();
  const low = rows.filter((r) => stockState(r.onHand, stock.lowAt) === 'low').length;
  const out = rows.filter((r) => stockState(r.onHand, stock.lowAt) === 'out').length;
  const parts = [`${total} on hand`];
  if (low) parts.push(`${low} ${low === 1 ? noun : `${noun}s`} low`);
  if (out) parts.push(`${out} out`);
  return parts.join(' · ');
}

/** Whether a product's stock wants a look: something low or out. */
export const stockWantsLook = (product: {
  readonly options?: unknown;
  readonly stock: ProductStock | null;
}): boolean =>
  !!product.stock &&
  stockRows(product).some((r) => stockState(r.onHand, product.stock!.lowAt) !== 'ok');

/**
 * Which count a line comes off, or null when it isn't counted: '' for a product counted as a whole, else the line's
 * choice of the option it's counted by (a line without one isn't counted). As the database works it out.
 */
export function stockChoiceOf(
  product: { readonly stock: ProductStock | null; readonly options?: unknown },
  choiceIds: readonly string[],
): string | null {
  const stock = product.stock;
  if (!stock) return null;
  if (!stock.optionId) return '';
  const option = productOptionsOf(product).find((o) => o.id === stock.optionId);
  return option?.choices.find((c) => choiceIds.includes(c.id))?.id ?? null;
}

/** What an order took off stock when it was done, as the database keeps it (`orders.stock_taken`). */
export const StockTaken = z.object({
  productId: z.string(),
  choiceId: z.string(),
  quantity: z.number(),
  /** The count just after. */
  left: z.number(),
  /** The product's number to hear at then. */
  lowAt: z.number().nullable().default(null),
});
export type StockTaken = z.output<typeof StockTaken>;

/** The kept list, leaving out anything that doesn't read. */
export const stockTakenOf = (value: unknown): StockTaken[] =>
  Array.isArray(value)
    ? value.flatMap((v) => {
        const parsed = StockTaken.safeParse(v);
        return parsed.success ? [parsed.data] : [];
      })
    : [];

/** The counts this order took down to its number or under, from above it: each is told once, when it crosses. */
export const stockCrossedLow = (taken: readonly StockTaken[]): StockTaken[] =>
  taken.filter((t) => t.lowAt !== null && t.left <= t.lowAt && t.left + t.quantity > t.lowAt);

/** The push and the bell: "Running low: T-shirt (Adult M)", "2 left after Order #1004." */
export function stockLowWords(
  name: string,
  left: number,
  orderNumber: number,
): { title: string; body: string } {
  return {
    title: `Running low: ${name}`,
    body:
      left <= 0
        ? `None left after Order #${orderNumber}. Count more in Settings → Payments → Products.`
        : `${left} left after Order #${orderNumber}. Count more in Settings → Payments → Products.`,
  };
}
