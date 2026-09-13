import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let outsider: TestUser;
let wsA: string;
let orgA: string;
let wsB: string;
let orgB: string;

const worker = (ws: string, org: string) => asService({ workspaceId: ws, organizationId: org });
const unscoped = asService({});
/** Lower-case letters and digits only, for names that must pass the address and domain checks. */
const token = () =>
  uniq()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

beforeAll(async () => {
  [owner, admin, member, outsider] = await Promise.all([
    createTestUser('mail-owner'),
    createTestUser('mail-admin'),
    createTestUser('mail-member'),
    createTestUser('mail-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Email Org A', 'Email A');
  wsA = a.wsId;
  orgA = a.orgId;
  const b = await bootstrapOrganization(outsider, 'Email Org B', 'Email B');
  wsB = b.wsId;
  orgB = b.orgId;
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: wsA, userId: admin.id, role: 'admin' },
    { workspaceId: wsA, userId: member.id, role: 'member' },
  ]);
});
afterAll(closeAll);

const defaultAddress = async (ws: string) =>
  (
    await rows<{ id: string; address: string }>(
      dbs.admin.db,
      sql`select id, address from app.email_addresses where workspace_id = ${ws} and is_default`,
    )
  )[0]!;

describe('the shared-subdomain address', () => {
  it('every workspace gets one as its default; outsiders see nothing', async () => {
    const mine = await as(member)((tx) =>
      rows<{
        address: string;
        is_default: boolean;
        email_domain_id: string | null;
        verified: boolean;
      }>(
        tx,
        sql`select address, is_default, email_domain_id, verified_at is not null as verified
            from app.email_addresses where workspace_id = ${wsA}`,
      ),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ is_default: true, email_domain_id: null, verified: true });
    expect(mine[0]!.address).toMatch(/^[a-z0-9._-]+@mail\.handsfreeos\.com$/);
    const other = await as(outsider)((tx) =>
      rows(tx, sql`select id from app.email_addresses where workspace_id = ${wsA}`),
    );
    expect(other).toHaveLength(0);
  });

  it('two workspaces with the same slug get different addresses', async () => {
    const slug = `echo-${token()}`;
    const make = (org: string) =>
      rows<{ id: string }>(
        dbs.admin.db,
        sql`insert into app.workspaces (organization_id, name, slug) values (${org}, 'Echo HVAC', ${slug}) returning id`,
      );
    const [w1] = await make(orgA);
    const [w2] = await make(orgB);
    const addresses = [
      (await defaultAddress(w1!.id)).address,
      (await defaultAddress(w2!.id)).address,
    ];
    expect(addresses).toEqual([`${slug}@mail.handsfreeos.com`, `${slug}-2@mail.handsfreeos.com`]);
  });

  it('owners and admins add addresses; names that read as HandsFreeOS are refused; one default', async () => {
    const insert = (u: TestUser, local: string) =>
      as(u)((tx) =>
        rows<{ id: string; address: string }>(
          tx,
          sql`insert into app.email_addresses (workspace_id, local_part, address, display_name, created_by)
              values (${wsA}, ${local}, 'filled-in@by-the-trigger', 'Sales', ${u.id}) returning id, address`,
        ),
      );
    expect((await expectPgError(() => insert(member, `sales-${token()}`))).code).toBe('42501');
    expect((await expectPgError(() => insert(owner, 'postmaster'))).code).toBe('23514');
    const local = `sales-${token()}`;
    const [made] = await insert(admin, local);
    expect(made!.address).toBe(`${local}@mail.handsfreeos.com`);
    const second = await expectPgError(() =>
      as(admin)((tx) =>
        rows(tx, sql`update app.email_addresses set is_default = true where id = ${made!.id}`),
      ),
    );
    expect(second.code).toBe('23505');
  });
});

describe('a workspace domain', () => {
  it('owners add it pending; only the worker records the checks; addresses wait for verification', async () => {
    const domain = `${token()}.example.com`;
    const add = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ id: string; status: string }>(
          tx,
          sql`insert into app.email_domains (workspace_id, domain, created_by)
              values (${wsA}, ${domain}, ${u.id}) returning id, status::text as status`,
        ),
      );
    expect((await expectPgError(() => add(member))).code).toBe('42501');
    const [d] = await add(owner);
    expect(d!.status).toBe('pending');
    const selfVerify = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.email_domains set status = 'verified' where id = ${d!.id}`),
      ),
    );
    expect(selfVerify.code).toBe('42501');
    const onDomain = (local: string) =>
      as(owner)((tx) =>
        rows<{ id: string; address: string }>(
          tx,
          sql`insert into app.email_addresses (workspace_id, email_domain_id, local_part, address, display_name, created_by)
              values (${wsA}, ${d!.id}, ${local}, 'x@x', 'Lone Star', ${owner.id}) returning id, address`,
        ),
      );
    expect((await expectPgError(() => onDomain('office'))).code).toBe('23514');

    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`update app.email_domains set status = 'verified', dkim_verified_at = now(), return_path_verified_at = now()
            where id = ${d!.id}`,
      ),
    );
    // Any name is fine on the business's own domain, even ones the shared subdomain reserves.
    const [office] = await onDomain('info');
    expect(office!.address).toBe(`info@${domain}`);
    const shared = await defaultAddress(wsA);
    await as(owner)(async (tx) => {
      await rows(
        tx,
        sql`update app.email_addresses set is_default = false where id = ${shared.id}`,
      );
      await rows(
        tx,
        sql`update app.email_addresses set is_default = true where id = ${office!.id}`,
      );
    });
    const inUse = await expectPgError(() =>
      as(owner)((tx) => rows(tx, sql`delete from app.email_domains where id = ${d!.id}`)),
    );
    expect(inUse.code).toBe('23514');

    // Back to the shared address; then the domain can go, and its addresses with it.
    await as(owner)(async (tx) => {
      await rows(
        tx,
        sql`update app.email_addresses set is_default = false where id = ${office!.id}`,
      );
      await rows(tx, sql`update app.email_addresses set is_default = true where id = ${shared.id}`);
    });
    await as(owner)((tx) => rows(tx, sql`delete from app.email_domains where id = ${d!.id}`));
    const left = await rows(
      dbs.admin.db,
      sql`select id from app.email_addresses where id = ${office!.id}`,
    );
    expect(left).toHaveLength(0);
  });

  it('HandsFreeOS’s own domain is not a workspace domain', async () => {
    const ours = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.email_domains (workspace_id, domain, created_by)
              values (${wsA}, ${`${token()}.handsfreeos.com`}, ${owner.id})`,
        ),
      ),
    );
    expect(ours.code).toBe('23514');
  });
});

describe('connected mailboxes', () => {
  it('members see a mailbox but never its tokens; people can only disconnect it', async () => {
    const stateHash = `state-${token()}`;
    const connect = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.mailbox_connections (workspace_id, provider, user_id, status, oauth_state_hash,
                oauth_state_expires_at, created_by)
              values (${wsA}, 'microsoft', ${u.id}, 'pending', ${stateHash}, now() + interval '10 minutes', ${u.id})
              returning id`,
        ),
      );
    expect((await expectPgError(() => connect(member))).code).toBe('42501');
    const [m] = await connect(owner);
    const found = await unscoped((tx) =>
      rows<{ connection_id: string; workspace_id: string }>(
        tx,
        sql`select connection_id, workspace_id from private.mailbox_connection_by_state(${stateHash})`,
      ),
    );
    expect(found).toEqual([{ connection_id: m!.id, workspace_id: wsA }]);
    const asPerson = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`select * from private.mailbox_connection_by_state(${stateHash})`),
      ),
    );
    expect(asPerson.code).toBe('42501');

    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`update app.mailbox_connections set status = 'active', account_email = ${`dale-${token()}@example.com`},
              token_enc = 'sealed:v1:not-a-real-token', connected_at = now()
            where id = ${m!.id}`,
      ),
    );
    const visible = await as(member)((tx) =>
      rows<{ status: string }>(
        tx,
        sql`select status::text as status from app.mailbox_connections where id = ${m!.id}`,
      ),
    );
    expect(visible).toEqual([{ status: 'active' }]);
    const sealed = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`select token_enc from app.mailbox_connections where id = ${m!.id}`),
      ),
    );
    expect(sealed.code).toBe('42501');
    const reactivate = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.mailbox_connections set status = 'error' where id = ${m!.id}`),
      ),
    );
    expect(reactivate.code).toBe('42501');
    await as(owner)((tx) =>
      rows(tx, sql`update app.mailbox_connections set status = 'disconnected' where id = ${m!.id}`),
    );
    const [after] = await rows<{ status: string; token_gone: boolean; at: boolean }>(
      dbs.admin.db,
      sql`select status::text as status, token_enc is null as token_gone, disconnected_at is not null as at
          from app.mailbox_connections where id = ${m!.id}`,
    );
    expect(after).toEqual({ status: 'disconnected', token_gone: true, at: true });
  });
});

describe('email conversations', () => {
  it('get a reply token nobody can change, and mail finds its way by token or address', async () => {
    const [c] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string; email_reply_token: string }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart)
            values (${wsA}, 'email', ${`mike-${token()}@example.com`}) returning id, email_reply_token`,
      ),
    );
    expect(c!.email_reply_token).toMatch(/^[a-z2-7]{10}$/);
    const [text] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ email_reply_token: string | null }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart)
            values (${wsA}, 'sms', ${`+1713${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`})
            returning email_reply_token`,
      ),
    );
    expect(text!.email_reply_token).toBeNull();
    const changed = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`update app.conversations set email_reply_token = 'aaaaaaaaaa' where id = ${c!.id}`,
        ),
      ),
    );
    expect(changed.code).toBe('23514');
    const byToken = await unscoped((tx) =>
      rows<{ conversation_id: string; workspace_id: string }>(
        tx,
        sql`select conversation_id, workspace_id from private.conversation_by_reply_token(${c!.email_reply_token.toUpperCase()})`,
      ),
    );
    expect(byToken).toEqual([{ conversation_id: c!.id, workspace_id: wsA }]);
    const shared = await defaultAddress(wsA);
    const byAddress = await unscoped((tx) =>
      rows<{ workspace_id: string; organization_id: string }>(
        tx,
        sql`select workspace_id, organization_id from private.email_address_route(${shared.address.toUpperCase()})`,
      ),
    );
    expect(byAddress).toEqual([{ workspace_id: wsA, organization_id: orgA }]);
  });

  it('never borrow another workspace’s address', async () => {
    const theirs = await defaultAddress(wsB);
    const borrowed = await expectPgError(() =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows(
          tx,
          sql`insert into app.conversations (workspace_id, channel, counterpart, email_address_id)
              values (${wsA}, 'email', ${`pat-${token()}@example.com`}, ${theirs.id})`,
        ),
      ),
    );
    expect(borrowed.code).toBe('23514');
  });
});

describe('suppressions and mail from strangers', () => {
  it('owners stop and release an address by hand; bounces are the worker’s', async () => {
    const add = (u: TestUser, reason: string, address: string) =>
      as(u)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.email_suppressions (workspace_id, address, reason, created_by)
              values (${wsA}, ${address}, ${reason}::app.suppression_reason, ${u.id}) returning id`,
        ),
      );
    expect(
      (await expectPgError(() => add(member, 'manual', `a-${token()}@example.com`))).code,
    ).toBe('42501');
    expect(
      (await expectPgError(() => add(owner, 'hard_bounce', `b-${token()}@example.com`))).code,
    ).toBe('42501');
    const [s] = await add(owner, 'manual', `c-${token()}@example.com`);
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`insert into app.email_suppressions (workspace_id, address, reason, origin)
            values (${wsA}, ${`d-${token()}@example.com`}, 'hard_bounce', 'postmark')`,
      ),
    );
    await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.email_suppressions set released_at = now(), released_by = ${owner.id} where id = ${s!.id}`,
      ),
    );
    const rename = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`update app.email_suppressions set address = 'other@example.com' where id = ${s!.id}`,
        ),
      ),
    );
    expect(rename.code).toBe('42501');
  });

  it('the worker keeps unknown mail; the team dismisses or claims it; outsiders see nothing', async () => {
    const [u] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.email_inbound_unmatched (workspace_id, from_address, from_name, subject, snippet, body_text)
            values (${wsA}, ${`stranger-${token()}@example.com`}, 'A Stranger', 'Quote?', 'Can you quote a new AC?',
              'Can you quote a new AC?') returning id`,
      ),
    );
    const seen = await as(member)((tx) =>
      rows(tx, sql`select id from app.email_inbound_unmatched where id = ${u!.id}`),
    );
    expect(seen).toHaveLength(1);
    const hidden = await as(outsider)((tx) =>
      rows(tx, sql`select id from app.email_inbound_unmatched where id = ${u!.id}`),
    );
    expect(hidden).toHaveLength(0);
    await as(member)((tx) =>
      rows(
        tx,
        sql`update app.email_inbound_unmatched set dismissed_at = now(), dismissed_by = ${member.id} where id = ${u!.id}`,
      ),
    );
    const rewrite = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`update app.email_inbound_unmatched set subject = 'changed' where id = ${u!.id}`,
        ),
      ),
    );
    expect(rewrite.code).toBe('42501');
  });
});

describe('the daily domain check', () => {
  it('lists every domain the mail service knows, with its tenant, to the worker only', async () => {
    const known = `${token()}.example.com`;
    const [d] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.email_domains (workspace_id, domain, provider_domain_id)
            values (${wsA}, ${known}, ${`local-${known}`}) returning id`,
      ),
    );
    // Not created at the mail service yet: nothing to check.
    const [fresh] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.email_domains (workspace_id, domain) values (${wsA}, ${`${token()}.example.com`}) returning id`,
      ),
    );
    const listed = await unscoped((tx) =>
      rows<{ email_domain_id: string; workspace_id: string; organization_id: string }>(
        tx,
        sql`select email_domain_id, workspace_id, organization_id from private.email_domains_to_check()
            where email_domain_id in (${d!.id}, ${fresh!.id})`,
      ),
    );
    expect(listed).toEqual([{ email_domain_id: d!.id, workspace_id: wsA, organization_id: orgA }]);
    const asPerson = await expectPgError(() =>
      as(owner)((tx) => rows(tx, sql`select * from private.email_domains_to_check()`)),
    );
    expect(asPerson.code).toBe('42501');
  });
});
