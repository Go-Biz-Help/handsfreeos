/**
 * Product options (product sellers, pick 3a): a product that comes in sizes, colors or any other choice the business
 * names, each choice with its own price bump. "T-shirt, $12" with Size (Youth S … Adult 2XL +$2) and Color (Black,
 * White) is one product on the price list, not twenty, and it works the same for a mug (11 oz, 15 oz +$3), a
 * tumbler, a keychain or a pin.
 *
 * Picking a product with options always means picking one choice of each: the line it makes reads
 * "T-shirt (Adult 2XL, Black)" at $12 + $2, and keeps that copy for good, as every line does. A choice's bump may be
 * below zero (Youth sizes $2 less), never so far that any choice costs less than nothing.
 *
 * Browser-safe and shared: Settings → Payments → Products, the estimate and invoice picker, a form's "How many of
 * each" rows, the AI teammate's bills and `product.create` / `product.update` all read options with these.
 */
import { z } from 'zod';
import { money, parseMoney } from './format';

export const MAX_PRODUCT_OPTIONS = 3;
export const MAX_OPTION_CHOICES = 40;
/** The most one choice may add or take off: $100,000. */
export const MAX_CHOICE_BUMP_CENTS = 10_000_000;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const OPTION_ID_RE = /^o_[a-z0-9]{8}$/;
const CHOICE_ID_RE = /^v_[a-z0-9]{8}$/;

/** Even odds for every letter: bytes from 252 up are thrown away, since 252 is the last multiple of 36 below 256. */
function randomChars(count: number): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < count) {
    for (const b of crypto.getRandomValues(new Uint8Array(count))) {
      if (b < limit && out.length < count) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

export const newOptionId = (): string => `o_${randomChars(8)}`;
export const newOptionChoiceId = (): string => `v_${randomChars(8)}`;

/** One choice of an option: "Adult 2XL", and what it adds to the product's price (+$2 is 200). */
export const ProductChoice = z.object({
  /** Left out, one is made. Kept when the choice is renamed, so a form row made from it still finds it. */
  id: z.string().regex(CHOICE_ID_RE).optional(),
  label: z.string().trim().min(1, 'Name the choice.').max(60, 'Keep a choice under 60 characters.'),
  priceCents: z.int().min(-MAX_CHOICE_BUMP_CENTS).max(MAX_CHOICE_BUMP_CENTS).default(0),
});

/** One option: "Size", and its choices in the order a customer sees them. */
export const ProductOption = z.object({
  id: z.string().regex(OPTION_ID_RE).optional(),
  name: z.string().trim().min(1, 'Name the option, like Size or Color.').max(40),
  choices: z
    .array(ProductChoice)
    .min(1, 'Add at least one choice.')
    .max(MAX_OPTION_CHOICES, `An option holds up to ${MAX_OPTION_CHOICES} choices.`),
});

export const ProductOptions = z
  .array(ProductOption)
  .max(MAX_PRODUCT_OPTIONS, `A product has up to ${MAX_PRODUCT_OPTIONS} options.`);

export interface OptionChoice {
  readonly id: string;
  readonly label: string;
  readonly priceCents: number;
}
export interface ProductOptionRow {
  readonly id: string;
  readonly name: string;
  readonly choices: readonly OptionChoice[];
}
export type ProductOptionsInput = z.input<typeof ProductOptions>;

/** What these read off a product. */
export interface OptionedProduct {
  readonly name: string;
  readonly unitPriceCents: number;
  readonly options?: readonly ProductOptionRow[] | null;
}

/** A product's options as stored, or none: a row from before options read as none. */
export function productOptionsOf(product: {
  readonly options?: unknown;
}): readonly ProductOptionRow[] {
  const list = product.options;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (o): o is ProductOptionRow =>
      !!o &&
      typeof o === 'object' &&
      typeof (o as ProductOptionRow).id === 'string' &&
      Array.isArray((o as ProductOptionRow).choices),
  );
}

/** Whether picking this product means picking choices. */
export const productHasOptions = (product: { readonly options?: unknown }): boolean =>
  productOptionsOf(product).length > 0;

/** Options as a person or the AI sends them: ids are there for what already existed, and may be left out. */
export type OptionsDraft = readonly {
  readonly id?: string;
  readonly name: string;
  readonly choices: readonly {
    readonly id?: string;
    readonly label: string;
    readonly priceCents: number;
  }[];
}[];

/**
 * Options as they're kept: every option and choice with an id. One sent without an id takes the id of the one it
 * had by the same name (Size, Adult 2XL), so a form row made from a choice still finds it; anything new gets a new id.
 */
export function withOptionIds(
  options: OptionsDraft,
  had: readonly ProductOptionRow[] = [],
): { id: string; name: string; choices: OptionChoice[] }[] {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  return options.map((o) => {
    const before = o.id ? had.find((h) => h.id === o.id) : had.find((h) => same(h.name, o.name));
    return {
      id: o.id ?? before?.id ?? newOptionId(),
      name: o.name.trim(),
      choices: o.choices.map((c) => ({
        id: c.id ?? before?.choices.find((x) => same(x.label, c.label))?.id ?? newOptionChoiceId(),
        label: c.label.trim(),
        priceCents: c.priceCents,
      })),
    };
  });
}

/**
 * Why these options won't do on a product at this price, or null when they will: the same name twice, the same
 * choice twice in one option, or a mix of choices that would cost less than nothing. Each problem names the option
 * or choice, with `path` pointing at it (options.1.choices.3.label).
 */
export function optionsProblem(
  unitPriceCents: number,
  options: OptionsDraft,
): { readonly path: string; readonly message: string } | null {
  const names = new Set<string>();
  const optionIds = new Set<string>();
  const choiceIds = new Set<string>();
  for (const [i, o] of options.entries()) {
    const key = o.name.trim().toLowerCase();
    if (names.has(key))
      return {
        path: `options.${i}.name`,
        message: `There are two options called ${o.name.trim()}. Give each its own name.`,
      };
    names.add(key);
    if (o.id) {
      if (optionIds.has(o.id))
        return { path: `options.${i}.id`, message: 'Each option needs its own id.' };
      optionIds.add(o.id);
    }
    const labels = new Set<string>();
    for (const [j, c] of o.choices.entries()) {
      const label = c.label.trim().toLowerCase();
      if (labels.has(label))
        return {
          path: `options.${i}.choices.${j}.label`,
          message: `${o.name.trim()} has ${c.label.trim()} twice. Take one out.`,
        };
      labels.add(label);
      if (c.id) {
        if (choiceIds.has(c.id))
          return { path: `options.${i}.choices.${j}.id`, message: 'Each choice needs its own id.' };
        choiceIds.add(c.id);
      }
    }
  }
  // The cheapest mix: the lowest choice of every option at once.
  let cheapest = unitPriceCents;
  const lows: { i: number; j: number; label: string; cents: number }[] = [];
  for (const [i, o] of options.entries()) {
    if (!o.choices.length) continue;
    let j = 0;
    o.choices.forEach((c, k) => {
      if (c.priceCents < o.choices[j]!.priceCents) j = k;
    });
    const low = o.choices[j]!;
    cheapest += low.priceCents;
    if (low.priceCents < 0) lows.push({ i, j, label: low.label, cents: low.priceCents });
  }
  const first = lows[0];
  if (cheapest < 0 && first)
    return {
      path: `options.${first.i}.choices.${first.j}.priceCents`,
      message: `${lows.map((l) => l.label).join(' with ')} would cost less than nothing: ${money(
        unitPriceCents,
      )} ${lows.map((l) => `− ${money(-l.cents)}`).join(' ')}. Take less off, or raise the price.`,
    };
  return null;
}

/** A choice's bump in words, for beside its name: "+$2", "−$1.50", or nothing when it costs the same. */
export function choiceBumpWords(priceCents: number): string {
  if (!priceCents) return '';
  return priceCents > 0 ? `+${money(priceCents)}` : `−${money(-priceCents)}`;
}

/**
 * A price change as typed beside a choice: "2", "+2.50", "-1", "−$1.50". Null when it isn't an amount. Blank is no
 * change.
 */
export function parseMoneyChange(input: string): number | null {
  const text = (input ?? '').trim();
  const minus = /^[-−]/.test(text);
  const cents = parseMoney(text.replace(/^[-−+]\s*/, ''));
  if (cents === null || cents > MAX_CHOICE_BUMP_CENTS) return null;
  return minus && cents ? -cents : cents;
}

/** Which choice of each option was picked, by option id. */
export type OptionPicks = Readonly<Record<string, string>>;

/** The picked choices in the options' order, and the options still waiting for one. */
export function pickedChoices(
  product: { readonly options?: unknown },
  picks: OptionPicks,
): { readonly choices: readonly OptionChoice[]; readonly missing: readonly ProductOptionRow[] } {
  const choices: OptionChoice[] = [];
  const missing: ProductOptionRow[] = [];
  for (const o of productOptionsOf(product)) {
    const c = o.choices.find((x) => x.id === picks[o.id]);
    if (c) choices.push(c);
    else missing.push(o);
  }
  return { choices, missing };
}

/** What one costs with these choices: the product's price and each choice's bump, never below nothing. */
export function priceWithChoices(
  unitPriceCents: number,
  choices: readonly Pick<OptionChoice, 'priceCents'>[],
): number {
  return Math.max(
    0,
    choices.reduce((sum, c) => sum + c.priceCents, unitPriceCents),
  );
}

/** The line's name with its choices: "T-shirt (Adult 2XL, Black)". No choices, just the name. */
export function nameWithChoices(
  name: string,
  choices: readonly Pick<OptionChoice, 'label'>[],
): string {
  return choices.length ? `${name} (${choices.map((c) => c.label).join(', ')})` : name;
}

/** The choice with this id on any of the product's options, with its option. */
export function findChoice(
  product: { readonly options?: unknown },
  choiceId: string,
): { readonly option: ProductOptionRow; readonly choice: OptionChoice } | null {
  for (const option of productOptionsOf(product)) {
    const choice = option.choices.find((c) => c.id === choiceId);
    if (choice) return { option, choice };
  }
  return null;
}

/**
 * Choices named in words (the AI teammate says "Adult 2XL" and "black"), matched to one choice of each option.
 * Case and spaces don't matter. Returns the picks, or what's wrong in words a model can act on.
 */
export function choicesFromWords(
  product: OptionedProduct,
  words: readonly string[],
): { readonly choices: readonly OptionChoice[] } | { readonly problem: string } {
  const options = productOptionsOf(product);
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!options.length)
    return words.length
      ? { problem: `${product.name} has no sizes or other choices. Leave choices out for it.` }
      : { choices: [] };
  const left = words.map(norm).filter(Boolean);
  const choices: OptionChoice[] = [];
  for (const o of options) {
    const at = left.findIndex((w) => o.choices.some((c) => norm(c.label) === w));
    if (at < 0)
      return {
        problem: `${product.name} comes in more than one ${o.name}. Say which in choices: ${o.choices
          .map((c) => c.label)
          .join(', ')}.`,
      };
    choices.push(o.choices.find((c) => norm(c.label) === left[at])!);
    left.splice(at, 1);
  }
  if (left.length)
    return {
      problem: `${product.name} has no choice called ${left.join(' or ')}. Its choices are: ${options
        .map((o) => `${o.name} (${o.choices.map((c) => c.label).join(', ')})`)
        .join('; ')}.`,
    };
  return { choices };
}

/**
 * The price list's options in one line, for the AI teammate: "pick one Size: Youth S, Adult 2XL (+$2)". Without
 * prices, the bumps are left out.
 */
export function optionsInWords(product: { readonly options?: unknown }, withPrices = true): string {
  return productOptionsOf(product)
    .map(
      (o) =>
        `pick one ${o.name}: ${o.choices
          .map((c) =>
            withPrices && c.priceCents ? `${c.label} (${choiceBumpWords(c.priceCents)})` : c.label,
          )
          .join(', ')}`,
    )
    .join('; ');
}

/** Ready-made options to start from in Settings → Products. Prices start the same; the business sets its own. */
export const OPTION_STARTERS: readonly {
  readonly key: string;
  readonly label: string;
  readonly name: string;
  readonly choices: readonly string[];
}[] = [
  {
    key: 'shirt_sizes',
    label: 'Shirt sizes',
    name: 'Size',
    choices: [
      'Youth S',
      'Youth M',
      'Youth L',
      'Youth XL',
      'Adult S',
      'Adult M',
      'Adult L',
      'Adult XL',
      'Adult 2XL',
      'Adult 3XL',
      'Adult 4XL',
      'Adult 5XL',
    ],
  },
  {
    key: 'cup_sizes',
    label: 'Cup sizes',
    name: 'Size',
    choices: ['11 oz', '15 oz', '20 oz', '30 oz'],
  },
  {
    key: 'colors',
    label: 'Colors',
    name: 'Color',
    choices: ['Black', 'White', 'Gray', 'Navy', 'Red'],
  },
];
