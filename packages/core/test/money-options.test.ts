/**
 * Product options (product sellers, 3a): sizes, colors and other choices with price bumps, read the same way by the
 * price list, the estimate and invoice picker, a form's rows and the AI teammate.
 */
import { describe, expect, it } from 'vitest';
import {
  choiceBumpWords,
  choicesFromWords,
  nameWithChoices,
  optionsInWords,
  optionsProblem,
  parseMoneyChange,
  pickedChoices,
  priceWithChoices,
  ProductOptions,
  withOptionIds,
} from '../src/money/options';
import { priceListCents, rowsFromOption } from '../src/forms/quantities';

const shirt = {
  name: 'T-shirt',
  unitPriceCents: 1200,
  options: withOptionIds([
    {
      name: 'Size',
      choices: [
        { label: 'Youth S', priceCents: -200 },
        { label: 'Adult M', priceCents: 0 },
        { label: 'Adult 2XL', priceCents: 200 },
      ],
    },
    {
      name: 'Color',
      choices: [
        { label: 'Black', priceCents: 0 },
        { label: 'White', priceCents: 0 },
      ],
    },
  ]),
};
const size = shirt.options[0]!;
const color = shirt.options[1]!;

describe('Product options', () => {
  it('gives every option and choice an id, and keeps the ones it had by name', () => {
    expect(size.id).toMatch(/^o_[a-z0-9]{8}$/);
    expect(size.choices.every((c) => /^v_[a-z0-9]{8}$/.test(c.id))).toBe(true);
    // The Assistant sends options without ids: Adult 2XL keeps its id, so a form row made from it still finds it.
    const again = withOptionIds(
      [
        {
          name: 'size',
          choices: [
            { label: 'adult 2xl ', priceCents: 300 },
            { label: 'Adult 3XL', priceCents: 300 },
          ],
        },
      ],
      shirt.options,
    );
    expect(again[0]!.id).toBe(size.id);
    expect(again[0]!.choices[0]!.id).toBe(size.choices[2]!.id);
    expect(again[0]!.choices[1]!.id).not.toBe(size.choices[2]!.id);
  });

  it('prices and names a line with the choices picked', () => {
    const picked = pickedChoices(shirt, { [size.id]: size.choices[2]!.id });
    expect(picked.missing.map((o) => o.name)).toEqual(['Color']);
    const both = pickedChoices(shirt, {
      [size.id]: size.choices[2]!.id,
      [color.id]: color.choices[0]!.id,
    });
    expect(both.missing).toEqual([]);
    expect(nameWithChoices(shirt.name, both.choices)).toBe('T-shirt (Adult 2XL, Black)');
    expect(priceWithChoices(shirt.unitPriceCents, both.choices)).toBe(1400);
    expect(priceWithChoices(100, [{ priceCents: -500 }])).toBe(0);
    expect(nameWithChoices('Mug', [])).toBe('Mug');
  });

  it('refuses two options alike, a choice twice, and a mix that costs less than nothing', () => {
    const one = (label: string, priceCents = 0) => ({ label, priceCents });
    expect(
      optionsProblem(1200, [
        { name: 'Size', choices: [one('S')] },
        { name: 'size', choices: [one('M')] },
      ])?.path,
    ).toBe('options.1.name');
    expect(
      optionsProblem(1200, [{ name: 'Color', choices: [one('Black'), one('black ')] }]),
    ).toMatchObject({
      path: 'options.0.choices.1.label',
      message: 'Color has black twice. Take one out.',
    });
    const cheap = optionsProblem(500, [
      { name: 'Size', choices: [one('Adult M'), one('Youth S', -300)] },
      { name: 'Color', choices: [one('Plain', -300)] },
    ]);
    expect(cheap?.path).toBe('options.0.choices.1.priceCents');
    expect(cheap?.message).toMatch(/^Youth S with Plain would cost less than nothing/);
    expect(optionsProblem(1200, shirt.options)).toBeNull();
    // The schema holds the counts.
    expect(ProductOptions.safeParse([{ name: 'Size', choices: [] }]).success).toBe(false);
    expect(
      ProductOptions.safeParse(
        Array.from({ length: 4 }, (_, i) => ({ name: `O${i}`, choices: [one('A')] })),
      ).success,
    ).toBe(false);
  });

  it('reads a price change as typed', () => {
    expect(parseMoneyChange('2')).toBe(200);
    expect(parseMoneyChange('+$2.50')).toBe(250);
    expect(parseMoneyChange('-1')).toBe(-100);
    expect(parseMoneyChange('−$1.50')).toBe(-150);
    expect(parseMoneyChange('')).toBe(0);
    expect(parseMoneyChange('-0')).toBe(0);
    expect(parseMoneyChange('two')).toBeNull();
    expect(choiceBumpWords(200)).toBe('+$2');
    expect(choiceBumpWords(-150)).toBe('−$1.50');
    expect(choiceBumpWords(0)).toBe('');
  });

  it('matches the choices the AI names, and says plainly what’s missing or unknown', () => {
    const ok = choicesFromWords(shirt, ['black', ' adult 2xl']);
    expect('choices' in ok && ok.choices.map((c) => c.label)).toEqual(['Adult 2XL', 'Black']);
    expect(choicesFromWords(shirt, ['Adult M'])).toEqual({
      problem: 'T-shirt comes in more than one Color. Say which in choices: Black, White.',
    });
    expect(choicesFromWords(shirt, ['Adult M', 'Black', 'Huge'])).toMatchObject({
      problem: expect.stringMatching(/^T-shirt has no choice called huge\. Its choices are: Size/),
    });
    expect(choicesFromWords({ name: 'Pin', unitPriceCents: 300 }, ['Gold'])).toEqual({
      problem: 'Pin has no sizes or other choices. Leave choices out for it.',
    });
    expect(optionsInWords(shirt)).toBe(
      'pick one Size: Youth S (−$2), Adult M, Adult 2XL (+$2); pick one Color: Black, White',
    );
    expect(optionsInWords(shirt, false)).toBe(
      'pick one Size: Youth S, Adult M, Adult 2XL; pick one Color: Black, White',
    );
  });

  it('makes a form row per size, each at its price, and spots when the price list moved on', () => {
    const product = {
      id: '00000000-0000-4000-8000-000000000001',
      priceCents: 1200,
      options: shirt.options,
    };
    const rows = rowsFromOption(product, size);
    expect(rows.map((r) => [r.label, r.price])).toEqual([
      ['Youth S', 10],
      ['Adult M', 12],
      ['Adult 2XL', 14],
    ]);
    expect(priceListCents({ optionChoiceId: rows[2]!.optionChoiceId }, product)).toBe(1400);
    expect(priceListCents({ optionChoiceId: null }, product)).toBe(1200);
    expect(priceListCents({ optionChoiceId: 'v_gone0000' }, product)).toBeNull();
  });
});
