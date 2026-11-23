/**
 * The order a sent form makes (docs/selling-products.md, "Orders"): a line for each row ordered on its "How many of
 * each" questions, the day from its date question, and pickup or delivery from the choice they picked. Only the
 * answers that were showing count, as everywhere else: `answers` here is already pruned.
 *
 * Browser-safe: the server makes the order with it, and a test reads the same answers the page sent.
 */
import { orderTotalCents, fulfilmentFromWords, type OrderFulfilment, type OrderLine } from '../money/orders';
import { findChoice, nameWithChoices } from '../money/options';
import { allQuestions, type FormDefinition } from './definition';
import type { AnswerSheet } from './logic';
import { quantitiesMakeOrder, quantityRowsOf, rowPriceCents } from './quantities';
import { isQuantitiesAnswer, type QuantityRow } from './questions';

/** A price-list product as the order reads it, for a row added from the price list. */
export interface OrderProduct {
  readonly name: string;
  readonly taxable: boolean;
  readonly options?: unknown;
}

export interface FormOrder {
  readonly lines: OrderLine[];
  readonly dueOn: string | null;
  readonly fulfilment: OrderFulfilment | null;
  readonly totalCents: number;
}

/**
 * What a row is called on the order. A row from the price list is the product's name, with its choice ("T-shirt
 * (Adult 2XL)"). Any other row is named with what the question is about: the words before a colon in its title
 * ("T-shirts: how many of each size?") or what it counts ("shirts"), so "Adult M" reads "T-shirts (Adult M)". A row
 * that already says it ("Keychains") stays as it is.
 */
export function orderLineName(
  question: { readonly title: string; readonly config?: unknown },
  row: Pick<QuantityRow, 'label' | 'productId' | 'optionChoiceId'>,
  product?: OrderProduct,
): string {
  if (product) {
    const found = row.optionChoiceId ? findChoice(product, row.optionChoiceId) : null;
    return nameWithChoices(product.name, found ? [found.choice] : []).slice(0, 200);
  }
  const colon = question.title.indexOf(':');
  const before = colon > 0 ? question.title.slice(0, colon).trim() : '';
  const unit = String((question.config as { unit?: unknown } | undefined)?.unit ?? '').trim();
  const thing =
    before && before.length <= 60
      ? before
      : unit
        ? unit.charAt(0).toUpperCase() + unit.slice(1)
        : '';
  const label = row.label.trim();
  if (!thing || thing.toLowerCase() === label.toLowerCase()) return label.slice(0, 200);
  return `${thing} (${label})`.slice(0, 200);
}

/**
 * The order these answers make, or null when nothing was ordered on a question that makes orders. Rows keep the
 * price the customer saw on the form (null is $0, for the business to price), as a form's row keeps its own copy.
 */
export function orderFromAnswers(
  definition: Pick<FormDefinition, 'pages'>,
  answers: AnswerSheet,
  products: ReadonlyMap<string, OrderProduct> = new Map(),
): FormOrder | null {
  const lines: OrderLine[] = [];
  let dueOn: string | null = null;
  let fulfilment: OrderFulfilment | null = null;
  for (const question of allQuestions(definition)) {
    const value = answers[question.id];
    if (value === undefined || value === null) continue;
    if (question.type === 'quantities') {
      if (!quantitiesMakeOrder(question) || !isQuantitiesAnswer(value)) continue;
      for (const row of quantityRowsOf(question)) {
        const count = value[row.id];
        if (!count || count < 1 || !Number.isInteger(count)) continue;
        const product = row.productId ? products.get(row.productId) : undefined;
        lines.push({
          productId: product ? row.productId : null,
          choiceIds: product && row.optionChoiceId ? [row.optionChoiceId] : [],
          name: orderLineName(question, row, product),
          quantity: count,
          unitPriceCents: rowPriceCents(row) ?? 0,
          taxable: product?.taxable ?? true,
        });
      }
    } else if (question.type === 'date' && !dueOn && typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) dueOn = value;
    } else if (question.type === 'choice' && !fulfilment && typeof value === 'string') {
      const choices =
        (question.config as { choices?: { id: string; label: string }[] } | undefined)?.choices ??
        [];
      const label = choices.find((c) => c.id === value)?.label ?? value;
      fulfilment = fulfilmentFromWords(label);
    }
  }
  if (!lines.length) return null;
  return { lines, dueOn, fulfilment, totalCents: orderTotalCents(lines) };
}
