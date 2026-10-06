/**
 * Which business a host belongs to (`/public/site-for-host/<host>`), which the web's proxy asks on every request that
 * arrives on a business's own domain. It names the business only once the domain is proved, verified and has its
 * certificate; anything else is no business at all.
 */
import { rows, sql } from '@hfos/db/client';
import {
  as,
  asService,
  bootstrapOrganization,
  closeTestDbs,
  createTestUser,
  testDbs,
  uniq,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

let app: FastifyInstance;
let owner: TestUser;
let org: string;
let ws: string;
let site: string;
let domainId: string;
const domain = `book.bayou-${uniq()}.example`;

const whose = async (host: string) =>
  (await app.inject({ method: 'GET', url: `/public/site-for-host/${host}` })).json() as {
    site: string | null;
  };

beforeAll(async () => {
  owner = await createTestUser('site-host-owner');
  ({ orgId: org, wsId: ws } = await bootstrapOrganization(owner, 'Host Org', 'Bayou Electric'));
  site = `bayou-electric-${uniq()}`;
  // Booking off: the business's domain still serves its forms and payment links.
  const [made] = await rows<{ id: string }>(
    testDbs().admin.db,
    sql`insert into app.booking_sites (workspace_id, slug, name, enabled)
        values (${ws}, ${site}, 'Bayou Electric', false) returning id`,
  );
  // As `branded_domain.add` writes it: pending, nothing proved.
  const [added] = await as(owner)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.branded_domains (workspace_id, site_id, domain, created_by)
          values (${ws}, ${made!.id}, ${domain}, ${owner.id}) returning id`,
    ),
  );
  domainId = added!.id;
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

describe('a business’s own domain', () => {
  it('is nobody’s while it waits on DNS', async () => {
    expect(await whose(domain)).toEqual({ site: null });
  });

  it('names the business once it is proved, verified and has its certificate', async () => {
    // What the worker's domain check writes when the host answers.
    await asService({ workspaceId: ws, organizationId: org })((tx) =>
      rows(
        tx,
        sql`update app.branded_domains
            set status = 'verified', certificate_ready = true, verified_at = now(),
              ownership_proved_at = now()
            where id = ${domainId}`,
      ),
    );
    expect(await whose(domain)).toEqual({ site });
    expect(await whose(`${domain}:443`)).toEqual({ site });
  });

  it('is nobody’s for a name we don’t know, or one that isn’t a name', async () => {
    expect(await whose(`nobody-${uniq()}.example`)).toEqual({ site: null });
    expect(await whose('not%20a%20host')).toEqual({ site: null });
  });
});
