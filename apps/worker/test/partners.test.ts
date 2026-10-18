/**
 * Partners in the worker (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2): a booking on the public page through
 * a partner's link makes its customer that partner's client, their payment earns the partner their share, and a
 * refund takes the share of it back, each as core's events are worked through. A booking without one changes nothing.
 */
import {
  catalogAddon,
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  partnerAdd,
  partnerGet,
  paymentRefund,
  personCreate,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  at,
  attendeeByToken,
  bookOnline,
  customer,
  drain,
  makeCalendar,
  makeWorld,
  query,
  run,
  type World,
} from './booking-world';

let w: World;
let slug: string;

beforeAll(async () => {
  w = await makeWorld('partners');
  slug = (await makeCalendar(w, 'Tune-ups')).slug;
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${w.workspaceId}, 'outreach', 'enabled', ${catalogAddon('outreach').version})`,
  );
});
afterAll(closeTestDbs);

const ws = () => ({ workspaceId: w.workspaceId });

/** Who a booking on the public page is for. */
async function personOf(manageToken: string): Promise<string> {
  const seat = await attendeeByToken(manageToken);
  const [row] = await rows<{ person_id: string }>(
    admin(),
    sql`select person_id from app.appointment_attendees where id = ${seat.id}`,
  );
  return row!.person_id;
}

const commissions = async (partnerId: string) =>
  (
    await rows<{ amount_cents: number }>(
      admin(),
      sql`select amount_cents::int as amount_cents from app.partner_commissions
          where partner_id = ${partnerId} order by created_at`,
    )
  ).map((c) => c.amount_cents);

describe('a partner’s link', () => {
  it('makes whoever books through it the partner’s client, whose payments earn the partner their share', async () => {
    const { personId: paula } = await run(w, personCreate, {
      ...ws(),
      firstName: 'Paula',
      lastName: 'Partner',
      ignoreDuplicates: true,
    });
    const { partnerId, code } = await run(w, partnerAdd, { ...ws(), personId: paula });

    const plain = await bookOnline(w, slug, at(2, '09:00'), customer('Nora'));
    const booked = await bookOnline(w, slug, at(2, '11:00'), {
      ...customer('Maria'),
      ref: `pa-${code}`,
    });
    await drain(w);
    const maria = await personOf(booked.manageToken);
    const referrals = await rows<{ person_id: string; how: string }>(
      admin(),
      sql`select person_id, how from app.partner_referrals where partner_id = ${partnerId}`,
    );
    expect(referrals).toEqual([{ person_id: maria, how: 'link' }]);
    expect(referrals.map((r) => r.person_id)).not.toContain(await personOf(plain.manageToken));

    const made = await run(w, invoiceCreate, {
      ...ws(),
      personId: maria,
      title: 'Tune-up',
      lines: [{ name: 'Tune-up', quantity: 1, unitPriceCents: 100_000, taxable: false }],
    });
    await run(w, invoiceSend, { ...ws(), invoiceId: made.invoiceId, channels: [] });
    const { paymentId } = await run(w, invoiceRecordCashPayment, {
      ...ws(),
      invoiceId: made.invoiceId,
      amountCents: 100_000,
    });
    await drain(w);
    expect(await commissions(partnerId)).toEqual([10_000]);

    // Cash handed back is settled by the worker at once, and takes the share of it back.
    await run(w, paymentRefund, { ...ws(), paymentId, amountCents: 50_000 });
    await drain(w);
    expect(await commissions(partnerId)).toEqual([10_000, -5_000]);
    const got = await query(w, partnerGet, { ...ws(), partnerId });
    expect(got.partner).toMatchObject({
      clients: 1,
      earnings: { earnedCents: 5_000, waitingCents: 5_000, payableCents: 0 },
    });
  });
});
