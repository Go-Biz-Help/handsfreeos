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
let ws: string;

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
  ws = await realestateBusiness(owner, 'Addon Public Realty');
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

describe('a listing’s page through the door', () => {
  let photo: string;

  beforeAll(async () => {
    const admin = testDbs().admin.db;
    const [deal] = await rows<{ id: string }>(
      admin,
      sql`insert into app.custom_records (workspace_id, type_id, name, created_by, owner_user_id)
          select ${ws}, t.id, 'Alvarez listing', ${owner.id}, ${owner.id} from app.custom_record_types t
          where t.workspace_id = ${ws} and t.key = 'realestate_deal' returning id`,
    );
    const dealId = deal!.id;
    await rows(
      admin,
      sql`insert into addon_realestate.deals (workspace_id, record_id, side, stage)
          values (${ws}, ${dealId}, 'listing', 'active')`,
    );
    const [home] = await rows<{ id: string }>(
      admin,
      sql`insert into app.custom_records (workspace_id, type_id, name, created_by)
          select ${ws}, t.id, '2207 Juniper Trail, Austin, TX 78745', ${owner.id} from app.custom_record_types t
          where t.workspace_id = ${ws} and t.key = 'realestate_property' returning id`,
    );
    await rows(
      admin,
      sql`insert into app.relationships (workspace_id, type_id, a_custom_record_id, b_custom_record_id)
          select ${ws}, t.id, ${dealId}, ${home!.id} from app.relationship_types t
          where t.workspace_id = ${ws} and t.addon_key = 'realestate_property_of'`,
    );
    await rows(
      admin,
      sql`insert into addon_realestate.listings (workspace_id, deal_record_id, facts, facts_confirmed_at,
            mls_number, mls_live_on, slug, page_state, page_published_at)
          values (${ws}, ${dealId}, '{"beds": 4, "baths": 3}'::jsonb, now(), '4821937', current_date,
            '2207-juniper-trail', 'published', now())`,
    );
    await rows(
      admin,
      sql`insert into addon_realestate.listing_descriptions (workspace_id, deal_record_id, version, words, source,
            state, signed_at)
          values (${ws}, ${dealId}, 1, 'Welcome to 2207 Juniper Trail.', 'person', 'signed', now())`,
    );
    // A photo whose file was never stored: the page still opens, without a link for it.
    const [f] = await rows<{ id: string }>(
      admin,
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, status)
          values (${ws}, 'custom_record', ${dealId}, ${`${ws}/missing/front.jpg`}, 'front.jpg', 'image/jpeg',
            'ready') returning id`,
    );
    photo = f!.id;
    await rows(
      admin,
      sql`insert into addon_realestate.listing_photos (workspace_id, deal_record_id, file_id, position)
          values (${ws}, ${dealId}, ${photo}, 0)`,
    );
  });

  it('answers the page with the business’s name, and a photo it can’t sign has no link', async () => {
    const res = await post(`/public/addon/${site}/query/realestate.public.listing`, {
      input: { slug: '2207-juniper-trail' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { result: Record<string, unknown>; business: { name: string } };
    expect(body.business.name).toBe('Addon Public Realty');
    expect(body.result).toMatchObject({
      street: '2207 Juniper Trail',
      status: 'for_sale',
      description: 'Welcome to 2207 Juniper Trail.',
      photos: [{ publicFileId: photo, caption: null, url: null }],
    });
  });

  it('takes a question through the change door, and refuses one the page’s honeypot caught', async () => {
    const input = {
      slug: '2207-juniper-trail',
      firstName: 'Kayla',
      email: 'kayla.b@example.com',
      question: 'Is the garage wired for a car charger?',
    };
    const caught = await post(`/public/addon/${site}/command/realestate.public.ask`, {
      input,
      website: 'http://spam.example',
    });
    expect(caught.statusCode).toBe(400);
    const res = await post(`/public/addon/${site}/command/realestate.public.ask`, { input });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { result: unknown }).result).toEqual({ sent: true });
    // A look-up's name is no change, and a change's name is no look-up.
    expect(
      (await post(`/public/addon/${site}/command/realestate.public.listing`, { input })).statusCode,
    ).toBe(404);
  });
});
