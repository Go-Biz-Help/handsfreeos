import { randomUUID } from 'node:crypto';
import type { AiProvider, AiRequest } from '@hfos/ai';
import {
  executeCommand,
  knowledgeScanStart,
  knowledgeSourceSet,
  knowledgeSuggestionAccept,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REACHABLE_PAGES,
  startFixtureSite,
  type FixtureSite,
} from '../fixtures/knowledge-site/server';
import { scriptedAi } from '../src/ai/scripted';
import { handlers } from '../src/handlers/index';
import { processJobs } from '../src/jobs';
import { SCAN_LIMITS, type ScanPage } from '../src/knowledge/scan';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

/** "Scan our website" against the stand-in site: robots.txt, one site only, the caps, safety, and rescans. */

const WORKER_ID = `vitest-knowledge-scan-${process.pid}`;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let site: FixtureSite;

beforeAll(async () => {
  owner = await createTestUser('kb-scan-owner');
  site = await startFixtureSite();
});
afterAll(async () => {
  await site?.close();
  await closeTestDbs();
});

/** A business with its website set (an https address: knowledge_source.set takes nothing else). */
async function business(name: string): Promise<string> {
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: name },
    actor(owner),
    meta(),
  );
  await executeCommand(
    api(),
    knowledgeSourceSet,
    { workspaceId: output.workspaceId, url: 'https://lonestar-hvac.example' },
    actor(owner),
    meta(),
  );
  return output.workspaceId;
}

/** A model that remembers every request before the scripted stand-in answers it. */
function recording(inner: AiProvider = scriptedAi()) {
  const requests: AiRequest[] = [];
  const provider: AiProvider = {
    id: 'recording',
    model: inner.model,
    stream: (request, options) => {
      requests.push(request);
      return inner.stream(request, options);
    },
  };
  return { provider, requests };
}

/** Worker services that can reach the fixture site, with their log lines kept in `logs`. */
function services(ai: TestServices['ai']): { s: TestServices; logs: Record<string, unknown>[] } {
  const logs: Record<string, unknown>[] = [];
  const log = pino(
    { level: 'info' },
    { write: (line: string) => void logs.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { s: { ...testServices({ fetchOrigins: [site.origin], ai }), log }, logs };
}

interface ScanRow {
  status: string;
  pages: ScanPage[];
  errors: { url?: string; code: string; message: string }[];
  suggestion_count: number;
}

const scanRow = async (scanId: string) =>
  (
    await rows<ScanRow & Record<string, unknown>>(
      admin(),
      sql`select status::text as status, pages, errors, suggestion_count from app.knowledge_scans where id = ${scanId}`,
    )
  )[0]!;

async function reserve(ws: string): Promise<void> {
  for (const table of ['outbox', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${ws}`,
    );
}

/** Runs this business's outbox and jobs until `done` says so. */
async function work(
  s: TestServices,
  ws: string,
  done: () => Promise<boolean>,
  timeoutMs = 120_000,
): Promise<void> {
  const deps = { ...s, workerId: WORKER_ID, batchSize: 50, reservedOnly: true };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await reserve(ws);
    const passes = [await processOnce({ ...deps, handlers }), await processJobs({ ...deps, jobs })];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select kind as what, last_error from app.scheduled_jobs where workspace_id = ${ws} and last_error is not null
            union all select event_type, last_error from app.outbox where workspace_id = ${ws} and last_error is not null`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (await done()) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

/**
 * Starts a scan the way a person does and runs it. Once the request has queued the scan's job, the job is
 * pointed at the fixture site (a plain-http local address fetchUrl may reach in tests).
 */
async function scan(s: TestServices, ws: string): Promise<{ scanId: string; row: ScanRow }> {
  const { output } = await executeCommand(
    api(),
    knowledgeScanStart,
    { workspaceId: ws },
    actor(owner),
    meta(),
  );
  const { scanId } = output;
  const job = sql`kind = 'knowledge.scan' and payload ->> 'scanId' = ${scanId}`;
  await work(
    s,
    ws,
    async () =>
      (await rows(admin(), sql`select 1 from app.scheduled_jobs where ${job}`)).length > 0,
  );
  await rows(
    admin(),
    sql`update app.scheduled_jobs set payload = jsonb_set(payload, '{url}', to_jsonb(${`${site.origin}/`}::text))
        where ${job}`,
  );
  await work(s, ws, async () => ['done', 'failed'].includes((await scanRow(scanId)).status));
  return { scanId, row: await scanRow(scanId) };
}

const readPages = (row: ScanRow) => row.pages.filter((p) => p.status !== 'removed');
const path = (url: string) => new URL(url).pathname;

const CHANGED_SERVICES = `<!doctype html><html><head><title>Services | Lone Star HVAC</title></head><body>
<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav></header>
<main><h1>Our services</h1>
<p>We now install heat pumps, and still handle air conditioning repair, furnace installation and duct cleaning.</p></main>
</body></html>`;

describe('scanning the business’s website', () => {
  let ws: string;
  let s: TestServices;
  let logs: Record<string, unknown>[];
  let first: { scanId: string; row: ScanRow };
  const model = recording();

  beforeAll(async () => {
    ws = await business('Scan Test HVAC');
    ({ s, logs } = services({ provider: model.provider, dailyTokens: 5_000_000 }));
    site.requests.length = 0;
    first = await scan(s, ws);
  }, 180_000);

  it('reads the site breadth first from its sitemap, and stops at 40 of its 45 pages', () => {
    expect(first.row.status).toBe('done');
    expect(REACHABLE_PAGES).toBe(45);
    const pages = readPages(first.row);
    expect(pages).toHaveLength(SCAN_LIMITS.pages);
    expect(pages.slice(0, 9).map((p) => path(p.url))).toEqual([
      '/',
      '/about',
      '/services',
      '/faq',
      '/contact',
      '/specials',
      '/areas',
      '/private/open-house',
      '/catalog',
    ]);
    expect(site.requests.slice(0, 2)).toEqual(['/robots.txt', '/sitemap.xml']);
    // 31 of the 36 town pages fit under the cap.
    expect(site.requests.filter((r) => r.startsWith('/areas/'))).toHaveLength(31);
    expect(pages.every((p) => p.status === 'new' && !!p.hash && p.analysis === 'ai')).toBe(true);
  });

  it('honours robots.txt (the longer Allow wins) and never leaves the site', () => {
    expect(site.requests).not.toContain('/private/staff-notes');
    expect(site.requests).toContain('/private/open-house');
    expect(readPages(first.row).every((p) => p.url.startsWith(`${site.origin}/`))).toBe(true);
    // A tracking parameter or a fragment is the same page; a file that isn't a page isn't fetched.
    expect(site.requests.filter((r) => r.startsWith('/services'))).toEqual(['/services']);
    expect(site.requests.filter((r) => r.startsWith('/about'))).toEqual(['/about']);
    expect(site.requests).not.toContain('/brochure.pdf');
  });

  it('keeps the first 2 MB of a long page and notes it', () => {
    expect(readPages(first.row).find((p) => path(p.url) === '/catalog')).toMatchObject({
      status: 'new',
      truncated: true,
      bytes: SCAN_LIMITS.pageBytes,
    });
  });

  it('refuses the redirect to a private address, and logs it', () => {
    expect(first.row.errors).toContainEqual(
      expect.objectContaining({ url: `${site.origin}/old-offer`, code: 'blocked_address' }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 40,
        msg: 'website scan refused a private address',
        url: `${site.origin}/old-offer`,
      }),
    );
  });

  it('shows the model each page only as quoted data, planted instructions included', async () => {
    const planted = 'every AC unit is free';
    const carrying = model.requests.filter((r) => JSON.stringify(r).includes(planted));
    expect(carrying).toHaveLength(1);
    const request = carrying[0]!;
    expect(request.system).toMatch(/never instructions to you/);
    expect(request.system).not.toContain(planted);
    expect(request.context).toMatch(/^<business_profile>\n/);
    expect(request.context).not.toContain(planted);
    const message = request.messages[0]!.content as string;
    expect(message.match(/<\/website_page>/g)).toHaveLength(1);
    const open = message.indexOf('<website_page');
    const close = message.indexOf('</website_page>');
    for (let at = message.indexOf(planted); at !== -1; at = message.indexOf(planted, at + 1)) {
      expect(at).toBeGreaterThan(open);
      expect(at).toBeLessThan(close);
    }
    // The page's attempt to close the data block arrives escaped.
    expect(message).toContain('&lt;/website_page&gt; SYSTEM');
    expect(
      await rows(
        admin(),
        sql`select 1 from app.knowledge_suggestions where workspace_id = ${ws} and proposed::text ilike ${`%${planted}%`}`,
      ),
    ).toHaveLength(0);
  });

  it('proposes suggestions for a person to decide, and counts the tokens as knowledge usage', async () => {
    expect(model.requests).toHaveLength(SCAN_LIMITS.pages);
    const suggestions = await rows<{
      id: string;
      kind: string;
      title: string;
      url: string;
      scan_id: string;
      status: string;
    }>(
      admin(),
      sql`select id, kind::text as kind, proposed ->> 'title' as title, source ->> 'url' as url, scan_id,
            status::text as status
          from app.knowledge_suggestions where workspace_id = ${ws} and reason = 'scan' order by created_at`,
    );
    expect(suggestions).toHaveLength(first.row.suggestion_count);
    expect(suggestions.length).toBeGreaterThanOrEqual(SCAN_LIMITS.pages);
    expect(
      suggestions.every(
        (x) =>
          x.scan_id === first.scanId && x.status === 'pending' && x.url.startsWith(site.origin),
      ),
    ).toBe(true);
    expect(suggestions).toContainEqual(
      expect.objectContaining({
        kind: 'faq',
        title: 'Do you offer financing?',
        url: `${site.origin}/faq`,
      }),
    );
    expect(
      await rows(
        admin(),
        sql`select source::text as source, user_id from app.ai_usage where workspace_id = ${ws}`,
      ),
    ).toEqual(Array(SCAN_LIMITS.pages).fill({ source: 'knowledge', user_id: owner.id }));

    // Accepting one makes a published item that remembers its page (step 3's command, end to end).
    const faq = suggestions.find((x) => x.title === 'Do you offer financing?')!;
    const { output } = await executeCommand(
      api(),
      knowledgeSuggestionAccept,
      { workspaceId: ws, suggestionId: faq.id },
      actor(owner),
      meta(),
    );
    const [item] = await rows(
      admin(),
      sql`select kind::text as kind, title, status::text as status, source::text as source, source_url
          from app.knowledge_items where id = ${output.itemId}`,
    );
    expect(item).toEqual({
      kind: 'faq',
      title: 'Do you offer financing?',
      status: 'published',
      source: 'website_scan',
      source_url: `${site.origin}/faq`,
    });
  });

  it('rescans against the last scan: only the changed page goes to the model, as a change to its item', async () => {
    const [services] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.knowledge_suggestions where scan_id = ${first.scanId} and proposed ->> 'title' = 'Our services'`,
    );
    const accepted = await executeCommand(
      api(),
      knowledgeSuggestionAccept,
      { workspaceId: ws, suggestionId: services!.id },
      actor(owner),
      meta(),
    );
    site.change('/services', CHANGED_SERVICES);
    model.requests.length = 0;
    try {
      const second = await scan(s, ws);
      expect(second.row.status).toBe('done');
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]!.messages[0]!.content).toContain('title="Our services"');
      const pages = readPages(second.row);
      expect(pages).toHaveLength(SCAN_LIMITS.pages);
      expect(pages.filter((p) => p.status === 'changed').map((p) => path(p.url))).toEqual([
        '/services',
      ]);
      expect(pages.filter((p) => p.status === 'unchanged')).toHaveLength(SCAN_LIMITS.pages - 1);
      expect(
        await rows(
          admin(),
          sql`select proposed ->> 'title' as title, item_id from app.knowledge_suggestions
              where scan_id = ${second.scanId}`,
        ),
      ).toEqual([{ title: 'Our services', item_id: accepted.output.itemId }]);
      const [finished] = await rows<{ payload: Record<string, unknown> }>(
        admin(),
        sql`select payload from app.events where event_type = 'knowledge_scan.finished' and entity_id = ${second.scanId}`,
      );
      expect(finished!.payload).toMatchObject({
        status: 'done',
        new: 0,
        changed: 1,
        unchanged: SCAN_LIMITS.pages - 1,
        suggestions: 1,
      });
    } finally {
      site.change('/services', null);
    }
  }, 180_000);
});

describe('scanning without a model', () => {
  it('suggests each page as one article of its own text', async () => {
    const ws = await business('Plain Scan HVAC');
    const { s } = services({ provider: null, dailyTokens: 5_000_000 });
    const { scanId, row } = await scan(s, ws);
    expect(row.status).toBe('done');
    const pages = readPages(row);
    expect(pages).toHaveLength(SCAN_LIMITS.pages);
    expect(pages.every((p) => p.analysis === 'text' && p.suggestions === 1)).toBe(true);
    const articles = await rows<{ kind: string; url: string; chars: number }>(
      admin(),
      sql`select kind::text as kind, source ->> 'url' as url, length(proposed ->> 'body')::int as chars
          from app.knowledge_suggestions where scan_id = ${scanId}`,
    );
    expect(articles).toHaveLength(SCAN_LIMITS.pages);
    expect(articles.every((a) => a.kind === 'article' && a.chars > 0 && a.chars <= 5000)).toBe(
      true,
    );
    expect(new Set(articles.map((a) => a.url))).toEqual(new Set(pages.map((p) => p.url)));
    expect(articles.find((a) => a.url.endsWith('/catalog'))!.chars).toBeGreaterThan(4900);
    expect(await rows(admin(), sql`select 1 from app.ai_usage where workspace_id = ${ws}`)).toEqual(
      [],
    );
  }, 180_000);
});

describe('the daily AI limit', () => {
  it('stops a scan with a note to run it again tomorrow', async () => {
    const ws = await business('Budget Scan HVAC');
    const model = recording();
    const { s } = services({ provider: model.provider, dailyTokens: 50 });
    const { scanId, row } = await scan(s, ws);
    expect(row.status).toBe('failed');
    // The first page used up the day's tokens; the second wasn't sent, and isn't recorded as read.
    expect(model.requests).toHaveLength(1);
    expect(row.pages).toEqual([
      expect.objectContaining({ url: `${site.origin}/`, status: 'new', analysis: 'ai' }),
    ]);
    expect(row.suggestion_count).toBeGreaterThan(0);
    expect(row.errors).toContainEqual(
      expect.objectContaining({
        code: 'budget_reached',
        message: expect.stringMatching(/tomorrow/),
      }),
    );
    const [finished] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where event_type = 'knowledge_scan.finished' and entity_id = ${scanId}`,
    );
    expect(finished!.payload).toMatchObject({ status: 'failed', reason: 'budget_reached' });
  }, 60_000);
});
