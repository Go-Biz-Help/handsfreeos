import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  knowledgeSourceSet,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../fixtures/knowledge-site/server';
import { READ_SITE_JOB } from '../src/ai-setup/read-site';
import { buildHttpServer } from '../src/http/server';
import { jobs } from '../src/scheduled';
import { testServices } from './helpers';

/**
 * Playwright's POST /test/knowledge/scan-at: a website scan of the local fixture site in place of the
 * business's (https-only) website, only for FETCH_TEST_ORIGINS, then read by run-due. And POST
 * /test/ai-setup/read-at, which has quick setup read it the same way.
 */

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
let app: FastifyInstance;

beforeAll(async () => {
  owner = await createTestUser('kb-scan-at-owner');
  site = await startFixtureSite();
  const s = testServices({ fetchOrigins: [site.origin] });
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
    testRoutes: { jobs, fetchTestOrigins: [site.origin] },
  });
});
afterAll(async () => {
  await app?.close();
  await site?.close();
  await closeTestDbs();
});

/** A business, with its website set unless `website` is false. */
async function business(name: string, website = true): Promise<string> {
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: name },
    actor(owner),
    meta(),
  );
  if (website)
    await executeCommand(
      api(),
      knowledgeSourceSet,
      { workspaceId: output.workspaceId, url: 'https://lonestar-hvac.example' },
      actor(owner),
      meta(),
    );
  return output.workspaceId;
}

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, payload });

const scanOf = async (scanId: string) =>
  (
    await rows<{ status: string; pages: { url: string }[] }>(
      admin(),
      sql`select status::text as status, pages from app.knowledge_scans where id = ${scanId}`,
    )
  )[0]!;

describe('POST /test/knowledge/scan-at', () => {
  it('scans the fixture site in place of the website, and run-due reads it', async () => {
    const ws = await business('Scan At HVAC');
    const res = await post('/test/knowledge/scan-at', { workspaceId: ws, url: site.origin });
    expect(res.statusCode, res.body).toBe(200);
    const { scanId, url } = res.json() as { scanId: string; url: string };
    expect(url).toBe(`${site.origin}/`);
    const [job] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.scheduled_jobs where dedupe_key = ${`knowledge.scan:${scanId}`}`,
    );
    expect(job!.payload).toMatchObject({ scanId, url });

    // One scan at a time.
    const again = await post('/test/knowledge/scan-at', { workspaceId: ws, url: site.origin });
    expect(again.statusCode).toBe(409);

    for (
      let pass = 0;
      pass < 10 && ['queued', 'running'].includes((await scanOf(scanId)).status);
      pass++
    ) {
      const ran = await post('/test/scheduled-jobs/run-due', { workspaceId: ws });
      expect(ran.statusCode, ran.body).toBe(200);
    }
    const scan = await scanOf(scanId);
    expect(scan.status).toBe('done');
    expect(site.requests).toContain('/robots.txt');
    expect(scan.pages.map((p) => p.url)).toContain(`${site.origin}/faq`);
  });

  it('refuses an address that isn’t a test site, and a business without a website', async () => {
    const ws = await business('Scan At Elsewhere');
    const elsewhere = await post('/test/knowledge/scan-at', {
      workspaceId: ws,
      url: 'https://example.com',
    });
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json()).toMatchObject({ error: { rule: 'not_a_test_origin' } });

    const bare = await business('Scan At Bare', false);
    const noSite = await post('/test/knowledge/scan-at', { workspaceId: bare, url: site.origin });
    expect(noSite.statusCode).toBe(409);
  });
});

describe('POST /test/ai-setup/read-at', () => {
  it('has quick setup read the fixture site for the saved website, and refuses anything else', async () => {
    const ws = await business('Read At HVAC');
    const res = await post('/test/ai-setup/read-at', { workspaceId: ws, url: site.origin });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ url: `${site.origin}/` });
    const [job] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${READ_SITE_JOB} and status = 'pending'`,
    );
    expect(job!.payload).toMatchObject({
      website: 'https://lonestar-hvac.example/',
      url: `${site.origin}/`,
    });

    const elsewhere = await post('/test/ai-setup/read-at', {
      workspaceId: ws,
      url: 'https://example.com',
    });
    expect(elsewhere.json()).toMatchObject({ error: { rule: 'not_a_test_origin' } });
    const bare = await business('Read At Bare', false);
    expect(
      (await post('/test/ai-setup/read-at', { workspaceId: bare, url: site.origin })).statusCode,
    ).toBe(409);
  });
});
