/**
 * Orders' words and working out (product sellers, 2a), the same on the web, the server and the Assistant; and the
 * order a sent form makes from its answers.
 */
import { describe, expect, it } from 'vitest';
import {
  fulfilmentFromWords,
  nextOrderStatus,
  OrderLine,
  orderInvoiceLines,
  orderSizeWords,
  orderStatusWords,
  orderStepLabel,
  orderSummary,
  orderTotalCents,
} from '../src/money/index';
import { orderFromAnswers, orderLineName } from '../src/forms/order';
import { cid, def, page, qid, shortText } from './forms/fixtures';

const line = (name: string, quantity: number, unitPriceCents: number) =>
  OrderLine.parse({ name, quantity, unitPriceCents });

describe('an order’s words', () => {
  it('names each step for pickup or delivery', () => {
    expect(orderStatusWords('ready', 'pickup')).toBe('Ready for pickup');
    expect(orderStatusWords('ready', 'delivery')).toBe('Ready to deliver');
    expect(orderStatusWords('ready', null)).toBe('Ready');
    expect(orderStatusWords('done', 'pickup')).toBe('Picked up');
    expect(orderStatusWords('done', 'delivery')).toBe('Delivered');
    expect(orderStepLabel('done', 'delivery')).toBe('Mark delivered');
    expect(orderStepLabel('making', null)).toBe('Start making it');
  });

  it('steps forward, and stops at done or cancelled', () => {
    expect(nextOrderStatus('new')).toBe('making');
    expect(nextOrderStatus('ready')).toBe('done');
    expect(nextOrderStatus('done')).toBeNull();
    expect(nextOrderStatus('cancelled')).toBeNull();
  });

  it('reads pickup or delivery from what a customer picked', () => {
    expect(fulfilmentFromWords('I’ll pick it up')).toBe('pickup');
    expect(fulfilmentFromWords('Curbside pickup')).toBe('pickup');
    expect(fulfilmentFromWords('Ship it to me')).toBe('delivery');
    expect(fulfilmentFromWords('Local drop-off')).toBe('delivery');
    expect(fulfilmentFromWords('Large')).toBeNull();
  });

  it('totals, sums up and copies its lines to an invoice', () => {
    const lines = [line('T-shirt (Adult M)', 5, 1200), line('Mug', 2, 1500), line('Pin', 3, 0)];
    expect(orderTotalCents(lines)).toBe(9000);
    expect(orderSummary(lines)).toBe('T-shirt (Adult M) × 5, Mug × 2 and 1 more');
    expect(orderSummary([])).toBe('Nothing on it yet');
    expect(orderSizeWords(lines)).toBe('10 items · $90');
    expect(orderSizeWords([line('Pin', 1, 0)])).toBe('1 item');
    expect(orderInvoiceLines(lines)[1]).toEqual({
      productId: null,
      name: 'Mug',
      quantity: 2,
      unitPriceCents: 1500,
      taxable: true,
    });
  });

  it('turns away a half, a line with no name and a price below $0', () => {
    expect(OrderLine.safeParse({ name: 'Mug', quantity: 1.5, unitPriceCents: 1 }).success).toBe(
      false,
    );
    expect(OrderLine.safeParse({ name: ' ', quantity: 1, unitPriceCents: 1 }).success).toBe(false);
    expect(OrderLine.safeParse({ name: 'Mug', quantity: 1, unitPriceCents: -1 }).success).toBe(
      false,
    );
  });
});

describe('the order a form makes', () => {
  const grid = (config: Record<string, unknown> = {}) => ({
    id: qid('shirts'),
    type: 'quantities' as const,
    title: 'T-shirts: how many of each size?',
    config: {
      choices: [
        { id: cid('adultm'), label: 'Adult M', price: 12 },
        { id: cid('youth'), label: 'Youth S' },
        {
          id: cid('product'),
          label: 'Adult 2XL',
          price: 14,
          productId: '00000000-0000-4000-8000-000000000001',
          optionChoiceId: 'v_aaaaaaaa',
        },
      ],
      ...config,
    },
  });
  const form = (config: Record<string, unknown> = {}) =>
    def({
      pages: [
        page('about', [
          shortText('name'),
          grid(config),
          { id: qid('when'), type: 'date', title: 'When?', config: {} },
          {
            id: qid('how'),
            type: 'choice',
            title: 'Pickup or delivery?',
            config: {
              choices: [
                { id: cid('pick'), label: 'Pickup' },
                { id: cid('ship'), label: 'Delivery' },
              ],
            },
          },
        ]),
      ],
    });

  it('makes a line for each row ordered, with the day and pickup or delivery', () => {
    const products = new Map([
      [
        '00000000-0000-4000-8000-000000000001',
        {
          name: 'T-shirt',
          taxable: false,
          options: [
            {
              id: 'o_aaaaaaaa',
              name: 'Size',
              choices: [{ id: 'v_aaaaaaaa', label: 'Adult 2XL', priceCents: 200 }],
            },
          ],
        },
      ],
    ]);
    const made = orderFromAnswers(
      form(),
      {
        [qid('shirts')]: { [cid('adultm')]: 2, [cid('youth')]: 1, [cid('product')]: 3 },
        [qid('when')]: '2027-03-01',
        [qid('how')]: cid('pick'),
      },
      products,
    );
    expect(made).toMatchObject({
      dueOn: '2027-03-01',
      fulfilment: 'pickup',
      totalCents: 2 * 1200 + 3 * 1400,
    });
    expect(
      made!.lines.map((l) => [l.name, l.quantity, l.unitPriceCents, l.taxable, l.choiceIds]),
    ).toEqual([
      ['T-shirts (Adult M)', 2, 1200, true, []],
      ['T-shirts (Youth S)', 1, 0, true, []],
      ['T-shirt (Adult 2XL)', 3, 1400, false, ['v_aaaaaaaa']],
    ]);
  });

  it('keeps a row as typed when its product is gone', () => {
    const made = orderFromAnswers(form(), { [qid('shirts')]: { [cid('product')]: 1 } });
    expect(made!.lines[0]).toMatchObject({
      name: 'T-shirts (Adult 2XL)',
      productId: null,
      choiceIds: [],
    });
  });

  it('makes none when nothing was ordered, or the question doesn’t make orders', () => {
    expect(orderFromAnswers(form(), { [qid('shirts')]: { [cid('adultm')]: 0 } })).toBeNull();
    expect(
      orderFromAnswers(form({ makesOrder: false }), { [qid('shirts')]: { [cid('adultm')]: 2 } }),
    ).toBeNull();
  });

  it('names a row by what the question is about', () => {
    const q = { title: 'How many?', config: { unit: 'mugs' } };
    expect(orderLineName(q, { label: '11 oz', productId: null, optionChoiceId: null })).toBe(
      'Mugs (11 oz)',
    );
    expect(
      orderLineName(
        { title: 'Extras' },
        { label: 'Keychains', productId: null, optionChoiceId: null },
      ),
    ).toBe('Keychains');
    expect(
      orderLineName(
        { title: 'Keychains: how many?' },
        { label: 'Keychains', productId: null, optionChoiceId: null },
      ),
    ).toBe('Keychains');
  });
});
