/**
 * Product options on the local database (product sellers, 3a): a T-shirt with Size and Color, each choice with its
 * price bump, saved through `product.create` / `product.update`, read back by the price list and a form's editor.
 */
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formCatalogs,
  organizationCreate,
  productCreate,
  productList,
  productUpdate,
} from '../src/server';
import { ask, expectHfos, run } from './calendar-helpers';

let owner: TestUser;
let wsId: string;

beforeAll(async () => {
  owner = await createTestUser('product-options-owner', { fullName: 'Sherri Owner' });
  wsId = (await run(organizationCreate, { businessName: 'Crafts-n-Things' }, owner)).workspaceId;
});
afterAll(closeTestDbs);

const shirtOptions = [
  {
    name: 'Size',
    choices: [
      { label: 'Youth S', priceCents: -200 },
      { label: 'Adult M' },
      { label: 'Adult 2XL', priceCents: 200 },
    ],
  },
  { name: 'Color', choices: [{ label: 'Black' }, { label: 'White' }] },
];

describe('a product with sizes and colors', () => {
  it('is saved with an id on every option and choice, and the price list reads it back', async () => {
    const made = await run(
      productCreate,
      { workspaceId: wsId, name: 'T-shirt', unitPriceCents: 1200, options: shirtOptions },
      owner,
    );
    expect(made.product.options.map((o) => o.name)).toEqual(['Size', 'Color']);
    expect(made.product.options[0]!.choices.map((c) => [c.label, c.priceCents])).toEqual([
      ['Youth S', -200],
      ['Adult M', 0],
      ['Adult 2XL', 200],
    ]);
    expect(made.product.options[0]!.choices[0]!.id).toMatch(/^v_[a-z0-9]{8}$/);
    const { products } = await ask(productList, { workspaceId: wsId }, owner);
    expect(products.find((p) => p.id === made.productId)?.options).toEqual(made.product.options);
    // A form's editor gets them too, for one row per size.
    const catalogs = await ask(formCatalogs, { workspaceId: wsId }, owner);
    expect(catalogs.products.find((p) => p.id === made.productId)?.options).toEqual(
      made.product.options,
    );
    // A product without any reads as none.
    const mug = await run(
      productCreate,
      { workspaceId: wsId, name: 'Mug', unitPriceCents: 1500 },
      owner,
    );
    expect(mug.product.options).toEqual([]);
  });

  it('keeps each choice’s id when it’s sent back by name, and says what changed', async () => {
    const made = await run(
      productCreate,
      { workspaceId: wsId, name: 'Hoodie', unitPriceCents: 3000, options: shirtOptions },
      owner,
    );
    const was = made.product.options[0]!.choices;
    const saved = await run(
      productUpdate,
      {
        workspaceId: wsId,
        productId: made.productId,
        options: [
          {
            name: 'Size',
            choices: [
              { label: 'Adult M' },
              { label: 'Adult 2XL', priceCents: 300 },
              { label: 'Adult 3XL', priceCents: 400 },
            ],
          },
        ],
      },
      owner,
    );
    expect(saved.updated).toEqual(['options']);
    const now = saved.product.options[0]!.choices;
    expect(now[0]!.id).toBe(was[1]!.id);
    expect(now[1]).toEqual({ id: was[2]!.id, label: 'Adult 2XL', priceCents: 300 });
    expect(now[2]!.id).not.toBe(was[2]!.id);
    // Sending the same back changes nothing.
    const same = await run(
      productUpdate,
      { workspaceId: wsId, productId: made.productId, options: saved.product.options },
      owner,
    );
    expect(same.updated).toEqual([]);
    // An empty list takes them off.
    const off = await run(
      productUpdate,
      { workspaceId: wsId, productId: made.productId, options: [] },
      owner,
    );
    expect(off.product.options).toEqual([]);
  });

  it('refuses two options alike, a choice twice, and a size that would cost less than nothing', async () => {
    const make = (name: string, options: unknown, unitPriceCents = 1200) =>
      run(productCreate, { workspaceId: wsId, name, unitPriceCents, options } as never, owner);
    const twice = await expectHfos(
      () =>
        make('Tumbler', [
          { name: 'Size', choices: [{ label: '20 oz' }] },
          { name: 'size', choices: [{ label: '30 oz' }] },
        ]),
      'validation',
      400,
    );
    expect(twice.message).toBe('There are two options called size. Give each its own name.');
    await expectHfos(
      () => make('Keychain', [{ name: 'Color', choices: [{ label: 'Red' }, { label: 'red' }] }]),
      'validation',
      400,
    );
    const cheap = await expectHfos(
      () => make('Pin', [{ name: 'Size', choices: [{ label: 'Small', priceCents: -500 }] }], 300),
      'validation',
      400,
    );
    expect(cheap.message).toMatch(/^Small would cost less than nothing/);
    // Lowering the price later is held to the same rule.
    const shirt = await make('Tank top', shirtOptions);
    const lower = await expectHfos(
      () =>
        run(
          productUpdate,
          {
            workspaceId: wsId,
            productId: (shirt as { productId: string }).productId,
            unitPriceCents: 100,
          },
          owner,
        ),
      'validation',
      400,
    );
    expect(lower.message).toMatch(/^Youth S would cost less than nothing: \$1 − \$2/);
  });
});
