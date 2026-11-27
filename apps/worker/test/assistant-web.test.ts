/**
 * search_web (the owner, 25 Nov 2026: "look things up for me"): the Assistant looks something up with the AI's own web
 * search, near the business unless told otherwise, and gives what it found with each page; each search is charged.
 * The backup AI has no search, so it says nothing was looked up rather than answering from memory. Every business,
 * store and page here is made up.
 *
 * read_website_brand_kit: the brand kit's Match my website, read from a stand-in site on a local port, keeping nothing.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AiProvider, AiRequest, AiTurn } from '@hfos/ai';
import { assistantToolByName } from '@hfos/core/server';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { rows, sql } from '@hfos/db/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/assistant/runtime';
import { createToolExecutor } from '../src/assistant/tools-write';
import { admin, makeWorld, type World } from './booking-world';
import { testServices } from './helpers';

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

describe('read_website_brand_kit', () => {
  /** A page the way GoDaddy's builder writes one: orange buttons, Lato, slightly round. */
  const PAGE = `<!doctype html><html><head>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap">
    <style>
      .x{font-family:'Lato', arial, sans-serif;color:rgb(27, 27, 27);background-color:rgb(255, 255, 255)}
      .c1-a{background-color:rgb(232, 93, 4)} .c1-b{color:rgb(255, 255, 255)} .c1-c{border-radius:4px}
    </style></head>
    <body class="x"><a data-ux="ButtonPrimary" class="c1-a c1-b c1-c" href="/quote">Get a quote</a>
    <p>We install solar panels.</p></body></html>`;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(PAGE);
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  const read = (args: Record<string, unknown>, withServices = true) =>
    createToolExecutor(
      testDbs().worker.db,
      null,
      null,
      '',
      undefined,
      withServices
        ? { services: { ...w.s, fetchUrl: testServices({ fetchOrigins: [origin] }).fetchUrl } }
        : null,
    ).run(assistantToolByName.get('read_website_brand_kit')!, args, ctx());
  const website = (url: string | null) =>
    rows(
      admin(),
      sql`update app.workspaces set settings = settings || ${JSON.stringify({ website: url })}::jsonb
          where id = ${w.workspaceId}`,
    );
  const lookNow = async () =>
    (
      await rows<{ look: unknown }>(
        admin(),
        sql`select settings -> 'look' as look from app.workspaces where id = ${w.workspaceId}`,
      )
    )[0]!.look;

  it('reads the business’s own website’s colour, font and corners, and keeps nothing', async () => {
    await website(`${origin}/`);
    const before = await lookNow();
    const out = await read({});
    expect(out.result).toMatchObject({
      site: `${origin}/`,
      color: '#e85d04',
      font: 'Lato',
      corners: 'slight',
      fontNote: null,
    });
    expect(JSON.stringify(out.result)).toContain('do_look_set');
    expect(await lookNow()).toEqual(before);
  });

  it('asks for the address when the business has no website', async () => {
    await website(null);
    await expect(read({})).rejects.toMatchObject({ rule: 'website_missing' });
  });

  it('says where to do it instead when websites can’t be read from here', async () => {
    await expect(read({ site: 'acme.com' }, false)).rejects.toMatchObject({
      rule: 'website_unreadable',
    });
  });
});
