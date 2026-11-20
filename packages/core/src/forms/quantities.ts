/**
 * "How many of each" (`type: 'quantities'`): rows the business names, each with a number box beside it, the total
 * under them, and what it all comes to when the rows have prices. A T-shirt order's sizes, a bakery's flavours, a
 * craft fair's mugs, tumblers, keychains and pins: anything somebody orders several of, in more than one kind.
 *
 * The answer is how many of each row by the row's id (`QuantitiesAnswer`), so rewording "Adult M" keeps every order
 * already given pointing at it. The rows are the question's `config.choices`, edited with a choice's ops.
 *
 * Browser-safe: the public page, the phone, the editor's preview and the server all read an answer the same way.
 */
import { money } from '../money/format';
import {
  MAX_QUANTITY,
  isQuantitiesAnswer,
  type QuantitiesAnswer,
  type QuantityRow,
} from './questions';

/** The parts of a "How many of each" question these read. */
export interface QuantitiesQuestion {
  readonly type: string;
  readonly config?: unknown;
}

interface QuantitiesConfig {
  readonly choices?: readonly QuantityRow[];
  readonly minTotal?: number | null;
  readonly maxTotal?: number | null;
  readonly unit?: string;
  readonly showPrices?: boolean;
}

const configOf = (question: QuantitiesQuestion): QuantitiesConfig =>
  (question.config ?? {}) as QuantitiesConfig;

/** The rows of a "How many of each" question, in order. */
export function quantityRowsOf(question: QuantitiesQuestion): readonly QuantityRow[] {
  return question.type === 'quantities' ? (configOf(question).choices ?? []) : [];
}

/** A row's price in cents, or null when it has none. */
export const rowPriceCents = (row: Pick<QuantityRow, 'price'>): number | null =>
  row.price === null || row.price === undefined ? null : Math.round(row.price * 100);

/** Whether any row has a price, so the question has something to add up in dollars. */
export function hasQuantityPrices(question: QuantitiesQuestion): boolean {
  return quantityRowsOf(question).some((row) => rowPriceCents(row) !== null);
}

/**
 * An answer as it should be kept: only rows the question has, only whole numbers above 0. A row typed back to 0 or
 * left blank isn't kept, so nothing ordered is `{}`.
 */
export function cleanQuantities(question: QuantitiesQuestion, value: unknown): QuantitiesAnswer {
  if (!isQuantitiesAnswer(value)) return {};
  const out: Record<string, number> = {};
  for (const row of quantityRowsOf(question)) {
    const n = value[row.id];
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[row.id] = n;
  }
  return out;
}

/** How many in all. */
export function quantityTotal(value: unknown): number {
  if (!isQuantitiesAnswer(value)) return 0;
  return Object.values(value).reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? n : 0), 0);
}

/** One row they ordered, with what it comes to. */
export interface QuantityLine {
  readonly rowId: string;
  readonly label: string;
  readonly count: number;
  /** One of it, in cents; null when the row has no price. */
  readonly priceCents: number | null;
  /** count × price, in cents; null when the row has no price. */
  readonly amountCents: number | null;
  readonly productId: string | null;
}

/** The rows they ordered, in the question's order, each with its count and what it comes to. */
export function quantityLines(question: QuantitiesQuestion, value: unknown): QuantityLine[] {
  const counts = cleanQuantities(question, value);
  return quantityRowsOf(question)
    .filter((row) => counts[row.id])
    .map((row) => {
      const count = counts[row.id]!;
      const priceCents = rowPriceCents(row);
      return {
        rowId: row.id,
        label: row.label,
        count,
        priceCents,
        amountCents: priceCents === null ? null : priceCents * count,
        productId: row.productId ?? null,
      };
    });
}

/** What the order comes to, in cents, over the rows that have a price; null when no row has one. */
export function quantityWorthCents(question: QuantitiesQuestion, value: unknown): number | null {
  if (!hasQuantityPrices(question)) return null;
  return quantityLines(question, value).reduce((sum, line) => sum + (line.amountCents ?? 0), 0);
}

/** "24 shirts", "1 mug", or "24 in all" when the business didn't say what it counts. */
export function quantityTotalWords(count: number, unit = ''): string {
  const word = unit.trim();
  if (!word) return `${count} in all`;
  if (count === 1) return `1 ${singular(word)}`;
  return `${count} ${word}`;
}

/** "shirts" → "shirt", "boxes" → "box", "pieces" → "piece". A word that isn't a plural is kept. */
function singular(word: string): string {
  if (/(ches|shes|xes|sses|zes)$/i.test(word)) return word.slice(0, -2);
  if (/ies$/i.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/[^s]s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * An answer in words, for the timeline, the Results screen and the export: "Adult M × 5, Adult L × 3 · 8 shirts ·
 * $96". Null when nothing was ordered.
 */
export function quantitiesWords(question: QuantitiesQuestion, value: unknown): string | null {
  const lines = quantityLines(question, value);
  if (!lines.length) return null;
  const config = configOf(question);
  const parts = [
    lines.map((line) => `${line.label} × ${line.count}`).join(', '),
    quantityTotalWords(quantityTotal(cleanQuantities(question, value)), config.unit),
  ];
  const worth = quantityWorthCents(question, value);
  if (worth !== null) parts.push(money(worth));
  return parts.join(' · ');
}

/**
 * What's wrong with a "How many of each" answer, or null when it will do. Nothing ordered is no answer, which the
 * caller turns into "Answer this one." on a question that must be answered.
 */
export function quantitiesProblem(question: QuantitiesQuestion, value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'Enter how many you’d like.';
  const known = new Set(quantityRowsOf(question).map((row) => row.id));
  for (const [rowId, n] of Object.entries(value as Record<string, unknown>)) {
    if (!known.has(rowId))
      return 'One of those isn’t on the list. Pick from the rows shown, or refresh the page.';
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return 'Whole numbers only.';
    if (n > MAX_QUANTITY) return `Up to ${MAX_QUANTITY.toLocaleString('en-US')} of each.`;
  }
  const total = quantityTotal(value);
  // Nothing ordered is no answer: whether that will do is the question's Required, which the caller checks.
  if (total === 0) return null;
  const config = configOf(question);
  const unit = config.unit ?? '';
  const amount = (n: number) => quantityTotalWords(n, unit).replace(' in all', '');
  if (config.minTotal && total < config.minTotal)
    return `The least is ${amount(config.minTotal)} in all. You have ${total}.`;
  if (config.maxTotal && total > config.maxTotal)
    return `The most is ${amount(config.maxTotal)} in all. You have ${total}.`;
  return null;
}
