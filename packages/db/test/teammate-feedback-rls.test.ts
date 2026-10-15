/**
 * Coaching the AI teammate (20261027006700): the Instructions list, feedback on its replies, and lessons already in
 * Policies moving to the list.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  uniq,
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
let teammateA: string;
let teammateB: string;

const worker = (b: Business) => asService({ workspaceId: b.ws, organizationId: b.org });
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;

async function createTeammate(user: TestUser, ws: string): Promise<string> {
  const [t] = await as(user)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.ai_teammates (workspace_id, name, status, config, created_by)
          values (${ws}, 'Ava', 'training'::app.ai_teammate_status, '{}'::jsonb, ${user.id})
          returning id`,
    ),
  );
  return t!.id;
}

/** A run the worker recorded, with its reply. */
async function createRun(b: Business, teammateId: string, isTest = false): Promise<string> {
  const [r] = await worker(b)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.ai_teammate_runs (workspace_id, teammate_id, triggered_by, is_test, outcome, status,
            reply_text, ended_at)
          values (${b.ws}, ${teammateId}, ${isTest ? 'test' : 'message.received'}, ${isTest}, 'replied', 'done',
            'We’re open Sundays too!', now())
          returning id`,
    ),
  );
  return r!.id;
}

const addInstruction = (user: TestUser, b: Business, teammateId: string, body: string) =>
  as(user)((tx: Tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.teammate_instructions (workspace_id, teammate_id, body, created_by, updated_by)
          values (${b.ws}, ${teammateId}, ${body}, ${user.id}, ${user.id}) returning id`,
    ),
  ).then((r) => r[0]!.id);

const giveFeedback = (
  user: TestUser,
  b: Business,
  runId: string,
  teammateId: string,
  learn = 'reading',
) =>
  as(user)((tx: Tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.teammate_feedback (workspace_id, teammate_id, run_id, rating, note, learn, created_by)
          values (${b.ws}, ${teammateId}, ${runId}, 'bad', 'We’re closed Sundays.', ${learn}, ${user.id})
          returning id`,
    ),
  ).then((r) => r[0]!.id);

beforeAll(async () => {
  [owner, admin, member, outsider] = await Promise.all([
    createTestUser('fb-owner'),
    createTestUser('fb-admin'),
    createTestUser('fb-member'),
    createTestUser('fb-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Feedback Org A', 'Feedback A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Feedback Org B', 'Feedback B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: A.ws, userId: admin.id, role: 'admin' },
    { workspaceId: A.ws, userId: member.id, role: 'member' },
  ]);
  teammateA = await createTeammate(admin, A.ws);
  teammateB = await createTeammate(outsider, B.ws);
});
afterAll(closeAll);

describe('the Instructions list', () => {
  it('is changed by people who manage the AI teammate, read by the business, and nobody else', async () => {
    const id = await addInstruction(admin, A, teammateA, 'Never offer Sunday visits.');
    const seen = await as(member)((tx) =>
      rows<{ body: string }>(tx, sql`select body from app.teammate_instructions where id = ${id}`),
    );
    expect(seen).toEqual([{ body: 'Never offer Sunday visits.' }]);
    expect(
      await as(outsider)((tx) =>
        rows(tx, sql`select 1 from app.teammate_instructions where id = ${id}`),
      ),
    ).toEqual([]);
    expect(await code(() => addInstruction(member, A, teammateA, 'Always say yes.'))).toBe('42501');
    const edited = await as(member)((tx) =>
      rows(
        tx,
        sql`update app.teammate_instructions set body = 'Always say yes.', updated_by = ${member.id}
            where id = ${id} returning id`,
      ),
    );
    expect(edited).toEqual([]);
    await as(admin)((tx) =>
      tx.execute(
        sql`update app.teammate_instructions set body = 'Never offer a Sunday visit.', updated_by = ${admin.id}
            where id = ${id}`,
      ),
    );
    const gone = await as(admin)((tx) =>
      rows(tx, sql`delete from app.teammate_instructions where id = ${id} returning id`),
    );
    expect(gone).toHaveLength(1);
  });

  it('keeps each one to its own business and stops at 50', async () => {
    expect(await failure(() => addInstruction(owner, A, teammateB, 'Theirs.'))).toEqual({
      code: '23514',
      detail: 'cross_workspace',
    });
    const b = await bootstrapOrganization(owner, `Feedback Org ${uniq()}`, `Feedback ${uniq()}`);
    const biz = { ws: b.wsId, org: b.orgId };
    const t = await createTeammate(owner, biz.ws);
    await dbs.admin.db.execute(
      sql`insert into app.teammate_instructions (workspace_id, teammate_id, body)
          select ${biz.ws}, ${t}, 'Rule ' || n from generate_series(1, 50) n`,
    );
    expect(await failure(() => addInstruction(owner, biz, t, 'One more.'))).toEqual({
      code: '23514',
      detail: 'instructions_full',
    });
  });
});

describe('feedback on a reply', () => {
  it('is given by people who work the inbox, on runs of their own business', async () => {
    const run = await createRun(A, teammateA);
    const id = await giveFeedback(member, A, run, teammateA);
    const seen = await as(owner)((tx) =>
      rows<{ learn: string }>(tx, sql`select learn from app.teammate_feedback where id = ${id}`),
    );
    expect(seen).toEqual([{ learn: 'reading' }]);
    expect(
      await as(outsider)((tx) =>
        rows(tx, sql`select 1 from app.teammate_feedback where id = ${id}`),
      ),
    ).toEqual([]);
    // Their run, our teammate: refused either way.
    const theirRun = await createRun(B, teammateB);
    expect(await code(() => giveFeedback(owner, A, theirRun, teammateA))).toMatch(/42501|23514/);
    // One per person per reply.
    expect(await code(() => giveFeedback(member, A, run, teammateA))).toBe('23505');
  });

  it('lets a person start a read but only the worker say what came of it', async () => {
    const run = await createRun(A, teammateA);
    expect(await code(() => giveFeedback(member, A, run, teammateA, 'suggested'))).toMatch(
      /42501|23514/,
    );
    const id = await giveFeedback(member, A, run, teammateA);
    // Someone else's feedback isn't theirs to change.
    const changed = await as(admin)((tx) =>
      rows(
        tx,
        sql`update app.teammate_feedback set rating = 'good', learn = 'none' where id = ${id} returning id`,
      ),
    );
    expect(changed).toEqual([]);
    expect(
      await code(() =>
        as(member)((tx) =>
          tx.execute(sql`update app.teammate_feedback set learn = 'nothing' where id = ${id}`),
        ),
      ),
    ).toBe('42501');
    const [lesson] = await worker(A)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.teammate_lessons (workspace_id, teammate_id, line, feedback_ids)
            values (${A.ws}, ${teammateA}, 'We’re closed Sundays.', array[${id}]::uuid[]) returning id`,
      ),
    );
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.teammate_feedback set learn = 'suggested', lesson_id = ${lesson!.id} where id = ${id}`,
      ),
    );
    // Asked once: the person answers, and it reads again.
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.teammate_feedback set learn = 'asking', lesson_id = null, question = 'All customers?',
              choices = array['All customers', 'Just this one'] where id = ${id}`,
      ),
    );
    await as(member)((tx) =>
      tx.execute(
        sql`update app.teammate_feedback set answer = 'All customers', learn = 'reading' where id = ${id}`,
      ),
    );
    const [after] = await rows<{ learn: string; answer: string }>(
      dbs.admin.db,
      sql`select learn, answer from app.teammate_feedback where id = ${id}`,
    );
    expect(after).toEqual({ learn: 'reading', answer: 'All customers' });
  });
});

describe('lessons already in Policies', () => {
  it('move to the list once, and the rest of the policies stays', async () => {
    const b = await bootstrapOrganization(owner, `Feedback Org ${uniq()}`, `Feedback ${uniq()}`);
    const t = await createTeammate(owner, b.wsId);
    const [lesson] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.teammate_lessons (workspace_id, teammate_id, line, status, decided_by, decided_at)
          values (${b.wsId}, ${t}, 'We don’t work   Sundays.', 'applied', ${owner.id}, now()) returning id`,
    );
    await rows(
      dbs.admin.db,
      sql`insert into app.teammate_lessons (workspace_id, teammate_id, line)
          values (${b.wsId}, ${t}, 'Still open, so it stays.')`,
    );
    const policies = 'Deposits are 50%.\n- We don’t work Sundays.\nStill open, so it stays.';
    await rows(
      dbs.admin.db,
      sql`insert into app.knowledge_profiles (workspace_id, profile)
          values (${b.wsId}, ${JSON.stringify({ policies })}::jsonb)`,
    );
    const migration = readFileSync(
      fileURLToPath(
        new URL('../../../supabase/migrations/20261027006700_ai_feedback.sql', import.meta.url),
      ),
      'utf8',
    );
    const move = migration.slice(migration.indexOf('do $$'));
    await dbs.admin.db.execute(sql.raw(move));
    await dbs.admin.db.execute(sql.raw(move));
    const [profile] = await rows<{ policies: string }>(
      dbs.admin.db,
      sql`select profile ->> 'policies' as policies from app.knowledge_profiles where workspace_id = ${b.wsId}`,
    );
    expect(profile!.policies).toBe('Deposits are 50%.\nStill open, so it stays.');
    const list = await rows<{
      body: string;
      source: string;
      lesson_id: string;
      created_by: string;
    }>(
      dbs.admin.db,
      sql`select body, source, lesson_id, created_by from app.teammate_instructions where teammate_id = ${t}`,
    );
    expect(list).toEqual([
      {
        body: 'We don’t work Sundays.',
        source: 'lesson',
        lesson_id: lesson!.id,
        created_by: owner.id,
      },
    ]);
  });
});
