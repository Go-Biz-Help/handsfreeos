/**
 * 20261027012500: each business pays for its own AI and sets its own daily AI limit, in dollars, and nobody is
 * Silent any more.
 *
 * - A new business opens its wallet as it's made: Stopped at zero, with a $5 starting credit and a $10 limit.
 * - private.ai_spend_today prices today's AI as it's charged, Claude Opus (Ask HandsFreeOS) from its own lines,
 *   for the business's own people and the worker scoped to it.
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

interface Spend {
  limit: number;
  spent: number;
  teammate: number;
}

const spendToday = async (tx: Tx, ws: string, teammate: string | null = null): Promise<Spend> => {
  const [r] = await rows<{ limit_cents: string; spent_cents: string; teammate_cents: string }>(
    tx,
    sql`select limit_cents, spent_cents, teammate_cents
        from private.ai_spend_today(${ws}::uuid, ${teammate}::uuid)`,
  );
  return {
    limit: Number(r!.limit_cents),
    spent: Number(r!.spent_cents),
    teammate: Number(r!.teammate_cents),
  };
};

/** An Assistant question of `user`'s on `model`, with its tokens (input, output, cache read, cache write). */
async function assistantRun(
  user: TestUser,
  ws: string,
  model: string,
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
        values (${ws}, ${user.id}, ${t!.id}, ${model}, gen_random_uuid(), 'done', ${i}, ${o}, ${r}, ${w},
          ${startedAt})`,
  );
}

let teammate: string;

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('ai-limit-owner'),
    createTestUser('ai-limit-member'),
    createTestUser('ai-limit-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'AI Limit Org A', 'AI Limit A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'AI Limit Org B', 'AI Limit B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values({ workspaceId: A.ws, userId: member.id, role: 'member' });
  const [t] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.ai_teammates (workspace_id, name) values (${A.ws}, 'Ava') returning id`,
  );
  teammate = t!.id;
  // Today: an Ask HandsFreeOS question on Claude Opus, 100,000 input and 10,000 output tokens: 60¢ + 30¢. The
  // teammate on Sonnet, 100,000 input and 1,000,000 cache read: 30¢ + 30¢. A workflow step, 40,000 cache written:
  // 15¢. Two days ago, more of each, which don't count.
  await assistantRun(owner, A.ws, 'claude-opus-5-5', [100_000, 10_000, 0, 0]);
  await assistantRun(
    owner,
    A.ws,
    'claude-opus-5-5',
    [9_000_000, 0, 0, 0],
    sql`now() - interval '2 days'`,
  );
  await rows(
    dbs.admin.db,
    sql`insert into app.ai_usage (workspace_id, source, teammate_id, model, input_tokens, cache_read_tokens)
        values (${A.ws}, 'teammate', ${teammate}, 'claude-sonnet-5', 100000, 1000000)`,
  );
  await rows(
    dbs.admin.db,
    sql`insert into app.ai_usage (workspace_id, source, model, cache_write_tokens, created_at)
        values (${A.ws}, 'workflow', 'claude-sonnet-5', 40000, now()),
               (${A.ws}, 'workflow', 'claude-sonnet-5', 9000000, now() - interval '2 days')`,
  );
});
afterAll(closeAll);

describe('a new business', () => {
  it('opens its wallet as it’s made: Stopped at zero, $5 to start, a $10 daily AI limit', async () => {
    const [w] = await rows<{ stage: string; balance: number; limit: number }>(
      dbs.admin.db,
      sql`select stage::text as stage, balance_cents::int as balance, ai_daily_limit_cents::int as limit
          from app.usage_wallets where workspace_id = ${B.ws}`,
    );
    expect(w).toEqual({ stage: 'enforce', balance: 500, limit: 1000 });
    const lines = await rows<{ kind: string; amount: number; subject: string }>(
      dbs.admin.db,
      sql`select kind::text as kind, amount_cents::int as amount, subject from app.usage_ledger
          where workspace_id = ${B.ws}`,
    );
    expect(lines).toEqual([{ kind: 'credit', amount: 500, subject: 'Starting credit' }]);
  });

  it('gets the starting credit once, however often it is asked for', async () => {
    await rows(dbs.admin.db, sql`select private.starting_credit_wallet(${B.ws}::uuid)`);
    const [n] = await rows<{ n: number }>(
      dbs.admin.db,
      sql`select count(*)::int as n from app.usage_ledger where workspace_id = ${B.ws}`,
    );
    expect(n!.n).toBe(1);
  });
});

describe('private.ai_spend_today', () => {
  it('prices today’s AI as it’s charged: Ask HandsFreeOS from Claude Opus’s own lines', async () => {
    const seen = await as(owner)((tx) => spendToday(tx, A.ws, teammate));
    expect(seen.limit).toBe(1000);
    expect(seen.spent).toBeCloseTo(90 + 60 + 15, 6);
    expect(seen.teammate).toBeCloseTo(60, 6);
  });

  it('gives a member the whole business’s spending, another person’s Assistant questions included', async () => {
    expect((await as(member)((tx) => spendToday(tx, A.ws))).spent).toBeCloseTo(165, 6);
  });

  it('follows the limit the business sets', async () => {
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.usage_wallets set ai_daily_limit_cents = 2500 where workspace_id = ${A.ws}`,
      ),
    );
    expect((await as(member)((tx) => spendToday(tx, A.ws))).limit).toBe(2500);
  });

  it('refuses an outsider another business’s spending', async () => {
    const e = await expectPgError(() => as(outsider)((tx) => spendToday(tx, A.ws)));
    expect({ code: e.code, detail: e.detail }).toEqual({
      code: '42501',
      detail: 'ai_usage_forbidden',
    });
    expect((await as(outsider)((tx) => spendToday(tx, B.ws))).spent).toBe(0);
  });

  it('gives the worker the business it’s scoped to, and no other', async () => {
    const workerA = asService({ workspaceId: A.ws, organizationId: A.org });
    const workerB = asService({ workspaceId: B.ws, organizationId: B.org });
    expect((await workerA((tx) => spendToday(tx, A.ws))).spent).toBeCloseTo(165, 6);
    expect((await expectPgError(() => workerB((tx) => spendToday(tx, A.ws)))).code).toBe('42501');
  });
});
