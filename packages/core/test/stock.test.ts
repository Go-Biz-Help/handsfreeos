/**
 * Stock counts on the local database (product sellers, the owner's pick 4a; docs/selling-products.md "Stock"):
 * counting a product as a whole or by an option, an order taking its lines off when it's picked up (whoever marks
 * it) and putting them back when it's moved back, telling the people who manage money when a count is down to
 * their number, and the refusals.
 */
import { eq } from 'drizzle-orm';
import { events } from '@hfos/db/schema';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  orderCreate,
  orderGet,
  orderSetStatus,
  productCreate,
  productList,
  productUpdate,
} from '../src/server';
import { admin, ask, customer, expectHfos, run, setupTeam, type Team } from './calendar-helpers';

let t: Team;
let shirt: { id: string; m: string; xl: string; black: string };
let mug: string;

const products = () => ask(productList, { workspaceId: t.wsId }, t.owner).then((r) => r.products);
const stockOf = async (id: string) => (await products()).find((p) => p.id === id)!.stock;

beforeAll(async () => {
  t = await setupTeam('stock');
  const made = await run(
    productCreate,
    {
      workspaceId: t.wsId,
      name: 'T-shirt',
      unitPriceCents: 1200,
      options: [
        { name: 'Size', choices: [{ label: 'Adult M' }, { label: 'Adult XL' }] },
        { name: 'Color', choices: [{ label: 'Black' }] },
      ],
      stock: {
        countBy: 'size',
        lowAt: 3,
        counts: [
          { choice: 'Adult M', onHand: 10 },
          { choice: 'adult xl', onHand: 4 },
        ],
      },
    },
    t.owner,
  );
  shirt = {
    id: made.productId,
    m: made.product.options[0]!.choices[0]!.id,
    xl: made.product.options[0]!.choices[1]!.id,
    black: made.product.options[1]!.choices[0]!.id,
  };
  const mugMade = await run(
    productCreate,
    {
      workspaceId: t.wsId,
      name: 'Mug',
      unitPriceCents: 1500,
      stock: { counts: [{ onHand: 6 }] },
    },
    t.owner,
  );
  mug = mugMade.productId;
});
afterAll(closeTestDbs);

const take = async (lines: Record<string, unknown>[], fulfilment = 'pickup') =>
  (
    await run(
      orderCreate,
      { workspaceId: t.wsId, personId: await customer(t, 'Sam'), lines, fulfilment },
      t.owner,
    )
  ).orderId;
const move = (orderId: string, status: string, who = t.member) =>
  run(orderSetStatus, { workspaceId: t.wsId, orderId, status }, who);
const lowEvents = async (productId: string) =>
  (await admin().select().from(events).where(eq(events.entityId, productId))).filter(
    (e) => e.eventType === 'stock.low',
  );

const shirtLine = (choiceIds: string[], quantity: number, name = 'T-shirt') => ({
  productId: shirt.id,
  choiceIds,
  name,
  quantity,
  unitPriceCents: 1200,
});

describe('counting stock', () => {
  it('keeps the counts by choice id, matching the names sent', async () => {
    expect(await stockOf(shirt.id)).toEqual({
      optionId: expect.stringMatching(/^o_/),
      lowAt: 3,
      counts: { [shirt.m]: 10, [shirt.xl]: 4 },
    });
    expect(await stockOf(mug)).toEqual({ optionId: null, lowAt: null, counts: { '': 6 } });
  });

  it('changes only the counts sent', async () => {
    const out = await run(
      productUpdate,
      {
        workspaceId: t.wsId,
        productId: shirt.id,
        stock: { countBy: 'Size', lowAt: 3, counts: [{ choice: 'Adult M', onHand: 12 }] },
      },
      t.owner,
    );
    expect(out.updated).toEqual(['stock']);
    expect(out.product.stock?.counts).toEqual({ [shirt.m]: 12, [shirt.xl]: 4 });
  });

  it('refuses an option or a choice the product doesn’t have, and a member', async () => {
    await expectHfos(
      () =>
        run(
          productUpdate,
          { workspaceId: t.wsId, productId: shirt.id, stock: { countBy: 'Flavor', counts: [] } },
          t.owner,
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          productUpdate,
          {
            workspaceId: t.wsId,
            productId: shirt.id,
            stock: { countBy: 'Size', counts: [{ choice: 'Youth S', onHand: 1 }] },
          },
          t.owner,
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          productUpdate,
          {
            workspaceId: t.wsId,
            productId: mug,
            stock: { counts: [{ choice: 'Big', onHand: 1 }] },
          },
          t.owner,
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          productUpdate,
          { workspaceId: t.wsId, productId: mug, stock: { counts: [{ onHand: 99 }] } },
          t.member,
        ),
      'forbidden',
    );
  });
});

describe('an order picked up', () => {
  it('takes its lines off, whoever marks it, and puts them back when it’s moved back', async () => {
    const orderId = await take([
      shirtLine([shirt.m, shirt.black], 5, 'T-shirt (Adult M, Black)'),
      { productId: mug, name: 'Mug', quantity: 2, unitPriceCents: 1500 },
      { productId: null, name: 'Keychain', quantity: 3, unitPriceCents: 500 },
    ]);
    await move(orderId, 'making');
    expect((await stockOf(shirt.id))?.counts[shirt.m]).toBe(12);
    // A member, who can't see the price list, marks it picked up.
    await move(orderId, 'done');
    expect((await stockOf(shirt.id))?.counts[shirt.m]).toBe(7);
    expect((await stockOf(mug))?.counts['']).toBe(4);
    const order = (await ask(orderGet, { workspaceId: t.wsId, orderId }, t.owner)).order;
    expect(order.stockTaken).toEqual([
      { productId: shirt.id, choiceId: shirt.m, quantity: 5, left: 7 },
      { productId: mug, choiceId: '', quantity: 2, left: 4 },
    ]);

    await move(orderId, 'ready');
    expect((await stockOf(shirt.id))?.counts[shirt.m]).toBe(12);
    expect((await stockOf(mug))?.counts['']).toBe(6);
    expect(
      (await ask(orderGet, { workspaceId: t.wsId, orderId }, t.owner)).order.stockTaken,
    ).toEqual([]);
    // Cancelled from done puts them back too; cancelled from ready changes nothing.
    await move(orderId, 'cancelled');
    expect((await stockOf(mug))?.counts['']).toBe(6);
  });

  it('skips a line without a choice of the option it’s counted by, and one not counted', async () => {
    const before = await stockOf(shirt.id);
    const orderId = await take([shirtLine([shirt.black], 2, 'T-shirt (Black)')]);
    await move(orderId, 'done');
    expect(await stockOf(shirt.id)).toEqual(before);
    expect(
      (await ask(orderGet, { workspaceId: t.wsId, orderId }, t.owner)).order.stockTaken,
    ).toEqual([]);
  });

  it('tells the people who manage money once, when a count goes down to their number', async () => {
    // Adult XL has 4, and they hear at 3.
    const first = await take([shirtLine([shirt.xl], 1, 'T-shirt (Adult XL)')]);
    await move(first, 'done');
    expect((await stockOf(shirt.id))?.counts[shirt.xl]).toBe(3);
    const told = await lowEvents(shirt.id);
    expect(told).toHaveLength(1);
    expect(told[0]!.payload).toMatchObject({
      productId: shirt.id,
      choiceId: shirt.xl,
      name: 'T-shirt (Adult XL)',
      left: 3,
      lowAt: 3,
      orderId: first,
    });
    // Already at or under it: no second push for the same low count.
    const second = await take([shirtLine([shirt.xl], 4, 'T-shirt (Adult XL)')]);
    await move(second, 'done');
    expect((await stockOf(shirt.id))?.counts[shirt.xl]).toBe(-1);
    expect(await lowEvents(shirt.id)).toHaveLength(1);
  });
});

describe('changing how it’s counted', () => {
  it('won’t take off the option it’s counted by unless the stock says how to count it', async () => {
    const options = [{ name: 'Color', choices: [{ label: 'Black' }] }];
    await expectHfos(
      () => run(productUpdate, { workspaceId: t.wsId, productId: shirt.id, options }, t.owner),
      'stock_option_gone',
      409,
    );
    const out = await run(
      productUpdate,
      {
        workspaceId: t.wsId,
        productId: shirt.id,
        options,
        stock: { countBy: null, counts: [{ onHand: 20 }] },
      },
      t.owner,
    );
    expect(out.product.stock).toMatchObject({ optionId: null, counts: { '': 20 } });
  });

  it('stops counting and keeps the counts for later', async () => {
    await run(productUpdate, { workspaceId: t.wsId, productId: mug, stock: null }, t.owner);
    expect(await stockOf(mug)).toBeNull();
    const orderId = await take([
      { productId: mug, name: 'Mug', quantity: 1, unitPriceCents: 1500 },
    ]);
    await move(orderId, 'done');
    await run(
      productUpdate,
      { workspaceId: t.wsId, productId: mug, stock: { counts: [] } },
      t.owner,
    );
    // Not counted while it was picked up, so it took nothing.
    expect(await stockOf(mug)).toEqual({ optionId: null, lowAt: null, counts: { '': 6 } });
  });
});
