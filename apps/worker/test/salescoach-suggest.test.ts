/**
 * AI Sales Coach's suggested replies (round two, docs/salescoach.md), in the worker against the stand-in model: a
 * customer writes, one job a moment later suggests replies for their newest message (the playbook's answer first when
 * they worry about price), at most three; nothing while the AI teammate answers the conversation, nor once someone
 * has already replied. And a written conversation's write-up once it goes quiet, for the person who answered.
 */
import { randomUUID } from 'node:crypto';
import { salescoachAddon } from '@hfos/core/addons/salescoach/manifest';
import { playbookSave } from '@hfos/core/addons/salescoach/ops/playbooks';
import { catalogAddon, executeCommand, organizationCreate } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addonScope } from '../src/addons/context';
import { QUIET_JOB, QUIET_MS } from '../src/addons/salescoach/quiet';
import { onCustomerWrote, SUGGEST_JOB } from '../src/addons/salescoach/suggest';
import type { EventRow } from '../src/handlers/types';
import { processJobs } from '../src/jobs';
import { jobs } from '../src/scheduled';
import { scriptedAi } from '../src/ai/scripted';
import { workerMeta } from '../src/services';
import { testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-suggest-${process.pid}`;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let ws: string;
let org: string;
let s: TestServices;

async function thread(): Promise<{
  id: string;
  said: (d: string, body: string) => Promise<string>;
}> {
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.conversations (workspace_id, channel, counterpart)
        values (${ws}, 'sms', ${`+1832555${String(Math.floor(Math.random() * 9000) + 1000)}`}) returning id`,
  );
  let at = Date.now() - 60_000;
  return {
    id: c!.id,
    said: async (direction, body) => {
      at += 1000;
      const [m] = await rows<{ id: string }>(
        admin(),
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at)
            values (${ws}, ${c!.id}, 'sms', ${direction}::app.direction,
                    ${direction === 'inbound' ? 'received' : 'sent'}::app.message_status, ${body},
                    ${new Date(at).toISOString()})
            returning id`,
      );
      return m!.id;
    },
  };
}

/** The customer wrote: the add-on hears it, and its job runs now rather than in two seconds. */
async function customerWrote(conversationId: string): Promise<void> {
  const ctx = addonScope(
    s,
    catalogAddon('salescoach'),
    { workspaceId: ws, organizationId: org },
    1,
    workerMeta(),
  );
  await onCustomerWrote({
    ...ctx,
    event: { payload: { conversationId, channel: 'sms' } } as unknown as EventRow,
    attempt: 1,
  });
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${WORKER_ID}
        where workspace_id = ${ws} and kind = ${SUGGEST_JOB} and status = 'pending'`,
  );
  const done = await processJobs({
    ...s,
    jobs,
    workerId: WORKER_ID,
    batchSize: 50,
    reservedOnly: true,
  });
  expect(done.failed + done.retried).toBe(0);
}

const suggested = async (conversationId: string) =>
  (
    await rows<{ replies: { label: string; text: string }[]; objection_id: string | null }>(
      admin(),
      sql`select replies, objection_id from addon_salescoach.suggestions where conversation_id = ${conversationId}`,
    )
  )[0];

beforeAll(async () => {
  owner = await createTestUser('coach-suggest-owner');
  const made = (
    await executeCommand(
      testDbs().api.db,
      organizationCreate,
      { businessName: 'Suggesting HVAC' },
      { type: 'human', userId: owner.id, email: owner.email, claims: owner.claims },
      meta(),
    )
  ).output;
  ws = made.workspaceId;
  org = made.organizationId;
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, 'salescoach', 'enabled', ${salescoachAddon.version})`,
  );
  await executeCommand(
    testDbs().api.db,
    playbookSave,
    {
      workspaceId: ws,
      name: 'First call',
      details: {
        steps: [{ id: 's1', title: 'Say hello', say: '' }],
        objections: [
          {
            id: 'o1',
            objection: 'It’s too expensive',
            answer: 'I hear you. The visit fee goes toward the repair.',
          },
        ],
        points: [],
      },
    },
    { type: 'human', userId: owner.id, email: owner.email, claims: owner.claims },
    meta(),
  );
  s = testServices({ ai: { provider: scriptedAi(), dailyTokens: 5_000_000 } });
}, 60_000);
afterAll(closeTestDbs);

describe('suggested replies', () => {
  it('answer the customer’s newest message, the playbook’s answer first, three at most', async () => {
    const t = await thread();
    await t.said('inbound', 'Hi, my AC stopped working.');
    await t.said('inbound', 'Honestly that sounds expensive');
    await customerWrote(t.id);
    const got = await suggested(t.id);
    expect(got?.objection_id).toBe('o1');
    expect(got?.replies.map((r) => r.label)).toEqual([
      'Answer the price worry',
      'Ask a question',
      'Check and come back',
    ]);
    expect(got?.replies[0]!.text).toContain('goes toward the repair');
  });

  it('wait for the AI teammate’s own drafts, and for nobody once someone replied', async () => {
    const mine = await thread();
    await mine.said('inbound', 'Can you come Friday?');
    const [teammate] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.ai_teammates (workspace_id, name) values (${ws}, 'Sam') returning id`,
    );
    await rows(
      admin(),
      sql`update app.conversations set handled_by = 'ai', ai_teammate_id = ${teammate!.id}
          where id = ${mine.id}`,
    );
    await customerWrote(mine.id);
    expect(await suggested(mine.id)).toBeUndefined();

    const answered = await thread();
    await answered.said('inbound', 'Can you come Friday?');
    await answered.said('outbound', 'Yes, 10am works.');
    await customerWrote(answered.id);
    expect(await suggested(answered.id)).toBeUndefined();
  });
});

describe('a written conversation going quiet', () => {
  /** A stretch of messages ending `agoMs` ago; outbound ones sent by `by` (a person) or nobody (the AI teammate). */
  async function stretch(agoMs: number, by: string | null): Promise<string> {
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, channel, counterpart)
          values (${ws}, 'sms', ${`+1281555${String(Math.floor(Math.random() * 9000) + 1000)}`}) returning id`,
    );
    const end = Date.now() - agoMs;
    const say = (direction: string, body: string, at: number, sentBy: string | null) =>
      rows(
        admin(),
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at, sent_by)
            values (${ws}, ${c!.id}, 'sms', ${direction}::app.direction,
                    ${direction === 'inbound' ? 'received' : 'sent'}::app.message_status, ${body},
                    ${new Date(at).toISOString()}, ${sentBy})`,
      );
    await say('inbound', 'How much is a new unit? Sounds expensive.', end - 60_000, null);
    await say('outbound', 'No problem. I’ll send the quote tomorrow.', end, by);
    return c!.id;
  }

  /** Runs the conversation's quiet check now; its next run, when it waits for more quiet. */
  async function check(conversationId: string): Promise<Date | null> {
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload, addon_id,
                                          addon_generation, locked_at, locked_by)
          select ${org}, ${ws}, ${QUIET_JOB}, ${`${QUIET_JOB}:${conversationId}`}, now(),
                 ${JSON.stringify({ conversationId })}::jsonb, 'salescoach', i.generation, now(), ${WORKER_ID}
          from app.addon_installations i where i.workspace_id = ${ws} and i.addon_id = 'salescoach'
          on conflict do nothing`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: WORKER_ID,
      batchSize: 50,
      reservedOnly: true,
    });
    expect(done.failed + done.retried).toBe(0);
    const [left] = await rows<{ run_at: Date }>(
      admin(),
      sql`select run_at from app.scheduled_jobs
          where dedupe_key = ${`${QUIET_JOB}:${conversationId}`} and status = 'pending'`,
    );
    return left ? new Date(left.run_at) : null;
  }

  const writeUps = (conversationId: string) =>
    rows<{ state: string; user_id: string; channel: string }>(
      admin(),
      sql`select state, user_id, channel from addon_salescoach.calls where conversation_id = ${conversationId}`,
    );

  it('is written up once nobody has written for a while, for the person who answered', async () => {
    const quiet = await stretch(QUIET_MS + 60_000, owner.id);
    expect(await check(quiet)).toBeNull();
    expect(await writeUps(quiet)).toEqual([{ state: 'done', user_id: owner.id, channel: 'sms' }]);
    const [task] = await rows<{ title: string }>(
      admin(),
      sql`select title from app.tasks where workspace_id = ${ws} and assignee_user_id = ${owner.id}
            and title like 'Send the quote tomorrow%'`,
    );
    expect(task).toBeTruthy();
  });

  it('waits while it’s still going, and isn’t written up when only the AI teammate answered', async () => {
    const going = await stretch(60_000, owner.id);
    const next = await check(going);
    expect(next!.getTime()).toBeGreaterThan(Date.now() + QUIET_MS - 5 * 60_000);
    expect(await writeUps(going)).toEqual([]);

    const ai = await stretch(QUIET_MS + 60_000, null);
    expect(await check(ai)).toBeNull();
    expect(await writeUps(ai)).toEqual([]);
  });
});
