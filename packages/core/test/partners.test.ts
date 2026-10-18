/**
 * Partners in core (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2): there to manage only while an add-on that
 * uses them is on, and only with Manage partners. A booking through a partner's link makes its customer theirs; each
 * payment in the client's first 12 months earns an active partner their share, free to pay out 30 days on; a refund
 * takes back the share of what went back; and it all comes out the same whichever the worker notes first.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachAddon } from '../src/addons/outreach/manifest';
import {
  commissionCents,
  monthsEndAt,
  partnerCodeOf,
  partnerLinkPath,
  PARTNER_CODE,
  payableAt,
  rateWords,
} from '../src/partners/rules';
import { partnerSettingsOf } from '../src/partners/settings';
import {
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceRecordPayment,
  invoiceSend,
  partnerAdd,
  partnerCommissionNote,
  partnerCommissionTakeBack,
  partnerGet,
  partnerList,
  partnerOfPerson,
  partnerReferralNote,
  partnerReferralSet,
  partnersSaveSettings,
  partnersSettings,
  partnerUpdate,
  paymentRecordRefund,
  paymentRefund,
  personCreate,
} from '../src/server';
import {
  admin,
  ask,
  bookOnline,
  DAY,
  expectHfos,
  isoAt,
  makeCalendar,
  nextPhone,
  nextWeekday,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

describe('how partners earn', () => {
  it('reads a partner’s code off a booking, and only theirs', () => {
    expect(partnerCodeOf('pa-AbCdEfGh23')).toBe('AbCdEfGh23');
    expect(partnerCodeOf('pa-short')).toBeNull();
    expect(partnerCodeOf('sp-AbCdEfGh23')).toBeNull();
    expect(partnerCodeOf(null)).toBeNull();
    const calendarId = randomUUID();
    expect(partnerLinkPath(calendarId, 'AbCdEfGh23')).toBe(
      `/book/c/${calendarId}?ref=pa-AbCdEfGh23`,
    );
  });

  it('works out a share to the nearest cent, 12 months from the first payment, payable 30 days on', () => {
    expect(commissionCents(12_345, 1_000)).toBe(1_235);
    expect(commissionCents(100_000, 1_250)).toBe(12_500);
    expect(monthsEndAt(new Date('2026-03-15T10:00:00Z')).toISOString()).toBe(
      '2027-03-15T10:00:00.000Z',
    );
    expect(payableAt(new Date('2026-03-15T10:00:00Z')).toISOString()).toBe(
      '2026-04-14T10:00:00.000Z',
    );
    expect([1_000, 1_250, 1_205, 5].map(rateWords)).toEqual(['10%', '12.5%', '12.05%', '0.05%']);
  });

  it('fills in every setting a business hasn’t made', () => {
    expect(partnerSettingsOf(null)).toEqual({
      rateBp: 1_000,
      terms: '',
      termsVersion: 0,
      smallestPayoutCents: 2_500,
      calendarId: null,
    });
    // Something that isn't settings is the defaults, never a refusal.
    expect(partnerSettingsOf({ partners: { rateBp: 'lots' } }).rateBp).toBe(1_000);
  });
});

describe('partners', () => {
  let t: Team;
  let calendarId: string;
  const ws = () => ({ workspaceId: t.wsId });

  /** A contact of the business. */
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

  /** A sent invoice for a customer, paid in cash. */
  async function paidCash(personId: string, cents: number, receivedAt?: Date): Promise<string> {
    const made = await run(
      invoiceCreate,
      {
        ...ws(),
        personId,
        title: 'Duct cleaning',
        lines: [{ name: 'Job', quantity: 1, unitPriceCents: cents, taxable: false }],
      },
      t.owner,
    );
    await run(invoiceSend, { ...ws(), invoiceId: made.invoiceId, channels: [] }, t.owner);
    const paid = await run(
      invoiceRecordCashPayment,
      {
        ...ws(),
        invoiceId: made.invoiceId,
        amountCents: cents,
        ...(receivedAt ? { receivedAt: receivedAt.toISOString() } : {}),
      },
      t.owner,
    );
    return paid.paymentId;
  }

  /** A refund of some of a payment, gone back. */
  async function refunded(paymentId: string, cents?: number): Promise<string> {
    const asked = await run(
      paymentRefund,
      { ...ws(), paymentId, ...(cents ? { amountCents: cents } : {}) },
      t.owner,
    );
    await runSystem(
      paymentRecordRefund,
      { ...ws(), refundId: asked.refundId, status: 'succeeded' },
      t.scope,
    );
    return asked.refundId;
  }

  let slot = 0;
  /** A customer books through a link carrying this ref, each at a time of their own. */
  function bookedThrough(ref: string | null, extra: Record<string, unknown> = {}) {
    const n = slot++;
    const clock = `${String(8 + (n % 8)).padStart(2, '0')}:00`;
    return bookOnline(t, calendarId, isoAt(nextWeekday(1 + (Math.floor(n / 8) % 5)), clock), {
      linkRef: ref,
      ...extra,
    });
  }

  const earnings = async (partnerId: string) =>
    (await ask(partnerGet, { ...ws(), partnerId }, t.owner)).partner.earnings;

  const commissionsOn = (paymentId: string) =>
    rows<{
      kind: string;
      amount_cents: number;
      base_cents: number;
      rate_bp: number;
      test: boolean;
    }>(
      admin(),
      sql`select kind, amount_cents::int as amount_cents, base_cents::int as base_cents, rate_bp, test
          from app.partner_commissions where payment_id = ${paymentId} order by created_at`,
    );

  beforeAll(async () => {
    t = await setupTeam('partners');
    calendarId = (
      await makeCalendar(t, 'Tune-ups', {
        public: true,
        team: { members: [{ userId: t.owner.id }], assignment: 'round_robin' },
      })
    ).id;
  });
  afterAll(closeTestDbs);

  it('are refused, and say where they come from, while no add-on that uses them is on', async () => {
    const paula = await contact('Paula');
    const e = await expectHfos(
      () => run(partnerAdd, { ...ws(), personId: paula }, t.owner),
      'partners_not_in_use',
      409,
    );
    expect(e.message).toContain('Social Outreach');
    expect(await ask(partnersSettings, ws(), t.owner)).toMatchObject({
      inUse: false,
      linkCalendar: { id: calendarId, name: 'Tune-ups' },
    });
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'outreach', 'enabled', ${outreachAddon.version})`,
    );
    expect((await ask(partnersSettings, ws(), t.owner)).inUse).toBe(true);
  });

  it('take Manage partners, which owners and admins have', async () => {
    const paula = await contact('Pauline');
    await expectHfos(() => run(partnerAdd, { ...ws(), personId: paula }, t.member), 'forbidden');
    await expectHfos(() => ask(partnerList, ws(), t.member), 'forbidden');
    // Not even a look at the rows themselves.
    const [seen] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.partners where workspace_id = ${t.wsId}`,
    );
    expect(seen?.n).toBe(0);
  });

  it('keep the settings, and new terms to accept whenever the words change', async () => {
    const save = (over: Record<string, unknown> = {}) =>
      run(
        partnersSaveSettings,
        {
          ...ws(),
          settings: {
            rateBp: 1_500,
            terms: 'Paid on the 1st, by bank transfer.',
            smallestPayoutCents: 2_000,
            calendarId,
            ...over,
          },
        },
        t.owner,
      );
    expect((await save()).settings).toEqual({
      rateBp: 1_500,
      terms: 'Paid on the 1st, by bank transfer.',
      termsVersion: 1,
      smallestPayoutCents: 2_000,
      calendarId,
    });
    expect((await save({ rateBp: 1_200 })).settings.termsVersion).toBe(1);
    expect((await save({ terms: 'Paid on the 15th.' })).settings.termsVersion).toBe(2);
    await expectHfos(() => save({ smallestPayoutCents: 3_000 }), 'validation');
    const hidden = await makeCalendar(t, 'Inside only', {
      team: { members: [{ userId: t.owner.id }], assignment: 'round_robin' },
    });
    const e = await expectHfos(() => save({ calendarId: hidden.id }), 'validation');
    expect(e.message).toContain('Inside only isn’t taking bookings on the booking page');
    await save({ rateBp: 1_500 });
  });

  it('are added once, with a link of their own, and come back when added again', async () => {
    const paula = await contact('Paula');
    const added = await run(partnerAdd, { ...ws(), personId: paula }, t.owner);
    expect(added.created).toBe(true);
    expect(added.code).toMatch(PARTNER_CODE);
    const again = await run(partnerAdd, { ...ws(), personId: paula }, t.owner);
    expect(again).toEqual({ partnerId: added.partnerId, code: added.code, created: false });

    await run(partnerUpdate, { ...ws(), partnerId: added.partnerId, status: 'ended' }, t.owner);
    expect((await run(partnerAdd, { ...ws(), personId: paula }, t.owner)).partnerId).toBe(
      added.partnerId,
    );
    const { partner } = await ask(partnerGet, { ...ws(), partnerId: added.partnerId }, t.owner);
    expect(partner).toMatchObject({
      name: 'Paula Lopez',
      status: 'active',
      rateBp: 1_500,
      ownRate: false,
      linkPath: `/book/c/${calendarId}?ref=pa-${added.code}`,
      clients: 0,
      termsAccepted: false,
      earnings: { earnedCents: 0, waitingCents: 0, payableCents: 0, heldCents: 0 },
    });
  });

  it('earn their share of what a client sent through their link pays, and give back the share of a refund', async () => {
    // A customer who booked once becomes a partner…
    const petra = { firstName: 'Petra', lastName: 'Lopez', phone: nextPhone() };
    const before = await bookedThrough(null, { customer: petra });
    const paula = before.personId;
    const { partnerId, code } = await run(partnerAdd, { ...ws(), personId: paula }, t.owner);

    // …and booking again through their own link is no client of theirs.
    const own = await bookedThrough(`pa-${code}`, { customer: petra });
    expect(own.personId).toBe(paula);
    expect(
      await runSystem(partnerReferralNote, { ...ws(), appointmentId: own.appointmentId }, t.scope),
    ).toEqual({ referred: 0 });

    const booked = await bookedThrough(`pa-${code}`);
    const note = () =>
      runSystem(partnerReferralNote, { ...ws(), appointmentId: booked.appointmentId }, t.scope);
    expect(await note()).toEqual({ referred: 1 });
    expect(await note()).toEqual({ referred: 0 });
    expect(
      await ask(partnerOfPerson, { ...ws(), personId: booked.personId }, t.owner),
    ).toMatchObject({
      inUse: true,
      partner: null,
      referredBy: { partnerId, name: 'Petra Lopez', how: 'link', earnedCents: 0 },
    });
    expect((await ask(partnerOfPerson, { ...ws(), personId: paula }, t.owner)).partner).toEqual({
      partnerId,
      status: 'active',
    });

    const paymentId = await paidCash(booked.personId, 100_000);
    const earn = () => runSystem(partnerCommissionNote, { ...ws(), paymentId }, t.scope);
    expect(await earn()).toEqual({ earned: true });
    expect(await earn()).toEqual({ earned: false });
    expect(await commissionsOn(paymentId)).toEqual([
      { kind: 'earned', amount_cents: 15_000, base_cents: 100_000, rate_bp: 1_500, test: false },
    ]);
    expect(await earnings(partnerId)).toEqual({
      earnedCents: 15_000,
      waitingCents: 15_000,
      payableCents: 0,
      heldCents: 0,
    });

    // A refund takes back its share, and never more than was earned, from what it comes off: while that waits its
    // 30 days, so does what's taken back…
    const some = await refunded(paymentId, 40_000);
    const takeBack = (refundId: string) =>
      runSystem(partnerCommissionTakeBack, { ...ws(), refundId }, t.scope);
    expect(await takeBack(some)).toEqual({ takenBack: true });
    expect(await takeBack(some)).toEqual({ takenBack: false });
    expect(await earnings(partnerId)).toEqual({
      earnedCents: 9_000,
      waitingCents: 9_000,
      payableCents: 0,
      heldCents: 0,
    });
    // …and once it's free to pay out, what's taken back comes off at once.
    await rows(
      admin(),
      sql`update app.partner_commissions set payable_at = now() - interval '1 day'
          where payment_id = ${paymentId}`,
    );
    const rest = await refunded(paymentId);
    expect(await takeBack(rest)).toEqual({ takenBack: true });
    expect((await commissionsOn(paymentId)).map((c) => c.amount_cents)).toEqual([
      15_000, -6_000, -9_000,
    ]);
    expect(await earnings(partnerId)).toEqual({
      earnedCents: 0,
      waitingCents: 0,
      payableCents: 0,
      heldCents: 0,
    });

    const got = await ask(partnerGet, { ...ws(), partnerId }, t.owner);
    expect(got.partner.clients).toBe(1);
    expect(got.clients).toMatchObject([{ personId: booked.personId, how: 'link', earnedCents: 0 }]);
    expect(got.clients[0]?.monthsEndAt).not.toBeNull();
    expect(got.commissions.map((c) => c.kind)).toEqual(['taken_back', 'taken_back', 'earned']);
    const [events] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events where workspace_id = ${t.wsId}
            and event_type in ('partner.commission_earned', 'partner.commission_taken_back')
            and entity_id = ${partnerId}`,
    );
    expect(events?.n).toBe(3);
  });

  it('come out the same whichever the worker notes first', async () => {
    const pia = await contact('Pia');
    const { partnerId, code } = await run(partnerAdd, { ...ws(), personId: pia }, t.owner);

    // A deposit paid as they booked, noted before the booking was.
    const first = await bookedThrough(`pa-${code}`);
    const deposit = await paidCash(first.personId, 20_000);
    expect(
      await runSystem(partnerCommissionNote, { ...ws(), paymentId: deposit }, t.scope),
    ).toEqual({
      earned: false,
    });
    await runSystem(partnerReferralNote, { ...ws(), appointmentId: first.appointmentId }, t.scope);
    expect((await commissionsOn(deposit)).map((c) => c.amount_cents)).toEqual([3_000]);

    // A refund noted before the payment it came from.
    const paymentId = await paidCash(first.personId, 50_000);
    await refunded(paymentId, 10_000);
    await runSystem(partnerCommissionNote, { ...ws(), paymentId }, t.scope);
    expect((await commissionsOn(paymentId)).map((c) => c.amount_cents)).toEqual([7_500, -1_500]);
    expect((await earnings(partnerId)).earnedCents).toBe(9_000);
  });

  it('earn nothing while paused or ended, on what came before, or after a client’s 12 months', async () => {
    const pat = await contact('Pat');
    const { partnerId, code } = await run(partnerAdd, { ...ws(), personId: pat }, t.owner);
    const booked = await bookedThrough(`pa-${code}`);
    // Paid before they were ever sent: never the partner's.
    const before = await paidCash(booked.personId, 10_000, new Date(Date.now() - 3 * DAY));
    await runSystem(partnerReferralNote, { ...ws(), appointmentId: booked.appointmentId }, t.scope);
    expect(await commissionsOn(before)).toEqual([]);

    await run(partnerUpdate, { ...ws(), partnerId, status: 'paused' }, t.owner);
    const paused = await paidCash(booked.personId, 10_000);
    expect(await runSystem(partnerCommissionNote, { ...ws(), paymentId: paused }, t.scope)).toEqual(
      { earned: false },
    );
    // Their 12 months started all the same.
    const [referral] = await rows<{ first_paid_at: Date | null }>(
      admin(),
      sql`select first_paid_at from app.partner_referrals where person_id = ${booked.personId}`,
    );
    expect(referral?.first_paid_at).not.toBeNull();

    await run(partnerUpdate, { ...ws(), partnerId, status: 'active', rateBp: 2_000 }, t.owner);
    const own = await paidCash(booked.personId, 10_000);
    await runSystem(partnerCommissionNote, { ...ws(), paymentId: own }, t.scope);
    expect((await commissionsOn(own)).map((c) => [c.rate_bp, c.amount_cents])).toEqual([
      [2_000, 2_000],
    ]);

    await rows(
      admin(),
      sql`update app.partner_referrals set first_paid_at = now() - interval '13 months', referred_at = now() - interval '14 months'
          where person_id = ${booked.personId}`,
    );
    const late = await paidCash(booked.personId, 10_000);
    expect(await runSystem(partnerCommissionNote, { ...ws(), paymentId: late }, t.scope)).toEqual({
      earned: false,
    });
  });

  it('count a provider’s test payments on their own, and never in what’s earned', async () => {
    const pam = await contact('Pam');
    const { partnerId, code } = await run(partnerAdd, { ...ws(), personId: pam }, t.owner);
    const booked = await bookedThrough(`pa-${code}`);
    await runSystem(partnerReferralNote, { ...ws(), appointmentId: booked.appointmentId }, t.scope);
    const [connection] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.payment_connections (workspace_id, provider, environment, status,
            external_account_id, label, token_enc, token_key_id, connected_at)
          values (${t.wsId}, 'stripe', 'test', 'active', ${`acct_${randomUUID().slice(0, 8)}`},
            'Test account', 'sealed', 'test-key', now())
          returning id`,
    );
    const made = await run(
      invoiceCreate,
      {
        ...ws(),
        personId: booked.personId,
        title: 'Duct cleaning',
        lines: [{ name: 'Job', quantity: 1, unitPriceCents: 30_000, taxable: false }],
      },
      t.owner,
    );
    await run(invoiceSend, { ...ws(), invoiceId: made.invoiceId, channels: [] }, t.owner);
    const paid = await runSystem(
      invoiceRecordPayment,
      {
        ...ws(),
        invoiceId: made.invoiceId,
        amountCents: 30_000,
        method: 'card',
        provider: 'stripe',
        connectionId: connection!.id,
        providerPaymentId: `pi_${randomUUID().slice(0, 12)}`,
        status: 'succeeded',
      },
      t.scope,
    );
    expect(
      await runSystem(partnerCommissionNote, { ...ws(), paymentId: paid.paymentId }, t.scope),
    ).toEqual({ earned: true });
    expect(await commissionsOn(paid.paymentId)).toMatchObject([
      { amount_cents: 4_500, test: true },
    ]);
    expect((await earnings(partnerId)).earnedCents).toBe(0);
    const got = await ask(partnerGet, { ...ws(), partnerId }, t.owner);
    expect(got.commissions).toMatchObject([{ test: true, amountCents: 4_500 }]);
  });

  it('are marked by hand, and a client who earned a partner something stays theirs', async () => {
    const [one, two, client, fresh] = await Promise.all([
      contact('Penny'),
      contact('Percy'),
      contact('Carla'),
      contact('Cody'),
    ]);
    const first = await run(partnerAdd, { ...ws(), personId: one }, t.owner);
    const second = await run(partnerAdd, { ...ws(), personId: two }, t.owner);
    const set = (personId: string, partnerId: string | null) =>
      run(partnerReferralSet, { ...ws(), personId, partnerId }, t.owner);

    const e = await expectHfos(() => set(one, first.partnerId), 'partner_own_client', 409);
    expect(e.message).toBe('Penny Lopez is the partner, so they can’t be their own client.');

    // Paid before they were marked: that payment was never the partner's.
    const earlier = await paidCash(client, 10_000, new Date(Date.now() - DAY));
    const marked = await set(client, first.partnerId);
    expect(marked.referralId).not.toBeNull();
    expect(await set(client, first.partnerId)).toEqual(marked);
    expect(
      await runSystem(partnerCommissionNote, { ...ws(), paymentId: earlier }, t.scope),
    ).toEqual({
      earned: false,
    });

    // No earnings yet: they can still move.
    expect((await set(client, second.partnerId)).referralId).not.toBe(marked.referralId);
    const paymentId = await paidCash(client, 10_000);
    await runSystem(partnerCommissionNote, { ...ws(), paymentId }, t.scope);
    const stays = await expectHfos(
      () => set(client, first.partnerId),
      'partner_client_has_earned',
      409,
    );
    expect(stays.message).toBe(
      'Carla Lopez has earned Percy Lopez commission already, so they stay Percy Lopez’s client.',
    );
    await expectHfos(() => set(client, null), 'partner_client_has_earned', 409);

    await set(fresh, second.partnerId);
    expect(await set(fresh, null)).toEqual({ referralId: null });
    expect(
      (await ask(partnerOfPerson, { ...ws(), personId: fresh }, t.owner)).referredBy,
    ).toBeNull();
    const list = await ask(partnerList, ws(), t.owner);
    expect(list.partners.find((p) => p.partnerId === second.partnerId)).toMatchObject({
      clients: 1,
      earnings: { earnedCents: 1_500 },
    });
  });
});
