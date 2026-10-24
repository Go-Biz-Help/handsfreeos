/**
 * Teammate funnels (20261027012000): who changes a funnel and who's in it, one funnel at a time a person, what stays
 * inside its own business and pipeline, and a person in the Deleted bin taking their funnel row with them.
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
  uniq,
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
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const admin = () => dbs.admin.db;

/** A pipeline with a New and an Interested stage, as the database's own writer makes one. */
async function pipeline(b: Business, name = `Recruiting ${uniq()}`) {
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.pipelines (workspace_id, name, position) values (${b.ws}, ${name}, 9) returning id`,
  );
  const stages = await rows<{ id: string; name: string }>(
    admin(),
    sql`insert into app.pipeline_stages (workspace_id, pipeline_id, name, kind, position)
        values (${b.ws}, ${p!.id}, 'New', 'open', 1), (${b.ws}, ${p!.id}, 'Interested', 'open', 2),
               (${b.ws}, ${p!.id}, 'Won', 'won', 3), (${b.ws}, ${p!.id}, 'Lost', 'lost', 4)
        returning id, name`,
  );
  return { id: p!.id, newStage: stages.find((s) => s.name === 'New')!.id };
}

const makeFunnel = (u: TestUser, b: Business, pipelineId: string, name = `Recruiting ${uniq()}`) =>
  as(u)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.funnels (workspace_id, pipeline_id, name, created_by, updated_by)
          values (${b.ws}, ${pipelineId}, ${name}, ${u.id}, ${u.id}) returning id`,
    ),
  ).then((r) => r[0]!.id);

/** A customer with a lead in the pipeline. */
async function customer(b: Business, pipelineId: string, stageId: string) {
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.people (workspace_id, first_name) values (${b.ws}, 'Sam') returning id`,
  );
  const [l] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.leads (workspace_id, title, person_id, pipeline_id, stage_id)
        values (${b.ws}, 'Sam', ${p!.id}, ${pipelineId}, ${stageId}) returning id`,
  );
  return { person: p!.id, lead: l!.id };
}

const addPerson = (
  u: TestUser,
  b: Business,
  f: { funnel: string; person: string; lead: string; stage: string },
  addedByUser: string | null = u.id,
) =>
  as(u)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.funnel_people (workspace_id, funnel_id, person_id, lead_id, stage_id, added_by,
            added_by_user)
          values (${b.ws}, ${f.funnel}, ${f.person}, ${f.lead}, ${f.stage}, 'hand', ${addedByUser}) returning id`,
    ),
  ).then((r) => r[0]!.id);

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('fun-owner'),
    createTestUser('fun-member'),
    createTestUser('fun-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Funnel Org A', 'Funnel A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Funnel Org B', 'Funnel B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: A.ws, userId: member.id, role: 'member' }]);
});
afterAll(closeAll);

describe('a funnel', () => {
  it('is changed by whoever runs the AI teammate, read by the business, and nobody else', async () => {
    const p = await pipeline(A);
    expect(await code(() => makeFunnel(member, A, p.id))).toBe('42501');
    const id = await makeFunnel(owner, A, p.id);
    expect(
      await as(member)((tx) => rows(tx, sql`select status from app.funnels where id = ${id}`)),
    ).toEqual([{ status: 'draft' }]);
    expect(
      await as(outsider)((tx) => rows(tx, sql`select 1 from app.funnels where id = ${id}`)),
    ).toEqual([]);
    const edited = await as(member)((tx) =>
      rows(
        tx,
        sql`update app.funnels set status = 'on', updated_by = ${member.id} where id = ${id} returning id`,
      ),
    );
    expect(edited).toEqual([]);
    // Its pipeline and who made it stay as they were.
    const other = await pipeline(A);
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.funnels set pipeline_id = ${other.id} where id = ${id}`),
        ),
      ),
    ).toBe('42501');
  });

  it('runs one a pipeline, inside its own business, twenty at most', async () => {
    const p = await pipeline(A);
    await makeFunnel(owner, A, p.id);
    expect(await code(() => makeFunnel(owner, A, p.id))).toBe('23505');
    const theirs = await pipeline(B);
    expect(await failure(() => makeFunnel(owner, A, theirs.id))).toMatchObject({ code: '23514' });
    const fresh = await bootstrapOrganization(owner, `Funnel Org ${uniq()}`, `Funnel ${uniq()}`);
    const biz = { ws: fresh.wsId, org: fresh.orgId };
    for (let i = 0; i < 20; i++) await makeFunnel(owner, biz, (await pipeline(biz)).id);
    expect(await failure(async () => makeFunnel(owner, biz, (await pipeline(biz)).id))).toEqual({
      code: '23514',
      detail: 'funnels_full',
    });
  });
});

describe('who’s in it', () => {
  it('is put in by people who change records, once a person, with their own lead at a stage of its pipeline', async () => {
    const p = await pipeline(A);
    const funnel = await makeFunnel(owner, A, p.id);
    const sam = await customer(A, p.id, p.newStage);
    const row = await addPerson(member, A, { funnel, ...sam, stage: p.newStage });
    expect(
      await as(outsider)((tx) => rows(tx, sql`select 1 from app.funnel_people where id = ${row}`)),
    ).toEqual([]);
    // Added in someone else's name: refused.
    const kim = await customer(A, p.id, p.newStage);
    expect(
      await code(() => addPerson(member, A, { funnel, ...kim, stage: p.newStage }, owner.id)),
    ).toBe('42501');
    // One funnel at a time.
    const second = await makeFunnel(owner, A, (await pipeline(A)).id);
    expect(
      await code(() => addPerson(owner, A, { funnel: second, ...sam, stage: p.newStage })),
    ).toMatch(/23505|23514/);
    // Another customer's lead, or a stage of another pipeline: refused.
    expect(
      await failure(() =>
        addPerson(owner, A, { funnel, person: kim.person, lead: sam.lead, stage: p.newStage }),
      ),
    ).toEqual({ code: '23514', detail: 'cross_workspace' });
    const elsewhere = await pipeline(A);
    expect(
      await failure(() => addPerson(owner, A, { funnel, ...kim, stage: elsewhere.newStage })),
    ).toEqual({ code: '23514', detail: 'cross_workspace' });
    // Who added them stays as it was.
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.funnel_people set added_by = 'ai' where id = ${row}`),
        ),
      ),
    ).toBe('42501');
  });

  it('keeps paused with a reason, left with when and why, and active with a lead', async () => {
    const p = await pipeline(A);
    const funnel = await makeFunnel(owner, A, p.id);
    const sam = await customer(A, p.id, p.newStage);
    const row = await addPerson(owner, A, { funnel, ...sam, stage: p.newStage });
    expect(
      await code(() =>
        worker(A)((tx) =>
          tx.execute(sql`update app.funnel_people set status = 'paused' where id = ${row}`),
        ),
      ),
    ).toBe('23514');
    expect(
      await code(() =>
        worker(A)((tx) =>
          tx.execute(
            sql`update app.funnel_people set status = 'left', left_reason = 'won' where id = ${row}`,
          ),
        ),
      ),
    ).toBe('23514');
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.funnel_people set status = 'left', left_reason = 'won', left_at = now() where id = ${row}`,
      ),
    );
    // A suggestion needs no lead yet.
    const jo = await customer(A, p.id, p.newStage);
    await worker(A)((tx) =>
      tx.execute(
        sql`insert into app.funnel_people (workspace_id, funnel_id, person_id, status, added_by, suggested_why)
            values (${A.ws}, ${funnel}, ${jo.person}, 'suggested', 'ai', 'Asked about the job')`,
      ),
    );
  });

  it('goes into the Deleted bin with the customer, and back with them', async () => {
    const p = await pipeline(A);
    const funnel = await makeFunnel(owner, A, p.id);
    const sam = await customer(A, p.id, p.newStage);
    const row = await addPerson(owner, A, { funnel, ...sam, stage: p.newStage });
    const [item] = await as(owner)((tx) =>
      rows<{ id: string }>(tx, sql`select private.bin_put('person', ${sam.person}::uuid) as id`),
    );
    const seen = (u: TestUser) =>
      as(u)((tx) => rows(tx, sql`select 1 from app.funnel_people where id = ${row}`));
    expect(await seen(owner)).toEqual([]);
    // The worker doesn't see it either, so nothing more goes to them.
    expect(
      await worker(A)((tx) => rows(tx, sql`select 1 from app.funnel_people where id = ${row}`)),
    ).toEqual([]);
    await as(owner)((tx) => rows(tx, sql`select private.restore_bin_item(${item!.id}::uuid)`));
    expect(await seen(owner)).toHaveLength(1);
  });
});
