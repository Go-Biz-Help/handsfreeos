/**
 * 0087: a business's own domain — who may change it, and what only the worker may write.
 *
 * **Needs the stack up.** Three things here can only be wrong in Postgres, and all three are the kind of
 * wrong that is invisible until a customer sees it:
 *
 *   - a member could mark their own domain verified, and we would serve a name nobody proved they hold;
 *   - `private.site_for_domain` could answer for a domain that is not finished, and every visitor to that
 *     name would get a certificate warning instead of a booking page;
 *   - two businesses could hold the same name, and "which business is this host?" would have two answers.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let org: string;
let ws: string;
let otherWs: string;
let siteId: string;
let otherSiteId: string;
const admin$ = dbs.admin.db;

const uniqueDomain = (label: string) =>
  `${label}-${Math.random().toString(36).slice(2, 10)}.lonestarhvac.test`;

/** The booking site a domain hangs off. Every business gets one the moment it publishes anything public. */
async function site(workspaceId: string, slug: string): Promise<string> {
  const [row] = await asService({ workspaceId, organizationId: org })((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.booking_sites (workspace_id, slug, name, enabled)
          values (${workspaceId}, ${slug}, 'Lone Star HVAC', true) returning id`,
    ),
  );
  return row!.id;
}

/** A domain as `branded_domain.add` writes one: pending, nothing proved, nothing serving. */
async function add(user: TestUser, workspaceId: string, id: string, domain: string) {
  return as(user)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.branded_domains (workspace_id, site_id, domain, created_by)
          values (${workspaceId}, ${id}, ${domain}, ${user.id}) returning id`,
    ),
  );
}

/** What the worker writes when the host answers: the only path by which these columns ever move. */
const record = (
  workspaceId: string,
  domainId: string,
  patch: { status: string; certificateReady: boolean },
) =>
  asService({ workspaceId, organizationId: org })((tx) =>
    rows(
      tx,
      sql`update app.branded_domains
          set status = ${patch.status}::app.branded_domain_status,
              certificate_ready = ${patch.certificateReady},
              verified_at = case when ${patch.status} = 'verified' then now() else null end
          where id = ${domainId}`,
    ),
  );

const whoseHost = (domain: string) =>
  rows<{ site_slug: string; workspace_id: string }>(
    admin$,
    sql`select * from private.site_for_domain(${domain})`,
  );

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('bd-owner'),
    createTestUser('bd-member'),
    createTestUser('bd-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Branded Org', 'Branded HVAC');
  org = a.orgId;
  ws = a.wsId;
  const b = await bootstrapOrganization(outsider, 'Branded Org B', 'Somebody Else');
  otherWs = b.wsId;
  await admin$
    .insert(workspaceMemberships)
    .values([{ workspaceId: ws, userId: member.id, role: 'member' }]);
  siteId = await site(ws, `branded-${Math.random().toString(36).slice(2, 8)}`);
  otherSiteId = await site(otherWs, `other-${Math.random().toString(36).slice(2, 8)}`);
}, 60_000);

/**
 * One domain per business, cleared between tests.
 *
 * `branded_domains.site_id` is unique — that is the feature, not an accident: "which business is this host?"
 * must have exactly one answer in both directions. This file used to add a domain per test against one
 * booking site, so every test after the first died on that constraint. The schema was right and the fixture
 * was wrong.
 */
afterEach(async () => {
  await rows(admin$, sql`delete from app.branded_domains`);
});

afterAll(closeAll);

describe('who may put a business on its own domain', () => {
  it('an owner may, and it starts pending with nothing proved', async () => {
    const domain = uniqueDomain('owner');
    const [made] = await add(owner, ws, siteId, domain);
    const [row] = await rows<{
      status: string;
      certificate_ready: boolean;
      verified_at: string | null;
    }>(
      admin$,
      sql`select status::text, certificate_ready, verified_at from app.branded_domains where id = ${made!.id}`,
    );
    expect(row!.status).toBe('pending');
    expect(row!.certificate_ready).toBe(false);
    expect(row!.verified_at).toBeNull();
  });

  it('a member may not — this is which names the business is reached by', async () => {
    const e = await expectPgError(() => add(member, ws, siteId, uniqueDomain('member')));
    expect(e.code).toBe('42501');
  });

  it('a member still sees the one that is there, because the booking page shows the address', async () => {
    const domain = uniqueDomain('visible');
    await add(owner, ws, siteId, domain);
    const seen = await as(member)((tx) =>
      rows<{ domain: string }>(tx, sql`select domain from app.branded_domains`),
    );
    expect(seen.map((r) => r.domain)).toContain(domain);
  });

  it('somebody else’s business is not theirs to see or to name', async () => {
    const domain = uniqueDomain('theirs');
    await add(outsider, otherWs, otherSiteId, domain);
    const seen = await as(owner)((tx) =>
      rows<{ domain: string }>(tx, sql`select domain from app.branded_domains`),
    );
    expect(seen.map((r) => r.domain)).not.toContain(domain);
  });

  it('nobody may claim a name another business already holds', async () => {
    const domain = uniqueDomain('contested');
    await add(owner, ws, siteId, domain);
    const e = await expectPgError(() => add(outsider, otherWs, otherSiteId, domain));
    // The unique index, not a policy: "which business is this host?" must have one answer.
    expect(e.code).toBe('23505');
  });

  it('refuses one of our own names, so nobody can point handsfreeos.com at themselves', async () => {
    const e = await expectPgError(() => add(owner, ws, siteId, 'book.handsfreeos.com'));
    // 0090 moved this from the check constraint to a trigger, because the answer now depends on who is
    // asking and a check constraint cannot read another table. Same refusal, and it says which rule it is.
    expect(e.code).toBe('42501');
    expect(e.detail).toBe('branded_domain_is_ours');
  });
});

/**
 * 0090: one of our own names, claimed on purpose.
 *
 * The rule that used to be "never" is now "only the workspace written down for it", and the whole of that
 * rule lives in Postgres — so this is the file that has to hold it down. The case that matters is the
 * third: a business that is not on the list must not get a name that is, even when the name is claimable
 * by somebody.
 */
describe('a name of ours somebody is allowed to claim', () => {
  const OURS = 'link.handsfreeos.com';

  const allow = (host: string, workspaceId: string) =>
    rows(
      admin$,
      sql`insert into platform.claimable_hosts (host, workspace_id, why)
          values (${host}, ${workspaceId}, 'test') on conflict (host) do update
          set workspace_id = excluded.workspace_id`,
    );

  afterEach(async () => {
    await rows(admin$, sql`delete from platform.claimable_hosts`);
  });

  it('is refused while it is on nobody’s list', async () => {
    const e = await expectPgError(() => add(owner, ws, siteId, OURS));
    expect(e.code).toBe('42501');
    expect(e.detail).toBe('branded_domain_is_ours');
  });

  it('is taken once it is written down against that workspace', async () => {
    await allow(OURS, ws);
    const [made] = await add(owner, ws, siteId, OURS);
    expect(made?.id).toBeTruthy();
  });

  it('is still refused to a business it was not written down for', async () => {
    // The one that matters: `link.handsfreeos.com` is claimable, and this business is not who may claim it.
    await allow(OURS, ws);
    const e = await expectPgError(() => add(outsider, otherWs, otherSiteId, OURS));
    expect(e.code).toBe('42501');
    expect(e.detail).toBe('branded_domain_is_ours');
  });

  it('answers the handler’s question, and says nothing about anybody else’s name', async () => {
    await allow(OURS, ws);
    const [mine] = await rows<{ workspace_id: string | null }>(
      admin$,
      sql`select private.claimable_host_workspace(${OURS}) as workspace_id`,
    );
    expect(mine?.workspace_id).toBe(ws);
    const [theirs] = await rows<{ workspace_id: string | null }>(
      admin$,
      sql`select private.claimable_host_workspace('booking.lonestarhvac.com') as workspace_id`,
    );
    expect(theirs?.workspace_id).toBeNull();
  });

  it('is not a list a business can read, nor one it can add itself to', async () => {
    await allow(OURS, ws);
    // Refused outright rather than read as empty: the grant was revoked, so this never reaches row level
    // security. A business cannot even learn which of our names exist.
    const read = await expectPgError(() =>
      as(owner)((tx) => rows(tx, sql`select host from platform.claimable_hosts`)),
    );
    expect(read.code).toBe('42501');
    const write = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into platform.claimable_hosts (host, workspace_id)
              values ('login.handsfreeos.com', ${ws})`,
        ),
      ),
    );
    expect(write.code).toBe('42501');
  });
});

describe('what the host said is the worker’s to write', () => {
  it('an owner cannot mark their own domain verified', async () => {
    const [made] = await add(owner, ws, siteId, uniqueDomain('self-verify'));
    const e = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`update app.branded_domains set status = 'verified', certificate_ready = true
              where id = ${made!.id}`,
        ),
      ),
    );
    expect(e.code).toBe('42501');
    expect(e.detail).toBe('branded_domain_provider_fields');
  });

  it('nor rewrite the records we are checking against', async () => {
    const [made] = await add(owner, ws, siteId, uniqueDomain('self-records'));
    const e = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`update app.branded_domains set cname_value = 'their-own-server.example.com'
              where id = ${made!.id}`,
        ),
      ),
    );
    expect(e.code).toBe('42501');
  });

  it('and the name itself never changes — removing and adding is the only way', async () => {
    const [made] = await add(owner, ws, siteId, uniqueDomain('rename'));
    const e = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`update app.branded_domains set domain = 'elsewhere.test' where id = ${made!.id}`,
        ),
      ),
    );
    // 23514, not 42501: `private.forbid_tenant_column_change` raises a check violation. The name really is
    // immutable — this asserted the wrong lock.
    expect(e.code).toBe('23514');
    const [row] = await rows<{ domain: string }>(
      admin$,
      sql`select domain from app.branded_domains where id = ${made!.id}`,
    );
    expect(row?.domain).not.toBe('elsewhere.test');
  });
});

describe('which business is this host', () => {
  it('says nothing about a domain still waiting on DNS', async () => {
    const domain = uniqueDomain('waiting');
    await add(owner, ws, siteId, domain);
    expect(await whoseHost(domain)).toEqual([]);
  });

  it('says nothing about a verified domain whose certificate has not issued', async () => {
    const domain = uniqueDomain('nocert');
    const [made] = await add(owner, ws, siteId, domain);
    await record(ws, made!.id, { status: 'verified', certificateReady: false });
    // Serving here would show every visitor a certificate warning, which is worse than serving nothing.
    expect(await whoseHost(domain)).toEqual([]);
  });

  it('answers once it is really working, with the site to serve', async () => {
    const domain = uniqueDomain('working');
    const [made] = await add(owner, ws, siteId, domain);
    await record(ws, made!.id, { status: 'verified', certificateReady: true });
    const [found] = await whoseHost(domain);
    expect(found?.workspace_id).toBe(ws);
    const [expected] = await rows<{ slug: string }>(
      admin$,
      sql`select slug::text from app.booking_sites where id = ${siteId}`,
    );
    expect(found?.site_slug).toBe(expected!.slug);
  });

  it('stops answering when the booking page is switched off', async () => {
    const domain = uniqueDomain('siteoff');
    const [made] = await add(owner, ws, siteId, domain);
    await record(ws, made!.id, { status: 'verified', certificateReady: true });
    await rows(admin$, sql`update app.booking_sites set enabled = false where id = ${siteId}`);
    expect(await whoseHost(domain)).toEqual([]);
    await rows(admin$, sql`update app.booking_sites set enabled = true where id = ${siteId}`);
  });

  it('does not care how the host is capitalised, because a browser does not', async () => {
    const domain = uniqueDomain('casing');
    const [made] = await add(owner, ws, siteId, domain);
    await record(ws, made!.id, { status: 'verified', certificateReady: true });
    expect((await whoseHost(domain.toUpperCase()))[0]?.workspace_id).toBe(ws);
  });

  it('forgets the name the moment the business takes it off', async () => {
    const domain = uniqueDomain('removed');
    const [made] = await add(owner, ws, siteId, domain);
    await record(ws, made!.id, { status: 'verified', certificateReady: true });
    await as(owner)((tx) => rows(tx, sql`delete from app.branded_domains where id = ${made!.id}`));
    expect(await whoseHost(domain)).toEqual([]);
  });
});
