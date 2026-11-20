/**
 * The texting registration's ways past a website's security (owner, 2026-11-20; http/site-check.ts): a site that shows
 * our server SiteGround's robot check on every page, as Full Spectrum's did on 20 November. The checks name the pages
 * and the fixed addresses to allow; the business's own browser reads the pages through a one-time code, only from its
 * own site; the checks then read those; and a screenshot stands in for a page that still won't open.
 */
import { randomUUID } from 'node:crypto';
import {
  createTokenVerifier,
  executeCommand,
  organizationCreate,
  policyAsText,
  privacyPolicy,
  smsConsentWords,
  termsOfService,
  type HumanActor,
  type PreflightCheck,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { standInMedia, testServices } from './helpers';

const env = testEnv();
const admin = () => testDbs().admin.db;
const SITE = 'https://guarded.test';
const NAME = 'Guarded Glow Spa';
const IPS = ['203.0.113.9'];

/** SiteGround's answer to our server, for every page (Full Spectrum, 13 and 20 Nov 2026). */
const CHECK = (path: string) =>
  `<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=${encodeURIComponent(path)}&y=ipr:203.0.113.7:1763650000.1"></meta></head></html>`;
const guarded = (path: string) => ({
  bytes: Buffer.from(CHECK(path)),
  contentType: 'text/html',
  status: 202,
});
const media = standInMedia({
  [SITE]: guarded('/'),
  [`${SITE}/`]: guarded('/'),
  [`${SITE}/privacy`]: guarded('/privacy'),
  [`${SITE}/terms`]: guarded('/terms'),
  [`${SITE}/contact`]: guarded('/contact'),
  [`${SITE}/robots.txt`]: guarded('/robots.txt'),
  [`${SITE}/sitemap.xml`]: guarded('/sitemap.xml'),
});

/** The pages as the business's browser gets them. */
const legal = { name: NAME, website: `${SITE}/`, email: 'hi@guarded.test' };
const box = smsConsentWords(NAME, 'form', `${SITE}/privacy`, `${SITE}/terms`);
const HOME = `<html><body><main><h1>${NAME}</h1><p>${`${NAME} offers red light therapy in Austin. `.repeat(10)}</p>
<a href="/contact">Contact</a> <a href="/privacy">Privacy policy</a> <a href="/terms">Terms</a></main></body></html>`;
const CONTACT = `<html><body><main><h1>Contact ${NAME}</h1><form>
<label>Mobile <input name="phone" type="tel"></label>
<label><input type="checkbox" name="texts"> ${box.title}. ${box.detail}</label>
<p><a href="${SITE}/privacy">Privacy policy</a> · <a href="${SITE}/terms">Terms</a></p>
<button type="submit">Send</button></form></main></body></html>`;
const PAGES = {
  [`${SITE}/`]: HOME,
  [`${SITE}/privacy`]: `<html><body><pre>${policyAsText(privacyPolicy(legal))}</pre></body></html>`,
  [`${SITE}/terms`]: `<html><body><pre>${policyAsText(termsOfService(legal))}</pre></body></html>`,
  [`${SITE}/contact`]: CONTACT,
};

let owner: TestUser;
let token: string;
let ws: string;
let app: FastifyInstance;

const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

const preflight = () =>
  app.inject({
    method: 'POST',
    url: '/v1/telephony/registration-preflight',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      workspaceId: ws,
      website: `${SITE}/`,
      policyUrl: `${SITE}/privacy`,
      termsUrl: `${SITE}/terms`,
      optInPath: 'own_site',
      optInUrl: `${SITE}/contact`,
      names: [NAME],
    },
  });
const checksOf = async () => {
  const res = await preflight();
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { checks: PreflightCheck[]; readerIps: string[] };
};
const byId = (checks: readonly PreflightCheck[], id: string) => checks.find((c) => c.id === id);

const start = () =>
  app.inject({
    method: 'POST',
    url: '/v1/telephony/site-check/start',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      workspaceId: ws,
      website: SITE,
      start: `${SITE}/contact`,
      urls: [`${SITE}/privacy`, `${SITE}/terms`, 'https://elsewhere.test/book'],
    },
  });
const codeOf = (open: string) => new URL(open).hash.replace('#hfos-check=', '');

beforeAll(async () => {
  owner = await createTestUser('site-check-owner');
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: NAME },
    human(owner),
    { correlationId: randomUUID(), channel: 'test' },
  );
  ws = output.workspaceId;
  token = await signInTestUser(owner);
  const ai = scriptedAi([
    {
      when: /guarded\.test\/contact\. Write the page down\.$/,
      json: () => ({ isWebPage: true, addressShown: 'guarded.test/contact', html: CONTACT }),
    },
    {
      when: /guarded\.test\/terms\. Write the page down\.$/,
      json: () => ({
        isWebPage: true,
        addressShown: 'someone-else.test/terms',
        html: '<p>Terms</p>',
      }),
    },
  ]);
  app = await buildHttpServer({
    ...testServices({ ai: { provider: ai } as never }),
    fetchUrl: media.fetchUrl,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    siteReaderIps: IPS,
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('a site whose security shows our server a robot check', () => {
  it('names every page it couldn’t look at, and the addresses to let in', async () => {
    const { checks, readerIps } = await checksOf();
    expect(readerIps).toEqual(IPS);
    for (const id of ['website', 'policy', 'terms', 'opt_in_surface']) {
      const check = byId(checks, id);
      expect(check?.ok, id).toBe(false);
      expect(check?.blocked?.[0]?.by, id).toBe('SiteGround');
      expect(check?.detail, id).toMatch(/Finish the check on my site/);
    }
  });

  it('reads the pages in the business’s own browser, from its own site only, and the checks then pass', async () => {
    const res = await start();
    expect(res.statusCode, res.body).toBe(200);
    const { open, checkId } = res.json() as { open: string; checkId: string };
    expect(open.startsWith(`${SITE}/contact#hfos-check=`)).toBe(true);
    const code = codeOf(open);

    // Only the code's hash is kept, and only the site's own pages are planned.
    const [kept] = await rows<{ token_hash: string; urls: string[] }>(
      admin(),
      sql`select token_hash, urls from app.site_checks where id = ${checkId}`,
    );
    expect(kept?.token_hash).not.toContain(code);
    expect(kept?.urls).toEqual([`${SITE}/privacy`, `${SITE}/terms`]);

    // Another site holding the code is turned away.
    const elsewhere = await app.inject({
      method: 'GET',
      url: `/public/site-check/${code}`,
      headers: { origin: 'https://evil.test' },
    });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json().error.rule).toBe('site_check_origin');

    const plan = await app.inject({
      method: 'GET',
      url: `/public/site-check/${code}`,
      headers: { origin: 'https://www.guarded.test' },
    });
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json()).toMatchObject({ site: 'guarded.test', business: NAME, most: 60 });
    expect(plan.headers['access-control-allow-origin']).toBe('https://www.guarded.test');

    const post = (pages: { url: string; html: string }[], done: boolean) =>
      app.inject({
        method: 'POST',
        url: `/public/site-check/${code}/pages`,
        headers: { origin: 'https://www.guarded.test', 'content-type': 'application/json' },
        payload: {
          pages: pages.map((p) => ({ url: p.url, finalUrl: p.url, status: 200, html: p.html })),
          done,
        },
      });
    const entries = Object.entries(PAGES).map(([url, html]) => ({ url, html }));
    // A page from somewhere else is dropped, not kept.
    const first = await post(
      [...entries.slice(0, 2), { url: 'https://evil.test/', html: HOME }],
      false,
    );
    expect(first.statusCode, first.body).toBe(200);
    const last = await post(entries.slice(2), true);
    expect(last.statusCode, last.body).toBe(200);
    expect(last.json().pages).toBe(4);
    const [stored] = await rows<{ n: number; elsewhere: number }>(
      admin(),
      sql`select count(*)::int as n, count(*) filter (where key like 'evil.test%')::int as elsewhere
          from app.site_pages where workspace_id = ${ws} and source = 'browser'`,
    );
    expect(stored).toEqual({ n: 4, elsewhere: 0 });
    // Done is done: nothing more is let in.
    const after = await post(entries.slice(0, 1), false);
    expect(after.json().error.rule).toBe('site_check_over');

    const status = await app.inject({
      method: 'POST',
      url: '/v1/telephony/site-check/status',
      headers: { authorization: `Bearer ${token}` },
      payload: { workspaceId: ws, checkId },
    });
    expect(status.json()).toMatchObject({ pages: 4, finished: true, expired: false });

    const { checks } = await checksOf();
    for (const id of ['website', 'policy', 'terms', 'opt_in_surface']) {
      const check = byId(checks, id);
      expect(check?.ok, `${id}: ${check?.detail}`).toBe(true);
      expect(check?.via, id).toBe('browser');
      expect(check?.blocked, id).toBeUndefined();
    }
  });

  it('refuses a code that’s run out, and a start for a page off the website', async () => {
    const res = await start();
    const code = codeOf((res.json() as { open: string }).open);
    await admin().execute(
      sql`update app.site_checks set expires_at = now() - interval '1 minute' where workspace_id = ${ws}`,
    );
    const plan = await app.inject({ method: 'GET', url: `/public/site-check/${code}` });
    expect(plan.statusCode).toBe(404);
    expect(plan.json().error.rule).toBe('site_check_over');

    const off = await app.inject({
      method: 'POST',
      url: '/v1/telephony/site-check/start',
      headers: { authorization: `Bearer ${token}` },
      payload: { workspaceId: ws, website: SITE, start: 'https://elsewhere.test/', urls: [] },
    });
    expect(off.statusCode).toBe(400);
    expect(off.json().error.rule).toBe('site_check_address');
  });

  it('reads a screenshot of a page that still won’t open in its place, and only one of the same site', async () => {
    // The browser's pages have gone with the new start above; only our own read is left, and it's still stopped.
    const image = (
      await sharp({
        create: { width: 800, height: 600, channels: 3, background: '#ffffff' },
      })
        .png()
        .toBuffer()
    ).toString('base64');
    const shot = (url: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/telephony/site-check/screenshot',
        headers: { authorization: `Bearer ${token}` },
        payload: { workspaceId: ws, url, images: [image] },
      });
    const wrong = await shot(`${SITE}/terms`);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.rule).toBe('screenshot_not_a_page');
    expect(wrong.json().error.message).toMatch(/shows someone-else\.test, not guarded\.test/);

    const res = await shot(`${SITE}/contact`);
    expect(res.statusCode, res.body).toBe(200);
    const [usage] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_usage where workspace_id = ${ws} and source = 'site_screenshot'`,
    );
    expect(usage?.n).toBe(2);

    const { checks } = await checksOf();
    const optIn = byId(checks, 'opt_in_surface');
    expect(optIn?.ok, optIn?.detail).toBe(true);
    expect(optIn?.via).toBe('screenshot');
    // The pages without one are still named, so nothing is skipped.
    expect(byId(checks, 'policy')?.blocked?.[0]?.by).toBe('SiteGround');
  });
});
