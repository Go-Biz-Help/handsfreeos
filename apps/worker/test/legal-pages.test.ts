/**
 * The privacy policy and terms we host for a business (`/public/legal/<site>/<kind>`), which the web's /legal pages
 * show and a carrier's reviewer opens. They open as soon as the business has a public name, before a registration
 * has gone and while the booking page is still off, since the registration's own review opens them first.
 */
import { rows, sql } from '@hfos/db/client';
import {
  bootstrapOrganization,
  closeTestDbs,
  createTestUser,
  testDbs,
  uniq,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

let app: FastifyInstance;
let ws: string;
let site: string;

const get = (url: string) => app.inject({ method: 'GET', url });

beforeAll(async () => {
  const owner = await createTestUser('legal-owner');
  ({ wsId: ws } = await bootstrapOrganization(owner, 'Legal Org', 'Bayou Electric'));
  site = `bayou-electric-${uniq()}`;
  // Named by the agreement box's form, and not open for booking yet.
  await rows(
    testDbs().admin.db,
    sql`insert into app.booking_sites (workspace_id, slug, name, enabled)
        values (${ws}, ${site}, 'Bayou Electric', false)`,
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

describe('the pages we write', () => {
  it('open before any registration has gone, on a booking page that is off', async () => {
    const privacy = await get(`/public/legal/${site}/privacy`);
    expect(privacy.statusCode, privacy.body).toBe(200);
    expect(privacy.json().policy.title).toBe('Bayou Electric — Privacy Policy');
    expect(privacy.headers['cache-control']).toContain('max-age=60');

    const terms = await get(`/public/legal/${site}/terms`);
    expect(terms.statusCode, terms.body).toBe(200);
    expect(terms.json().policy.title).toBe('Bayou Electric — Terms of Service');
  });

  it('follow the answers being got ready, before anything has gone', async () => {
    await rows(
      testDbs().admin.db,
      sql`insert into app.registration_drafts (workspace_id, answers)
          values (${ws}, ${JSON.stringify({
            form: {
              legalName: 'Bayou Electric LLC',
              policyEmail: 'hello@bayou.example',
              policyPhone: '(504) 555-0144',
              ownPolicyUrl: '',
              ownTermsUrl: 'bayou.example/terms',
            },
            at: new Date().toISOString(),
          })}::jsonb)`,
    );
    // Ours, with the way to reach them the wizard asked for under Contact us.
    const privacy = (await get(`/public/legal/${site}/privacy`)).json();
    const contact = privacy.policy.sections.find(
      (s: { heading: string }) => s.heading === 'Contact us',
    );
    expect(contact.paragraphs[0]).toContain('Bayou Electric LLC');
    expect(contact.paragraphs[0]).toContain('hello@bayou.example');
    expect(contact.paragraphs[0]).toContain('(504) 555-0144');
    // Theirs, as soon as they've said where it is.
    expect((await get(`/public/legal/${site}/terms`)).json()).toEqual({
      redirectTo: 'https://bayou.example/terms',
    });
  });

  it('send each kind on to the business’s own, once a registration names them', async () => {
    await rows(
      testDbs().admin.db,
      sql`insert into app.telephony_registrations (workspace_id, kind, status, submission, submitted_at)
          values (${ws}, 'a2p_campaign', 'submitted', ${JSON.stringify({
            policyUrl: 'https://bayou.example/privacy',
            termsUrl: 'https://bayou.example/terms',
          })}::jsonb, now())`,
    );
    expect((await get(`/public/legal/${site}/privacy`)).json()).toEqual({
      redirectTo: 'https://bayou.example/privacy',
    });
    expect((await get(`/public/legal/${site}/terms`)).json()).toEqual({
      redirectTo: 'https://bayou.example/terms',
    });
  });

  it('have no page for a name that isn’t a business, or a kind that isn’t one', async () => {
    expect((await get(`/public/legal/no-such-business-${uniq()}/privacy`)).statusCode).toBe(404);
    expect((await get(`/public/legal/${site}/cookies`)).statusCode).toBe(404);
    expect((await get('/public/legal/Bad%20Name/privacy')).statusCode).toBe(404);
  });
});
