/**
 * Orders on the local database (product sellers, the owner's pick 2a; docs/selling-products.md): taking one by hand,
 * its number, changing it and moving it along, making its invoice, the list Money → Orders and the calendar read, a
 * sent order form taking one, a customer merge moving them, and the Deleted bin hiding them.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { events, forms, invoiceLines, invoices } from '@hfos/db/schema';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formCreate,
  formPublish,
  formResponseStart,
  formResponseSubmit,
  formSaveDraft,
  invoiceVoid,
  orderCreate,
  orderGet,
  orderList,
  orderMakeInvoice,
  orderSetStatus,
  orderUpdate,
  organizationCreate,
  personDelete,
  personMerge,
  productCreate,
} from '../src/server';
import {
  admin,
  ask,
  customer,
  expectHfos,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let shirt: { id: string; adult2xl: string; black: string };
let mug: string;

beforeAll(async () => {
  t = await setupTeam('orders');
  const made = await run(
    productCreate,
    {
      workspaceId: t.wsId,
      name: 'T-shirt',
      unitPriceCents: 1200,
      options: [
        { name: 'Size', choices: [{ label: 'Adult M' }, { label: 'Adult 2XL', priceCents: 200 }] },
        { name: 'Color', choices: [{ label: 'Black' }] },
      ],
    },
    t.owner,
  );
  shirt = {
    id: made.productId,
    adult2xl: made.product.options[0]!.choices[1]!.id,
    black: made.product.options[1]!.choices[0]!.id,
  };
  mug = (
    await run(
      productCreate,
      { workspaceId: t.wsId, name: 'Mug', unitPriceCents: 1500, taxable: false },
      t.owner,
    )
  ).productId;
});
afterAll(closeTestDbs);

const take = (personId: string, extra: Record<string, unknown> = {}, who = t.owner) =>
  run(
    orderCreate,
    {
      workspaceId: t.wsId,
      personId,
      lines: [
        {
          productId: shirt.id,
          choiceIds: [shirt.adult2xl],
          name: 'T-shirt (Adult 2XL)',
          quantity: 5,
          unitPriceCents: 1400,
        },
        { productId: mug, name: 'Mug', quantity: 2, unitPriceCents: 1500, taxable: false },
      ],
      ...extra,
    },
    who,
  );

const get = (orderId: string, who = t.owner) =>
  ask(orderGet, { workspaceId: t.wsId, orderId }, who).then((r) => r.order);

const eventsFor = (type: string, entityId: string) =>
  admin()
    .select()
    .from(events)
    .where(eq(events.entityId, entityId))
    .then((list) => list.filter((e) => e.eventType === type));

describe('taking an order by hand', () => {
  it('numbers it from 1001, totals it, and says it was taken', async () => {
    const ann = await customer(t, 'Ann');
    const first = await take(ann, { fulfilment: 'pickup', dueOn: '2026-12-05', notes: 'Gift' });
    const second = await take(ann);
    expect(first).toMatchObject({ number: 1001, status: 'new', totalCents: 10000, changed: true });
    expect(second.number).toBe(1002);
    const order = await get(first.orderId);
    expect(order).toMatchObject({
      number: 1001,
      status: 'new',
      open: true,
      fulfilment: 'pickup',
      dueOn: '2026-12-05',
      totalCents: 10000,
      itemCount: 7,
      notes: 'Gift',
      person: { id: ann, name: 'Ann Customer' },
      form: null,
      invoice: null,
    });
    expect(order.lines[0]).toEqual({
      productId: shirt.id,
      choiceIds: [shirt.adult2xl],
      name: 'T-shirt (Adult 2XL)',
      quantity: 5,
      unitPriceCents: 1400,
      taxable: true,
    });
    const [created] = await eventsFor('order.created', first.orderId);
    expect(created!.payload).toMatchObject({ personId: ann, number: 1001, via: 'staff' });
  });

  it('keeps a line whose product isn’t this business’s as typed, and drops a choice that isn’t its product’s', async () => {
    const ben = await customer(t, 'Ben');
    const out = await run(
      orderCreate,
      {
        workspaceId: t.wsId,
        personId: ben,
        lines: [
          { productId: randomUUID(), choiceIds: ['v_zzzzzzzz'], name: 'Pin', quantity: 3, unitPriceCents: 300 },
          { productId: mug, choiceIds: [shirt.black], name: 'Mug', quantity: 1, unitPriceCents: 1500 },
        ],
      },
      t.owner,
    );
    const order = await get(out.orderId);
    expect(order.lines.map((l) => [l.productId, l.choiceIds])).toEqual([
      [null, []],
      [mug, []],
    ]);
  });

  it('needs something on it, and a customer who’s there', async () => {
    const cy = await customer(t, 'Cy');
    await expectHfos(
      () => run(orderCreate, { workspaceId: t.wsId, personId: cy, lines: [] }, t.owner),
      'validation',
      400,
    );
    await expectHfos(() => take(randomUUID()), 'not_found', 404);
  });

  it('lets a member take one, but only someone who bills makes its invoice', async () => {
    const di = await customer(t, 'Di');
    const out = await take(di, {}, t.member);
    expect(out.number).toBeGreaterThan(1000);
    await expectHfos(
      () => run(orderMakeInvoice, { workspaceId: t.wsId, orderId: out.orderId }, t.member),
      'forbidden',
      403,
    );
  });
});

describe('changing one and moving it along', () => {
  it('replaces the lines and retotals, and says when nothing changed', async () => {
    const ed = await customer(t, 'Ed');
    const { orderId } = await take(ed);
    const changed = await run(
      orderUpdate,
      {
        workspaceId: t.wsId,
        orderId,
        lines: [{ name: 'Keychain', quantity: 10, unitPriceCents: 500 }],
        fulfilment: 'delivery',
        dueOn: '2026-12-10',
      },
      t.owner,
    );
    expect(changed).toMatchObject({ totalCents: 5000, changed: true });
    expect(await get(orderId)).toMatchObject({
      totalCents: 5000,
      fulfilment: 'delivery',
      dueOn: '2026-12-10',
      lines: [{ name: 'Keychain', quantity: 10, productId: null, choiceIds: [], taxable: true }],
    });
    const again = await run(
      orderUpdate,
      { workspaceId: t.wsId, orderId, fulfilment: 'delivery' },
      t.owner,
    );
    expect(again.changed).toBe(false);
    const [updated] = await eventsFor('order.updated', orderId);
    expect(updated!.payload).toMatchObject({ changed: ['lines', 'totalCents', 'fulfilment', 'dueOn'] });
  });

  it('moves through the steps, back a step, and keeps what was on it once it’s handed over', async () => {
    const flo = await customer(t, 'Flo');
    const { orderId } = await take(flo, { fulfilment: 'pickup' });
    for (const status of ['making', 'ready', 'done'] as const) {
      const out = await run(orderSetStatus, { workspaceId: t.wsId, orderId, status }, t.member);
      expect(out).toMatchObject({ status, changed: true });
    }
    expect((await get(orderId)).open).toBe(false);
    const same = await run(orderSetStatus, { workspaceId: t.wsId, orderId, status: 'done' }, t.owner);
    expect(same.changed).toBe(false);
    const refused = await expectHfos(
      () =>
        run(
          orderUpdate,
          { workspaceId: t.wsId, orderId, lines: [{ name: 'Pin', quantity: 1, unitPriceCents: 1 }] },
          t.owner,
        ),
      'order_closed',
      409,
    );
    expect(refused.message).toContain('picked up');
    // Notes still change.
    expect(
      (await run(orderUpdate, { workspaceId: t.wsId, orderId, notes: 'Paid cash' }, t.owner)).changed,
    ).toBe(true);
    const back = await run(orderSetStatus, { workspaceId: t.wsId, orderId, status: 'ready' }, t.owner);
    expect(back.changed).toBe(true);
    const moves = await eventsFor('order.status_changed', orderId);
    expect(moves.map((e) => (e.payload as { status: string }).status).sort()).toEqual(
      ['done', 'making', 'ready', 'ready'].sort(),
    );
  });
});

describe('making the invoice', () => {
  it('makes a draft with the order’s lines, once, and again after that one is voided', async () => {
    const gus = await customer(t, 'Gus');
    const { orderId } = await take(gus);
    const made = await run(orderMakeInvoice, { workspaceId: t.wsId, orderId }, t.owner);
    const [inv] = await admin().select().from(invoices).where(eq(invoices.id, made.invoiceId));
    expect(inv).toMatchObject({ personId: gus, status: 'draft', title: 'Order #' + (await get(orderId)).number });
    const lines = await admin()
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, made.invoiceId));
    expect(
      lines
        .sort((a, b) => a.position - b.position)
        .map((l) => [l.name, Number(l.quantity), Number(l.unitPriceCents), l.taxable, l.productId]),
    ).toEqual([
      ['T-shirt (Adult 2XL)', 5, 1400, true, shirt.id],
      ['Mug', 2, 1500, false, mug],
    ]);
    expect((await get(orderId)).invoice).toMatchObject({ id: made.invoiceId, status: 'draft' });
    await expectHfos(
      () => run(orderMakeInvoice, { workspaceId: t.wsId, orderId }, t.owner),
      'order_invoiced',
      409,
    );
    await run(invoiceVoid, { workspaceId: t.wsId, invoiceId: made.invoiceId }, t.owner);
    const again = await run(orderMakeInvoice, { workspaceId: t.wsId, orderId }, t.owner);
    expect(again.invoiceId).not.toBe(made.invoiceId);
  });

  it('refuses one with nothing priced, or cancelled', async () => {
    const hal = await customer(t, 'Hal');
    const free = await run(
      orderCreate,
      {
        workspaceId: t.wsId,
        personId: hal,
        lines: [{ name: 'Custom tumbler', quantity: 2, unitPriceCents: 0 }],
      },
      t.owner,
    );
    await expectHfos(
      () => run(orderMakeInvoice, { workspaceId: t.wsId, orderId: free.orderId }, t.owner),
      'order_unpriced',
      409,
    );
    const { orderId } = await take(hal);
    await run(orderSetStatus, { workspaceId: t.wsId, orderId, status: 'cancelled' }, t.owner);
    await expectHfos(
      () => run(orderMakeInvoice, { workspaceId: t.wsId, orderId }, t.owner),
      'order_cancelled',
      409,
    );
  });
});

describe('the list', () => {
  it('shows open ones by default, done and cancelled when asked, by number, name, line and day', async () => {
    const ida = await customer(t, 'Ida');
    const a = await take(ida, { dueOn: '2027-01-04' });
    const b = await take(ida, { dueOn: '2027-01-09' });
    const c = await take(ida);
    await run(orderSetStatus, { workspaceId: t.wsId, orderId: b.orderId, status: 'done' }, t.owner);
    await run(orderSetStatus, { workspaceId: t.wsId, orderId: c.orderId, status: 'cancelled' }, t.owner);
    const mine = (show?: string, extra: Record<string, unknown> = {}) =>
      ask(orderList, { workspaceId: t.wsId, personId: ida, ...(show ? { show } : {}), ...extra }, t.member).then(
        (r) => r.orders.map((o) => o.id),
      );
    expect(await mine()).toEqual([a.orderId]);
    expect(await mine('done')).toEqual([b.orderId]);
    expect(await mine('cancelled')).toEqual([c.orderId]);
    expect(await mine('all')).toEqual([c.orderId, b.orderId, a.orderId]);
    // The calendar's range, both days counted.
    expect(await mine('all', { dueFrom: '2027-01-04', dueTo: '2027-01-08' })).toEqual([a.orderId]);
    expect(await mine('all', { dueFrom: '2027-01-05', dueTo: '2027-01-09' })).toEqual([b.orderId]);
    const byNumber = await ask(
      orderList,
      { workspaceId: t.wsId, show: 'all', search: `#${b.number}` },
      t.owner,
    );
    expect(byNumber.orders.map((o) => o.id)).toEqual([b.orderId]);
    const byName = await ask(orderList, { workspaceId: t.wsId, show: 'all', search: 'ida cust' }, t.owner);
    expect(byName.orders.map((o) => o.id).sort()).toEqual([a.orderId, b.orderId, c.orderId].sort());
    const byLine = await ask(orderList, { workspaceId: t.wsId, show: 'all', search: 'keychain' }, t.owner);
    expect(byLine.orders.length).toBeGreaterThan(0);
    expect(byLine.orders.every((o) => o.lines.some((l) => /keychain/i.test(l.name)))).toBe(true);
    expect(byNumber.openCount).toBeGreaterThan(0);
  });

  it('pages', async () => {
    const page1 = await ask(orderList, { workspaceId: t.wsId, show: 'all', limit: 2 }, t.owner);
    expect(page1.orders.length).toBe(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await ask(
      orderList,
      { workspaceId: t.wsId, show: 'all', limit: 2, cursor: page1.nextCursor! },
      t.owner,
    );
    expect(page2.orders.map((o) => o.id)).not.toContain(page1.orders[0]!.id);
  });

  it('numbers each business’s own orders from 1001', async () => {
    const org = await run(organizationCreate, { businessName: 'Second Shop' }, t.owner);
    const p = await run(
      (await import('../src/server')).personCreate,
      { workspaceId: org.workspaceId, firstName: 'Jo', ignoreDuplicates: true },
      t.owner,
    );
    const out = await run(
      orderCreate,
      {
        workspaceId: org.workspaceId,
        personId: p.personId,
        lines: [{ name: 'Pin', quantity: 1, unitPriceCents: 300 }],
      },
      t.owner,
    );
    expect(out.number).toBe(1001);
  });
});

describe('with its customer', () => {
  it('moves to the customer kept when two are merged', async () => {
    const dup = await customer(t, 'Kay');
    const keep = await customer(t, 'Kayla');
    const { orderId } = await take(dup);
    await run(orderMakeInvoice, { workspaceId: t.wsId, orderId }, t.owner);
    await run(personMerge, { workspaceId: t.wsId, personId: dup, intoPersonId: keep }, t.owner);
    expect((await get(orderId)).person.id).toBe(keep);
  });

  it('goes out of sight while the customer is in the Deleted bin', async () => {
    const lou = await customer(t, 'Lou');
    const { orderId } = await take(lou);
    await run(personDelete, { workspaceId: t.wsId, personIds: [lou] }, t.owner);
    await expectHfos(() => get(orderId), 'not_found', 404);
    const listed = await ask(orderList, { workspaceId: t.wsId, show: 'all' }, t.owner);
    expect(listed.orders.map((o) => o.id)).not.toContain(orderId);
    await expectHfos(
      () => run(orderSetStatus, { workspaceId: t.wsId, orderId, status: 'making' }, t.owner),
      'not_found',
      404,
    );
  });
});

// ---- A sent order form ----

const qid = (name: string) => `q_${name.padEnd(8, '0').slice(0, 8)}`;
const cid = (name: string) => `c_${name.padEnd(8, '0').slice(0, 8)}`;

async function orderForm(name: string, quantities: Record<string, unknown> = {}) {
  const created = await run(formCreate, { workspaceId: t.wsId, name }, t.owner);
  const [form] = await admin().select().from(forms).where(eq(forms.id, created.formId));
  const pageId = (form!.definition as { pages: { id: string }[] }).pages[0]!.id;
  const add = (question: Record<string, unknown>) => ({
    op: 'add_question',
    pageId,
    index: null,
    question: { config: {}, ...question },
  });
  const saved = await run(
    formSaveDraft,
    {
      workspaceId: t.wsId,
      formId: created.formId,
      baseRevision: 1,
      ops: [
        add({ id: qid('name'), type: 'short_text', title: 'Your name', required: true, mapTo: 'person.first_name' }),
        add({ id: qid('phone'), type: 'phone', title: 'Your phone', mapTo: 'person.phone' }),
        add({
          id: qid('shirts'),
          type: 'quantities',
          title: 'T-shirts: how many of each size?',
          config: {
            choices: [
              { id: cid('adultm'), label: 'Adult M', price: 12 },
              {
                id: cid('adult2xl'),
                label: 'Adult 2XL',
                price: 14,
                productId: shirt.id,
                optionChoiceId: shirt.adult2xl,
              },
              { id: cid('youth'), label: 'Youth S' },
            ],
            ...quantities,
          },
        }),
        add({ id: qid('when'), type: 'date', title: 'When do you need them?' }),
        add({
          id: qid('how'),
          type: 'choice',
          title: 'Pickup or delivery?',
          config: {
            choices: [
              { id: cid('pickup'), label: 'I’ll pick it up' },
              { id: cid('ship'), label: 'Ship it to me' },
            ],
          },
        }),
      ],
    },
    t.owner,
  );
  await run(
    formPublish,
    { workspaceId: t.wsId, formId: created.formId, baseRevision: saved.revision },
    t.owner,
  );
  return created.formId;
}

async function send(formId: string, answers: Record<string, unknown>) {
  const started = await runSystem(
    formResponseStart,
    { workspaceId: t.wsId, formId, source: 'link' },
    t.scope,
  );
  const sent = await runSystem(
    formResponseSubmit,
    { workspaceId: t.wsId, responseId: started.responseId, token: started.token, answers },
    t.scope,
  );
  return { ...sent, responseId: started.responseId };
}

describe('a sent order form', () => {
  it('takes an order: a line for each row ordered, the day and pickup or delivery', async () => {
    const formId = await orderForm('Shirt order');
    const sent = await send(formId, {
      [qid('name')]: 'Sherri',
      [qid('phone')]: '+17135550199',
      [qid('shirts')]: { [cid('adultm')]: 3, [cid('adult2xl')]: 2, [cid('youth')]: 1 },
      [qid('when')]: '2027-02-01',
      [qid('how')]: cid('ship'),
    });
    const [row] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.orders where form_response_id = ${sent.responseId}`,
    );
    const order = await get(row!.id);
    expect(order).toMatchObject({
      status: 'new',
      person: { id: sent.personId },
      form: { id: formId, name: 'Shirt order' },
      formResponseId: sent.responseId,
      dueOn: '2027-02-01',
      fulfilment: 'delivery',
      totalCents: 3 * 1200 + 2 * 1400,
    });
    expect(order.lines.map((l) => [l.name, l.quantity, l.unitPriceCents, l.productId, l.choiceIds])).toEqual([
      ['T-shirts (Adult M)', 3, 1200, null, []],
      ['T-shirt (Adult 2XL)', 2, 1400, shirt.id, [shirt.adult2xl]],
      ['T-shirts (Youth S)', 1, 0, null, []],
    ]);
    const [created] = await eventsFor('order.created', order.id);
    expect(created!.payload).toMatchObject({ via: 'form', formId });
  });

  it('takes none when nothing was ordered, or the question doesn’t make orders', async () => {
    const formId = await orderForm('Shirt count', { makesOrder: false });
    const sent = await send(formId, {
      [qid('name')]: 'Tess',
      [qid('phone')]: '+17135550198',
      [qid('shirts')]: { [cid('adultm')]: 3 },
    });
    const made = await rows(
      admin(),
      sql`select id from app.orders where form_response_id = ${sent.responseId}`,
    );
    expect(made).toEqual([]);
  });
});
