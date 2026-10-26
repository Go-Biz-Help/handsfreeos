/**
 * 0038: private.ai_tokens_today gives a business's AI use today, counted as the daily budget counts it (the
 * Assistant's runs plus ai_usage since midnight in its time zone), to its own people and to the worker scoped
 * to it. A person's own view of assistant_runs is only their chats, so the AI teammate's pages take the total
 * from here.
 */
import type { SQL } from 'drizzle-orm';
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
let member: TestUser;
let outsider: TestUser;
let A: { ws: string; org: string };
let B: { ws: string; org: string };

const today = async (tx: Tx, ws: string) => {
  const [r] = await rows<{ n: string }>(
    tx,
    sql`select private.ai_tokens_today(${ws}::uuid)::text as n`,
  );
  return Number(r!.n);
};

/** An Assistant chat of `user`'s with one run and its tokens (input, output, cache read, cache write). */
async function assistantRun(
  user: TestUser,
  ws: string,
  [i, o, r, w]: readonly number[],
  startedAt: SQL = sql`now()`,
) {
  const [t] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.assistant_threads (workspace_id, user_id) values (${ws}, ${user.id}) returning id`,
  );
  await rows(
    dbs.admin.db,
    sql`insert into app.assistant_runs (workspace_id, user_id, thread_id, model, correlation_id, status,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at)
        values (${ws}, ${user.id}, ${t!.id}, 'scripted', gen_random_uuid(), 'done', ${i}, ${o}, ${r}, ${w}, ${startedAt})`,
  );
}

/** AI outside the Assistant (a knowledge scan, say). */
async function usage(ws: string, tokens: number, createdAt: SQL = sql`now()`) {
  await rows(
    dbs.admin.db,
    sql`insert into app.ai_usage (workspace_id, source, model, input_tokens, output_tokens, created_at)
        values (${ws}, 'knowledge', 'scripted', ${tokens}, 0, ${createdAt})`,
  );
}

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('usage-owner'),
    createTestUser('usage-member'),
    createTestUser('usage-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Usage Org A', 'Usage A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Usage Org B', 'Usage B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values({ workspaceId: A.ws, userId: member.id, role: 'member' });
  // Today: the owner's Assistant chat (1,234 tokens) and a knowledge scan (500). Two days ago: more of both,
  // which don't count. Business B: the outsider's own chat.
  await assistantRun(owner, A.ws, [1000, 200, 30, 4]);
  await usage(A.ws, 500);
  await assistantRun(owner, A.ws, [9000, 0, 0, 0], sql`now() - interval '2 days'`);
  await usage(A.ws, 7000, sql`now() - interval '2 days'`);
  await assistantRun(outsider, B.ws, [300, 0, 0, 0]);
});
afterAll(closeAll);

describe('private.ai_tokens_today', () => {
  it('gives a member the whole business’s total, another member’s Assistant chats included', async () => {
    // Their own view of the Assistant's runs is only their chats: none.
    const [seen] = await as(member)((tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from app.assistant_runs where workspace_id = ${A.ws}`,
      ),
    );
    expect(seen!.n).toBe(0);
    expect(await as(member)((tx) => today(tx, A.ws))).toBe(1734);
    expect(await as(owner)((tx) => today(tx, A.ws))).toBe(1734);
  });

  it('counts as the daily budget does: the same sources, token columns and midnight', async () => {
    // The sources and midnight the daily AI limit counts by (private.ai_spend_today), run where every row is visible.
    const [budget] = await rows<{ n: string }>(
      dbs.admin.db,
      sql`with since as (
            select date_trunc('day', now() at time zone z.tz) at time zone z.tz as t
            from (select coalesce((select w.timezone from app.workspaces w where w.id = ${A.ws}), 'UTC') as tz) z
          )
          select (coalesce((select sum(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens)
              from app.assistant_runs r, since where r.workspace_id = ${A.ws} and r.started_at >= since.t), 0)
            + coalesce((select sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens)
              from app.ai_usage u, since where u.workspace_id = ${A.ws} and u.created_at >= since.t), 0))::text as n`,
    );
    expect(await as(member)((tx) => today(tx, A.ws))).toBe(Number(budget!.n));
  });

  it('refuses an outsider another business’s total', async () => {
    const e = await expectPgError(() => as(outsider)((tx) => today(tx, A.ws)));
    expect({ code: e.code, detail: e.detail }).toEqual({
      code: '42501',
      detail: 'ai_usage_forbidden',
    });
    expect(await as(outsider)((tx) => today(tx, B.ws))).toBe(300);
  });

  it('won’t take a signed-in person’s word for the worker’s scope', async () => {
    const e = await expectPgError(() =>
      as(outsider)(async (tx) => {
        await tx.execute(sql`select set_config('app.system_scope.workspace_id', ${A.ws}, true)`);
        return today(tx, A.ws);
      }),
    );
    expect(e.code).toBe('42501');
  });

  it('gives the worker the total for the business it’s scoped to, and no other', async () => {
    const workerA = asService({ workspaceId: A.ws, organizationId: A.org });
    const workerB = asService({ workspaceId: B.ws, organizationId: B.org });
    expect(await workerA((tx) => today(tx, A.ws))).toBe(1734);
    expect((await expectPgError(() => workerB((tx) => today(tx, A.ws)))).code).toBe('42501');
  });
});
