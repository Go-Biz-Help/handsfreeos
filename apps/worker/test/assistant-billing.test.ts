/**
 * The Assistant's billing tools, against the real queries and commands underneath them: writing, changing, sending
 * and voiding estimates and invoices, a yes taken on the phone, a refund, the plans a business sells and the
 * customers on them, numbering and ways to pay, and the balance's automatic top-up.
 *
 * What every one of them is held to:
 * - **The card says what will happen, from real rows**, and the figure on it is the figure that gets stored.
 * - **Nothing changes until Confirm**, and Confirm does exactly what the card said.
 * - **What the screens refuse is refused here too** — in words, or as a card that can't be confirmed.
 */
import { randomUUID } from 'node:crypto';
import {
  assistantToolByName,
  estimateCreate,
  estimateSend,
  executeCommand,
  executeQuery,
  hasWorkspacePermission,
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceRecordPayment,
  invoiceSend,
  money,
  moneySaveSettings,
  organizationCreate,
  personCreate,
  planCreate,
  productCreate,
  registry,
  serviceCreate,
  subscriptionRecordCycle,
  walletRecordCard,
  walletSetAutoTopup,
  type AssistantCard,
  type CommandDef,
  type HumanActor,
  type MoneySettings,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import { billingStepLabels } from '../src/assistant/tools-billing';
import { createToolExecutor, executorFor } from '../src/assistant/tools-write';
import { systemActor } from '../src/services';

type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
type Line = { name: string; productId: string | null };

const CHI = 'America/Chicago';
const suffix = randomUUID().slice(0, 8);
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let member: TestUser;
let workspaceId: string;
let organizationId: string;
/** A second business with nothing connected: no payment account, no card on its balance. */
let bare: { workspaceId: string; organizationId: string };
let maria: { id: string; email: string; phone: string };
let samId: string;
let stripeId: string;
let tuneUpId: string;
let serviceId: string;

const run = async <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser = owner,
) => (await executeCommand(api(), cmd, input, actor(u), meta())).output;

/** What the worker writes: a provider's answer about a payment, a plan going live, a card landing. */
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(testDbs().worker.db, cmd, input, systemActor({ workspaceId, organizationId }), {
    correlationId: randomUUID(),
    channel: 'worker',
  }).then((r) => r.output);

const ask = <T>(name: string, input: Record<string, unknown> = {}, ws = workspaceId) =>
  executeQuery(
    api(),
    registry.query(name)!,
    { workspaceId: ws, ...input },
    actor(owner),
    meta(),
  ) as Promise<T>;

const ctxFor = (u: TestUser, ws = workspaceId, org = organizationId): ToolContext => ({
  actor: actor(u),
  workspaceId: ws,
  organizationId: org,
  correlationId: randomUUID(),
  timezone: CHI,
});

/** Draws the card the way the runtime does; `confirm` presses the button on it. */
async function prepare(name: string, args: Record<string, unknown>, u = owner, ws?: typeof bare) {
  const tool = assistantToolByName.get(name)!;
  const parsed = tool.input.parse(args) as Record<string, unknown>;
  const toolCallId = randomUUID();
  const ctx = ws ? ctxFor(u, ws.workspaceId, ws.organizationId) : ctxFor(u);
  const executor = createToolExecutor(api());
  const out = await executor.prepare(tool, parsed, ctx, toolCallId);
  return {
    card: out.card as ConfirmCard,
    result: out.result as Record<string, unknown>,
    toolCallId,
    confirm: () => executor.commit(tool, parsed, ctx, { toolCallId }),
  };
}

async function look(name: string, args: Record<string, unknown>) {
  const tool = assistantToolByName.get(name)!;
  const out = await createToolExecutor(api()).run(
    tool,
    tool.input.parse(args) as Record<string, unknown>,
    ctxFor(owner),
  );
  return out as { result: Record<string, unknown>; card?: AssistantCard };
}

const field = (card: ConfirmCard, label: string) =>
  card.fields.find((f) => f.label === label)?.value;
const warningsOf = (card: ConfirmCard) =>
  card.warnings.map((w) => `${w.kind}: ${w.text}`).join('\n');
const idOf = (href: string | null) => href!.split('/').pop()!;

interface EstimateGet {
  estimate: {
    status: string;
    number: string | null;
    title: string | null;
    notes: string | null;
    totals: { totalCents: number; discountPercentBp: number | null };
    deposit: { kind: string; percentBp: number };
    depositCents: number;
    acceptedVia: string | null;
    acceptedName: string | null;
    voidReason: string | null;
    lines: Line[];
  };
  invoices: { id: string; purpose: string; totalCents: number; status: string }[];
}
interface InvoiceGet {
  invoice: {
    status: string;
    number: string | null;
    origin: string;
    title: string | null;
    connectionId: string | null;
    dueOn: string | null;
    totals: { totalCents: number };
    lines: Line[];
  };
  refunds: { amountCents: number; status: string; reason: string | null }[];
}
const estimate = (estimateId: string) => ask<EstimateGet>('estimate.get', { estimateId });
const invoice = (invoiceId: string) => ask<InvoiceGet>('invoice.get', { invoiceId });

async function eventsOf(type: string, entityId: string) {
  return rows<{ payload: Record<string, unknown> }>(
    admin(),
    sql`select payload from app.events where event_type = ${type} and entity_id = ${entityId}::uuid`,
  );
}

const line = (name: string, cents: number) => ({
  productId: null,
  name,
  description: null,
  quantity: 1,
  unitLabel: 'each',
  unitPriceCents: cents,
  taxable: false,
  discountCents: 0,
});

async function sentInvoice(personId: string, cents: number) {
  const { invoiceId } = (await run(invoiceCreate, {
    workspaceId,
    personId,
    title: 'Repair',
    lines: [line('Repair', cents)],
  })) as { invoiceId: string };
  await run(invoiceSend, { workspaceId, invoiceId, channels: [] });
  return invoiceId;
}

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('billing-dale', { fullName: 'Dale Owner' }),
    createTestUser('billing-marco', { fullName: 'Marco Tech' }),
  ]);
  const org = (await run(organizationCreate, {
    businessName: `Billing HVAC ${suffix}`,
    timezone: CHI,
  })) as { workspaceId: string; organizationId: string };
  ({ workspaceId, organizationId } = org);
  bare = (await run(organizationCreate, {
    businessName: `Bare HVAC ${suffix}`,
    timezone: CHI,
  })) as { workspaceId: string; organizationId: string };
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${member.id}, 'member')`,
  );
  const email = `maria-${suffix}@example.test`;
  const { personId } = (await run(personCreate, {
    workspaceId,
    firstName: 'Maria',
    lastName: 'Lopez',
    email,
    phone: `+1713555${String(1000 + Math.floor(Math.random() * 8999))}`,
  })) as { personId: string };
  // Her number as the business reads it, which is how a card shows it.
  const { person } = await ask<{ person: { phone: string } }>('person.get', { personId });
  maria = { id: personId, email, phone: person.phone };
  samId = (
    (await run(personCreate, { workspaceId, firstName: 'Sam', lastName: 'Quiet' })) as {
      personId: string;
    }
  ).personId;

  // 8.25% sales tax, so a card's total has tax in it.
  const got = await ask<{ settings: MoneySettings }>('money.settings');
  await run(moneySaveSettings, {
    workspaceId,
    settings: { ...got.settings, tax: { ...got.settings.tax, rateBp: 825 } },
  });
  // A connected Stripe account, as the worker leaves one after the sign-in.
  const [conn] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.payment_connections (workspace_id, provider, environment, status,
          external_account_id, label, display_name, token_enc, token_key_id, connected_at, is_default)
        values (${workspaceId}, 'stripe', 'live', 'active', ${`acct_${suffix}`},
          'Lone Star', 'Lone Star', 'sealed', 'key-1', now(), true)
        returning id`,
  );
  stripeId = conn!.id;
  tuneUpId = (
    (await run(productCreate, {
      workspaceId,
      name: 'AC tune-up',
      unitPriceCents: 18_000,
      unitLabel: 'visit',
      taxable: true,
    })) as { productId: string }
  ).productId;
  serviceId = (
    (await run(serviceCreate, {
      workspaceId,
      name: 'Maintenance visit',
      durations: [60],
    })) as { serviceId: string }
  ).serviceId;
}, 60_000);

afterAll(closeTestDbs);

// ---------------------------------------------------------------------------

const TOOLS: Record<string, { autonomy: string; permission: string; commands: string[] }> = {
  get_money_document: { autonomy: 'auto', permission: 'money.read', commands: [] },
  list_plans: { autonomy: 'auto', permission: 'money.read', commands: [] },
  write_estimate: {
    autonomy: 'confirm',
    permission: 'money.bill',
    commands: ['estimate.create', 'estimate.update'],
  },
  manage_estimate: {
    autonomy: 'confirm',
    permission: 'money.bill',
    commands: ['estimate.void', 'estimate.mark_accepted', 'estimate.convert'],
  },
  write_invoice: {
    autonomy: 'confirm',
    permission: 'money.bill',
    commands: ['invoice.create', 'invoice.update'],
  },
  manage_invoice: {
    autonomy: 'confirm',
    permission: 'money.bill',
    commands: ['invoice.send', 'invoice.void'],
  },
  refund_payment: { autonomy: 'confirm', permission: 'money.manage', commands: ['payment.refund'] },
  manage_plan: {
    autonomy: 'confirm',
    permission: 'money.manage',
    commands: ['plan.create', 'plan.update', 'plan.archive'],
  },
  manage_customer_plan: {
    autonomy: 'confirm',
    permission: 'money.bill',
    commands: [
      'subscription.start',
      'subscription.pause',
      'subscription.resume',
      'subscription.cancel',
      'subscription.request_card',
    ],
  },
  update_numbering_and_ways_to_pay: {
    autonomy: 'confirm',
    permission: 'money.manage',
    commands: ['money.save_settings'],
  },
  update_auto_topup: {
    autonomy: 'confirm',
    permission: 'money.manage',
    commands: ['wallet.set_auto_topup'],
  },
};

describe('the billing tools', () => {
  it('each ask for what its commands ask for, and only the look-ups run on their own', () => {
    for (const [name, want] of Object.entries(TOOLS)) {
      const tool = assistantToolByName.get(name);
      expect(tool, name).toBeTruthy();
      expect({ autonomy: tool!.autonomy, permission: tool!.permission }, name).toEqual({
        autonomy: want.autonomy,
        permission: want.permission,
      });
      expect(executorFor(name), name).toBeTruthy();
      expect(billingStepLabels[name], name).toBeTruthy();
      for (const c of want.commands)
        expect(registry.command(c)?.permission, `${name} → ${c}`).toBe(want.permission);
    }
    expect(Object.keys(billingStepLabels).sort()).toEqual(Object.keys(TOOLS).sort());
  });

  it('offers a member the look-ups only', () => {
    const offered = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    expect(offered).toContain('get_money_document');
    expect(offered).toContain('list_plans');
    for (const [name, want] of Object.entries(TOOLS))
      if (want.autonomy === 'confirm') expect(offered, name).not.toContain(name);
  });
});

// ---------------------------------------------------------------------------

describe('an estimate, written by asking', () => {
  let estimateId: string;
  const estimatesOfMaria = () =>
    ask<{ estimates: unknown[] }>('estimate.list', { personId: maria.id, limit: 100 }).then(
      (r) => r.estimates.length,
    );

  it('shows the lines and the total first, saves nothing, then saves a draft', async () => {
    const before = await estimatesOfMaria();
    const p = await prepare('write_estimate', {
      personId: maria.id,
      title: 'Spring tune-up',
      lines: [
        { productId: tuneUpId },
        { name: 'Filter', quantity: 2, unitPrice: 25, taxable: false },
      ],
      discountPercent: 10,
      depositPercent: 25,
      note: 'Includes a filter check.',
    });
    expect(p.card.title).toBe('Write an estimate for Maria Lopez');
    expect(p.card.personId).toBe(maria.id);
    expect(field(p.card, 'AC tune-up')).toBe('1 visit × $180');
    expect(field(p.card, 'Filter')).toBe('2 each × $25 · no tax');
    expect(field(p.card, 'Total')).toMatch(/after \$23 off \(10%\) · with \$[\d.]+ sales tax/);
    expect(p.card.confirmLabel).toBe('Save the draft');
    expect(warningsOf(p.card)).toContain('Nothing goes to Maria until you send it');
    expect(await estimatesOfMaria()).toBe(before);

    const done = await p.confirm();
    expect(done.command).toBe('estimate.create');
    expect(await estimatesOfMaria()).toBe(before + 1);
    estimateId = idOf(done.href);
    const { estimate: e } = await estimate(estimateId);
    expect(e.status).toBe('draft');
    expect(e.lines.map((l) => [l.name, l.productId])).toEqual([
      ['AC tune-up', tuneUpId],
      ['Filter', null],
    ]);
    expect(e.totals.discountPercentBp).toBe(1_000);
    expect(e.deposit).toMatchObject({ kind: 'percent', percentBp: 2_500 });
    expect(e.notes).toBe('Includes a filter check.');
    // What the person approved is what was stored, to the cent.
    expect(field(p.card, 'Total')!.startsWith(`${money(e.totals.totalCents)} ·`)).toBe(true);
    expect(field(p.card, 'Deposit')).toBe(`${money(e.depositCents)} up front (25%)`);
  });

  it('changes a draft whole: a line off, a line on, and everything else kept', async () => {
    const was = (await estimate(estimateId)).estimate;
    const p = await prepare('write_estimate', {
      estimateId,
      removeLines: [2],
      addLines: [{ name: 'Duct sealing', unitPrice: 300 }],
    });
    expect(p.card.title).toBe('Change the draft estimate for Maria Lopez');
    expect(field(p.card, 'Was')).toBe(money(was.totals.totalCents));
    expect((await estimate(estimateId)).estimate.lines.map((l) => l.name)).toEqual([
      'AC tune-up',
      'Filter',
    ]);
    await p.confirm();
    const { estimate: e } = await estimate(estimateId);
    expect(e.lines.map((l) => l.name)).toEqual(['AC tune-up', 'Duct sealing']);
    expect(e.title).toBe('Spring tune-up');
    expect(e.notes).toBe('Includes a filter check.');
    expect(e.totals.discountPercentBp).toBe(1_000);
    expect(e.deposit).toMatchObject({ kind: 'percent', percentBp: 2_500 });
  });

  it('says so when nothing would change, or a line isn’t there', async () => {
    await expect(prepare('write_estimate', { estimateId })).rejects.toThrow(
      'Nothing would change.',
    );
    await expect(prepare('write_estimate', { estimateId, removeLines: [9] })).rejects.toThrow(
      /no line 9/,
    );
    await expect(
      prepare('write_estimate', { personId: maria.id, lines: [{ name: 'Mystery' }] }),
    ).rejects.toThrow(/a price/);
    await expect(
      prepare('write_estimate', { estimateId, depositDollars: 100_000 }),
    ).rejects.toThrow(/deposit/i);
  });

  it('reads back with its lines numbered, for the next change', async () => {
    const { result, card } = await look('get_money_document', { estimateId });
    expect(result['canChange']).toBe(true);
    expect(result['lines']).toMatchObject([
      { n: 1, name: 'AC tune-up', productId: tuneUpId },
      { n: 2, name: 'Duct sealing' },
    ]);
    expect(card?.type).toBe('money');
  });

  describe('once it has gone out', () => {
    beforeAll(async () => {
      await run(estimateSend, { workspaceId, estimateId, channels: [] });
    });

    it('can’t be changed any more', async () => {
      await expect(
        prepare('write_estimate', { estimateId, title: 'Something else' }),
      ).rejects.toThrow(/has gone out/);
    });

    it('records a yes taken on the phone, in the person’s name', async () => {
      const p = await prepare('manage_estimate', { estimateId, action: 'record_yes' });
      expect(p.card.title).toMatch(/^Mark EST-\d+ approved\?$/);
      expect(field(p.card, 'Who said yes')).toBe('Maria Lopez');
      expect(warningsOf(p.card)).toContain('never as their own approval');
      expect(warningsOf(p.card)).toContain('Turn it into an invoice to collect it');
      expect((await estimate(estimateId)).estimate.status).toBe('sent');
      await p.confirm();
      const { estimate: e } = await estimate(estimateId);
      expect(e).toMatchObject({
        status: 'accepted',
        acceptedVia: 'staff',
        acceptedName: 'Maria Lopez',
      });
    });

    it('turns into a deposit invoice, a draft until it is sent', async () => {
      const { estimate: e } = await estimate(estimateId);
      const p = await prepare('manage_estimate', {
        estimateId,
        action: 'make_invoice',
        bill: 'deposit_only',
      });
      expect(field(p.card, 'It bills')).toBe(`Only the ${money(e.depositCents)} deposit`);
      expect(warningsOf(p.card)).toContain('Nothing goes to Maria until you send it');
      expect((await estimate(estimateId)).invoices).toHaveLength(0);
      const done = await p.confirm();
      expect(done.command).toBe('estimate.convert');
      const { invoices } = await estimate(estimateId);
      expect(invoices).toMatchObject([
        { id: idOf(done.href), purpose: 'deposit', totalCents: e.depositCents, status: 'draft' },
      ]);
    });
  });

  it('voids one that went out, saying it can’t be undone', async () => {
    const { estimateId: other } = (await run(estimateCreate, {
      workspaceId,
      personId: maria.id,
      title: 'Attic insulation',
      lines: [line('Insulation', 90_000)],
    })) as { estimateId: string };
    // A draft can't be approved: it hasn't been shown to anyone.
    await expect(
      prepare('manage_estimate', { estimateId: other, action: 'record_yes' }),
    ).rejects.toThrow(/hasn’t been sent yet/);
    await run(estimateSend, { workspaceId, estimateId: other, channels: [] });
    const p = await prepare('manage_estimate', {
      estimateId: other,
      action: 'void',
      reason: 'Priced wrong',
    });
    expect(p.card.title).toMatch(/^Void EST-\d+\?$/);
    expect(warningsOf(p.card)).toMatch(/caution: It can’t be undone/);
    expect(warningsOf(p.card)).toContain('link will say it was withdrawn');
    expect((await estimate(other)).estimate.status).toBe('sent');
    await p.confirm();
    expect((await estimate(other)).estimate).toMatchObject({
      status: 'void',
      voidReason: 'Priced wrong',
    });
  });
});

// ---------------------------------------------------------------------------

describe('an invoice, written and sent by asking', () => {
  let invoiceId: string;

  it('writes one, paid into the account the person bills into', async () => {
    const p = await prepare('write_invoice', {
      personId: maria.id,
      title: 'Duct repair',
      lines: [{ name: 'Duct repair', unitPrice: 450, taxable: false }],
      dueOn: '2026-12-01',
    });
    expect(p.card.title).toBe('Write an invoice for Maria Lopez');
    expect(field(p.card, 'Paid into')).toBe('Stripe · Lone Star');
    expect(field(p.card, 'Due')).toBe('Tue, Dec 1');
    expect(field(p.card, 'Total')).toBe('$450');
    const done = await p.confirm();
    invoiceId = idOf(done.href);
    const { invoice: i } = await invoice(invoiceId);
    expect(i).toMatchObject({
      status: 'draft',
      origin: 'assistant',
      connectionId: stripeId,
      dueOn: '2026-12-01',
    });
  });

  it('changes the draft and keeps its due date', async () => {
    const p = await prepare('write_invoice', { invoiceId, addLines: [{ productId: tuneUpId }] });
    expect(field(p.card, 'Was')).toBe('$450');
    await p.confirm();
    const { invoice: i } = await invoice(invoiceId);
    expect(i.lines.map((l) => l.name)).toEqual(['Duct repair', 'AC tune-up']);
    expect(i).toMatchObject({ dueOn: '2026-12-01', title: 'Duct repair', status: 'draft' });
  });

  it('sends it by email and text, taking the number the card said', async () => {
    const p = await prepare('manage_invoice', {
      invoiceId,
      action: 'send',
      channels: ['email', 'sms'],
      message: 'Thanks for having us out.',
    });
    expect(p.card.title).toBe('Send an invoice to Maria Lopez');
    expect(field(p.card, 'How')).toBe(`Email · ${maria.email} and Text · ${maria.phone}`);
    expect(p.card.body).toBe('Thanks for having us out.');
    expect(warningsOf(p.card)).toMatch(/caution: It goes to Maria now and is frozen/);
    expect((await invoice(invoiceId)).invoice.status).toBe('draft');
    await p.confirm();
    const { invoice: i } = await invoice(invoiceId);
    expect(i.status).toBe('sent');
    expect(i.number).toBe(field(p.card, 'Number'));
    const [sent] = await eventsOf('invoice.sent', invoiceId);
    expect(sent?.payload).toMatchObject({
      channels: ['email', 'sms'],
      message: 'Thanks for having us out.',
    });
  });

  it('won’t send to someone it can’t reach', async () => {
    const { invoiceId: sams } = (await run(invoiceCreate, {
      workspaceId,
      personId: samId,
      lines: [line('Repair', 10_000)],
    })) as { invoiceId: string };
    const p = await prepare('manage_invoice', { invoiceId: sams, action: 'send' });
    expect(p.card.confirmLabel).toBe('');
    expect(p.card.warnings[0]?.kind).toBe('blocked');
    expect(p.result).toMatchObject({ blocked: true });
  });

  it('voids a draft, and says money paid has to go back first', async () => {
    const { invoiceId: spare } = (await run(invoiceCreate, {
      workspaceId,
      personId: maria.id,
      lines: [line('Spare', 5_000)],
    })) as { invoiceId: string };
    const p = await prepare('manage_invoice', { invoiceId: spare, action: 'void' });
    expect(p.card.title).toBe('Void the draft invoice?');
    await p.confirm();
    expect((await invoice(spare)).invoice.status).toBe('void');

    await run(invoiceRecordCashPayment, {
      workspaceId,
      invoiceId,
      amountCents: 10_000,
      method: 'cash',
    });
    await expect(prepare('manage_invoice', { invoiceId, action: 'void' })).rejects.toThrow(
      /Refund it first/,
    );
  });

  describe('a refund', () => {
    it('of cash: says money leaves, moves nothing until Confirm, and asks once', async () => {
      const p = await prepare('refund_payment', { invoiceId, amount: 40, reason: 'Overcharged' });
      expect(p.card.title).toBe('Refund $40 to Maria Lopez?');
      expect(field(p.card, 'Payment')).toMatch(/^\$100 by cash · /);
      expect(field(p.card, 'Still refundable after')).toBe('$60');
      expect(p.card.warnings[0]).toMatchObject({ kind: 'caution' });
      expect(warningsOf(p.card)).toContain('Money leaves the business');
      expect(warningsOf(p.card)).toContain('The invoice stays paid');
      expect((await invoice(invoiceId)).refunds).toHaveLength(0);
      await p.confirm();
      expect((await invoice(invoiceId)).refunds).toMatchObject([
        { amountCents: 4_000, status: 'pending', reason: 'Overcharged' },
      ]);
      const [key] = await rows<{ idempotency_key: string }>(
        admin(),
        sql`select idempotency_key from app.refunds where invoice_id = ${invoiceId}::uuid`,
      );
      expect(key?.idempotency_key).toBe(`assistant-refund-${p.toolCallId}`);
      // Money on its way back: the invoice can't be voided until it has landed.
      await expect(prepare('manage_invoice', { invoiceId, action: 'void' })).rejects.toThrow(
        /still on its way back/,
      );
    });

    it('of a card: goes back to the card, never more than is left, and counts what is on its way', async () => {
      const cardInvoice = await sentInvoice(maria.id, 20_000);
      await sys(invoiceRecordPayment, {
        workspaceId,
        invoiceId: cardInvoice,
        amountCents: 20_000,
        method: 'card',
        provider: 'stripe',
        connectionId: stripeId,
        providerPaymentId: `pi_${suffix}`,
        status: 'succeeded',
        cardBrand: 'Visa',
        cardLast4: '4242',
      });
      await expect(
        prepare('refund_payment', { invoiceId: cardInvoice, amount: 500 }),
      ).rejects.toThrow(/Only \$200 of that payment/);
      const p = await prepare('refund_payment', { invoiceId: cardInvoice });
      expect(field(p.card, 'Refund')).toBe('$200');
      expect(warningsOf(p.card)).toContain('goes back to Maria’s Visa •••• 4242 through Stripe');
      await p.confirm();
      expect((await invoice(cardInvoice)).refunds).toMatchObject([
        { amountCents: 20_000, status: 'pending' },
      ]);
      await expect(prepare('refund_payment', { invoiceId: cardInvoice })).rejects.toThrow(
        /already been refunded/,
      );
    });

    it('is never done for a member, even if asked', async () => {
      const cardInvoice = await sentInvoice(maria.id, 3_000);
      await run(invoiceRecordCashPayment, {
        workspaceId,
        invoiceId: cardInvoice,
        amountCents: 3_000,
        method: 'cash',
      });
      const p = await prepare('refund_payment', { invoiceId: cardInvoice });
      const tool = assistantToolByName.get('refund_payment')!;
      await expect(
        createToolExecutor(api()).commit(tool, { invoiceId: cardInvoice }, ctxFor(member), {
          toolCallId: p.toolCallId,
        }),
      ).rejects.toThrow();
      expect((await invoice(cardInvoice)).refunds).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------

describe('the plans a business sells, and a customer on one', () => {
  let planId: string;
  let subscriptionId: string;

  it('adds a plan with its visits', async () => {
    const p = await prepare('manage_plan', {
      action: 'create',
      name: 'Comfort Club',
      priceDollars: 29,
      includes: ['Two tune-ups a year', '15% off repairs'],
      serviceId,
      visitEveryMonths: 6,
    });
    expect(p.card.title).toBe('Add the Comfort Club plan');
    expect(field(p.card, 'Price')).toBe('$29 a month');
    expect(field(p.card, 'Visits')).toBe('Maintenance visit every 6 months');
    const plans = () =>
      ask<{ plans: { id: string; name: string; priceCents: number; archivedAt: string | null }[] }>(
        'plan.list',
        { includeArchived: true },
      ).then((r) => r.plans.filter((x) => x.name === 'Comfort Club'));
    expect(await plans()).toHaveLength(0);
    await p.confirm();
    const [made] = await plans();
    planId = made!.id;
    await expect(
      prepare('manage_plan', { action: 'create', name: 'Half', priceDollars: 9, serviceId }),
    ).rejects.toThrow(/how often/);
  });

  it('changes its price, and says who is already on it keeps theirs', async () => {
    const p = await prepare('manage_plan', { action: 'change', planId, priceDollars: 35 });
    expect(field(p.card, 'Price')).toBe('$35 a month · was $29 a month');
    expect(warningsOf(p.card)).toContain('keep the price');
    await p.confirm();
    const { plans } = await ask<{ plans: { id: string; priceCents: number }[] }>('plan.list');
    expect(plans.find((x) => x.id === planId)?.priceCents).toBe(3_500);
    await expect(
      prepare('manage_plan', { action: 'change', planId, priceDollars: 35 }),
    ).rejects.toThrow('Nothing would change.');
  });

  it('puts a customer on it, waiting on their card, and emails them the link', async () => {
    const p = await prepare('manage_customer_plan', {
      action: 'start',
      personId: maria.id,
      planId,
      sendBy: ['email'],
    });
    expect(p.card.title).toBe('Put Maria Lopez on Comfort Club');
    expect(field(p.card, 'Bills through')).toBe('Stripe · Lone Star');
    expect(field(p.card, 'Card link')).toBe(`Email · ${maria.email}`);
    expect(warningsOf(p.card)).toContain('Nothing is billed until Maria puts a card on it');
    expect(warningsOf(p.card)).toContain('caution: Emails Maria the link');
    const theirs = () =>
      ask<{ subscriptions: { id: string; status: string }[] }>('subscription.list', {
        personId: maria.id,
      }).then((r) => r.subscriptions);
    expect(await theirs()).toHaveLength(0);
    const done = await p.confirm();
    expect(done.command).toBe('subscription.start');
    const [sub] = await theirs();
    subscriptionId = sub!.id;
    expect(sub!.status).toBe('draft');
    const [asked] = await eventsOf('subscription.card_requested', subscriptionId);
    expect(asked?.payload).toMatchObject({ channels: ['email'] });
  });

  it('lists the plans and who is on them, with the ids the other tools take', async () => {
    const all = await look('list_plans', {});
    expect(all.result['plans']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ planId, name: 'Comfort Club', customersOnIt: 1, onSale: true }),
      ]),
    );
    const hers = await look('list_plans', { personId: maria.id });
    expect(hers.result['customers']).toMatchObject([
      {
        subscriptionId,
        customer: 'Maria Lopez',
        status: 'Waiting on a card',
        card: 'asked for, not added yet',
      },
    ]);
  });

  it('won’t pause a plan that isn’t billing yet', async () => {
    await expect(
      prepare('manage_customer_plan', { action: 'pause', subscriptionId }),
    ).rejects.toThrow(/Only a plan that is billing/);
  });

  it('pauses and resumes a billing plan', async () => {
    await sys(subscriptionRecordCycle, {
      workspaceId,
      subscriptionId,
      outcome: 'activated',
      provider: 'stripe',
      externalSubscriptionId: `sub_${suffix}`,
      nextBillingOn: '2026-10-26',
    });
    const status = async () =>
      (await ask<{ subscription: { status: string } }>('subscription.get', { subscriptionId }))
        .subscription.status;
    const pause = await prepare('manage_customer_plan', { action: 'pause', subscriptionId });
    expect(pause.card.title).toBe('Pause Maria’s Comfort Club?');
    expect(warningsOf(pause.card)).toContain('Nothing is charged until you start it again');
    expect(await status()).toBe('active');
    await pause.confirm();
    expect(await status()).toBe('paused');

    const resume = await prepare('manage_customer_plan', { action: 'resume', subscriptionId });
    expect(warningsOf(resume.card)).toContain('caution: Maria’s card is charged $35 a month again');
    await resume.confirm();
    expect(await status()).toBe('active');
  });

  it('asks for a card, by email when they have one', async () => {
    const p = await prepare('manage_customer_plan', { action: 'ask_for_card', subscriptionId });
    expect(field(p.card, 'How')).toBe(`Email · ${maria.email}`);
    const done = await p.confirm();
    expect(done.command).toBe('subscription.request_card');
    expect(await eventsOf('subscription.card_requested', subscriptionId)).toHaveLength(2);
  });

  it('cancels, saying it can’t be restarted', async () => {
    const p = await prepare('manage_customer_plan', {
      action: 'cancel',
      subscriptionId,
      reason: 'Moving away',
    });
    expect(warningsOf(p.card)).toContain('caution: Maria won’t be billed again');
    await p.confirm();
    const { subscription } = await ask<{
      subscription: { status: string; cancelReason: string | null };
    }>('subscription.get', { subscriptionId });
    expect(subscription).toMatchObject({ status: 'cancelled', cancelReason: 'Moving away' });
  });

  it('stops selling the plan, and sells it again', async () => {
    const stop = await prepare('manage_plan', { action: 'stop_selling', planId });
    expect(field(stop.card, 'On it now')).toBe('0 customers');
    expect(warningsOf(stop.card)).toContain('Anyone already on it stays on it');
    await stop.confirm();
    const onSale = async () =>
      ((await look('list_plans', {})).result['plans'] as { planId: string }[]).some(
        (x) => x.planId === planId,
      );
    expect(await onSale()).toBe(false);
    await (await prepare('manage_plan', { action: 'sell_again', planId })).confirm();
    expect(await onSale()).toBe(true);
  });

  it('won’t start a plan with nowhere to bill, as the screen won’t', async () => {
    const { planId: barePlan } = (await run(planCreate, {
      workspaceId: bare.workspaceId,
      name: 'Basic',
      priceCents: 1_900,
    })) as { planId: string };
    const { personId } = (await run(personCreate, {
      workspaceId: bare.workspaceId,
      firstName: 'Ana',
      lastName: 'Diaz',
    })) as { personId: string };
    const p = await prepare(
      'manage_customer_plan',
      { action: 'start', personId, planId: barePlan },
      owner,
      bare,
    );
    expect(p.card.confirmLabel).toBe('');
    expect(p.card.warnings).toMatchObject([{ kind: 'blocked' }]);
    expect(warningsOf(p.card)).toContain('Connect Stripe or Square');
  });
});

// ---------------------------------------------------------------------------

describe('numbering and ways to pay', () => {
  const settings = () =>
    ask<{ settings: MoneySettings; nextInvoiceNumber: string; nextEstimateNumber: string }>(
      'money.settings',
    );

  it('starts from where the counter really is, not where the settings say', async () => {
    const got = await settings();
    // Invoices have gone out above: the counter has moved on and the settings document hasn't.
    expect(got.settings.numbering.invoice.next).toBe(1_001);
    expect(got.nextInvoiceNumber).not.toBe('INV-1001');
    const next = Number(/(\d+)$/.exec(got.nextInvoiceNumber)![1]);

    const p = await prepare('update_numbering_and_ways_to_pay', {
      invoicePrefix: 'LS-',
      offerBankTransfer: false,
    });
    expect(field(p.card, 'Next invoice')).toBe(`LS-${next} · was ${got.nextInvoiceNumber}`);
    expect(field(p.card, 'Bank transfer')).toBe('Not offered — customers see card only');
    expect((await settings()).settings.bankTransfer).toBe(true);
    await p.confirm();
    const after = await settings();
    expect(after.nextInvoiceNumber).toBe(`LS-${next}`);
    expect(after.settings.bankTransfer).toBe(false);
    expect(after.nextEstimateNumber).toBe(got.nextEstimateNumber);
    // Nothing else in the settings moved.
    expect(after.settings.tax.rateBp).toBe(825);
  });

  it('jumps forward with a warning, and never goes back', async () => {
    const p = await prepare('update_numbering_and_ways_to_pay', { estimateNextNumber: 5_000 });
    expect(warningsOf(p.card)).toMatch(/caution: Estimate numbers jump from \d+ to 5000/);
    await p.confirm();
    expect((await settings()).nextEstimateNumber).toBe('EST-5000');
    await expect(
      prepare('update_numbering_and_ways_to_pay', { invoiceNextNumber: 5 }),
    ).rejects.toThrow(/only moves forward/);
  });
});

// ---------------------------------------------------------------------------

describe('automatic top-up of the balance', () => {
  beforeAll(async () => {
    // A balance with a card on it and automatic top-up off: the card from the provider, then the owner's own
    // press turning it off (a card going on turns it on), and the business on the wallet (stage is HandsFreeOS's
    // to set, so it is set the way the worker would).
    await sys(walletRecordCard, {
      workspaceId,
      provider: 'stripe',
      customerRef: `cus_${suffix}`,
      methodToken: `pm_${suffix}`,
      cardBrand: 'Visa',
      cardLast4: '4242',
      cardExpiryMonth: 4,
      cardExpiryYear: 2030,
    });
    await run(walletSetAutoTopup, { workspaceId, autoTopup: false });
    await admin().transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.system_scope.workspace_id', ${workspaceId}, true)`,
      );
      await tx.execute(
        sql`update app.usage_wallets set stage = 'warn' where workspace_id = ${workspaceId}`,
      );
    });
  });

  /** The row itself: what was really stored, not what the tool said it would store. */
  const wallet = async () => {
    const [w] = await rows<{ auto_topup: boolean; floor_cents: number; topup_cents: number }>(
      admin(),
      sql`select auto_topup, floor_cents::int as floor_cents, topup_cents::int as topup_cents
          from app.usage_wallets where workspace_id = ${workspaceId}`,
    );
    return { autoTopup: w!.auto_topup, floorCents: w!.floor_cents, topupCents: w!.topup_cents };
  };

  it('says it charges the card by itself, and changes nothing until Confirm', async () => {
    const p = await prepare('update_auto_topup', { on: true, belowDollars: 20, addDollars: 50 });
    expect(field(p.card, 'Automatic top-up')).toMatch(/^On/);
    expect(field(p.card, 'Tops up below')).toMatch(/^\$20/);
    expect(field(p.card, 'Adds each time')).toMatch(/^\$50/);
    expect(p.card.warnings[0]?.kind).toBe('caution');
    expect(warningsOf(p.card)).toMatch(
      /It charges \$50 to .+ by itself whenever the balance drops below \$20/,
    );
    expect(await wallet()).toMatchObject({ autoTopup: false });
    await p.confirm();
    expect(await wallet()).toEqual({ autoTopup: true, floorCents: 2_000, topupCents: 5_000 });
  });

  it('turning it off says what stops', async () => {
    const p = await prepare('update_auto_topup', { on: false });
    expect(warningsOf(p.card)).toContain('outbound texts and calls stop');
    await p.confirm();
    expect(await wallet()).toEqual({ autoTopup: false, floorCents: 2_000, topupCents: 5_000 });
  });

  it('can’t be turned on with no card, as the screen’s switch can’t', async () => {
    const p = await prepare('update_auto_topup', { on: true }, owner, bare);
    expect(p.card.confirmLabel).toBe('');
    expect(p.card.warnings).toMatchObject([{ kind: 'blocked' }]);
  });
});
