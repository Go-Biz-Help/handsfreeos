/**
 * Partners in the Deleted bin (20261027008900): asked of the database rather than trusted.
 *   1. The delete box says a customer is a partner (`partners`), and nothing for someone who isn't.
 *   2. Emptied, a partner's contact takes their partner record with it: what they earned, and which clients were
 *      theirs. The clients themselves stay, and so do the bills their shares came from.
 *   3. Emptied, a client a partner sent only lets go of their referral: what they earned the partner stays theirs.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  type TestUser,
} from './harness';

const admin = () => dbs.admin.db;
let owner: TestUser;
let ws: string;
let org: string;

const worker = () => asService({ workspaceId: ws, organizationId: org });
const ids = (list: string[]) => sql`${`{${list.join(',')}}`}::uuid[]`;
const one = async (q: Promise<{ id: string }[]>) => (await q)[0]!.id;

const person = (first: string, last: string) =>
  one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, ${first}, ${last})
          returning id`,
    ),
  );

/** A partner, a client they sent, and a $100 cash payment of the client's that earned them $15. */
async function partnership(partnerFirst: string, clientFirst: string) {
  const partnerPerson = await person(partnerFirst, 'Partner');
  const client = await person(clientFirst, 'Client');
  const partner = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.partners (workspace_id, person_id, code)
          values (${ws}, ${partnerPerson}, ${`Pb${randomBytes(4).toString('hex')}`}) returning id`,
    ),
  );
  const referral = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.partner_referrals (workspace_id, partner_id, person_id, how, referred_at)
          values (${ws}, ${partner}, ${client}, 'by_hand', now() - interval '2 days') returning id`,
    ),
  );
  const invoice = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.invoices (workspace_id, person_id, title, status)
          values (${ws}, ${client}, 'Tune-up', 'sent') returning id`,
    ),
  );
  const payment = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, status, received_at)
          values (${ws}, ${invoice}, 10000, 'cash', 'succeeded', now() - interval '1 day') returning id`,
    ),
  );
  const commission = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.partner_commissions (workspace_id, partner_id, referral_id, payment_id, kind,
            base_cents, rate_bp, amount_cents, earned_at, payable_at)
          values (${ws}, ${partner}, ${referral}, ${payment}, 'earned', 10000, 1500, 1500,
            now() - interval '1 day', now() + interval '29 days') returning id`,
    ),
  );
  return { partnerPerson, client, partner, referral, payment, commission };
}

const preview = (personIds: string[]) =>
  as(owner)((tx) =>
    rows<{ record_id: string; contents: Record<string, unknown> }>(
      tx,
      sql`select record_id, contents from private.bin_preview('person', ${ids(personIds)})`,
    ),
  );

/** Puts a customer in the bin and empties it at once, the way the worker does. */
async function deleteForGood(personId: string): Promise<void> {
  const [put] = await as(owner)((tx) =>
    rows<{ id: string }>(tx, sql`select private.bin_put('person', ${personId}::uuid) as id`),
  );
  await as(owner)((tx) => rows(tx, sql`select * from private.bin_start_purge(${ids([put!.id])})`));
  for (let i = 0; i < 50; i++) {
    const [r] = await worker()((tx) =>
      rows<{ r: { more: boolean } }>(
        tx,
        sql`select private.purge_bin_batch(${ws}::uuid, ${put!.id}::uuid) as r`,
      ),
    );
    if (!r!.r.more) return;
  }
  throw new Error('the bin never finished emptying');
}

const count = async (table: string, id: string) =>
  (
    await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from ${sql.raw(`app.${table}`)} where id = ${id}`,
    )
  )[0]!.n;

beforeAll(async () => {
  owner = await createTestUser('partner-bin-owner');
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(
    owner,
    'Partner Bin Org',
    'Partner Bin HVAC',
  ));
});
afterAll(closeAll);

describe('a partner in the Deleted bin', () => {
  it('says before anything goes that a customer is a partner', async () => {
    const p = await partnership('Gail', 'Maria');
    const found = await preview([p.partnerPerson, p.client]);
    expect(found.find((f) => f.record_id === p.partnerPerson)!.contents).toMatchObject({
      partners: 1,
    });
    expect(found.find((f) => f.record_id === p.client)!.contents).not.toHaveProperty('partners');
  });

  it('takes their partner record when emptied: what they earned, and which clients were theirs', async () => {
    const p = await partnership('Hal', 'Nora');
    await deleteForGood(p.partnerPerson);
    expect(await count('partners', p.partner)).toBe(0);
    expect(await count('partner_commissions', p.commission)).toBe(0);
    expect(await count('partner_referrals', p.referral)).toBe(0);
    // The client, and the payment their share came from, stay.
    expect(await count('people', p.client)).toBe(1);
    expect(await count('payments', p.payment)).toBe(1);
  });

  it('keeps what a client earned their partner when the client is deleted for good', async () => {
    const p = await partnership('Ivy', 'Olga');
    await deleteForGood(p.client);
    expect(await count('partner_commissions', p.commission)).toBe(1);
    const [referral] = await rows<{ person_id: string | null }>(
      admin(),
      sql`select person_id from app.partner_referrals where id = ${p.referral}`,
    );
    expect(referral).toEqual({ person_id: null });
  });
});
