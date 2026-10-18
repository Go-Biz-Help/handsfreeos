/**
 * The partner's page (20261027008800): asked of the database rather than trusted.
 *   1. A signed-in partner reads their own partner record, the business's partner settings, their clients and their
 *      earnings through the portal's look-ups, and nobody else's: not another person's, not another business's.
 *   2. Someone who isn't a partner reads nothing through them, not even the business's settings.
 *   3. A client is named by first name and last initial only.
 *   4. The partner tables themselves stay shut to the portal.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  asPortal,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

let owner: TestUser;
let ws: string;
let otherWs: string;
let paula: string;
let nina: string;
let other: string;
// Codes are unique everywhere, so each run makes its own.
const paulaCode = `Pp${randomBytes(4).toString('hex')}`;
const otherCode = `Po${randomBytes(4).toString('hex')}`;

const admin = () => dbs.admin.db;
const one = async (q: Promise<{ id: string }[]>) => (await q)[0]!.id;

const person = (workspace: string, first: string, last: string) =>
  one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, email)
          values (${workspace}, ${first}, ${last}, ${`${first.toLowerCase()}-${randomBytes(3).toString('hex')}@example.com`})
          returning id`,
    ),
  );

/** A live device for this person. */
async function signedIn(personId: string, workspace = ws): Promise<string> {
  const access = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.portal_access (workspace_id, person_id, given_by) values (${workspace}, ${personId}, ${owner.id})
          returning id`,
    ),
  );
  return one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.portal_sessions (workspace_id, access_id, person_id, token_hash, expires_at)
          values (${workspace}, ${access}, ${personId}, ${createHash('sha256').update(randomBytes(32)).digest()},
            now() + interval '90 days')
          returning id`,
    ),
  );
}

/** What a signed-in device reads through the partner page's look-ups. */
const page = (session: string) =>
  asPortal(session)(async (tx) => ({
    partner: await rows<{ code: string }>(tx, sql`select code from portal.partner()`),
    settings: (
      await rows<{ s: Record<string, unknown> | null }>(
        tx,
        sql`select portal.partner_settings() as s`,
      )
    )[0]!.s,
    calendar: (
      await rows<{ id: string | null }>(tx, sql`select portal.partner_link_calendar() as id`)
    )[0]!.id,
    clients: await rows<{ first_name: string | null; last_initial: string | null }>(
      tx,
      sql`select first_name, last_initial from portal.partner_clients()`,
    ),
    earnings: (
      await rows<{ earned_cents: string }>(
        tx,
        sql`select earned_cents from portal.partner_earnings()`,
      )
    )[0]!.earned_cents,
  }));

beforeAll(async () => {
  owner = await createTestUser('partner-page-rls-owner');
  ({ wsId: ws } = await bootstrapOrganization(owner, 'Partner Page Org', 'Partner Page HVAC'));
  ({ wsId: otherWs } = await bootstrapOrganization(owner, 'Partner Page Other', 'Other HVAC'));
  await rows(
    admin(),
    sql`update app.workspaces set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{partners}',
          '{"rateBp": 1500, "terms": "Paid monthly.", "termsVersion": 1}'::jsonb)
        where id = ${ws}`,
  );
  await rows(
    admin(),
    sql`insert into app.calendars (workspace_id, name, slug, status, public)
        values (${ws}, 'Tune-ups', ${`pp-${randomBytes(4).toString('hex')}`}, 'active', true)`,
  );
  paula = await person(ws, 'Paula', 'Partner');
  nina = await person(ws, 'Nina', 'Client');
  other = await person(otherWs, 'Olga', 'Partner');
  const maria = await person(ws, 'Maria', 'lopez');
  const [partner] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.partners (workspace_id, person_id, code) values (${ws}, ${paula}, ${paulaCode})
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.partners (workspace_id, person_id, code) values (${otherWs}, ${other}, ${otherCode})`,
  );
  const [referral] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.partner_referrals (workspace_id, partner_id, person_id, how, referred_at)
        values (${ws}, ${partner!.id}, ${maria}, 'by_hand', now() - interval '2 days') returning id`,
  );
  const [invoice] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.invoices (workspace_id, person_id, title, status)
        values (${ws}, ${maria}, 'Tune-up', 'sent') returning id`,
  );
  const [payment] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, status, received_at)
        values (${ws}, ${invoice!.id}, 10000, 'cash', 'succeeded', now() - interval '1 day') returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.partner_commissions (workspace_id, partner_id, referral_id, payment_id, kind, base_cents,
          rate_bp, amount_cents, earned_at, payable_at)
        values (${ws}, ${partner!.id}, ${referral!.id}, ${payment!.id}, 'earned', 10000, 1500, 1500,
          now() - interval '1 day', now() + interval '29 days')`,
  );
});
afterAll(closeAll);

describe('the partner’s page', () => {
  it('shows a partner their own, and names their clients by first name and last initial', async () => {
    const mine = await page(await signedIn(paula));
    expect(mine.partner).toEqual([{ code: paulaCode }]);
    expect(mine.settings).toMatchObject({ rateBp: 1500, terms: 'Paid monthly.', termsVersion: 1 });
    expect(mine.calendar).not.toBeNull();
    expect(mine.clients).toEqual([{ first_name: 'Maria', last_initial: 'L' }]);
    expect(Number(mine.earnings)).toBe(1500);
  });

  it('shows someone who isn’t a partner nothing, and another business’s partner only theirs', async () => {
    expect(await page(await signedIn(nina))).toEqual({
      partner: [],
      settings: null,
      calendar: null,
      clients: [],
      earnings: '0',
    });
    const theirs = await page(await signedIn(other, otherWs));
    expect(theirs).toMatchObject({ partner: [{ code: otherCode }], clients: [], settings: {} });
  });

  it('keeps the partner tables themselves shut to the portal', async () => {
    const session = await signedIn(await person(ws, 'Petra', 'Partner'));
    for (const table of ['partners', 'partner_referrals', 'partner_commissions'])
      expect(
        (
          await expectPgError(() =>
            asPortal(session)((tx) => rows(tx, sql`select 1 from ${sql.raw(`app.${table}`)}`)),
          )
        ).code,
      ).toBe('42501');
  });
});
