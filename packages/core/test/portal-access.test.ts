/**
 * The client portal's sign-in (Real Estate round two, core): letting a customer in and sending the link again,
 * refusing one without an email, the six-digit code (three an hour, five tries, only its hash kept), a device
 * signed in with only its bearer's hash kept, and turning access off signing every device out and retiring the link.
 */
import { createHash, randomBytes } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  organizationCreate,
  personCreate,
  portalAccessGet,
  portalAccessGive,
  portalAccessRevoke,
  portalCheckCode,
  portalSendCode,
  portalSessionEnd,
  portalSessionSeen,
} from '../src/server';
import { admin, ask, expectHfos, run, runSystem, type Scope } from './calendar-helpers';

let owner: TestUser;
let scope: Scope;
let linh: string;
let noEmail: string;
let accessId: string;

const bearerHash = () => createHash('sha256').update(randomBytes(32)).digest('hex');

beforeAll(async () => {
  owner = await createTestUser('portal-owner', { fullName: 'Dana Reyes' });
  const org = await run(organizationCreate, { businessName: 'Hill Country Realty' }, owner);
  scope = { workspaceId: org.workspaceId, organizationId: org.organizationId };
  linh = (
    await run(
      personCreate,
      {
        workspaceId: scope.workspaceId,
        firstName: 'Linh',
        lastName: 'Nguyen',
        email: 'linh.nguyen@example.com',
      },
      owner,
    )
  ).personId;
  noEmail = (
    await run(
      personCreate,
      { workspaceId: scope.workspaceId, firstName: 'Tuan', lastName: 'Nguyen' },
      owner,
    )
  ).personId;
});
afterAll(closeTestDbs);

describe('letting a customer in', () => {
  it('needs their email on file', async () => {
    await expectHfos(
      () => run(portalAccessGive, { workspaceId: scope.workspaceId, personId: noEmail }, owner),
      'portal_no_email',
    );
  });

  it('lets them in once, and sends the link again after that', async () => {
    const first = await run(
      portalAccessGive,
      { workspaceId: scope.workspaceId, personId: linh },
      owner,
    );
    expect(first).toMatchObject({ resent: false, sentTo: 'l•••@example.com' });
    accessId = first.accessId;
    const again = await run(
      portalAccessGive,
      { workspaceId: scope.workspaceId, personId: linh },
      owner,
    );
    expect(again).toMatchObject({ accessId, resent: true });
    const events = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events where workspace_id = ${scope.workspaceId}
          and event_type = 'portal.access_given' order by created_at`,
    );
    expect(events).toHaveLength(2);
    const got = await ask(
      portalAccessGet,
      { workspaceId: scope.workspaceId, personId: linh },
      owner,
    );
    expect(got.access).toMatchObject({ on: true, devices: [], givenBy: { id: owner.id } });
  });
});

describe('signing in on a new device', () => {
  it('sends a code, keeps only its hash, and signs the device in with the right one', async () => {
    const sent = await runSystem(
      portalSendCode,
      { workspaceId: scope.workspaceId, accessId },
      scope,
    );
    expect(sent).toMatchObject({ to: 'linh.nguyen@example.com', business: 'Hill Country Realty' });
    const kept = await rows<{ code_hash: Buffer }>(
      admin(),
      sql`select code_hash from app.portal_codes where id = ${sent.codeId}`,
    );
    expect(kept[0]!.code_hash.toString('hex')).not.toContain(sent.code);
    const wrong = sent.code === '000000' ? '111111' : '000000';
    const miss = await runSystem(
      portalCheckCode,
      { workspaceId: scope.workspaceId, accessId, code: wrong, tokenHash: bearerHash() },
      scope,
    );
    expect(miss).toMatchObject({ verified: false, triesLeft: 4, sessionId: null });
    const hash = bearerHash();
    const hit = await runSystem(
      portalCheckCode,
      {
        workspaceId: scope.workspaceId,
        accessId,
        code: sent.code,
        tokenHash: hash,
        device: 'Safari on iPhone',
      },
      scope,
    );
    expect(hit.verified).toBe(true);
    // The worker finds the device by its bearer's hash; nothing else about the bearer is kept.
    const found = await rows<{ session_id: string }>(
      admin(),
      sql`select session_id from private.portal_session_lookup(decode(${hash}, 'hex'))`,
    );
    expect(found.map((f) => f.session_id)).toEqual([hit.sessionId]);
    // A used code doesn't work twice.
    await expectHfos(
      () =>
        runSystem(
          portalCheckCode,
          { workspaceId: scope.workspaceId, accessId, code: sent.code, tokenHash: bearerHash() },
          scope,
        ),
      'code_expired',
    );
    const got = await ask(
      portalAccessGet,
      { workspaceId: scope.workspaceId, personId: linh },
      owner,
    );
    expect(got.access!.devices).toEqual([expect.objectContaining({ device: 'Safari on iPhone' })]);
    expect(got.access!.lastUsedAt).not.toBeNull();
    await runSystem(
      portalSessionSeen,
      { workspaceId: scope.workspaceId, sessionId: hit.sessionId! },
      scope,
    );
  });

  it('sends three codes an hour, and no more', async () => {
    // One went out above; two more are fine, the fourth isn't.
    await runSystem(portalSendCode, { workspaceId: scope.workspaceId, accessId }, scope);
    await runSystem(portalSendCode, { workspaceId: scope.workspaceId, accessId }, scope);
    await expectHfos(
      () => runSystem(portalSendCode, { workspaceId: scope.workspaceId, accessId }, scope),
      'too_many_codes',
    );
  });

  it('stops after five wrong tries', async () => {
    await rows(admin(), sql`delete from app.portal_codes where access_id = ${accessId}`);
    const sent = await runSystem(
      portalSendCode,
      { workspaceId: scope.workspaceId, accessId },
      scope,
    );
    const wrong = sent.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      await runSystem(
        portalCheckCode,
        { workspaceId: scope.workspaceId, accessId, code: wrong, tokenHash: bearerHash() },
        scope,
      );
    await expectHfos(
      () =>
        runSystem(
          portalCheckCode,
          { workspaceId: scope.workspaceId, accessId, code: sent.code, tokenHash: bearerHash() },
          scope,
        ),
      'too_many_tries',
    );
  });
});

describe('turning it off', () => {
  it('signs every device out and retires the link; letting them back in makes a new one', async () => {
    const [before] = await rows<{ link_version: number }>(
      admin(),
      sql`select link_version from app.portal_access where id = ${accessId}`,
    );
    await run(portalAccessRevoke, { workspaceId: scope.workspaceId, personId: linh }, owner);
    const open = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.portal_sessions where access_id = ${accessId} and ended_at is null`,
    );
    expect(open[0]!.n).toBe(0);
    await expectHfos(
      () => runSystem(portalSendCode, { workspaceId: scope.workspaceId, accessId }, scope),
      'portal_access_off',
    );
    await expectHfos(
      () => run(portalAccessRevoke, { workspaceId: scope.workspaceId, personId: linh }, owner),
      'portal_not_in',
    );
    const back = await run(
      portalAccessGive,
      { workspaceId: scope.workspaceId, personId: linh },
      owner,
    );
    expect(back).toMatchObject({ accessId, resent: false });
    const [after] = await rows<{ link_version: number }>(
      admin(),
      sql`select link_version from app.portal_access where id = ${accessId}`,
    );
    expect(after!.link_version).toBe(before!.link_version + 2);
  });

  it('signs one device out', async () => {
    await rows(admin(), sql`delete from app.portal_codes where access_id = ${accessId}`);
    const sent = await runSystem(
      portalSendCode,
      { workspaceId: scope.workspaceId, accessId },
      scope,
    );
    const hit = await runSystem(
      portalCheckCode,
      { workspaceId: scope.workspaceId, accessId, code: sent.code, tokenHash: bearerHash() },
      scope,
    );
    expect(
      await runSystem(
        portalSessionEnd,
        { workspaceId: scope.workspaceId, sessionId: hit.sessionId! },
        scope,
      ),
    ).toEqual({ ended: true });
    expect(
      await runSystem(
        portalSessionEnd,
        { workspaceId: scope.workspaceId, sessionId: hit.sessionId! },
        scope,
      ),
    ).toEqual({ ended: false });
  });
});
