/**
 * A business receiving its own mail (M19): who may turn it on, what only the worker may say, where mail to the
 * domain goes, and handsfreeos.com belonging to HandsFreeOS's own business alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql, type Tx } from '../src/client';
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
let member: TestUser;
let outsider: TestUser;
let wsA: string;
let orgA: string;
let wsB: string;

const worker = () => asService({ workspaceId: wsA, organizationId: orgA });
const unscoped = asService({});
const token = () =>
  uniq()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Runs `fn` as the database owner and rolls it all back, so handsfreeos.com is never held past the test. Core's
 * suite holds the name for real, in parallel, so both take turns on the same lock.
 */
async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
  const undo = new Error('roll back');
  await dbs.admin.db
    .transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hfos-test:handsfreeos.com'))`);
      await fn(tx);
      throw undo;
    })
    .catch((e: unknown) => {
      if (e !== undo) throw e;
    });
}

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('receiving-owner'),
    createTestUser('receiving-member'),
    createTestUser('receiving-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Receiving Org A', 'Receiving A');
  wsA = a.wsId;
  orgA = a.orgId;
  wsB = (await bootstrapOrganization(outsider, 'Receiving Org B', 'Receiving B')).wsId;
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values({ workspaceId: wsA, userId: member.id, role: 'member' });
});
afterAll(closeAll);

/** A domain of wsA's, verified by the worker as the daily check would. */
async function verifiedDomain(): Promise<{ id: string; domain: string }> {
  const domain = `${token()}.example.com`;
  const [d] = await as(owner)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.email_domains (workspace_id, domain, created_by)
          values (${wsA}, ${domain}, ${owner.id}) returning id`,
    ),
  );
  await worker()((tx) =>
    rows(
      tx,
      sql`update app.email_domains set status = 'verified', dkim_verified_at = now(), return_path_verified_at = now()
          where id = ${d!.id}`,
    ),
  );
  return { id: d!.id, domain };
}

const receiving = async (id: string) =>
  (
    await rows<{ receiving: string }>(
      dbs.admin.db,
      sql`select receiving::text as receiving from app.email_domains where id = ${id}`,
    )
  )[0]!.receiving;

const route = (address: string) =>
  unscoped((tx) =>
    rows<{ email_address_id: string; workspace_id: string; organization_id: string }>(
      tx,
      sql`select email_address_id, workspace_id, organization_id from private.email_receiving_route(${address})`,
    ),
  );

describe('turning receiving on', () => {
  it('is for owners and admins, on a verified domain; only the worker says it is on', async () => {
    const pendingName = `${token()}.example.com`;
    const [pending] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.email_domains (workspace_id, domain, created_by)
            values (${wsA}, ${pendingName}, ${owner.id}) returning id`,
      ),
    );
    const ask = (u: TestUser, id: string, to: string) =>
      as(u)((tx) =>
        rows(
          tx,
          sql`update app.email_domains set receiving = ${to}::app.email_receiving_status
              where id = ${id} returning id`,
        ),
      );
    // Not verified yet: nobody has proved the name is theirs.
    const unproved = await expectPgError(() => ask(owner, pending!.id, 'pending'));
    expect(unproved).toMatchObject({ code: '23514', detail: 'email_domain_unverified' });

    const { id } = await verifiedDomain();
    // A member can't, and an outsider doesn't even see it.
    expect(await ask(member, id, 'pending')).toHaveLength(0);
    expect(await ask(outsider, id, 'pending')).toHaveLength(0);
    expect(await receiving(id)).toBe('off');

    expect(await ask(owner, id, 'pending')).toHaveLength(1);
    expect(await receiving(id)).toBe('pending');
    const claimed = await expectPgError(() => ask(owner, id, 'on'));
    expect(claimed).toMatchObject({ code: '42501', detail: 'email_domain_provider_fields' });
    // Nor any other column: people write `receiving` and nothing else.
    const stamp = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.email_domains set mx_verified_at = now() where id = ${id}`),
      ),
    );
    expect(stamp.code).toBe('42501');

    await worker()((tx) =>
      rows(
        tx,
        sql`update app.email_domains set receiving = 'on', mx_verified_at = now() where id = ${id}`,
      ),
    );
    expect(await receiving(id)).toBe('on');
    expect(await ask(owner, id, 'off')).toHaveLength(1);
    expect(await receiving(id)).toBe('off');
  });
});

describe('where mail to a receiving domain goes', () => {
  it('to the address, or the default address when nobody has that name, while it receives', async () => {
    const { id, domain } = await verifiedDomain();
    const [chris] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.email_addresses (workspace_id, email_domain_id, local_part, address, display_name, created_by)
            values (${wsA}, ${id}, 'chris', ${`chris@${domain}`}, 'Receiving A', ${owner.id}) returning id`,
      ),
    );
    const [fallback] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`select id from app.email_addresses where workspace_id = ${wsA} and is_default`,
    );
    const set = (to: string) =>
      worker()((tx) =>
        rows(
          tx,
          sql`update app.email_domains set receiving = ${to}::app.email_receiving_status where id = ${id}`,
        ),
      );

    await set('pending');
    expect(await route(`chris@${domain}`)).toHaveLength(0);

    await set('on');
    expect(await route(`Chris@${domain.toUpperCase()}`)).toEqual([
      { email_address_id: chris!.id, workspace_id: wsA, organization_id: orgA },
    ]);
    expect(await route(`nobody@${domain}`)).toEqual([
      { email_address_id: fallback!.id, workspace_id: wsA, organization_id: orgA },
    ]);
    // Another business's address on this domain can't exist, and a domain nobody receives routes nowhere.
    expect(await route(`chris@not-${domain}`)).toHaveLength(0);
    const listed = await unscoped((tx) =>
      rows<{ workspace_id: string }>(
        tx,
        sql`select workspace_id from private.email_receiving_to_check() where email_domain_id = ${id}`,
      ),
    );
    expect(listed).toEqual([{ workspace_id: wsA }]);

    // Lapsed while DNS catches up: mail that still arrives is still filed.
    await set('lapsed');
    expect(await route(`chris@${domain}`)).toHaveLength(1);

    await set('off');
    expect(await route(`chris@${domain}`)).toHaveLength(0);

    // People can't look the routes up; only the worker's webhook does.
    const denied = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`select * from private.email_receiving_route(${`chris@${domain}`})`),
      ),
    );
    expect(denied.code).toBe('42501');
  });
});

describe('handsfreeos.com', () => {
  it('is refused to every business but HandsFreeOS’s own, and its subdomains to everyone', async () => {
    const bare = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.email_domains (workspace_id, domain, created_by)
              values (${wsA}, 'handsfreeos.com', ${owner.id})`,
        ),
      ),
    );
    expect(bare).toMatchObject({ code: '23514', detail: 'email_domain_ours' });

    await rolledBack(async (tx) => {
      await rows(tx, sql`update app.workspaces set is_platform = true where id = ${wsB}`);
      const [d] = await rows<{ id: string }>(
        tx,
        sql`insert into app.email_domains (workspace_id, domain, status)
            values (${wsB}, 'handsfreeos.com', 'verified') returning id`,
      );
      expect(d).toBeDefined();
      // Its names are the business's, except the ones the support desk and HandsFreeOS's own mail use.
      const [chris] = await rows<{ address: string }>(
        tx,
        sql`insert into app.email_addresses (workspace_id, email_domain_id, local_part, address, display_name)
            values (${wsB}, ${d!.id}, 'chris', '', 'HandsFreeOS') returning address`,
      );
      expect(chris!.address).toBe('chris@handsfreeos.com');
    });

    for (const name of ['support', 'help', 'no-reply', 'alerts'])
      await rolledBack(async (tx) => {
        await rows(tx, sql`update app.workspaces set is_platform = true where id = ${wsB}`);
        const [d] = await rows<{ id: string }>(
          tx,
          sql`insert into app.email_domains (workspace_id, domain, status)
              values (${wsB}, 'handsfreeos.com', 'verified') returning id`,
        );
        const kept = await expectPgError(() =>
          tx.transaction((inner) =>
            rows(
              inner,
              sql`insert into app.email_addresses (workspace_id, email_domain_id, local_part, address, display_name)
                  values (${wsB}, ${d!.id}, ${name}, '', 'HandsFreeOS')`,
            ),
          ),
        );
        expect(kept).toMatchObject({ code: '23514', detail: 'email_local_part_reserved' });
      });

    // A subdomain is nobody's, not even HandsFreeOS's own business's.
    await rolledBack(async (tx) => {
      await rows(tx, sql`update app.workspaces set is_platform = true where id = ${wsB}`);
      const sub = await expectPgError(() =>
        tx.transaction((inner) =>
          rows(
            inner,
            sql`insert into app.email_domains (workspace_id, domain) values (${wsB}, 'mail.handsfreeos.com')`,
          ),
        ),
      );
      expect(sub.code).toBe('23514');
    });
  });

  it('only a staff admin marks HandsFreeOS’s own business', async () => {
    const direct = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.workspaces set is_platform = true where id = ${wsA}`),
      ),
    );
    expect(direct).toMatchObject({ code: '42501', detail: 'is_platform_is_ours' });
    const viaFunction = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`select * from private.set_platform_workspace(${wsA}::uuid, true)`),
      ),
    );
    expect(viaFunction).toMatchObject({ code: '42501', detail: 'is_platform_is_ours' });
    const [w] = await rows<{ is_platform: boolean }>(
      dbs.admin.db,
      sql`select is_platform from app.workspaces where id = ${wsA}`,
    );
    expect(w!.is_platform).toBe(false);
  });
});
