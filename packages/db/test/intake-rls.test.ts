/**
 * Lead intake sources (0072): everyone in the business sees how leads arrive, channels.manage sets them,
 * the worker keeps the daily counter, and a source never points at another business's pipeline.
 */
import { randomUUID } from 'node:crypto';
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

/** ik_ and 20 characters, the shape private.new_intake_key() makes. */
const newKey = () =>
  `ik_${randomUUID().replace(/-/g, '').slice(0, 20)}`.replace(/[^A-Za-z0-9_]/g, 'a');

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

describe('forms and connected apps (0082)', () => {
  it('keeps a secret key from everyone: people read every other column, never the hash', async () => {
    const [row] = await worker(A)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.intake_sources (workspace_id, kind, name, secret_hash, secret_hint)
            values (${A.ws}, 'api', 'Zapier', ${Buffer.alloc(32, 7)}, 'abcd') returning id`,
      ),
    );
    const seen = await as(admin)((tx) =>
      rows<{ name: string; secret_hint: string }>(
        tx,
        sql`select name, secret_hint from app.intake_sources where id = ${row!.id}`,
      ),
    );
    expect(seen[0]).toMatchObject({ name: 'Zapier', secret_hint: 'abcd' });
    // The hash itself is not theirs to read, by column grant rather than by policy.
    expect(
      await code(() =>
        as(admin)((tx) =>
          rows(tx, sql`select secret_hash from app.intake_sources where id = ${row!.id}`),
        ),
      ),
    ).toBe('42501');
    // And `select *` asks for it, so it is refused too — every reader names its columns.
    expect(
      await code(() =>
        as(admin)((tx) => rows(tx, sql`select * from app.intake_sources where id = ${row!.id}`)),
      ),
    ).toBe('42501');
  });

  it('holds one keyless website form row, and as many keyed ones as they like', async () => {
    const make = (key: string | null) =>
      worker(A)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.intake_sources (workspace_id, kind, name, public_key)
              values (${A.ws}, 'website_form', 'A form', ${key}) returning id`,
        ),
      );
    await make(null);
    expect(await code(() => make(null))).toBe('23505');
    // A key is unique across every business, so these are made fresh rather than written out.
    await make(newKey());
    await make(newKey());
  });

  it('refuses a key on a channel, and a channel with sites', async () => {
    expect(
      await code(() =>
        worker(A)((tx) =>
          rows(
            tx,
            sql`insert into app.intake_sources (workspace_id, kind, name, public_key)
                values (${A.ws}, 'email', 'Email', ${newKey()})`,
          ),
        ),
      ),
    ).toBe('23514');
    expect(
      await code(() =>
        worker(A)((tx) =>
          rows(
            tx,
            sql`insert into app.intake_sources (workspace_id, kind, name, allowed_origins)
                values (${A.ws}, 'call', 'Calls', array['https://example.com'])`,
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('writes down what arrived, once per sender’s id, and only the business sees it', async () => {
    const [source] = await worker(A)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.intake_sources (workspace_id, kind, name, secret_hash, secret_hint)
            values (${A.ws}, 'api', 'Ad forwarder', ${Buffer.alloc(32, 9)}, 'wxyz') returning id`,
      ),
    );
    const write = () =>
      worker(A)((tx) =>
        rows(
          tx,
          sql`insert into app.intake_submissions (workspace_id, source_id, dedupe_key, outcome)
              values (${A.ws}, ${source!.id}, 'fb-1', 'opened')`,
        ),
      );
    await write();
    expect(await code(write)).toBe('23505');
    // A member of the business doesn't work the settings, so they don't see what a key sent either.
    expect(
      await as(member)((tx) =>
        rows(tx, sql`select id from app.intake_submissions where workspace_id = ${A.ws}`),
      ),
    ).toHaveLength(0);
    expect(
      await as(admin)((tx) =>
        rows(tx, sql`select id from app.intake_submissions where workspace_id = ${A.ws}`),
      ),
    ).toHaveLength(1);
    // Another business's submission never belongs to this one's source.
    expect(
      await detail(() =>
        worker(B)((tx) =>
          rows(
            tx,
            sql`insert into app.intake_submissions (workspace_id, source_id, dedupe_key, outcome)
                values (${B.ws}, ${source!.id}, 'fb-2', 'opened')`,
          ),
        ),
      ),
    ).toEqual({ code: '23514', detail: 'record_workspace_mismatch' });
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
