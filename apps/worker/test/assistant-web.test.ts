/**
 * search_web (the owner, 25 Nov 2026: "look things up for me"): the Assistant looks something up with the AI's own web
 * search, near the business unless told otherwise, and gives what it found with each page; each search is charged.
 * The backup AI has no search, so it says nothing was looked up rather than answering from memory. Every business,
 * store and page here is made up.
 */
import { randomUUID } from 'node:crypto';
import type { AiProvider, AiRequest, AiTurn } from '@hfos/ai';
import { assistantToolByName } from '@hfos/core/server';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { rows, sql } from '@hfos/db/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/assistant/runtime';
import { createToolExecutor } from '../src/assistant/tools-write';
import { admin, makeWorld, type World } from './booking-world';

let w: World;

beforeAll(async () => {
  w = await makeWorld('web');
  await rows(
    admin(),
    sql`update app.workspaces
        set settings = settings || ${JSON.stringify({
          address: {
            line1: '12 Oak St',
            city: 'Katy',
            state: 'TX',
            postalCode: '77494',
            country: 'US',
          },
        })}::jsonb
        where id = ${w.workspaceId}`,
  );
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

const ctx = (): ToolContext => ({
  actor: { type: 'human', userId: w.owner.id, email: w.owner.email, claims: w.owner.claims },
  workspaceId: w.workspaceId,
  organizationId: w.organizationId,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
});

const turn = (over: Partial<AiTurn>): AiTurn => ({
  text: '',
  toolCalls: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'searching',
  ...over,
});

/** A model that searches the web: what it was asked, and the answer it gives. */
function searching(answer: AiTurn) {
  const asked: AiRequest[] = [];
  const provider: AiProvider = {
    id: 'searching',
    model: 'searching',
    stream: async (request) => {
      asked.push(request);
      return answer;
    },
  };
  return { provider, asked };
}

const run = (provider: AiProvider, args: Record<string, unknown>) =>
  createToolExecutor(testDbs().worker.db, null, null, '', undefined, {
    services: { ...w.s, ai: { provider } },
  }).run(assistantToolByName.get('search_web')!, args, ctx());

const searches = async () =>
  (
    await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.usage_ledger
          where workspace_id = ${w.workspaceId} and rate_key = 'ai.web_search'`,
    )
  )[0]!.n;

describe('search_web', () => {
  it('looks it up near the business and gives each fact with its page', async () => {
    const { provider, asked } = searching(
      turn({
        text: 'Katy Plumbing Supply, (281) 555-0142, open Saturday 7 AM to noon.',
        citedText: 'Katy Plumbing Supply, (281) 555-0142, open Saturday 7 AM to noon. [1]',
        webSources: [
          { url: 'https://katyplumbingsupply.example/hours', title: 'Hours', age: null },
        ],
        webSearches: 2,
      }),
    );
    const before = await searches();
    const out = await run(provider, { question: 'plumbing supply stores open Saturday' });
    expect(out.isError).toBeFalsy();
    expect(out.result).toMatchObject({
      found: true,
      near: 'Katy, TX 77494',
      answer: 'Katy Plumbing Supply, (281) 555-0142, open Saturday 7 AM to noon. [1]',
      pages: [{ n: 1, title: 'Hours', link: 'https://katyplumbingsupply.example/hours' }],
      searches: 2,
    });
    expect(asked[0]!.webSearch).toEqual({ maxUses: 3 });
    expect(asked[0]!.messages[0]!.content).toContain('Where: near Katy, TX 77494.');
    // Each search is on the statement.
    expect(await searches()).toBeGreaterThan(before);
  });

  it('looks where they say instead', async () => {
    const { provider, asked } = searching(
      turn({
        text: 'Found it.',
        webSources: [{ url: 'https://example.org/a', title: 'A', age: null }],
        webSearches: 1,
      }),
    );
    await run(provider, { question: 'roofing supply', near: 'Austin, TX' });
    expect(asked[0]!.messages[0]!.content).toContain('Where: near Austin, TX.');
  });

  it('says nothing was looked up when the AI answering has no web search', async () => {
    const { provider } = searching(turn({ text: 'From memory, try Home Depot.' }));
    const out = await run(provider, { question: 'plumbing supply stores open Saturday' });
    expect(out.result).toMatchObject({ found: false });
    expect(JSON.stringify(out.result)).toContain('Don’t answer from memory');
  });
});
