/**
 * Real Estate Agent, round two, step 7: buyer memory. The model's items are kept only when quoted word for word from
 * the buyer's own words, never when protected, never twice. On the database: a person's own items are kept, the AI's
 * wait as suggestions, a person decides each one, words about who lives somewhere are refused, and the worker's
 * suggestions record how far it read.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkedMemory, type MemorySource } from '../../src/addons/realestate/prompts';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  executeQuery,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

const sources: MemorySource[] = [
  {
    kind: 'message',
    id: randomUUID(),
    at: '2026-10-01T10:00:00Z',
    text: 'We need a fenced yard for the dog. Absolutely no HOA please.',
  },
  {
    kind: 'call',
    id: randomUUID(),
    at: '2026-10-01T11:00:00Z',
    text: 'Our lease ends in March, so we must move by March 1.',
  },
];

describe('the model’s memory, checked', () => {
  it('keeps quoted items, drops protected and made-up ones, and nothing twice', () => {
    const out = checkedMemory(
      {
        items: [
          {
            kind: 'must_have',
            words: 'A fenced yard for the dog',
            quote: 'We need a fenced yard for the dog.',
            protected: false,
          },
          {
            kind: 'timing',
            words: 'Must move by March 1',
            quote: 'we must move by March 1',
            protected: false,
          },
          // Made up: nobody said it.
          { kind: 'likes', words: 'A pool', quote: 'We love pools', protected: false },
          // The model says it's protected.
          {
            kind: 'other',
            words: 'Wants a quiet street',
            quote: 'Absolutely no HOA please',
            protected: true,
          },
          // The fixed list catches it whatever the model said.
          {
            kind: 'likes',
            words: 'A family-friendly street',
            quote: 'We need a fenced yard for the dog.',
            protected: false,
          },
          // Already kept.
          {
            kind: 'deal_breaker',
            words: 'No HOA',
            quote: 'Absolutely no HOA please.',
            protected: false,
          },
        ],
      },
      sources,
      ['No HOA'],
    );
    expect(out.items.map((i) => [i.kind, i.words, i.source.kind])).toEqual([
      ['must_have', 'A fenced yard for the dog', 'message'],
      ['timing', 'Must move by March 1', 'call'],
    ]);
    expect([out.unquoted, out.protectedDropped]).toEqual([1, 2]);
  });
});

// ---------- on the database ----------

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const meta = (channel: 'test' | 'assistant' = 'test') => ({ correlationId: randomUUID(), channel });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const op = (kind: 'commands' | 'queries', name: string) => {
  const found = (realestateAddonServer[kind] ?? []).find((x) => x.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const run = (
  name: string,
  input: Record<string, unknown>,
  channel: 'test' | 'assistant' = 'test',
): Promise<Any> =>
  executeCommand(
    api(),
    op('commands', name) as CommandDef,
    { workspaceId: ws, ...input },
    human(agent),
    meta(channel),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(
    api(),
    op('queries', name) as QueryDef,
    { workspaceId: ws, ...input },
    human(agent),
    meta(),
  );
async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { rule?: string; code?: string };
    return err.rule ?? err.code ?? String(e);
  }
  throw new Error('It was allowed.');
}

let agent: TestUser;
let ws: string;
let org: string;
let deal: string;

beforeAll(async () => {
  agent = await createTestUser('rem-agent');
  ws = await realestateBusiness(agent, 'Memory Realty');
  const [w] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  );
  org = w!.organization_id;
  const client = (
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
      name: 'Nguyen purchase',
      clientPersonId: client,
    })
  ).dealId;
}, 90_000);
afterAll(closeTestDbs);

describe('buyer memory', () => {
  it('keeps what a person adds, and leaves what the AI adds as a suggestion', async () => {
    expect(
      await run('realestate.memory.add', {
        dealId: deal,
        kind: 'likes',
        words: 'Big kitchen windows',
      }),
    ).toMatchObject({
      status: 'confirmed',
    });
    expect(
      await run(
        'realestate.memory.add',
        { dealId: deal, kind: 'timing', words: 'Wants to move by spring' },
        'assistant',
      ),
    ).toMatchObject({ status: 'suggested' });
    expect(
      await refused(
        run('realestate.memory.add', {
          dealId: deal,
          kind: 'likes',
          words: 'big kitchen windows.',
        }),
      ),
    ).toBe('realestate_memory_already');
    expect(
      await refused(
        run('realestate.memory.add', {
          dealId: deal,
          kind: 'other',
          words: 'Prefers a mostly white area',
        }),
      ),
    ).toBe('realestate_fair_housing');
  });

  it('takes the worker’s suggestions with their quotes, and remembers how far it read', async () => {
    const out = await executeCommand(
      worker(),
      op('commands', 'realestate.memory.suggest') as CommandDef,
      {
        workspaceId: ws,
        dealId: deal,
        items: [
          {
            kind: 'must_have',
            words: 'A fenced yard for the dog',
            quote: 'We need a fenced yard for the dog.',
            sourceKind: 'message',
            sourceId: randomUUID(),
          },
        ],
        readThrough: '2026-10-01T10:00:00.000Z',
        protectedDropped: 1,
      },
      { type: 'system', workspaceId: ws, organizationId: org },
      meta(),
    );
    expect(out.output).toEqual({ added: 1, waiting: 2 });
    const [d] = await rows<{ at: string }>(
      admin(),
      sql`select memory_read_through::text as at from addon_realestate.deals where record_id = ${deal}`,
    );
    expect(d!.at).toContain('2026-10-01');
    const [e] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where event_type = 'realestate.memory.suggested' and entity_id = ${deal}`,
    );
    // Only how many were dropped: never what.
    expect(e!.payload).toMatchObject({ added: 1, protectedDropped: 1 });
  });

  it('is decided by a person, never the AI', async () => {
    const list = await ask('realestate.memory', { dealId: deal });
    const yard = list.items.find((i: { words: string }) => i.words === 'A fenced yard for the dog');
    expect(yard).toMatchObject({
      status: 'suggested',
      suggestedBy: 'ai',
      quote: 'We need a fenced yard for the dog.',
    });
    expect(
      await refused(
        run('realestate.memory.decide', { itemId: yard.id, decision: 'confirm' }, 'assistant'),
      ),
    ).toBe('forbidden');
    expect(
      await run('realestate.memory.decide', {
        itemId: yard.id,
        decision: 'confirm',
        words: 'A fenced yard (dog)',
      }),
    ).toMatchObject({
      status: 'confirmed',
      waiting: 1,
    });
    const spring = list.items.find((i: { words: string }) => i.words === 'Wants to move by spring');
    expect(
      await run('realestate.memory.decide', { itemId: spring.id, decision: 'reject' }),
    ).toMatchObject({
      status: 'rejected',
      waiting: 0,
    });
    expect(
      await refused(run('realestate.memory.decide', { itemId: spring.id, decision: 'confirm' })),
    ).toBe('realestate_memory_decided');
    expect(
      await run('realestate.memory.decide', { itemId: yard.id, decision: 'retire' }),
    ).toMatchObject({
      status: 'retired',
    });
    const now = await ask('realestate.memory', { dealId: deal });
    expect(now.items.map((i: { words: string }) => i.words)).toEqual(['Big kitchen windows']);
  });
});
