/**
 * Add-ons' public pages through the worker (Real Estate round three, step 1): the one door for a look-up and one for a
 * change, by the business's booking site name. Only an add-on's operations made for public pages go through it; any
 * other name, and any site that isn't one, is the same "no page here".
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

let owner: TestUser;
let app: FastifyInstance;
let site: string;

const errorOf = (res: LightMyRequestResponse) =>
  (res.json() as { error: { code: string; rule?: string; message: string } }).error;

const post = (url: string, body: unknown = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'x-forwarded-for': '203.0.113.71', 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

beforeAll(async () => {
  owner = await createTestUser('addon-public-owner', { fullName: 'Dana Reyes' });
  const ws = await realestateBusiness(owner, 'Addon Public Realty');
  site = `addon-public-${ws.slice(0, 8)}`;
  await rows(
    testDbs().admin.db,
    sql`insert into app.booking_sites (workspace_id, slug, name, enabled)
        values (${ws}, ${site}, 'Addon Public Realty', false)
        on conflict (workspace_id) do update set slug = excluded.slug`,
  );
  app = await buildHttpServer({
    ...testServices(),
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('the public door', () => {
  it('has no page for anything not made for public pages', async () => {
    for (const url of [
      `/public/addon/${site}/query/person.list`,
      `/public/addon/${site}/command/person.create`,
      `/public/addon/${site}/query/realestate.deals`,
      `/public/addon/${site}/query/nothing.at_all`,
      // Core's own portal look-up is for a signed-in customer, not a visitor.
      `/public/addon/${site}/query/portal.home`,
    ]) {
      const res = await post(url, { input: {} });
      expect(res.statusCode, url).toBe(404);
      expect(errorOf(res).message).toContain('There’s no page at this address');
    }
  });

  it('answers no-store, and a site that isn’t one is the same no page', async () => {
    const res = await post('/public/addon/no-such-site-here/query/realestate.public.listing', {
      input: { slug: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await post('/public/addon/Bad%20Site/query/x', {})).statusCode).toBe(404);
  });
});
