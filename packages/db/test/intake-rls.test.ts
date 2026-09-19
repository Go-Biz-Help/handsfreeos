/**
 * Lead intake sources (0072): everyone in the business sees how leads arrive, channels.manage sets them,
 * the worker keeps the daily counter, and a source never points at another business's pipeline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql, type Tx } from '../src/client';
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
let admin: TestUser;
let member: TestUser;
let outsider: TestUser;

interface Business {
  readonly ws: string;
  readonly org: string;
}
let A: Business;
let B: Business;

type Actor = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
const worker = (b: Business) => asService({ workspaceId: b.ws, organizationId: b.org });
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const detail = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};

/** The business's own first pipeline and its first open stage. */
async function board(b: Business): Promise<{ pipeline: string; stage: string }> {
  const [row] = await rows<{ pipeline_id: string; id: string }>(
    dbs.admin.db,
    sql`select pipeline_id, id from app.pipeline_stages
        where workspace_id = ${b.ws} and kind = 'open' order by position limit 1`,
  );
  return { pipeline: row!.pipeline_id, stage: row!.id };
}

const insertAs = (actor: Actor, b: Business, who: TestUser | null, kind = 'text') =>
  actor((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.intake_sources (workspace_id, kind, name, created_by)
          values (${b.ws}, ${kind}::app.intake_kind, 'Text message', ${who ? who.id : null})
          returning id`,
    ),
  );

beforeAll(async () => {
  [owner, admin, member, outsider] = await Promise.all([
    createTestUser('intake-rls-owner'),
    createTestUser('intake-rls-admin'),
    createTestUser('intake-rls-member'),
    createTestUser('intake-rls-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Intake Org A', 'Intake A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Intake Org B', 'Intake B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: A.ws, userId: admin.id, role: 'admin' },
    { workspaceId: A.ws, userId: member.id, role: 'member' },
  ]);
});
afterAll(closeAll);

describe('who may change how leads arrive', () => {
  it('an admin writes one, a member only reads it, an outsider sees nothing', async () => {
    const [row] = await insertAs(as(admin), A, admin);
    expect(row!.id).toBeTruthy();

    const seen = await as(member)((tx) =>
      rows<{ name: string }>(tx, sql`select name from app.intake_sources where id = ${row!.id}`),
    );
    expect(seen).toHaveLength(1);

    // A member's update simply finds no row to change: the policy hides it from them.
    await as(member)((tx) =>
      rows(tx, sql`update app.intake_sources set active = false where id = ${row!.id}`),
    );
    const [still] = await rows<{ active: boolean }>(
      dbs.admin.db,
      sql`select active from app.intake_sources where id = ${row!.id}`,
    );
    expect(still!.active).toBe(true);
    expect(await insertAs(as(member), A, member).catch(() => 'refused')).toBe('refused');

    const hidden = await as(outsider)((tx) =>
      rows(tx, sql`select id from app.intake_sources where id = ${row!.id}`),
    );
    expect(hidden).toHaveLength(0);
  });

  it('nobody signs someone else’s name to one', async () => {
    expect(await code(() => insertAs(as(admin), A, owner))).toBe('42501');
  });

  it('the counter and the clock are the worker’s alone', async () => {
    const [row] = await insertAs(as(admin), A, admin, 'call');
    expect(
      await code(() =>
        as(admin)((tx) =>
          rows(tx, sql`update app.intake_sources set day_count = 99 where id = ${row!.id}`),
        ),
      ),
    ).toBe('42501');
    await worker(A)((tx) =>
      rows(
        tx,
        sql`update app.intake_sources set day_count = 3, day_on = current_date where id = ${row!.id}`,
      ),
    );
  });
});

describe('a source stays inside its business', () => {
  it('refuses another business’s pipeline, and a stage from another pipeline', async () => {
    const [row] = await insertAs(as(admin), A, admin, 'email');
    const mine = await board(A);
    const theirs = await board(B);
    expect(
      await detail(() =>
        as(admin)((tx) =>
          rows(
            tx,
            sql`update app.intake_sources set pipeline_id = ${theirs.pipeline} where id = ${row!.id}`,
          ),
        ),
      ),
    ).toEqual({ code: '23514', detail: 'record_workspace_mismatch' });
    expect(
      await detail(() =>
        as(admin)((tx) =>
          rows(
            tx,
            sql`update app.intake_sources set pipeline_id = ${mine.pipeline}, stage_id = ${theirs.stage}
                where id = ${row!.id}`,
          ),
        ),
      ),
    ).toEqual({ code: '23514', detail: 'stage_pipeline_mismatch' });
    await as(admin)((tx) =>
      rows(
        tx,
        sql`update app.intake_sources set pipeline_id = ${mine.pipeline}, stage_id = ${mine.stage}
            where id = ${row!.id}`,
      ),
    );
  });

  it('holds one row per channel', async () => {
    expect(await code(() => insertAs(as(admin), A, admin, 'text'))).toBe('23505');
  });

  it('never moves to another business', async () => {
    const [row] = await insertAs(worker(B), B, null, 'text');
    expect(
      await code(() =>
        worker(B)((tx) =>
          rows(tx, sql`update app.intake_sources set workspace_id = ${A.ws} where id = ${row!.id}`),
        ),
      ).catch(() => '42501'),
    ).toBeTruthy();
  });
});
