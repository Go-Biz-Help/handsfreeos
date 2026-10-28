/**
 * Paying partners in the worker (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3), against the payments
 * stand-in, which does what Stripe does:
 *
 * - The business's card goes on through Stripe's own page, onto HandsFreeOS's customer, and only once staff have
 *   opened payouts for it.
 * - A partner sets up their bank from their page, on Stripe's own form; Stripe's `account.updated` says when it's
 *   ready, routed to them by the Connect webhook.
 * - Each month the card is charged on our own account for what's owed and Stripe's fees, and each partner is paid by
 *   a transfer tied to that charge; they hear they were paid.
 * - A declined card is tried again later, and the owners hear.
 * - A line held for a partner deleted for good is given back to the business's card (stage 5).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  catalogAddon,
  executeCommand,
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  partnerAdd,
  partnerReferralSet,
  partnersSaveSettings,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, signInTestUser, testDbs } from '@hfos/db/testing';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planPartnerPayouts } from '../src/partners/payouts';
import { FAKE_CARDS } from '../src/payments/fake';
import { portalToken } from '../src/portal/links';
import type { JobContext } from '../src/jobs';
import { waitForMail } from './booking-world';
import { admin, drain, moneyWorld, run, type MoneyWorld } from './money-world';

let w: MoneyWorld;
let ownerToken: string;
let pia: { personId: string; partnerId: string; email: string };
const ws = () => ({ workspaceId: w.workspaceId });
const fake = () => w.s.payments.fake;

const call = (
  url: string,
  body: Record<string, unknown>,
  bearer: string | null,
): Promise<LightMyRequestResponse> =>
  w.app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.71',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    payload: JSON.stringify(body),
  });

const addCard = (body: Record<string, unknown> = {}) =>
  call('/v1/partners/payout-card', { ...ws(), ...body }, ownerToken);

/** As the worker writes it, under the business's own scope: what staff opening payouts leaves behind. */
async function asBusiness(statement: ReturnType<typeof sql>) {
  await admin().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.system_scope.workspace_id', ${w.workspaceId}, true)`,
    );
    await tx.execute(statement);
  });
}

/** A partner, with a client of theirs who paid this much, the share free to pay out already. */
async function partnerOwed(firstName: string, paidCents: number) {
  const email = `${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`;
  const { personId } = await run(w, personCreate, {
    ...ws(),
    firstName,
    lastName: 'Partner',
    email,
    ignoreDuplicates: true,
  });
  const { partnerId } = await run(w, partnerAdd, { ...ws(), personId });
  await earn(partnerId, paidCents);
  return { personId, partnerId, email };
}

async function earn(partnerId: string, paidCents: number) {
  const { personId: client } = await run(w, personCreate, {
    ...ws(),
    firstName: `Client${randomUUID().slice(0, 4)}`,
    lastName: 'Lopez',
    ignoreDuplicates: true,
  });
  await run(w, partnerReferralSet, { ...ws(), personId: client, partnerId });
  const made = await run(w, invoiceCreate, {
    ...ws(),
    personId: client,
    title: 'Tune-up',
    lines: [{ name: 'Tune-up', quantity: 1, unitPriceCents: paidCents, taxable: false }],
  });
  await run(w, invoiceSend, { ...ws(), invoiceId: made.invoiceId, channels: [] });
  const { paymentId } = await run(w, invoiceRecordCashPayment, {
    ...ws(),
    invoiceId: made.invoiceId,
    amountCents: paidCents,
  });
  await drain(w);
  await rows(
    admin(),
    sql`update app.partner_commissions set payable_at = now() - interval '1 day'
        where payment_id = ${paymentId}`,
  );
}

/** A device signed in to the partner's portal, the way the worker does it: its bearer and its link. */
async function signIn(personId: string): Promise<{ bearer: string; token: string }> {
  const { accessId } = await run(w, portalAccessGive, { ...ws(), personId });
  const scope = {
    type: 'system' as const,
    workspaceId: w.workspaceId,
    organizationId: w.organizationId,
  };
  const m = () => ({ correlationId: randomUUID(), channel: 'test' as const });
  const { output: sent } = await executeCommand(
    testDbs().worker.db,
    portalSendCode,
    { ...ws(), accessId },
    scope,
    m(),
  );
  const bearer = randomBytes(32).toString('base64url');
  await executeCommand(
    testDbs().worker.db,
    portalCheckCode,
    {
      ...ws(),
      accessId,
      code: sent.code,
      tokenHash: createHash('sha256').update(bearer).digest('hex'),
    },
    scope,
    m(),
  );
  const [access] = await rows<{ public_ref: string; link_version: number }>(
    admin(),
    sql`select public_ref, link_version from app.portal_access where id = ${accessId}`,
  );
  const token = portalToken(w.s.portalLinks, {
    publicRef: access!.public_ref,
    accessId,
    linkVersion: access!.link_version,
  });
  return { bearer, token };
}

/** The hourly plan, run now as the worker runs it. */
const plan = () =>
  planPartnerPayouts({
    ...w.s,
    job: { payload: {} } as unknown as JobContext['job'],
    scope: {},
    attempt: 1,
    now: Date.now(),
  });

const payoutsHere = () =>
  rows<{ id: string; status: string; charge_cents: number; attempts: number; next_try: boolean }>(
    admin(),
    sql`select id, status, charge_cents::int as charge_cents, attempts,
          next_try_at > now() + interval '5 hours' as next_try
        from app.partner_payouts where workspace_id = ${w.workspaceId} order by created_at`,
  );

beforeAll(async () => {
  w = await moneyWorld('payouts');
  ownerToken = await signInTestUser(w.owner);
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${w.workspaceId}, 'outreach', 'enabled', ${catalogAddon('outreach').version})`,
  );
  await run(w, partnersSaveSettings, {
    ...ws(),
    settings: { rateBp: 1_000, terms: '', smallestPayoutCents: 2_500, calendarId: null },
  });
  pia = await partnerOwed('Pia', 100_000);
}, 120_000);
afterAll(closeTestDbs);

describe('paying partners', () => {
  it('takes no card until HandsFreeOS has opened payouts for the business', async () => {
    const res = await addCard();
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: { rule: string } }).error.rule).toBe('partner_payouts_not_open');
    await asBusiness(
      sql`insert into app.partner_payout_billing (workspace_id, organization_id, opened_at)
          values (${w.workspaceId}, ${w.organizationId}, now())`,
    );
  });

  it('puts the card on through Stripe’s own page, on HandsFreeOS’s own customer', async () => {
    const started = (await addCard()).json() as { stage: string; hostedUrl: string };
    expect(started.stage).toBe('started');
    const sessionRef = new URL(started.hostedUrl).searchParams.get('session')!;
    const returnUrl = new URL(started.hostedUrl).searchParams.get('return')!;
    expect(returnUrl).toBe(`http://localhost:3000/app/w/${w.workspaceId}/settings/partners`);
    const typed = await w.app.inject({
      method: 'POST',
      url: '/payments/fake/card',
      payload: {
        session: sessionRef,
        return: returnUrl,
        instrument: FAKE_CARDS.succeeds,
        decision: 'save',
      },
    });
    expect(typed.statusCode, typed.body).toBe(302);
    const saved = await addCard({ sessionRef });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ stage: 'saved', card: { last4: '4242' } });
    const [b] = await rows<{ customer_ref: string; method_token: string | null }>(
      admin(),
      sql`select customer_ref, method_token from app.partner_payout_billing where workspace_id = ${w.workspaceId}`,
    );
    expect(b?.customer_ref).toMatch(/^cus_hfos/);
    expect(b?.method_token).toBeTruthy();
  });

  it('refuses a card page another business opened, and keeps this business’s card', async () => {
    const card = () =>
      rows<{ customer_ref: string; method_token: string | null }>(
        admin(),
        sql`select customer_ref, method_token from app.partner_payout_billing where workspace_id = ${w.workspaceId}`,
      );
    const before = await card();
    // Another business's page, finished, with its id read off their address bar.
    const platform = w.s.payments.providers.stripe.platform;
    const { customerRef } = await platform.ensureCustomer({
      customerRef: null,
      name: 'Someone Else Plumbing',
      email: null,
      phone: null,
      idempotencyKey: 'wallet-customer:someone-else',
    });
    const theirs = await platform.startCardSession({
      customerRef,
      reference: randomUUID(),
      returnUrl: 'http://localhost:3000/app/w/someone-else/settings/partners',
      idempotencyKey: 'partner-payout-card:someone-else:1',
    });
    fake().page.saveCard({ sessionRef: theirs.sessionRef, instrument: FAKE_CARDS.succeeds });

    const res = await addCard({ sessionRef: theirs.sessionRef });
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: { rule: string } }).error.rule).toBe(
      'partner_payouts_other_business',
    );
    expect(await card()).toEqual(before);
  });

  it('lets a partner set up their bank on Stripe’s own form, and hears from Stripe when it’s ready', async () => {
    const { bearer, token } = await signIn(pia.personId);
    const payouts = (body: Record<string, unknown>, who: string | null = bearer) =>
      call(`/public/portal/${token}/partner/payouts`, body, who);
    expect((await payouts({ action: 'start' }, null)).statusCode).toBe(401);

    const started = await payouts({ action: 'start' });
    expect(started.statusCode, started.body).toBe(200);
    const form = new URL((started.json() as { url: string }).url);
    expect(form.pathname).toBe('/payments/fake/express');
    expect(form.searchParams.get('return')).toBe(
      `http://localhost:3000/c/${token}/partner?payouts=back`,
    );
    const accountRef = form.searchParams.get('account')!;
    // Two presses make one account.
    await payouts({ action: 'start' });
    expect(
      fake()
        .payoutAccounts()
        .filter((a) => a.metadata['partner_id'] === pia.partnerId),
    ).toHaveLength(1);
    expect((await payouts({ action: 'check' })).json()).toEqual({ ready: false });
    // Stripe's page only once they've finished its form.
    expect((await payouts({ action: 'stripe' })).statusCode).toBe(409);

    const finished = await w.app.inject({
      method: 'POST',
      url: '/payments/fake/express',
      payload: { account: accountRef, return: form.searchParams.get('return'), decision: 'ready' },
    });
    expect(finished.statusCode, finished.body).toBe(302);
    await drain(w);
    const [a] = await rows<{ ready: boolean }>(
      admin(),
      sql`select payouts_enabled and transfers_active as ready from app.partner_payout_accounts
          where partner_id = ${pia.partnerId}`,
    );
    expect(a?.ready).toBe(true);
    expect((await payouts({ action: 'check' })).json()).toEqual({ ready: true });
    expect((await payouts({ action: 'stripe' })).json()).toMatchObject({
      url: expect.stringContaining('dashboard=1'),
    });
  });

  it('makes their account in the country their bank is in, and lets them change it until Stripe’s form is done', async () => {
    // Nothing owed, so the month's payout below is Pia's alone.
    const { personId } = await run(w, personCreate, {
      ...ws(),
      firstName: 'Noor',
      lastName: 'Partner',
      email: `noor-${randomUUID().slice(0, 6)}@example.com`,
      ignoreDuplicates: true,
    });
    const { partnerId } = await run(w, partnerAdd, { ...ws(), personId });
    const { bearer, token } = await signIn(personId);
    const payouts = (body: Record<string, unknown>) =>
      call(`/public/portal/${token}/partner/payouts`, body, bearer);
    const theirs = () =>
      fake()
        .payoutAccounts()
        .filter((a) => a.metadata['partner_id'] === partnerId);
    const kept = async () =>
      (
        await rows<{ account_ref: string; country: string }>(
          admin(),
          sql`select account_ref, country from app.partner_payout_accounts where partner_id = ${partnerId}`,
        )
      )[0];

    // A country Stripe can't pay from here is told so, and nothing is made.
    const brazil = await payouts({ action: 'start', country: 'BR' });
    expect(brazil.statusCode, brazil.body).toBe(422);
    expect((brazil.json() as { error: { rule: string; message: string } }).error).toMatchObject({
      rule: 'partner_payouts_country',
      message: expect.stringContaining('Brazil'),
    });
    expect(theirs()).toHaveLength(0);

    const canada = await payouts({ action: 'start', country: 'ca' });
    expect(canada.statusCode, canada.body).toBe(200);
    expect(theirs().map((a) => a.country)).toEqual(['CA']);
    expect((await kept())?.country).toBe('CA');
    // Pressed again with no country, it's the account they have.
    await payouts({ action: 'start' });
    expect(theirs()).toHaveLength(1);

    // Their bank is in the UK after all: a new account there takes the Canadian one's place.
    await payouts({ action: 'start', country: 'GB' });
    expect(theirs().map((a) => a.country)).toEqual(['CA', 'GB']);
    const uk = theirs()[1]!;
    expect(await kept()).toEqual({ account_ref: uk.accountRef, country: 'GB' });

    // Once Stripe's form is done, the country stays.
    const form = new URL(((await payouts({ action: 'start' })).json() as { url: string }).url);
    expect(form.searchParams.get('account')).toBe(uk.accountRef);
    await w.app.inject({
      method: 'POST',
      url: '/payments/fake/express',
      payload: {
        account: uk.accountRef,
        return: form.searchParams.get('return'),
        decision: 'ready',
      },
    });
    await drain(w);
    const moved = await payouts({ action: 'start', country: 'DE' });
    expect(moved.statusCode, moved.body).toBe(409);
    expect((moved.json() as { error: { rule: string } }).error.rule).toBe(
      'partner_payouts_country_set',
    );
    expect(theirs()).toHaveLength(2);
    expect((await kept())?.country).toBe('GB');
  });

  it('charges the card each month for what’s owed and Stripe’s fees, and pays the partner from that charge', async () => {
    const before = fake().platformCharges().length;
    await plan();
    await drain(w);
    const [payout] = await payoutsHere();
    expect(payout).toMatchObject({ status: 'paid', attempts: 1 });
    const charges = fake().platformCharges().slice(before);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ amountCents: payout!.charge_cents, status: 'succeeded' });
    const sent = fake()
      .transfers()
      .filter((t) => t.metadata['partner_payout_id'] === payout!.id);
    expect(sent).toEqual([
      expect.objectContaining({
        amountCents: 10_000,
        sourceChargeRef: `ch_${charges[0]!.id.replace(/^pi_/, '')}`,
        transferGroup: `partner-payout-${payout!.id}`,
      }),
    ]);
    // Once a month: the plan again changes nothing.
    await plan();
    await drain(w);
    expect(await payoutsHere()).toHaveLength(1);
    expect(fake().platformCharges().length).toBe(before + 1);
    // They hear they were paid, from the business.
    const [conversation] = await rows<{ subject: string }>(
      admin(),
      sql`select m.subject from app.messages m join app.conversations c on c.id = m.conversation_id
          where c.workspace_id = ${w.workspaceId} and c.counterpart = ${pia.email} and m.direction = 'outbound'
            and m.subject like '%paid you%'`,
    );
    expect(conversation?.subject).toBe('payouts Lone Star HVAC paid you $100');
  });

  it('tries a declined card again later, and tells the owners', async () => {
    await earn(pia.partnerId, 50_000);
    // The next month, with a card that's refused when nobody's there to press the button.
    await asBusiness(
      sql`update app.partner_payout_billing set last_month = last_month - interval '1 month'
          where workspace_id = ${w.workspaceId}`,
    );
    await rows(
      admin(),
      sql`update app.partner_payouts set month = month - interval '1 month' where workspace_id = ${w.workspaceId}`,
    );
    const started = (await addCard()).json() as { hostedUrl: string };
    const sessionRef = new URL(started.hostedUrl).searchParams.get('session')!;
    await w.app.inject({
      method: 'POST',
      url: '/payments/fake/card',
      payload: {
        session: sessionRef,
        return: new URL(started.hostedUrl).searchParams.get('return'),
        instrument: FAKE_CARDS.failsOffSession,
        decision: 'save',
      },
    });
    expect((await addCard({ sessionRef })).statusCode).toBe(200);

    await plan();
    await drain(w);
    const payouts = await payoutsHere();
    expect(payouts.at(-1)).toMatchObject({ status: 'charging', attempts: 1, next_try: true });
    const mail = await waitForMail(w.owner.email, 'Your partners’ payout for');
    expect(mail.text).toContain('We’ll try it again on');
    expect(mail.text).toContain('Settings → Partners');

    // A card that works: tried at once, and the partner is paid.
    const again = (await addCard()).json() as { hostedUrl: string };
    const nextSession = new URL(again.hostedUrl).searchParams.get('session')!;
    await w.app.inject({
      method: 'POST',
      url: '/payments/fake/card',
      payload: {
        session: nextSession,
        return: new URL(again.hostedUrl).searchParams.get('return'),
        instrument: FAKE_CARDS.succeeds,
        decision: 'save',
      },
    });
    expect((await addCard({ sessionRef: nextSession })).statusCode).toBe(200);
    await drain(w);
    expect((await payoutsHere()).at(-1)).toMatchObject({ status: 'paid', attempts: 2 });
  });

  it('gives a line held for a partner deleted for good back to the business’s card', async () => {
    const dee = await partnerOwed('Dee', 100_000);
    // Stripe said their account was ready, then won't take the transfer.
    await rows(
      admin(),
      sql`insert into app.partner_payout_accounts (workspace_id, partner_id, account_ref, livemode,
            details_submitted, payouts_enabled, transfers_active)
          values (${w.workspaceId}, ${dee.partnerId}, 'acct_fake_gone', true, true, true, true)`,
    );
    await asBusiness(
      sql`update app.partner_payout_billing set last_month = last_month - interval '1 month'
          where workspace_id = ${w.workspaceId}`,
    );
    await rows(
      admin(),
      sql`update app.partner_payouts set month = month - interval '12 months' where workspace_id = ${w.workspaceId}`,
    );
    await plan();
    await drain(w);
    const payout = (await payoutsHere()).at(-1)!;
    expect(payout.status).toBe('paying');
    const lineOf = async () =>
      (
        await rows<{
          id: string;
          status: string;
          given_back_cents: number | null;
          refund_ref: string | null;
        }>(
          admin(),
          sql`select id, status, given_back_cents::int as given_back_cents, refund_ref
              from app.partner_payout_lines where payout_id = ${payout.id}`,
        )
      )[0]!;
    expect(await lineOf()).toMatchObject({ status: 'held', given_back_cents: null });

    // Kept while they're kept; once they're deleted for good, given back: the line and its two fees.
    await rows(admin(), sql`delete from app.partners where id = ${dee.partnerId}`);
    await plan();
    await drain(w);
    const back = fake()
      .givenBack()
      .filter((g) => g.metadata['partner_payout_id'] === payout.id);
    expect(back).toEqual([
      expect.objectContaining({ amountCents: 10_000 + 200 + 50, chargeRef: expect.any(String) }),
    ]);
    expect(await lineOf()).toMatchObject({
      status: 'cancelled',
      given_back_cents: 10_250,
      refund_ref: back[0]!.id,
    });
    expect((await payoutsHere()).at(-1)).toMatchObject({ status: 'paid' });
    // Once.
    await plan();
    await drain(w);
    expect(fake().givenBack()).toHaveLength(1);
  });
});
