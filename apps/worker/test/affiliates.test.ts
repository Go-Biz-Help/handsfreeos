/**
 * The affiliate program's worker half (20261027014000): the website's click counter, through the real HTTP server
 * and the worker's real login, and the emails its events send.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  onAffiliateApplied,
  onAffiliateApproved,
  onAffiliateTurnedDown,
} from '../src/handlers/affiliates';
import type { HandlerContext } from '../src/handlers/types';
import { buildHttpServer } from '../src/http/server';
import type { MailMessage } from '../src/mailer';
import { testServices } from './helpers';

const admin = () => testDbs().admin.db;
let app: FastifyInstance;
let seller: TestUser;
let staff: TestUser;
let affiliateId: string;
const code = `wk-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  app = await buildHttpServer({
    ...testServices(),
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
  [seller, staff] = await Promise.all([
    createTestUser('affiliate-worker-seller', { fullName: 'Sam Seller' }),
    createTestUser('affiliate-worker-staff', { fullName: 'Chris Staff' }),
  ]);
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
  const [row] = await rows<{ id: string }>(
    admin(),
    sql`insert into platform.affiliates (user_id, code, name, pitch, links)
        values (${seller.id}, ${code}, 'Sam Seller', 'My newsletter', 'https://sam.example')
        returning id`,
  );
  affiliateId = row!.id;
});

afterAll(async () => {
  await admin().execute(sql`delete from platform.affiliates where id = ${affiliateId}`);
  await app?.close();
  await closeTestDbs();
});

const setStatus = (status: string) =>
  admin().execute(sql`update platform.affiliates set status = ${status} where id = ${affiliateId}`);

const click = (c: string) =>
  app.inject({
    method: 'POST',
    url: '/public/affiliates/click',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ code: c }),
  });

const clicks = async () =>
  Number(
    (
      await rows<{ n: number | string | null }>(
        admin(),
        sql`select sum(clicks) as n from platform.affiliate_clicks where affiliate_id = ${affiliateId}`,
      )
    )[0]?.n ?? 0,
  );

describe('POST /public/affiliates/click', () => {
  beforeEach(() =>
    admin().execute(sql`delete from platform.affiliate_clicks where affiliate_id = ${affiliateId}`),
  );

  it('counts an approved affiliate’s click, and answers the same for any code', async () => {
    await setStatus('applied');
    expect((await click(code)).json()).toEqual({ ok: true });
    expect(await clicks()).toBe(0);
    await setStatus('approved');
    expect((await click(code.toUpperCase())).statusCode).toBe(200);
    expect((await click('nobody-at-all')).json()).toEqual({ ok: true });
    expect(await clicks()).toBe(1);
  });

  it('refuses a body that isn’t a code', async () => {
    expect((await click('')).statusCode).toBe(400);
  });
});

describe('the emails', () => {
  const sent: MailMessage[] = [];
  const ctx = (payload: Record<string, unknown>): HandlerContext =>
    ({
      ...testServices(),
      mailer: {
        async send(m: MailMessage) {
          sent.push(m);
          return { messageId: randomUUID() };
        },
      },
      event: { payload },
      scope: {},
      attempt: 1,
      maxAttempts: 5,
    }) as unknown as HandlerContext;

  beforeEach(() => {
    sent.length = 0;
  });

  it('tells the staff who run the program about a new application, not about a change to one', async () => {
    await setStatus('applied');
    await onAffiliateApplied(ctx({ affiliateId, created: false, reapplied: false }));
    expect(sent).toEqual([]);
    await onAffiliateApplied(ctx({ affiliateId, created: true, reapplied: false }));
    const toStaff = sent.find((m) => m.to === staff.email);
    expect(toStaff?.subject).toBe('New affiliate application: Sam Seller');
    expect(toStaff?.text).toContain('My newsletter');
    expect(toStaff?.text).toContain('http://localhost:3000/admin/affiliates');
    expect(sent.some((m) => m.to === seller.email)).toBe(false);
  });

  it('sends the approved their link and share, and the turned down a short note', async () => {
    await setStatus('approved');
    await onAffiliateApproved(ctx({ affiliateId }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: seller.email, subject: 'You’re a HandsFreeOS affiliate' });
    expect(sent[0]!.text).toContain(`https://handsfreeos.com/?ref=${code}`);
    expect(sent[0]!.text).toMatch(/earns you \d+(\.\d+)?% of every plan payment/);

    // A decision that changed before the email went says nothing it no longer means.
    await onAffiliateTurnedDown(ctx({ affiliateId }));
    expect(sent).toHaveLength(1);
    await setStatus('turned_down');
    await onAffiliateTurnedDown(ctx({ affiliateId }));
    expect(sent[1]).toMatchObject({
      to: seller.email,
      subject: 'Your HandsFreeOS affiliate application',
    });
  });
});
