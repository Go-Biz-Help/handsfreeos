/**
 * The founding offers' two signed-out doors (0091), through the real HTTP server and the real database login.
 *
 * These exist because both routes shipped reading the database as `hfos_worker` itself — a login with no
 * rights of its own, which only ever works through `service_actor` — and so answered 500 in production from
 * the moment they were deployed: the website printed no counter and the application form turned everybody
 * away. Nothing had exercised them as the worker actually connects.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

const OFFER = 'test_routes_offer';
const admin = () => testDbs().admin.db;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildHttpServer({
    ...testServices(),
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
});
afterAll(async () => {
  await admin().execute(sql`delete from platform.founding_applications where offer_id = ${OFFER}`);
  await admin().execute(sql`delete from platform.founding_offers where id = ${OFFER}`);
  await app?.close();
  await closeTestDbs();
});

beforeEach(async () => {
  await admin().execute(sql`delete from platform.founding_applications where offer_id = ${OFFER}`);
  await admin().execute(sql`delete from platform.founding_offers where id = ${OFFER}`);
  await admin().execute(
    sql`insert into platform.founding_offers (id, name, seat_cap, price_cents, status, show_counter, sort)
        values (${OFFER}, 'Route test', 3, 0, 'open', true, 99)`,
  );
});

const apply = (
  fields: Record<string, string>,
  ip = `203.0.113.${Math.floor(Math.random() * 200)}`,
) =>
  app.inject({
    method: 'POST',
    url: '/public/founding/apply',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    payload: JSON.stringify(fields),
  });

describe('GET /public/founding/counts', () => {
  it('answers with every open offer and its numbers', async () => {
    const res = await app.inject({ method: 'GET', url: '/public/founding/counts' });
    expect(res.statusCode).toBe(200);
    const offer = (res.json() as { offers: { offerId: string }[] }).offers.find(
      (o) => o.offerId === OFFER,
    );
    expect(offer).toMatchObject({ offerId: OFFER, seatCap: 3, claimed: 0, remaining: 3 });
  });
});

describe('POST /public/founding/apply', () => {
  const form = () => ({
    offerId: OFFER,
    businessName: 'Route Test Plumbing',
    contactName: 'Dana',
    email: `${randomUUID()}@hfos.test`,
    note: 'We answer every call ourselves and miss half of them.',
  });

  it('takes an application, and answers the same way when it is sent twice', async () => {
    const fields = form();
    const first = await apply(fields);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'pending', offerId: OFFER });
    const again = await apply(fields);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ applicationId: first.json().applicationId });

    const stored = await rows<{ n: number | string }>(
      admin(),
      sql`select count(*) as n from platform.founding_applications where offer_id = ${OFFER}`,
    );
    expect(Number(stored[0]!.n)).toBe(1);
  });

  it('takes the website form as it posts, with the hidden field left empty', async () => {
    const res = await apply({
      ...form(),
      company_website_url: '',
      source: 'https://handsfreeos.com/',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'pending', offerId: OFFER });
  });

  it('drops a crawler that fills in the hidden field', async () => {
    const res = await apply({ ...form(), company_website_url: 'https://spam.example' });
    expect(res.statusCode).toBe(200);
    const stored = await rows<{ n: number | string }>(
      admin(),
      sql`select count(*) as n from platform.founding_applications where offer_id = ${OFFER}`,
    );
    expect(Number(stored[0]!.n)).toBe(0);
  });
});
