/**
 * 0061: handing an organization over, deleting an account in no business, and cancelling a call through your cell.
 *   - private.add_organization_owner: only an owner of the organization, never for themselves, only to someone who
 *     already owns one of its businesses (or is an admin of it) and hasn't deleted their account; an admin moves up;
 *     the new owner then reaches every business in it.
 *   - private.request_account_deletion: queues the worker's job for the person asking, once, and only while they
 *     belong to no business.
 *   - private.cancel_bridge_call: the person's own call through their cell, before the customer answers, and nothing
 *     else; the call itself stays closed to people.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
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

const admin$ = dbs.admin.db;
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};

let chris: TestUser;
let dale: TestUser;
let marco: TestUser;
let olive: TestUser;
let gone: TestUser;
let loner: TestUser;
let agency: { orgId: string; wsId: string };
let second: string;

const addOwner = (by: TestUser, org: string, user: string) =>
  as(by)((tx) =>
    rows<{ previous: string }>(
      tx,
      sql`select private.add_organization_owner(${org}, ${user}) as previous`,
    ),
  ).then((r) => r[0]!.previous);

beforeAll(async () => {
  [chris, dale, marco, olive, gone, loner] = await Promise.all([
    createTestUser('handover-chris'),
    createTestUser('handover-dale'),
    createTestUser('handover-marco'),
    createTestUser('handover-olive'),
    createTestUser('handover-gone'),
    createTestUser('handover-loner'),
  ]);
  agency = await bootstrapOrganization(chris, 'Handover Agency DB', 'Client A');
  const [ws] = await rows<{ id: string }>(
    admin$,
    sql`insert into app.workspaces (organization_id, name, slug)
        values (${agency.orgId}, 'Client B', ${`client-b-${randomUUID().slice(0, 6)}`}) returning id`,
  );
  second = ws!.id;
  await rows(
    admin$,
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${agency.wsId}, ${dale.id}, 'owner'), (${agency.wsId}, ${marco.id}, 'admin'), (${agency.wsId}, ${gone.id}, 'owner')`,
  );
  await rows(
    admin$,
    sql`insert into app.organization_memberships (organization_id, user_id, role) values (${agency.orgId}, ${olive.id}, 'admin')`,
  );
  await rows(admin$, sql`update app.users set deleted_at = now() where id = ${gone.id}`);
});
afterAll(closeAll);

describe('private.add_organization_owner', () => {
  it('is only for an owner of the organization, and never for themselves', async () => {
    expect(await failure(() => addOwner(dale, agency.orgId, marco.id))).toEqual({
      code: '42501',
      detail: 'organization_owner_required',
    });
    expect(await failure(() => addOwner(olive, agency.orgId, dale.id))).toEqual({
      code: '42501',
      detail: 'organization_owner_required',
    });
    expect(await failure(() => addOwner(chris, agency.orgId, chris.id))).toEqual({
      code: '23514',
      detail: 'own_role',
    });
  });

  it('only to someone who owns one of its businesses, or is an admin of it, and still has an account', async () => {
    expect(await failure(() => addOwner(chris, agency.orgId, marco.id))).toEqual({
      code: '23514',
      detail: 'not_a_business_owner',
    });
    expect(await failure(() => addOwner(chris, agency.orgId, loner.id))).toEqual({
      code: '23514',
      detail: 'not_a_business_owner',
    });
    expect(await failure(() => addOwner(chris, agency.orgId, gone.id))).toEqual({
      code: 'P0002',
      detail: 'user_not_found',
    });
  });

  it('makes Dale an owner, who then reaches every business in it; an admin moves up; asking twice is fine', async () => {
    const reaches = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ id: string }>(tx, sql`select id from app.workspaces where id = ${second}`),
      ).then((r) => r.length);
    expect(await reaches(dale)).toBe(0);
    expect(await addOwner(chris, agency.orgId, dale.id)).toBe('none');
    expect(await reaches(dale)).toBe(1);
    expect(await addOwner(chris, agency.orgId, dale.id)).toBe('owner');
    expect(await addOwner(chris, agency.orgId, olive.id)).toBe('admin');
    const roles = await rows<{ user_id: string; role: string }>(
      admin$,
      sql`select user_id, role::text as role from app.organization_memberships
          where organization_id = ${agency.orgId} order by role, user_id`,
    );
    expect(roles.map((r) => r.role)).toEqual(['owner', 'owner', 'owner']);
    // People still can't write organization memberships themselves.
    expect(
      (
        await expectPgError(() =>
          as(chris)((tx) =>
            tx.execute(
              sql`insert into app.organization_memberships (organization_id, user_id, role) values (${agency.orgId}, ${marco.id}, 'owner')`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });
});

describe('private.request_account_deletion', () => {
  it('queues the worker’s job for someone in no business, once, and refuses anyone in a business', async () => {
    const queue = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ queued: boolean }>(tx, sql`select private.request_account_deletion() as queued`),
      ).then((r) => r[0]!.queued);
    expect(await queue(loner)).toBe(true);
    expect(await queue(loner)).toBe(false);
    const jobs = await rows<{ kind: string; workspace_id: string | null; payload: unknown }>(
      admin$,
      sql`select kind, workspace_id, payload from app.scheduled_jobs where dedupe_key = ${`account-delete:${loner.id}`}`,
    );
    expect(jobs).toEqual([
      { kind: 'account.delete', workspace_id: null, payload: { userId: loner.id } },
    ]);
    expect(await failure(() => queue(marco))).toEqual({ code: '23514', detail: 'has_business' });
    // Through an agency counts too.
    expect(await failure(() => queue(olive))).toEqual({ code: '23514', detail: 'has_business' });
  });
});

describe('private.cancel_bridge_call', () => {
  it('ends only the person’s own call through their cell, before the customer answers', async () => {
    const own = await bootstrapOrganization(marco, 'Cancel Org', 'Cancel Biz');
    const call = async (u: TestUser, answeredVia: string | null, answered = false) => {
      const [c] = await rows<{ id: string }>(
        admin$,
        sql`insert into app.calls (workspace_id, direction, status, to_e164, placed_by, answered_via, answered_at)
            values (${own.wsId}, 'outbound', 'ringing', '+17135550142', ${u.id}, ${answeredVia}::app.call_answered_via,
              ${answered ? sql`now()` : sql`null`})
            returning id`,
      );
      return c!.id;
    };
    const cancel = (u: TestUser, id: string, activity: string | null = null) =>
      as(u)((tx) =>
        rows<{ cancelled: boolean }>(
          tx,
          sql`select private.cancel_bridge_call(${id}, ${activity}) as cancelled`,
        ),
      ).then((r) => r[0]!.cancelled);
    const statusOf = async (id: string) =>
      (
        await rows<{ status: string; ended: boolean }>(
          admin$,
          sql`select status::text as status, ended_at is not null as ended from app.calls where id = ${id}`,
        )
      )[0];

    const browser = await call(marco, 'browser');
    expect(await cancel(marco, browser)).toBe(false);
    const answered = await call(marco, 'bridge', true);
    expect(await cancel(marco, answered)).toBe(false);
    const mine = await call(marco, 'bridge');
    expect(await cancel(chris, mine)).toBe(false);
    expect(await statusOf(mine)).toEqual({ status: 'ringing', ended: false });
    // Someone else's timeline entry can't be linked to it.
    const [elsewhere] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.people (workspace_id, first_name, last_name) values (${agency.wsId}, 'Mike', 'Elsewhere') returning id`,
    );
    const [entry] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.activities (workspace_id, kind, subtype, person_id, author_user_id, actor_type)
          values (${agency.wsId}, 'call', 'outbound_missed', ${elsewhere!.id}, ${marco.id}, 'human') returning id`,
    );
    expect(await failure(() => cancel(marco, mine, entry!.id))).toEqual({
      code: '23514',
      detail: 'record_workspace_mismatch',
    });
    expect(await cancel(marco, mine)).toBe(true);
    expect(await statusOf(mine)).toEqual({ status: 'canceled', ended: true });
    expect(await cancel(marco, mine)).toBe(false);
    // The call itself stays closed to people.
    expect(
      (
        await expectPgError(() =>
          as(marco)((tx) =>
            tx.execute(sql`update app.calls set status = 'completed' where id = ${answered}`),
          ),
        )
      ).code,
    ).toBe('42501');
    // The worker still can't be asked to do it for someone.
    expect(
      (
        await expectPgError(() =>
          asService({ workspaceId: own.wsId, organizationId: own.orgId })((tx) =>
            tx.execute(sql`select private.cancel_bridge_call(${mine}, null)`),
          ),
        )
      ).code,
    ).toBe('42501');
  });
});
