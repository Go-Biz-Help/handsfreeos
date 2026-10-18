/**
 * Payment disputes (20261027008700; HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2b): what Stripe or Square
 * says about a customer's bank taking a payment back, kept once per dispute and settled once. The invoice stays paid.
 * What a partner earned on a disputed payment is held while it's open, taken back when it's lost, and free again when
 * it's won, whichever the worker notes first.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachAddon } from '../src/addons/outreach/manifest';
import {
  invoiceCreate,
  invoiceRecordPayment,
  invoiceSend,
  partnerAdd,
  partnerCommissionDisputeNote,
  partnerCommissionNote,
  partnerGet,
  partnerReferralSet,
  paymentRecordDispute,
  personCreate,
} from '../src/server';
import { admin, ask, run, runSystem, setupTeam, type Team } from './calendar-helpers';

let t: Team;
const ws = () => ({ workspaceId: t.wsId });

async function contact(firstName: string): Promise<string> {
  const out = await run(
    personCreate,
    { ...ws(), firstName, lastName: 'Diaz', ignoreDuplicates: true },
    t.owner,
  );
  return out.personId;
}

/** A sent invoice for a customer, paid by card through Stripe. Its payment and the provider's id for it. */
async function paidByCard(personId: string, cents: number) {
  const made = await run(
    invoiceCreate,
    {
      ...ws(),
      personId,
      title: 'Furnace repair',
      lines: [{ name: 'Job', quantity: 1, unitPriceCents: cents, taxable: false }],
    },
    t.owner,
  );
  await run(invoiceSend, { ...ws(), invoiceId: made.invoiceId, channels: [] }, t.owner);
  const providerPaymentId = `pi_${randomUUID().slice(0, 12)}`;
  const paid = await runSystem(
    invoiceRecordPayment,
    {
      ...ws(),
      invoiceId: made.invoiceId,
      amountCents: cents,
      method: 'card',
      provider: 'stripe',
      providerPaymentId,
      status: 'succeeded',
    },
    t.scope,
  );
  return { paymentId: paid.paymentId, invoiceId: made.invoiceId, providerPaymentId };
}

const dispute = (providerPaymentId: string, over: Record<string, unknown> = {}) =>
  runSystem(
    paymentRecordDispute,
    {
      ...ws(),
      provider: 'stripe',
      providerDisputeId: `dp_${providerPaymentId}`,
      providerPaymentId,
      reason: 'fraudulent',
      status: 'open',
      providerStatus: 'needs_response',
      ...over,
    },
    t.scope,
  );

/** What was said about a dispute; two said in one go have no order between them. */
const eventsOf = async (disputeId: string) =>
  (
    await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where entity_id = ${disputeId}`,
    )
  )
    .map((e) => e.event_type)
    .sort();

beforeAll(async () => {
  t = await setupTeam('disputes');
});
afterAll(closeTestDbs);

describe('a dispute', () => {
  it('is kept once, says when the answer is due, and settles once', async () => {
    const { providerPaymentId, invoiceId } = await paidByCard(await contact('Dora'), 50_000);
    const respondBy = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const opened = await dispute(providerPaymentId, { respondBy });
    expect(opened).toMatchObject({ status: 'open', changed: true });
    expect(await dispute(providerPaymentId)).toMatchObject({
      disputeId: opened.disputeId,
      changed: false,
    });
    // Answered at the provider: still open, its word for it kept.
    expect(await dispute(providerPaymentId, { providerStatus: 'under_review' })).toMatchObject({
      status: 'open',
      changed: true,
    });
    expect(
      await dispute(providerPaymentId, { status: 'won', providerStatus: 'won' }),
    ).toMatchObject({
      status: 'won',
      changed: true,
    });
    // A late "still open" after it's won changes nothing, nor does a second answer.
    expect(await dispute(providerPaymentId)).toMatchObject({ status: 'won', changed: false });
    expect(await dispute(providerPaymentId, { status: 'lost' })).toMatchObject({ status: 'won' });
    const [row] = await rows<{
      status: string;
      amount_cents: number;
      provider_status: string;
      respond_by: Date | string;
      closed_at: Date | string | null;
    }>(
      admin(),
      sql`select status, amount_cents::int as amount_cents, provider_status, respond_by, closed_at
          from app.payment_disputes where id = ${opened.disputeId}`,
    );
    expect(row).toMatchObject({ status: 'won', amount_cents: 50_000, provider_status: 'won' });
    expect(new Date(row!.respond_by).toISOString()).toBe(respondBy);
    expect(row?.closed_at).not.toBeNull();
    expect(await eventsOf(opened.disputeId!)).toEqual(['dispute.closed', 'dispute.opened']);
    // The payment was made all the same.
    const [invoice] = await rows<{ status: string; balance_cents: number }>(
      admin(),
      sql`select status, balance_cents::int as balance_cents from app.invoices where id = ${invoiceId}`,
    );
    expect(invoice).toEqual({ status: 'paid', balance_cents: 0 });
  });

  it('first heard of once it’s over opens and closes all the same, and one on a payment never taken is passed over', async () => {
    const { providerPaymentId } = await paidByCard(await contact('Dale'), 20_000);
    const lost = await dispute(providerPaymentId, { status: 'lost', amountCents: 5_000 });
    expect(lost).toMatchObject({ status: 'lost', changed: true });
    expect(await eventsOf(lost.disputeId!)).toEqual(['dispute.closed', 'dispute.opened']);
    expect(await dispute('pi_never_ours')).toEqual({
      disputeId: null,
      status: null,
      changed: false,
    });
  });
});

describe('what a partner earned on a disputed payment', () => {
  let partnerId: string;
  let client: string;

  beforeAll(async () => {
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'outreach', 'enabled', ${outreachAddon.version})`,
    );
    ({ partnerId } = await run(
      partnerAdd,
      { ...ws(), personId: await contact('Pedro'), rateBp: 1_000 },
      t.owner,
    ));
    client = await contact('Cleo');
    await run(partnerReferralSet, { ...ws(), personId: client, partnerId }, t.owner);
  });

  const earnings = async () =>
    (await ask(partnerGet, { ...ws(), partnerId }, t.owner)).partner.earnings;
  const commissionsOn = async (paymentId: string) =>
    (
      await rows<{ amount_cents: number }>(
        admin(),
        sql`select amount_cents::int as amount_cents from app.partner_commissions
            where payment_id = ${paymentId} order by created_at`,
      )
    ).map((c) => c.amount_cents);

  it('is held while the dispute is open, free again once it’s won, and taken back once it’s lost', async () => {
    const won = await paidByCard(client, 10_000);
    await runSystem(partnerCommissionNote, { ...ws(), paymentId: won.paymentId }, t.scope);
    expect(await earnings()).toEqual({
      earnedCents: 1_000,
      waitingCents: 1_000,
      payableCents: 0,
      heldCents: 0,
    });
    const opened = await dispute(won.providerPaymentId);
    expect(await earnings()).toMatchObject({ waitingCents: 0, heldCents: 1_000 });
    const got = await ask(partnerGet, { ...ws(), partnerId }, t.owner);
    expect(got.commissions).toMatchObject([{ held: true, amountCents: 1_000 }]);
    await dispute(won.providerPaymentId, { status: 'won' });
    expect(
      await runSystem(
        partnerCommissionDisputeNote,
        { ...ws(), disputeId: opened.disputeId },
        t.scope,
      ),
    ).toEqual({ takenBack: false });
    expect(await earnings()).toMatchObject({ waitingCents: 1_000, heldCents: 0 });

    // Lost on part of a payment: the share of what the bank took comes back.
    const lost = await paidByCard(client, 20_000);
    await runSystem(partnerCommissionNote, { ...ws(), paymentId: lost.paymentId }, t.scope);
    const closed = await dispute(lost.providerPaymentId, { status: 'lost', amountCents: 15_000 });
    const note = () =>
      runSystem(partnerCommissionDisputeNote, { ...ws(), disputeId: closed.disputeId }, t.scope);
    expect(await note()).toEqual({ takenBack: true });
    expect(await note()).toEqual({ takenBack: false });
    expect(await commissionsOn(lost.paymentId)).toEqual([2_000, -1_500]);
    const [row] = await rows<{ dispute_id: string; refund_id: string | null }>(
      admin(),
      sql`select dispute_id, refund_id from app.partner_commissions
          where payment_id = ${lost.paymentId} and kind = 'taken_back'`,
    );
    expect(row).toEqual({ dispute_id: closed.disputeId, refund_id: null });
    expect(await earnings()).toMatchObject({ earnedCents: 1_500, heldCents: 0 });
  });

  it('comes out the same when the dispute was noted before the payment earned', async () => {
    const early = await paidByCard(client, 30_000);
    await dispute(early.providerPaymentId, { status: 'lost' });
    await runSystem(partnerCommissionNote, { ...ws(), paymentId: early.paymentId }, t.scope);
    expect(await commissionsOn(early.paymentId)).toEqual([3_000, -3_000]);
  });
});
