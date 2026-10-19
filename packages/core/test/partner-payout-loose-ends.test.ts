/**
 * The payout loose ends (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 5): Stripe's fee for each partner's 1099
 * rides on the first payout after the year, once; a line held for a partner deleted for good is given back to the
 * business's card; and a refund the client's bank turns down after it went through gives the partner their share
 * back.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachAddon } from '../src/addons/outreach/manifest';
import { executeCommand } from '../src/kernel/execute';
import type { CommandContext } from '../src/kernel/types';
import { canRefundMove } from '../src/money/status';
import {
  givenBackCents,
  payoutTotals,
  TAX_FORM_FEE_CENTS,
  taxFormThresholdCents,
} from '../src/partners/payouts';
import {
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  partnerAdd,
  partnerCommissionGiveBack,
  partnerCommissionNote,
  partnerCommissionTakeBack,
  partnerGet,
  partnerPayoutBuild,
  partnerPayoutGet,
  partnerPayoutGiveBack,
  partnerPayoutRecordAccount,
  partnerPayoutRecordCard,
  partnerPayoutRecordCharge,
  partnerPayoutRecordTransfer,
  partnerPayouts,
  partnerReferralSet,
  partnerSetPayoutsOpen,
  partnersSaveSettings,
  paymentRecordRefund,
  paymentRefund,
  personCreate,
  taxFormsDue,
} from '../src/server';
import {
  admin,
  ask,
  human,
  makeCalendar,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

describe('Stripe’s fee for each 1099', () => {
  it('counts each form on its own line, inside what the card is charged', () => {
    const t = payoutTotals([10_000], 2);
    expect(t.taxFormsCents).toBe(2 * TAX_FORM_FEE_CENTS);
    expect(
      t.owedCents + t.accountFeesCents + t.payoutFeesCents + t.taxFormsCents + t.cardFeeCents,
    ).toBe(t.chargeCents);
    expect(t.chargeCents).toBeGreaterThan(payoutTotals([10_000]).chargeCents);
    expect(payoutTotals([10_000]).taxFormsCents).toBe(0);
  });

  it('files a form once a year’s payments reach the IRS’s threshold', () => {
    expect(taxFormThresholdCents(2026)).toBe(200_000);
    expect(taxFormThresholdCents(2025)).toBe(60_000);
  });

  it('gives back a line with both its Stripe fees', () => {
    expect(givenBackCents({ amountCents: 10_000, accountFeeCents: 200, payoutFeeCents: 50 })).toBe(
      10_250,
    );
  });

  it('lets a refund fail after it went through, and nothing else go back', () => {
    expect(canRefundMove('succeeded', 'failed')).toBe(true);
    expect(canRefundMove('failed', 'succeeded')).toBe(false);
    expect(canRefundMove('succeeded', 'pending')).toBe(false);
  });
});

describe('the payout loose ends', () => {
  let t: Team;
  let staff: TestUser;
  const ws = () => ({ workspaceId: t.wsId });

  async function contact(firstName: string): Promise<string> {
    const out = await run(
      personCreate,
      {
        ...ws(),
        firstName,
        lastName: 'Ortiz',
        email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`,
        ignoreDuplicates: true,
      },
      t.owner,
    );
    return out.personId;
  }

  async function partner(firstName: string): Promise<string> {
    const personId = await contact(firstName);
    return (await run(partnerAdd, { ...ws(), personId }, t.owner)).partnerId;
  }

  /** A client of theirs pays this much, and the share is free to pay out at once. */
  async function earn(partnerId: string, paidCents: number): Promise<string> {
    const client = await contact(`Client${randomUUID().slice(0, 4)}`);
    await run(partnerReferralSet, { ...ws(), personId: client, partnerId }, t.owner);
    const made = await run(
      invoiceCreate,
      {
        ...ws(),
        personId: client,
        title: 'Duct cleaning',
        lines: [{ name: 'Job', quantity: 1, unitPriceCents: paidCents, taxable: false }],
      },
      t.owner,
    );
    await run(invoiceSend, { ...ws(), invoiceId: made.invoiceId, channels: [] }, t.owner);
    const paid = await run(
      invoiceRecordCashPayment,
      { ...ws(), invoiceId: made.invoiceId, amountCents: paidCents },
      t.owner,
    );
    await runSystem(partnerCommissionNote, { ...ws(), paymentId: paid.paymentId }, t.scope);
    await rows(
      admin(),
      sql`update app.partner_commissions set payable_at = now() - interval '1 day'
          where payment_id = ${paid.paymentId}`,
    );
    return paid.paymentId;
  }

  const accountRefOf = (partnerId: string) => `acct_${partnerId.replace(/-/g, '').slice(0, 16)}`;

  const bank = (partnerId: string) =>
    runSystem(
      partnerPayoutRecordAccount,
      {
        ...ws(),
        partnerId,
        accountRef: accountRefOf(partnerId),
        livemode: true,
        detailsSubmitted: true,
        payoutsEnabled: true,
        transfersActive: true,
        disabledReason: null,
        due: [],
      },
      t.scope,
    );

  const build = (month: string) =>
    runSystem(partnerPayoutBuild, { ...ws(), month, livemode: true }, t.scope);

  const charge = (payoutId: string, attempt: number, outcome: 'declined' | 'succeeded') =>
    runSystem(
      partnerPayoutRecordCharge,
      {
        ...ws(),
        payoutId,
        attempt,
        outcome,
        paymentRef: `pi_${payoutId.slice(0, 8)}_${attempt}`,
        ...(outcome === 'succeeded'
          ? { chargeRef: `ch_${payoutId.slice(0, 8)}`, cardBrand: 'Visa', cardLast4: '4242' }
          : {
              failureCode: 'insufficient_funds',
              failureMessage: 'Your card has insufficient funds.',
            }),
      },
      t.scope,
    );

  const linesOf = (payoutId: string) =>
    rows<{
      id: string;
      partner_id: string | null;
      amount_cents: number;
      account_fee_cents: number;
      payout_fee_cents: number;
      status: string;
    }>(
      admin(),
      sql`select id, partner_id, amount_cents::int as amount_cents, account_fee_cents::int as account_fee_cents,
            payout_fee_cents::int as payout_fee_cents, status
          from app.partner_payout_lines where payout_id = ${payoutId} order by amount_cents desc`,
    );

  const send = (lineId: string, outcome: 'paid' | 'held') =>
    runSystem(
      partnerPayoutRecordTransfer,
      {
        ...ws(),
        lineId,
        outcome,
        transferRef: outcome === 'paid' ? `tr_${lineId.slice(0, 8)}` : null,
        heldReason: outcome === 'held' ? 'This account can’t receive transfers yet.' : null,
      },
      t.scope,
    );

  const formsOf = (payoutId: string) =>
    rows<{ partner_id: string | null; tax_year: number; paid_cents: number; fee_cents: number }>(
      admin(),
      sql`select partner_id, tax_year, paid_cents::int as paid_cents, fee_cents::int as fee_cents
          from app.partner_tax_forms where payout_id = ${payoutId}`,
    );

  const payoutRow = async (payoutId: string) =>
    (
      await rows<{ tax_forms_cents: number; charge_cents: number; status: string }>(
        admin(),
        sql`select tax_forms_cents::int as tax_forms_cents, charge_cents::int as charge_cents, status
            from app.partner_payouts where id = ${payoutId}`,
      )
    )[0]!;

  const due = (month: string, livemode = true) =>
    taxFormsDue({ tx: admin() } as unknown as CommandContext, t.wsId, month, livemode);

  let pia: string;
  let ben: string;
  let stillPaying: string;

  beforeAll(async () => {
    t = await setupTeam('payout-ends');
    staff = await createTestUser('payout-ends-staff');
    await admin().execute(
      sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
          on conflict (user_id) do update set role = 'admin', status = 'active'`,
    );
    const calendarId = (
      await makeCalendar(t, 'Tune-ups', {
        public: true,
        team: { members: [{ userId: t.owner.id }], assignment: 'round_robin' },
      })
    ).id;
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'outreach', 'enabled', ${outreachAddon.version})`,
    );
    await run(
      partnersSaveSettings,
      {
        ...ws(),
        settings: { rateBp: 1_000, terms: '', smallestPayoutCents: 2_500, calendarId },
      },
      t.owner,
    );
    await executeCommand(
      testDbs().api.db,
      partnerSetPayoutsOpen,
      { ...ws(), open: true, reason: 'Trying it on one business' },
      human(staff),
      { correlationId: randomUUID(), channel: 'test' },
    );
    await runSystem(
      partnerPayoutRecordCard,
      {
        ...ws(),
        provider: 'stripe',
        customerRef: 'cus_payout_ends',
        methodToken: 'pm_4242',
        cardBrand: 'Visa',
        cardLast4: '4242',
        cardExpiryMonth: 12,
        cardExpiryYear: 2030,
      },
      t.scope,
    );
    pia = await partner('Pia');
    ben = await partner('Ben');
    await bank(pia);
    await bank(ben);
  });
  afterAll(closeTestDbs);

  it('charge Stripe’s fee for each 1099 on the first payout after the year, once', async () => {
    // Pia is paid $2,000 in 2026, the threshold; Ben $100.
    await earn(pia, 2_000_000);
    await earn(ben, 100_000);
    const nov = await build('2026-11-01');
    expect(nov).toMatchObject({ outcome: 'built', partners: 2 });
    expect((await payoutRow(nov.payoutId!)).tax_forms_cents).toBe(0);
    await charge(nov.payoutId!, 1, 'succeeded');
    for (const l of await linesOf(nov.payoutId!)) await send(l.id, 'paid');
    await rows(
      admin(),
      sql`update app.partner_payout_lines set paid_at = '2026-06-15T12:00:00Z' where payout_id = ${nov.payoutId}`,
    );

    expect(await due('2027-01-01')).toEqual([
      { accountRef: accountRefOf(pia), partnerId: pia, taxYear: 2026, paidCents: 200_000 },
    ]);
    // Not before the year ends, and never on a test payout.
    expect(await due('2026-12-01')).toEqual([]);
    expect(await due('2027-01-01', false)).toEqual([]);

    await earn(pia, 50_000);
    const jan = await build('2027-01-01');
    expect(jan.chargeCents).toBe(payoutTotals([5_000], 1).chargeCents);
    expect(await payoutRow(jan.payoutId!)).toMatchObject({
      tax_forms_cents: TAX_FORM_FEE_CENTS,
      charge_cents: jan.chargeCents,
    });
    expect(await formsOf(jan.payoutId!)).toEqual([
      { partner_id: pia, tax_year: 2026, paid_cents: 200_000, fee_cents: TAX_FORM_FEE_CENTS },
    ]);
    const statement = await ask(partnerPayoutGet, { ...ws(), payoutId: jan.payoutId! }, t.owner);
    expect(statement.payout.totals.taxFormsCents).toBe(TAX_FORM_FEE_CENTS);
    expect(statement.taxForms).toEqual([
      { name: 'Pia Ortiz', taxYear: 2026, paidCents: 200_000, feeCents: TAX_FORM_FEE_CENTS },
    ]);

    // A payout that's given up on lets its forms go to the next one.
    for (const attempt of [1, 2, 3, 4]) await charge(jan.payoutId!, attempt, 'declined');
    expect((await payoutRow(jan.payoutId!)).status).toBe('failed');
    expect(await formsOf(jan.payoutId!)).toEqual([]);
    const feb = await build('2027-02-01');
    expect((await payoutRow(feb.payoutId!)).tax_forms_cents).toBe(TAX_FORM_FEE_CENTS);
    expect(await formsOf(feb.payoutId!)).toHaveLength(1);
    await charge(feb.payoutId!, 1, 'succeeded');
    stillPaying = feb.payoutId!;

    // Charged once: the next month carries none.
    await earn(pia, 50_000);
    const mar = await build('2027-03-01');
    expect((await payoutRow(mar.payoutId!)).tax_forms_cents).toBe(0);
    expect(await due('2027-04-01')).toEqual([]);
  });

  it('give back a line held for a partner deleted for good, and only theirs', async () => {
    const dee = await partner('Dee');
    await bank(dee);
    await earn(dee, 100_000);
    const apr = await build('2027-04-01');
    await charge(apr.payoutId!, 1, 'succeeded');
    const [line] = (await linesOf(apr.payoutId!)).filter((l) => l.partner_id === dee);
    await send(line!.id, 'held');

    // A partner still kept is never given back.
    const [kept] = await linesOf(stillPaying);
    const back = givenBackCents({
      amountCents: line!.amount_cents,
      accountFeeCents: line!.account_fee_cents,
      payoutFeeCents: line!.payout_fee_cents,
    });
    expect(
      await runSystem(
        partnerPayoutGiveBack,
        { ...ws(), lineId: kept!.id, refundRef: 're_kept', amountCents: back },
        t.scope,
      ),
    ).toMatchObject({ given: false });

    await rows(admin(), sql`delete from app.partners where id = ${dee}`);
    const unfinished = await rows<{ payout_id: string }>(
      admin(),
      sql`select payout_id from private.partner_payouts_unfinished(500)`,
    );
    expect(unfinished.map((u) => u.payout_id)).toContain(apr.payoutId);

    const giveBack = () =>
      runSystem(
        partnerPayoutGiveBack,
        { ...ws(), lineId: line!.id, refundRef: 're_dee', amountCents: back },
        t.scope,
      );
    expect(await giveBack()).toMatchObject({ given: true });
    expect(await giveBack()).toMatchObject({ given: false });
    const statement = await ask(partnerPayoutGet, { ...ws(), payoutId: apr.payoutId! }, t.owner);
    expect(statement.lines.find((l) => l.lineId === line!.id)).toMatchObject({
      partnerId: null,
      name: 'A deleted partner',
      status: 'cancelled',
      givenBackCents: back,
    });
    expect(statement.lines.find((l) => l.lineId === line!.id)?.givenBackAt).not.toBeNull();
  });

  it('give a partner back their share when a refund fails after it went through', async () => {
    const fay = await partner('Fay');
    const paymentId = await earn(fay, 100_000);
    const refund = async (cents: number) => {
      const asked = await run(paymentRefund, { ...ws(), paymentId, amountCents: cents }, t.owner);
      await runSystem(
        paymentRecordRefund,
        { ...ws(), refundId: asked.refundId, status: 'succeeded' },
        t.scope,
      );
      await runSystem(partnerCommissionTakeBack, { ...ws(), refundId: asked.refundId }, t.scope);
      return asked.refundId;
    };
    const fail = (refundId: string) =>
      runSystem(
        paymentRecordRefund,
        { ...ws(), refundId, status: 'failed', failureCode: 'expired_or_canceled_card' },
        t.scope,
      );
    const giveBack = (refundId: string) =>
      runSystem(partnerCommissionGiveBack, { ...ws(), refundId }, t.scope);
    const earnings = async () =>
      (await ask(partnerGet, { ...ws(), partnerId: fay }, t.owner)).partner.earnings;
    const refunded = async () =>
      (
        await rows<{ cents: number }>(
          admin(),
          sql`select i.amount_refunded_cents::int as cents
              from app.payments p join app.invoices i on i.id = p.invoice_id where p.id = ${paymentId}`,
        )
      )[0]!.cents;

    // No payout took it yet: given back beside it, free to pay out with it.
    const first = await refund(40_000);
    expect(await refunded()).toBe(40_000);
    expect((await earnings()).payableCents).toBe(6_000);
    expect(await fail(first)).toMatchObject({ status: 'failed' });
    expect(await refunded()).toBe(0);
    expect(await giveBack(first)).toEqual({ givenBack: true });
    expect(await giveBack(first)).toEqual({ givenBack: false });
    expect((await earnings()).payableCents).toBe(10_000);

    // A payout took it: given back, free to pay out now.
    await bank(fay);
    const second = await refund(20_000);
    const may = await build('2027-05-01');
    expect((await linesOf(may.payoutId!)).find((l) => l.partner_id === fay)?.amount_cents).toBe(
      8_000,
    );
    await fail(second);
    expect(await giveBack(second)).toEqual({ givenBack: true });
    expect(await giveBack(second)).toEqual({ givenBack: false });
    const page = await ask(partnerGet, { ...ws(), partnerId: fay }, t.owner);
    expect(
      page.commissions
        .filter((c) => c.kind === 'given_back')
        .map((c) => [c.amountCents, c.baseCents])
        .sort(),
    ).toEqual([
      [2_000, 20_000],
      [4_000, 40_000],
    ]);
    const next = await ask(partnerPayouts, ws(), t.owner);
    expect(next.next.waiting).toContainEqual(
      expect.objectContaining({ partnerId: fay, owedCents: 2_000, why: 'below_smallest' }),
    );

    // A refund that never went through took nothing back.
    const asked = await run(paymentRefund, { ...ws(), paymentId, amountCents: 1_000 }, t.owner);
    await fail(asked.refundId);
    expect(await giveBack(asked.refundId)).toEqual({ givenBack: false });
  });
});
