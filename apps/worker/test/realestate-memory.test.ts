/**
 * Real Estate Agent, round two, step 7, in the worker: what a buyer said is read for their deal (the stand-in model
 * here) from their own words alone: their texts, a verified chat, this deal's portal thread, the team's notes. Never
 * another deal's private thread or note, an unverified chat, or what the business sent. What the model suggests
 * comes with its quote; anything protected is dropped and only counted; the next read starts where this one stopped.
 * A client's message reads their buyer deals ten minutes on, once for a burst. While suggestions wait, the agent has
 * a note on Home, gone when none do.
 */
import { randomUUID } from 'node:crypto';
import {
  activityLog,
  ADDON_SERVER_MODULES,
  executeCommand,
  executeQuery,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { memoryAlertKey, memoryJobKey, MEMORY_JOB } from '../src/addons/realestate/memory';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const realestate = ADDON_SERVER_MODULES.find((m) => m.manifest.id === 'realestate')!;
const op = (name: string) =>
  [...realestate.commands!, ...realestate.queries!].find((c) => c.name === name)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(agent),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(agent), meta());

const handlers = withAddons({});
const jobs = { ...addonJobs };

let s: TestServices;
let agent: TestUser;
let ws: string;
let org: string;
let client: string;
let deal: string;
let other: string;

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-memory-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()
            and kind <> 'realestate.sweep'`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

/** A thread with the client, and what they (or the business) said on it. */
async function thread(
  channel: 'sms' | 'chat' | 'portal',
  said: readonly { text: string; direction?: 'inbound' | 'outbound' }[],
  recordId: string | null = null,
): Promise<string> {
  const counterpart =
    channel === 'sms'
      ? `+1512555${String(1000 + Math.floor(Math.random() * 9000))}`
      : channel === 'portal'
        ? `portal:${client}:${recordId}`
        : `chat:${randomUUID()}`;
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, custom_record_id)
        values (${ws}, ${channel}, ${counterpart}, ${client}, ${recordId}) returning id`,
  );
  for (const m of said) {
    const inbound = (m.direction ?? 'inbound') === 'inbound';
    await rows(
      admin(),
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at)
          values (${ws}, ${c!.id}, ${channel}, ${inbound ? 'inbound' : 'outbound'},
            ${inbound ? 'received' : 'sent'}, ${m.text}, now() - interval '1 minute')`,
    );
  }
  return c!.id;
}

const memory = async (dealId: string) =>
  (
    (await ask('realestate.memory', { dealId })).items as {
      words: string;
      kind: string;
      quote: string;
    }[]
  )
    .map((i) => [i.kind, i.words, i.quote])
    .sort((a, b) => a[1]!.localeCompare(b[1]!));

const alert = () =>
  rows<{ title: string; href: string; cleared: boolean; assignee_user_id: string }>(
    admin(),
    sql`select title, href, cleared_at is not null as cleared, assignee_user_id from app.addon_alerts
        where workspace_id = ${ws} and addon_id = 'realestate' and key = ${memoryAlertKey(deal)}`,
  ).then((r) => r[0]);

/** A client's message as core records one: the event the worker hears. */
async function clientWrote() {
  const eventId = randomUUID();
  await rows(
    admin(),
    sql`insert into app.events (id, organization_id, workspace_id, event_type, actor_type, entity_type, entity_id,
          payload, correlation_id)
        values (${eventId}, ${org}, ${ws}, 'message.received', 'system', 'message', ${randomUUID()},
          ${JSON.stringify({ personId: client, channel: 'sms' })}::jsonb, ${randomUUID()})`,
  );
  await rows(
    admin(),
    sql`insert into app.outbox (event_id, organization_id, workspace_id, event_type)
        values (${eventId}, ${org}, ${ws}, 'message.received')`,
  );
}

const pendingReads = () =>
  rows<{ key: string; minutes: number }>(
    admin(),
    sql`select dedupe_key as key, round(extract(epoch from run_at - now()) / 60)::int as minutes
        from app.scheduled_jobs where workspace_id = ${ws} and kind = ${MEMORY_JOB} and status = 'pending'
        order by dedupe_key`,
  );

beforeAll(async () => {
  s = testServices({ ai: { provider: scriptedAi() } });
  agent = await createTestUser('rem-worker-agent', { fullName: 'Sam Rivera' });
  ws = await realestateBusiness(agent, 'Buyer Memory Realty');
  const [w] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  );
  org = w!.organization_id;
  client = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Linh', lastName: 'Nguyen' },
      human(agent),
      meta(),
    )
  ).output.personId;
  deal = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen home',
      clientPersonId: client,
    })
  ).dealId;
  other = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen rental',
      clientPersonId: client,
    })
  ).dealId;
  await drain();
}, 90_000);

afterAll(closeTestDbs);

describe('what the buyer said, read for their deal', () => {
  it('is read from their own words alone, each item with its quote, and protected words only counted', async () => {
    await thread('sms', [
      { text: 'We need a fenced yard for the dog. Absolutely no HOA please.' },
      { text: 'We want a family-friendly street.' },
      // What the business said isn't the buyer's.
      { text: 'You want a pool? I can look for one.', direction: 'outbound' },
    ]);
    // This deal's own portal thread is the client's words for it.
    await thread(
      'portal',
      [{ text: 'Our lease ends in March, so we must move by March 1.' }],
      deal,
    );
    // Another deal's private thread, and an unverified chat, are never read for this one.
    await thread('portal', [{ text: 'We need a pool for the rental.' }], other);
    await thread('chat', [{ text: 'We love big kitchens.' }]);
    // The team's note on the client is read; one on the other deal isn't.
    await executeCommand(
      api(),
      activityLog,
      { workspaceId: ws, kind: 'note', body: 'Linh said they hate carpet.', personId: client },
      human(agent),
      meta(),
    );
    await executeCommand(
      api(),
      activityLog,
      {
        workspaceId: ws,
        kind: 'note',
        body: 'Linh said they want a basement in the rental.',
        customRecordId: other,
      },
      human(agent),
      meta(),
    );

    await run('realestate.memory.request', { dealId: deal });
    await drain();

    expect(await memory(deal)).toEqual([
      ['deal_breaker', 'Absolutely no HOA please', 'Absolutely no HOA please.'],
      ['dislikes', 'Linh said they hate carpet', 'Linh said they hate carpet.'],
      [
        'timing',
        'Our lease ends in March, so we must move by March 1',
        'Our lease ends in March, so we must move by March 1.',
      ],
      ['must_have', 'We need a fenced yard for the dog', 'We need a fenced yard for the dog.'],
    ]);
    const [e] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where event_type = 'realestate.memory.suggested' and entity_id = ${deal}`,
    );
    expect(e!.payload).toMatchObject({ added: 4, waiting: 4, protectedDropped: 1 });
    // Nothing about the street was kept anywhere.
    expect(JSON.stringify(e!.payload)).not.toContain('family');
    const [kept] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_realestate.memory_items where words ilike '%family%'`,
    );
    expect(kept!.n).toBe(0);
    // The other deal wasn't touched.
    expect(await memory(other)).toEqual([]);
  });

  it('puts a note on the agent’s Home while suggestions wait, gone when none do', async () => {
    expect(await alert()).toMatchObject({
      title: '4 things the buyer said, to confirm',
      href: `/a/realestate/deals/${deal}/buyer`,
      cleared: false,
      assignee_user_id: agent.id,
    });
    const list = (await ask('realestate.memory', { dealId: deal })).items as { id: string }[];
    for (const item of list)
      await run('realestate.memory.decide', { itemId: item.id, decision: 'confirm' });
    await drain();
    expect(await alert()).toMatchObject({ cleared: true });
  });

  it('starts the next read where the last one stopped', async () => {
    await run('realestate.memory.request', { dealId: deal });
    await drain();
    const [n] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events where event_type = 'realestate.memory.suggested'
          and entity_id = ${deal}`,
    );
    // Nothing new was said, so the model wasn't asked again.
    expect(n!.n).toBe(1);
    await thread('sms', [{ text: 'We would like a home office.' }]);
    await run('realestate.memory.request', { dealId: deal });
    await drain();
    const now = await memory(deal);
    expect(now.map((i) => i[1])).toContain('We would like a home office');
    expect(now).toHaveLength(5);
  });
});

describe('a long backlog', () => {
  it('is read a batch at a time, oldest first, until it’s all read', async () => {
    const reads = async () => {
      const [n] = await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.events where event_type = 'realestate.memory.suggested'
            and entity_id = ${deal}`,
      );
      return n!.n;
    };
    const before = await reads();
    await thread('sms', [
      { text: 'We need a sauna.' },
      ...Array.from({ length: 63 }, (_, i) => ({ text: `Thanks, talk soon (${i}).` })),
      { text: 'We need a garden shed.' },
    ]);
    await run('realestate.memory.request', { dealId: deal });
    await drain();
    // More than one read's worth: the first read queued the next at once.
    expect((await reads()) - before).toBe(2);
    expect((await memory(deal)).map((i) => i[1])).toEqual(
      expect.arrayContaining(['We need a sauna', 'We need a garden shed']),
    );
    const [d] = await rows<{ behind: boolean }>(
      admin(),
      sql`select d.memory_read_through < (select max(date_trunc('milliseconds', created_at)) from app.messages
            where workspace_id = ${ws}) as behind
          from addon_realestate.deals d where d.record_id = ${deal}`,
    );
    expect(d!.behind).toBe(false);
  });
});

describe('a client’s message', () => {
  it('reads each of their buyer deals ten minutes on, once for a burst', async () => {
    await clientWrote();
    await drain();
    expect(await pendingReads()).toEqual(
      [
        { key: `${ws}:${memoryJobKey(deal)}`, minutes: 10 },
        { key: `${ws}:${memoryJobKey(other)}`, minutes: 10 },
      ].sort((a, b) => a.key.localeCompare(b.key)),
    );
    await clientWrote();
    await drain();
    expect(await pendingReads()).toHaveLength(2);
    // Ten minutes on, each deal is read: the other deal's own thread and note are its own.
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now() where workspace_id = ${ws} and kind = ${MEMORY_JOB}
          and status = 'pending'`,
    );
    await drain();
    expect(await pendingReads()).toEqual([]);
    const theirs = (await memory(other)).map((i) => i[1]);
    expect(theirs).toEqual(
      expect.arrayContaining([
        'Linh said they want a basement in the rental',
        'We need a pool for the rental',
      ]),
    );
    // This deal's own portal thread stays this deal's.
    expect(theirs.join()).not.toMatch(/lease ends/i);
    expect((await memory(deal)).map((i) => i[1]).join()).not.toMatch(/pool|basement/);
  });
});
