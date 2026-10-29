/**
 * Paying partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3): Stripe's fees on their own lines and the
 * charge grossed up to cover them; once a month, only after staff open payouts and a card is on; everyone owed at
 * least the smallest payout whose bank is set up is paid, and the rest wait; a declined card is tried again on the
 * wallet's ladder, and when it gives up, what was owed waits for next month's; a partner's page shows what's on its
 * way and what's been paid.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { outreachAddon } from '../src/addons/outreach/manifest';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CustomerActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  cardFeeCents,
  grossUpCents,
  monthAfter,
  nextPayoutMonth,
  payoutFeeCents,
  payoutMonthOf,
  PAYOUT_COUNTRY_KEYS,
  payoutCountryIn,
  payoutCountryName,
  payoutTotals,
  planPayout,
} from '../src/partners/payouts';
import {
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  partnerAdd,
  partnerCommissionNote,
  partnerGet,
  partnerList,
  partnerPayoutBuild,
  partnerPayoutForgetCard,
  partnerPayoutGet,
  partnerPayoutRecordAccount,
  partnerPayoutRecordCard,
  partnerPayoutRecordCharge,
  partnerPayoutRecordTransfer,
  partnerPayouts,
  partnerReferralSet,
  partnerSetPayoutsOpen,
  partnersSaveSettings,
  platformPartnerPayoutsGet,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalPartner,
  portalSendCode,
} from '../src/server';
import {
  admin,
  ask,
  expectHfos,
  human,
  makeCalendar,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

describe('what a payout charges', () => {
  it('works out Stripe’s fees, rounded up so they’re always covered', () => {
    expect(payoutFeeCents(10_000)).toBe(50);
    expect(payoutFeeCents(10_001)).toBe(51);
    expect(cardFeeCents(10_000)).toBe(320);
    expect(cardFeeCents(1)).toBe(31);
  });

  it('charges the least that leaves everything else once the card fee is taken', () => {
    for (const subtotal of [1, 99, 2_500, 10_000, 12_345, 1_000_000, 7_654_321]) {
      const charge = grossUpCents(subtotal);
      expect(charge - cardFeeCents(charge)).toBeGreaterThanOrEqual(subtotal);
      expect(charge - 1 - cardFeeCents(charge - 1)).toBeLessThan(subtotal);
    }
    expect(grossUpCents(0)).toBe(0);
  });

  it('puts each of Stripe’s fees on its own line', () => {
    const t = payoutTotals([10_000, 5_000]);
    expect(t.lines).toEqual([
      { amountCents: 10_000, accountFeeCents: 200, payoutFeeCents: 50 },
      { amountCents: 5_000, accountFeeCents: 200, payoutFeeCents: 38 },
    ]);
    expect(t).toMatchObject({ owedCents: 15_000, accountFeesCents: 400, payoutFeesCents: 88 });
    expect(t.chargeCents).toBe(grossUpCents(15_488));
    expect(t.owedCents + t.accountFeesCents + t.payoutFeesCents + t.cardFeeCents).toBe(
      t.chargeCents,
    );
  });

  it('adds Stripe’s 0.25% for a payout to a bank outside the US (decision 118)', () => {
    expect(payoutFeeCents(10_000, true)).toBe(75);
    const t = payoutTotals([{ amountCents: 10_000, abroad: true }, 5_000]);
    expect(t.lines.map((l) => l.payoutFeeCents)).toEqual([75, 38]);
    expect(t.payoutFeesCents).toBe(113);
    expect(t.chargeCents).toBe(grossUpCents(15_000 + 400 + 113));
    expect(payoutCountryIn('US')).toBe('in the United States');
    expect(payoutCountryIn('CA')).toBe('in Canada');
    expect(payoutCountryName('BR')).toBe('Brazil');
    expect(PAYOUT_COUNTRY_KEYS[0]).toBe('US');
    expect(PAYOUT_COUNTRY_KEYS).not.toContain('IS');
  });

  it('pays everyone owed the smallest payout whose bank is set up; the rest wait', () => {
    const plan = planPayout({
      partners: [
        { partnerId: 'a', owedCents: 3_000, bankReady: true },
        { partnerId: 'b', owedCents: 2_499, bankReady: true },
        { partnerId: 'c', owedCents: 9_000, bankReady: false },
        { partnerId: 'd', owedCents: -500, bankReady: true },
        { partnerId: 'e', owedCents: 0, bankReady: true },
      ],
      smallestPayoutCents: 2_500,
    });
    expect(plan.paid.map((p) => p.partnerId)).toEqual(['a']);
    expect(plan.waiting.map((p) => [p.partnerId, p.why])).toEqual([
      ['b', 'below_smallest'],
      ['c', 'no_bank'],
    ]);
  });

  it('reads the month in the business’s own time zone', () => {
    const late = new Date('2026-11-01T03:00:00Z');
    expect(payoutMonthOf(late, 'UTC')).toBe('2026-11-01');
    expect(payoutMonthOf(late, 'America/Chicago')).toBe('2026-10-01');
    expect(payoutMonthOf(late, 'Not/AZone')).toBe('2026-11-01');
    expect(monthAfter('2026-12-01')).toBe('2027-01-01');
    expect(nextPayoutMonth({ now: late, timeZone: 'UTC', lastMonth: null })).toEqual({
      month: '2026-11-01',
      soon: true,
    });
    expect(nextPayoutMonth({ now: late, timeZone: 'UTC', lastMonth: '2026-11-01' })).toEqual({
      month: '2026-12-01',
      soon: false,
    });
  });
});

describe('paying partners', () => {
  let t: Team;
  let staff: TestUser;
  let calendarId: string;
  const ws = () => ({ workspaceId: t.wsId });
  const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });

  const open = (isOpen: boolean, who: TestUser = staff) =>
    executeCommand(
      testDbs().api.db,
      partnerSetPayoutsOpen,
      { ...ws(), open: isOpen, reason: 'Trying it on one business' },
      human(who),
      meta(),
    ).then((r) => r.output);

  async function contact(firstName: string): Promise<string> {
    const out = await run(
      personCreate,
      {
        ...ws(),
        firstName,
        lastName: 'Lopez',
        email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`,
        ignoreDuplicates: true,
      },
      t.owner,
    );
    return out.personId;
  }

  /** A partner with a client of theirs who paid this much, free to pay out already. */
  async function partnerOwed(
    firstName: string,
    paidCents: number,
  ): Promise<{ partnerId: string; personId: string }> {
    const personId = await contact(firstName);
    const { partnerId } = await run(partnerAdd, { ...ws(), personId }, t.owner);
    await earn(partnerId, paidCents);
    return { partnerId, personId };
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

  /** Their bank at Stripe, ready to be paid or not. */
  const bank = (partnerId: string, ready = true, livemode = true) =>
    runSystem(
      partnerPayoutRecordAccount,
      {
        ...ws(),
        partnerId,
        accountRef: `acct_${partnerId.replace(/-/g, '').slice(0, 16)}`,
        livemode,
        detailsSubmitted: ready,
        payoutsEnabled: ready,
        transfersActive: ready,
        disabledReason: ready ? null : 'requirements.past_due',
        due: ready ? [] : ['external_account'],
      },
      t.scope,
    );

  const card = (last4 = '4242') =>
    runSystem(
      partnerPayoutRecordCard,
      {
        ...ws(),
        provider: 'stripe',
        customerRef: 'cus_payouts',
        methodToken: `pm_${last4}`,
        cardBrand: 'Visa',
        cardLast4: last4,
        cardExpiryMonth: 12,
        cardExpiryYear: 2030,
      },
      t.scope,
    );

  const build = (month: string, livemode = true) =>
    runSystem(partnerPayoutBuild, { ...ws(), month, livemode }, t.scope);

  const earnings = async (partnerId: string) =>
    (await ask(partnerGet, { ...ws(), partnerId }, t.owner)).partner.earnings;

  const linesOf = (payoutId: string) =>
    rows<{ partner_id: string; amount_cents: number; status: string }>(
      admin(),
      sql`select partner_id, amount_cents::int as amount_cents, status from app.partner_payout_lines
          where payout_id = ${payoutId} order by amount_cents desc`,
    );

  let pia: string;
  let ben: string;
  let cy: string;
  let piaPerson: string;
  let first: string;

  beforeAll(async () => {
    t = await setupTeam('payouts');
    staff = await createTestUser('payouts-staff-admin');
    await admin().execute(
      sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
          on conflict (user_id) do update set role = 'admin', status = 'active'`,
    );
    calendarId = (
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
    // Pia is owed $100 and has a bank; Ben $20, under the smallest payout; Cy $50, with no bank yet.
    ({ partnerId: pia, personId: piaPerson } = await partnerOwed('Pia', 100_000));
    ({ partnerId: ben } = await partnerOwed('Ben', 20_000));
    ({ partnerId: cy } = await partnerOwed('Cy', 50_000));
    await bank(pia);
  });
  afterAll(closeTestDbs);

  const staffView = (who: TestUser) =>
    executeQuery(testDbs().api.db, platformPartnerPayoutsGet, ws(), human(who), meta());

  it('pay nobody until staff open them, and only staff admins open them', async () => {
    expect(await staffView(staff)).toMatchObject({ open: false, hasCard: false, payouts: 0 });
    await expectHfos(() => staffView(t.owner), 'not_found');
    expect(await build('2026-11-01')).toMatchObject({ outcome: 'not_open', payoutId: null });
    // Not found rather than forbidden: the support desk doesn't exist for someone who doesn't work here.
    await expectHfos(() => open(true, t.owner), 'not_found');
    expect(await open(true)).toMatchObject({ wasOpen: false, open: true, changed: true });
    expect(await open(true)).toMatchObject({ wasOpen: true, changed: false });
    expect(await staffView(staff)).toMatchObject({ open: true, latestStatus: null });
    // Open with no card: still nothing, and the month isn't spent.
    expect(await build('2026-11-01')).toMatchObject({ outcome: 'no_card' });
    const [b] = await rows<{ last_month: string | null }>(
      admin(),
      sql`select last_month::text from app.partner_payout_billing where workspace_id = ${t.wsId}`,
    );
    expect(b?.last_month).toBeNull();
  });

  it('show the business the next payout as it stands, with who waits and why', async () => {
    expect((await card()).card).toEqual({
      brand: 'Visa',
      last4: '4242',
      expiryMonth: 12,
      expiryYear: 2030,
    });
    const got = await ask(partnerPayouts, ws(), t.owner);
    expect(got).toMatchObject({ open: true, card: { last4: '4242' }, payouts: [] });
    expect(got.next.soon).toBe(true);
    expect(got.next.lines).toEqual([{ partnerId: pia, name: 'Pia Lopez', amountCents: 10_000 }]);
    expect(got.next.waiting).toEqual([
      { partnerId: cy, name: 'Cy Lopez', owedCents: 5_000, why: 'no_bank' },
      { partnerId: ben, name: 'Ben Lopez', owedCents: 2_000, why: 'below_smallest' },
    ]);
    const { lines: _, ...charged } = payoutTotals([10_000]);
    expect(got.next.totals).toEqual(charged);
    await expectHfos(() => ask(partnerPayouts, ws(), t.member), 'forbidden');
  });

  it('work out a month once: a line for each partner paid, and their shares taken by it', async () => {
    const built = await build('2026-11-01');
    expect(built).toMatchObject({ outcome: 'built', partners: 1 });
    first = built.payoutId!;
    expect(built.chargeCents).toBe(payoutTotals([10_000]).chargeCents);
    expect(await linesOf(first)).toEqual([
      { partner_id: pia, amount_cents: 10_000, status: 'pending' },
    ]);
    expect(await build('2026-11-01')).toMatchObject({ outcome: 'already', payoutId: first });
    expect(await earnings(pia)).toMatchObject({ payableCents: 0, payingCents: 10_000 });
    expect(await earnings(cy)).toMatchObject({ payableCents: 5_000, payingCents: 0 });
    const statement = await ask(partnerPayoutGet, { ...ws(), payoutId: first }, t.owner);
    expect(statement.payout).toMatchObject({
      month: '2026-11-01',
      status: 'charging',
      livemode: true,
      partners: 1,
      card: { brand: 'Visa', last4: '4242' },
      totals: { owedCents: 10_000, accountFeesCents: 200, payoutFeesCents: 50 },
    });
    expect(statement.lines).toMatchObject([
      { partnerId: pia, name: 'Pia Lopez', amountCents: 10_000, status: 'pending' },
    ]);
  });

  it('try a declined card again on the wallet’s ladder, then let what was owed wait for next month', async () => {
    const charge = (attempt: number, outcome: 'declined' | 'succeeded' = 'declined') =>
      runSystem(
        partnerPayoutRecordCharge,
        {
          ...ws(),
          payoutId: first,
          attempt,
          outcome,
          paymentRef: `pi_${attempt}`,
          failureCode: outcome === 'declined' ? 'insufficient_funds' : null,
          failureMessage: outcome === 'declined' ? 'Your card has insufficient funds.' : null,
        },
        t.scope,
      );
    const once = await charge(1);
    expect(once).toMatchObject({ status: 'charging', recorded: true });
    const wait = new Date(once.nextTryAt!).getTime() - Date.now();
    expect(wait).toBeGreaterThan(5.9 * 3_600_000);
    expect(wait).toBeLessThan(6.1 * 3_600_000);
    // The same try told twice is recorded once.
    expect(await charge(1)).toMatchObject({ status: 'charging', recorded: false });
    // A new card tries again at once.
    await card('1881');
    const [due] = await rows<{ soon: boolean }>(
      admin(),
      sql`select next_try_at <= now() as soon from app.partner_payouts where id = ${first}`,
    );
    expect(due?.soon).toBe(true);
    expect((await charge(2)).status).toBe('charging');
    expect((await charge(3)).status).toBe('charging');
    const given = await charge(4);
    expect(given).toMatchObject({ status: 'failed', nextTryAt: null, recorded: true });
    expect(await linesOf(first)).toEqual([
      { partner_id: pia, amount_cents: 10_000, status: 'cancelled' },
    ]);
    expect(await earnings(pia)).toMatchObject({ payableCents: 10_000, payingCents: 0 });
    const [why] = await rows<{ failure_message: string }>(
      admin(),
      sql`select failure_message from app.partner_payouts where id = ${first}`,
    );
    expect(why?.failure_message).toContain('We tried three times over four days.');
    const [failed] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${t.wsId} and event_type = 'partner.payout_failed'`,
    );
    expect(failed?.n).toBe(1);
  });

  it('pay next month’s, a line held while Stripe can’t take it, and paid once every partner is', async () => {
    await bank(cy);
    await bank(ben);
    await earn(ben, 10_000);
    const built = await build('2026-12-01');
    expect(built).toMatchObject({ outcome: 'built', partners: 3 });
    const payoutId = built.payoutId!;
    expect(await linesOf(payoutId)).toEqual([
      { partner_id: pia, amount_cents: 10_000, status: 'pending' },
      { partner_id: cy, amount_cents: 5_000, status: 'pending' },
      { partner_id: ben, amount_cents: 3_000, status: 'pending' },
    ]);
    // A transfer before the charge goes through is never recorded.
    const [piaLine, cyLine, benLine] = (
      await rows<{ id: string }>(
        admin(),
        sql`select id from app.partner_payout_lines where payout_id = ${payoutId}
            order by amount_cents desc`,
      )
    ).map((l) => l.id);
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
    expect(await send(piaLine!, 'paid')).toMatchObject({ recorded: false, status: 'pending' });

    expect(
      await runSystem(
        partnerPayoutRecordCharge,
        {
          ...ws(),
          payoutId,
          attempt: 1,
          outcome: 'succeeded',
          paymentRef: 'pi_dec',
          chargeRef: 'ch_dec',
          cardBrand: 'Visa',
          cardLast4: '1881',
        },
        t.scope,
      ),
    ).toMatchObject({ status: 'paying', recorded: true });
    expect(await send(piaLine!, 'paid')).toMatchObject({ status: 'paid', payoutStatus: 'paying' });
    expect(await send(piaLine!, 'paid')).toMatchObject({ recorded: false });
    expect(await send(cyLine!, 'held')).toMatchObject({ status: 'held', payoutStatus: 'paying' });
    expect(await send(benLine!, 'paid')).toMatchObject({ payoutStatus: 'paying' });
    expect(await send(cyLine!, 'paid')).toMatchObject({ status: 'paid', payoutStatus: 'paid' });

    expect(await earnings(pia)).toMatchObject({ paidCents: 10_000, payableCents: 0 });
    expect(await earnings(ben)).toMatchObject({ paidCents: 3_000, payableCents: 0 });
    const list = await ask(partnerList, ws(), t.owner);
    expect(list.partners.find((p) => p.partnerId === cy)?.earnings).toMatchObject({
      earnedCents: 5_000,
      paidCents: 5_000,
    });
    const got = await ask(partnerPayouts, ws(), t.owner);
    expect(got.payouts.map((p) => [p.month, p.status])).toEqual([
      ['2026-12-01', 'paid'],
      ['2026-11-01', 'failed'],
    ]);
    expect(got.payouts[0]).toMatchObject({ card: { last4: '1881' }, partners: 3 });
    const page = await ask(partnerGet, { ...ws(), partnerId: pia }, t.owner);
    expect(page.payouts.account).toEqual({
      ready: true,
      detailsSubmitted: true,
      needsMore: false,
      country: 'US',
    });
    expect(page.payouts.lines.map((l) => [l.month, l.status])).toEqual([
      ['2026-12-01', 'paid'],
      ['2026-11-01', 'cancelled'],
    ]);
  });

  it('pay a live payout from live payments only, and a test one from test payments only', async () => {
    const dot = await partnerOwed('Dot', 40_000);
    await bank(dot.partnerId, true, false);
    await rows(
      admin(),
      sql`update app.partner_commissions set test = true where partner_id = ${dot.partnerId}`,
    );
    // Live: Dot's are test payments, and her account is a test one.
    expect(await build('2027-01-01')).toMatchObject({ outcome: 'nothing' });
    // As the worker would, under the business's own scope: nobody else writes the months worked out.
    await admin().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.system_scope.workspace_id', ${t.wsId}, true)`);
      await tx.execute(
        sql`update app.partner_payout_billing set last_month = '2026-12-01' where workspace_id = ${t.wsId}`,
      );
    });
    const test = await build('2027-01-01', false);
    expect(test).toMatchObject({ outcome: 'built', partners: 1 });
    const [p] = await rows<{ livemode: boolean }>(
      admin(),
      sql`select livemode from app.partner_payouts where id = ${test.payoutId}`,
    );
    expect(p?.livemode).toBe(false);
  });

  it('let someone who manages money take the card off, and nobody put one on by hand', async () => {
    await expectHfos(() => run(partnerPayoutForgetCard, ws(), t.member), 'forbidden');
    // Not even straight at the table: the card is HandsFreeOS's to write.
    await expect(
      asUser(testDbs().api.db, t.owner.claims, (tx) =>
        tx.execute(
          sql`update app.partner_payout_billing set method_token = 'pm_mine' where workspace_id = ${t.wsId}`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(testDbs().api.db, t.owner.claims, (tx) =>
        tx.execute(
          sql`update app.partner_payout_billing set opened_at = null where workspace_id = ${t.wsId}`,
        ),
      ),
    ).rejects.toThrow();
    expect(await run(partnerPayoutForgetCard, ws(), t.owner)).toEqual({ card: null });
    expect((await ask(partnerPayouts, ws(), t.owner)).card).toBeNull();
    const [forgot] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${t.wsId} and event_type = 'partner.payout_card_forgotten'`,
    );
    expect(forgot?.n).toBe(1);
    // A payout is never charged to a card that was taken off.
    expect(await build('2027-02-01')).toMatchObject({ outcome: 'no_card' });
  });

  it('show the partner what’s on its way and what’s been paid, and their bank', async () => {
    const portal = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'portal' });
    const { accessId } = await run(portalAccessGive, { ...ws(), personId: piaPerson }, t.owner);
    const sent = await runSystem(portalSendCode, { ...ws(), accessId }, t.scope);
    const hit = await runSystem(
      portalCheckCode,
      {
        ...ws(),
        accessId,
        code: sent.code,
        tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      },
      t.scope,
    );
    const piaHere: CustomerActor = {
      type: 'customer',
      ...t.scope,
      personId: piaPerson,
      sessionId: hit.sessionId!,
    };
    const asCustomer = <O extends z.ZodType>(q: QueryDef<z.ZodType, O>): Promise<z.output<O>> =>
      executeQuery(testDbs().worker.db, q, ws(), piaHere, portal());
    const page = (await asCustomer(portalPartner)).partner!;
    expect(page.earnings).toMatchObject({
      earnedCents: 10_000,
      paidCents: 10_000,
      payableCents: 0,
    });
    expect(page.payouts).toMatchObject({
      open: true,
      smallestPayoutCents: 2_500,
      account: { ready: true, needsMore: false, country: 'US' },
    });
    // The failed month's line isn't theirs to see: what it held went into the next one.
    expect(page.payouts.lines).toMatchObject([
      { month: '2026-12-01', amountCents: 10_000, status: 'paid', livemode: true },
    ]);
    await open(false);
    expect((await asCustomer(portalPartner)).partner!.payouts.open).toBe(false);
  });
});
