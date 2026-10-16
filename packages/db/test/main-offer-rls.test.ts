/**
 * The main offer's direction and the AI's tries (20261027007800): asked of the database rather than trusted.
 *   1. Everyone in the business reads a try, and nobody outside it does.
 *   2. Only the worker keeps one, and only for the business it works for; nobody changes one after.
 *   3. The direction is the owner's or an admin's to change, never a member's, and never blank.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;

interface Business {
  readonly ws: string;
  readonly org: string;
}
let A: Business;
let B: Business;

const worker = (b: Business) => asService({ workspaceId: b.ws, organizationId: b.org });
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;

/** A try as the worker keeps one. */
const keepTry = (as: Business, forWs: string, number: number) =>
  worker(as)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.main_offer_tries (workspace_id, round, number, from_revision, base, parts, why, score)
          values (${forWs}, 0, ${number}, 1, '{}'::jsonb, '{"line": "We help roofers."}'::jsonb, '{}'::jsonb,
            '{}'::jsonb)
          returning id`,
    ),
  ).then((r) => r[0]!.id);

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('offer-tries-owner'),
    createTestUser('offer-tries-member'),
    createTestUser('offer-tries-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Offer Tries Org A', 'Offer Tries A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Offer Tries Org B', 'Offer Tries B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: A.ws, userId: member.id, role: 'member' }]);
  await dbs.admin.db.execute(sql`insert into app.main_offers (workspace_id) values (${A.ws})`);
});
afterAll(closeAll);

describe('the AI’s tries', () => {
  it('are read by everyone in the business, and nobody outside it', async () => {
    const id = await keepTry(A, A.ws, 1);
    const seen = await as(member)((tx) =>
      rows<{ line: string }>(
        tx,
        sql`select parts->>'line' as line from app.main_offer_tries where id = ${id}`,
      ),
    );
    expect(seen).toEqual([{ line: 'We help roofers.' }]);
    expect(
      await as(outsider)((tx) =>
        rows(tx, sql`select 1 from app.main_offer_tries where id = ${id}`),
      ),
    ).toEqual([]);
  });

  it('are kept by the worker alone, for its own business, and never changed', async () => {
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`insert into app.main_offer_tries (workspace_id, round, number, from_revision, base, parts, why,
                  score)
                values (${A.ws}, 0, 9, 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(await code(() => keepTry(B, A.ws, 2))).toBe('42501');
    const id = await keepTry(A, A.ws, 2);
    expect(await code(() => keepTry(A, A.ws, 2))).toBe('23505');
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.main_offer_tries set number = 5 where id = ${id}`),
        ),
      ),
    ).toBe('42501');
    const refused = await rows(
      dbs.admin.db,
      sql`update app.main_offer_tries set number = 5 where id = ${id}`,
    ).then(
      () => 'changed',
      (e: Error & { cause?: { message?: string } }) => e.cause?.message ?? e.message,
    );
    expect(refused).toMatch(/append-only/);
  });
});

describe('the direction', () => {
  it('is changed by an owner, never by a member, and is never blank', async () => {
    const set = (u: TestUser, direction: string) =>
      as(u)((tx) =>
        rows(
          tx,
          sql`update app.main_offers set direction = ${direction} where workspace_id = ${A.ws}
              returning workspace_id`,
        ),
      );
    expect(await set(owner, 'It’s more than a CRM. Lead with the AI.')).toHaveLength(1);
    expect(await set(member, 'Make it about me.')).toEqual([]);
    expect(await code(() => set(owner, '   '))).toBe('23514');
    const [row] = await as(member)((tx) =>
      rows<{ direction: string }>(
        tx,
        sql`select direction from app.main_offers where workspace_id = ${A.ws}`,
      ),
    );
    expect(row?.direction).toBe('It’s more than a CRM. Lead with the AI.');
  });
});
