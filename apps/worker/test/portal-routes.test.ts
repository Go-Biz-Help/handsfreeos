/**
 * The client portal's sign-in on its public pages (Real Estate round two, core): the invite email with its
 * private link, the link alone showing only whose portal it is, the six-digit code emailed to the address on file,
 * a wrong code and the right one, the device's bearer, the 30-day idle rule, signing out, and a link the business
 * replaced or turned off.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  catalogAddon,
  partnerAdd,
  personCreate,
  portalAccessGive,
  portalAccessRevoke,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { portalToken } from '../src/portal/links';
import { admin, drain, errorOf, makeWorld, run, waitForMail, type World } from './booking-world';

let w: World;
let personId: string;
let email: string;
let business: string;
let token: string;
let bearer: string;

const IP = '203.0.113.44';

function call(
  method: 'GET' | 'POST',
  url: string,
  opts: { body?: unknown; bearer?: string } = {},
): Promise<LightMyRequestResponse> {
  return w.app.inject({
    method,
    url,
    headers: {
      'x-forwarded-for': IP,
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { payload: JSON.stringify(opts.body ?? {}) } : {}),
  });
}

const tokenIn = (text: string): string => {
  const m = /\/c\/([0-9A-Za-z]+)/.exec(text);
  if (!m) throw new Error(`no portal link in: ${text}`);
  return m[1]!;
};

/** Asks for a code and reads it from the email (this file asks for only one). */
async function newCode(): Promise<string> {
  const res = await call('POST', `/public/portal/${token}/code`);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json()).toEqual({ sentTo: `${email.slice(0, 1)}•••@example.com`, minutes: 10 });
  const mail = await waitForMail(email, `Your ${business} code:`);
  expect(mail.text).toContain('expires in 10 minutes');
  return /code: (\d{6})$/.exec(mail.subject)![1]!;
}

beforeAll(async () => {
  w = await makeWorld('portal-routes');
  email = `linh-${randomUUID().slice(0, 8)}@example.com`;
  personId = (
    await run(w, personCreate, {
      workspaceId: w.workspaceId,
      firstName: 'Linh',
      lastName: 'Nguyen',
      email,
    })
  ).personId;
  const [ws] = await rows<{ name: string }>(
    admin(),
    sql`select name from app.workspaces where id = ${w.workspaceId}`,
  );
  business = ws!.name;
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('the invite', () => {
  it('emails the client their private link, from the business', async () => {
    await run(w, portalAccessGive, { workspaceId: w.workspaceId, personId });
    await drain(w);
    const mail = await waitForMail(email, `Your private portal with ${business}`);
    expect(mail.text).toContain('Dale Owner');
    expect(mail.text).toContain('6-digit code');
    token = tokenIn(mail.text);
    expect(mail.text).toContain(`http://localhost:3000/c/${token}`);
  });

  it('tells a partner of the business about their partner page instead', async () => {
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${w.workspaceId}, 'outreach', 'enabled', ${catalogAddon('outreach').version})
          on conflict do nothing`,
    );
    const partnerEmail = `paula-${randomUUID().slice(0, 8)}@example.com`;
    const { personId: paula } = await run(w, personCreate, {
      workspaceId: w.workspaceId,
      firstName: 'Paula',
      lastName: 'Partner',
      email: partnerEmail,
    });
    await run(w, partnerAdd, { workspaceId: w.workspaceId, personId: paula });
    await run(w, portalAccessGive, { workspaceId: w.workspaceId, personId: paula });
    await drain(w);
    const mail = await waitForMail(partnerEmail, `Your partner page with ${business}`);
    expect(mail.text).toContain('your link to share, the clients you’ve sent, what you’ve earned');
    expect(mail.text).not.toContain('to-do');
    expect(tokenIn(mail.text)).toBeTruthy();
  });

  it('shows only whose portal it is to someone with just the link', async () => {
    const res = await call('GET', `/public/portal/${token}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.json()).toEqual({
      business: { name: business },
      person: { firstName: 'Linh' },
      sentTo: `${email.slice(0, 1)}•••@example.com`,
      signedIn: false,
    });
  });

  it('refuses a link that isn’t one', async () => {
    const forged = token.slice(0, 8) + 'A'.repeat(token.length - 8);
    for (const t of [forged, 'nope', randomBytes(9).toString('hex')]) {
      const res = await call('GET', `/public/portal/${t}`);
      expect(res.statusCode, t).toBe(404);
    }
  });
});

describe('signing in on a new device', () => {
  it('refuses a bot filling the hidden field', async () => {
    const res = await call('POST', `/public/portal/${token}/code`, {
      body: { website: 'spam.example' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('emails a code; a wrong one says how many tries are left, the right one signs the device in', async () => {
    const code = await newCode();
    const wrong = code === '000000' ? '111111' : '000000';
    const miss = await call('POST', `/public/portal/${token}/verify`, { body: { code: wrong } });
    expect(miss.statusCode, miss.body).toBe(200);
    expect(miss.json()).toEqual({ verified: false, triesLeft: 4 });

    const bad = await call('POST', `/public/portal/${token}/verify`, { body: { code: '12ab' } });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toContain('Type the 6 digits from the email.');

    const hit = await call('POST', `/public/portal/${token}/verify`, {
      body: { code, device: 'Safari on iPhone' },
    });
    expect(hit.statusCode, hit.body).toBe(200);
    const out = hit.json() as { verified: boolean; bearer: string; expiresAt: string };
    expect(out.verified).toBe(true);
    expect(out.bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const days = (new Date(out.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    bearer = out.bearer;
    // Only the bearer's hash is kept.
    const kept = await rows<{ device: string; token_hash: Buffer }>(
      admin(),
      sql`select s.device, s.token_hash from app.portal_sessions s join app.portal_access a on a.id = s.access_id
          where a.person_id = ${personId} and s.ended_at is null`,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.device).toBe('Safari on iPhone');
    expect(kept[0]!.token_hash.toString('base64url')).not.toBe(bearer);
  });

  it('knows the device on the next visit, and nobody else', async () => {
    const mine = await call('GET', `/public/portal/${token}`, { bearer });
    expect((mine.json() as { signedIn: boolean }).signedIn).toBe(true);
    const other = await call('GET', `/public/portal/${token}`, {
      bearer: randomBytes(32).toString('base64url'),
    });
    expect((other.json() as { signedIn: boolean }).signedIn).toBe(false);
  });

  it('lets the device run what customers may, as them, in their own business', async () => {
    const home = await call('POST', '/public/portal/op/portal.home', {
      bearer,
      // A business named in the body is ignored: the device says whose it is.
      body: { workspaceId: randomUUID() },
    });
    expect(home.statusCode, home.body).toBe(200);
    expect(home.json()).toEqual({
      business: { name: business },
      person: { firstName: 'Linh', lastName: 'Nguyen' },
      addons: [],
      partner: false,
      documents: { total: 0, toSign: 0 },
    });
    const nobody = await call('POST', '/public/portal/op/portal.home');
    expect(nobody.statusCode).toBe(401);
    expect(errorOf(nobody).rule).toBe('portal_signed_out');
    // Nothing that isn't made for customers, staff's or the worker's own.
    for (const name of ['person.get', 'portal_code.send', 'portal_access.give', 'nothing.here']) {
      const res = await call('POST', `/public/portal/op/${name}`, { bearer });
      expect(res.statusCode, name).toBe(404);
    }
  });

  it('keeps a device in use signed in, and signs out one left alone for 30 days', async () => {
    await rows(
      admin(),
      sql`update app.portal_sessions set last_seen_at = now() - interval '2 hours'
          where access_id = (select id from app.portal_access where person_id = ${personId}) and ended_at is null`,
    );
    await call('GET', `/public/portal/${token}`, { bearer });
    const [seen] = await rows<{ last_seen_at: Date | string }>(
      admin(),
      sql`select last_seen_at from app.portal_sessions
          where access_id = (select id from app.portal_access where person_id = ${personId}) and ended_at is null`,
    );
    expect(Date.now() - new Date(seen!.last_seen_at).getTime()).toBeLessThan(60_000);

    await rows(
      admin(),
      sql`update app.portal_sessions set last_seen_at = now() - interval '31 days'
          where access_id = (select id from app.portal_access where person_id = ${personId}) and ended_at is null`,
    );
    const idle = await call('GET', `/public/portal/${token}`, { bearer });
    expect((idle.json() as { signedIn: boolean }).signedIn).toBe(false);
    await rows(
      admin(),
      sql`update app.portal_sessions set last_seen_at = now()
          where access_id = (select id from app.portal_access where person_id = ${personId}) and ended_at is null`,
    );
  });

  it('signs the device out', async () => {
    const out = await call('POST', `/public/portal/${token}/sign-out`, { bearer });
    expect(out.json()).toEqual({ signedOut: true });
    const after = await call('GET', `/public/portal/${token}`, { bearer });
    expect((after.json() as { signedIn: boolean }).signedIn).toBe(false);
    const again = await call('POST', `/public/portal/${token}/sign-out`, { bearer });
    expect(again.json()).toEqual({ signedOut: false });
  });
});

describe('when the business changes the link', () => {
  it('sends the same link again while they’re in', async () => {
    await run(w, portalAccessGive, { workspaceId: w.workspaceId, personId });
    await drain(w);
    const mail = await waitForMail(email, `Your portal link from ${business}`);
    expect(tokenIn(mail.text)).toBe(token);
  });

  it('says the portal is off once it’s turned off, and the old link was replaced once they’re back in', async () => {
    await run(w, portalAccessRevoke, { workspaceId: w.workspaceId, personId });
    const off = await call('GET', `/public/portal/${token}`);
    expect(off.statusCode).toBe(410);
    expect(errorOf(off).rule).toBe('portal_access_off');
    expect(errorOf(off).message).toContain(business);
    const code = await call('POST', `/public/portal/${token}/code`);
    expect(code.statusCode).toBe(410);

    await rows(
      admin(),
      sql`delete from app.portal_codes where access_id in
      (select id from app.portal_access where person_id = ${personId})`,
    );
    await run(w, portalAccessGive, { workspaceId: w.workspaceId, personId });
    const stale = await call('GET', `/public/portal/${token}`);
    expect(stale.statusCode).toBe(410);
    expect(errorOf(stale).rule).toBe('portal_link_stale');

    await drain(w);
    const [access] = await rows<{ public_ref: string; link_version: number; id: string }>(
      admin(),
      sql`select id, public_ref, link_version from app.portal_access where person_id = ${personId}`,
    );
    token = portalToken(w.s.portalLinks, {
      publicRef: access!.public_ref,
      accessId: access!.id,
      linkVersion: access!.link_version,
    });
    const fresh = await call('GET', `/public/portal/${token}`);
    expect(fresh.statusCode, fresh.body).toBe(200);
  });
});
