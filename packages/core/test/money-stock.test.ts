/** Stock's shared words and rules (packages/core/src/money/stock.ts), with no database. */
import { describe, expect, it } from 'vitest';
import {
  resolveStock,
  StockInput,
  stockChipWords,
  stockChoiceOf,
  stockCrossedLow,
  stockLowWords,
  stockRows,
  stockSummary,
  stockTakenOf,
  stockWords,
} from '../src/money/stock';

const options = [
  {
    id: 'o_size0000',
    name: 'Size',
    choices: [
      { id: 'v_m0000000', label: 'Adult M', priceCents: 0 },
      { id: 'v_xl000000', label: 'Adult XL', priceCents: 200 },
      { id: 'v_2xl00000', label: 'Adult 2XL', priceCents: 200 },
    ],
  },
  {
    id: 'o_color000',
    name: 'Color',
    choices: [{ id: 'v_black000', label: 'Black', priceCents: 0 }],
  },
];
const shirt = {
  options,
  stock: { optionId: 'o_size0000', lowAt: 3, counts: { v_m0000000: 10, v_xl000000: 2 } },
};

describe('stock words', () => {
  it('says what’s on hand, low and out', () => {
    expect(stockWords(12, 3)).toBe('12 on hand');
    expect(stockWords(3, 3)).toBe('3 left');
    expect(stockWords(0, 3)).toBe('Out');
    expect(stockWords(-2, null)).toBe('Out · 2 more went out than counted');
    expect(stockChipWords(12, 3)).toBeNull();
    expect(stockChipWords(2, 3)).toBe('2 left');
    expect(stockChipWords(0, null)).toBe('Out');
  });

  it('lists every choice of the option it’s counted by, uncounted ones at 0', () => {
    expect(stockRows(shirt)).toEqual([
      { choiceId: 'v_m0000000', label: 'Adult M', onHand: 10 },
      { choiceId: 'v_xl000000', label: 'Adult XL', onHand: 2 },
      { choiceId: 'v_2xl00000', label: 'Adult 2XL', onHand: 0 },
    ]);
    expect(stockSummary(shirt)).toBe('12 on hand · 1 size low · 1 out');
    expect(stockSummary({ stock: { optionId: null, lowAt: null, counts: { '': 6 } } })).toBe(
      '6 on hand',
    );
    expect(stockSummary({ stock: null })).toBeNull();
  });

  it('finds the count a line comes off', () => {
    expect(stockChoiceOf(shirt, ['v_xl000000', 'v_black000'])).toBe('v_xl000000');
    expect(stockChoiceOf(shirt, ['v_black000'])).toBeNull();
    expect(stockChoiceOf({ stock: { optionId: null, lowAt: null, counts: {} } }, [])).toBe('');
    expect(stockChoiceOf({ stock: null }, [])).toBeNull();
  });

  it('tells once, when an order takes a count down to the number', () => {
    const taken = stockTakenOf([
      { productId: 'p', choiceId: 'a', quantity: 2, left: 3, lowAt: 3 },
      { productId: 'p', choiceId: 'b', quantity: 2, left: 1, lowAt: 3 },
      { productId: 'p', choiceId: 'c', quantity: 2, left: 9, lowAt: 3 },
      { productId: 'p', choiceId: 'd', quantity: 2, left: 0, lowAt: null },
      { nonsense: true },
    ]);
    expect(taken).toHaveLength(4);
    expect(stockCrossedLow(taken).map((t) => t.choiceId)).toEqual(['a']);
    expect(stockLowWords('T-shirt (Adult M)', 3, 1004)).toEqual({
      title: 'Running low: T-shirt (Adult M)',
      body: '3 left after Order #1004. Count more in Settings → Payments → Products.',
    });
    expect(stockLowWords('Mug', 0, 1005).body).toMatch(/^None left/);
  });
});

describe('resolving stock sent by name', () => {
  it('matches the option and choices without minding case', () => {
    const out = resolveStock(
      'T-shirt',
      StockInput.parse({ countBy: 'size', counts: [{ choice: 'adult m', onHand: 4 }] }),
      options,
    );
    expect(out).toEqual({
      stock: {
        optionId: 'o_size0000',
        lowAt: null,
        counts: [{ choiceId: 'v_m0000000', onHand: 4 }],
      },
    });
  });

  it('names what’s wrong', () => {
    const noOption = resolveStock('T-shirt', StockInput.parse({ countBy: 'Flavor' }), options);
    expect('problem' in noOption && noOption.problem.message).toBe(
      'T-shirt has no option called Flavor to count stock by. Count it as a whole, or by Size or Color.',
    );
    const noChoice = resolveStock(
      'T-shirt',
      StockInput.parse({ countBy: 'Size', counts: [{ choice: 'Youth S', onHand: 1 }] }),
      options,
    );
    expect('problem' in noChoice && noChoice.problem.message).toBe(
      'Size on T-shirt has no Youth S. Pick one of Adult M, Adult XL, Adult 2XL.',
    );
    const whole = resolveStock(
      'Mug',
      StockInput.parse({ counts: [{ choice: 'Big', onHand: 1 }] }),
      [],
    );
    expect('problem' in whole && whole.problem.path).toBe('stock.counts');
  });
});
