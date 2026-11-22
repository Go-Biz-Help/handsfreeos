import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, rows, sql, type Tx } from '../src/client';
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

/**
 * Viewing the app as a teammate (20261018000100), held by the database rather than by the API: who may open a view
 * (private.may_view_as, in the insert's own policy), that a view is only ever ended, that nobody reads anyone
 * else's views, and that a request read through a view never shows more than the viewer could see
 * (20261027032800): not the teammate's own mail, safety contacts, check-ins or About you, not an add-on's rows kept
 * to them, and a private record only when the viewer sees it too, support through a grant.
 */
let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let stranger: TestUser;
let wsId: string;
let orgId: string;
let privateThread: string;
let teamThread: string;

const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const mayViewAs = (viewer: TestUser, person: TestUser) =>
  as(viewer)(async (tx) => {
    const [r] = await rows<{ ok: boolean }>(
      tx,
      sql`select private.may_view_as(${wsId}::uuid, ${person.id}::uuid) as ok`,
    );
    return r!.ok;
  });
const openView = (viewer: TestUser, person: TestUser) =>
  as(viewer)(async (tx) => {
    const [r] = await rows<{ id: string }>(
      tx,
      sql`insert into app.teammate_views (workspace_id, organization_id, viewer_id, person_id)
          values (${wsId}, ${orgId}, ${viewer.id}, ${person.id}) returning id`,
    );
    return r!.id;
  });

beforeAll(async () => {
  [owner, admin, member, stranger] = await Promise.all([
    createTestUser('tv-rls-owner'),
    createTestUser('tv-rls-admin'),
    createTestUser('tv-rls-member'),
    createTestUser('tv-rls-stranger'),
  ]);
  const b = await bootstrapOrganization(owner, 'Viewed Org', 'Viewed Business');
  wsId = b.wsId;
  orgId = b.orgId;
  await dbs.admin.db.execute(
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${admin.id}, 'admin'), (${wsId}, ${member.id}, 'member')`,
  );
  // A thread of the member's own mail (M19), and one of the team's.
  const [domain] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.email_domains (workspace_id, domain, status, receiving, ownership_proved_at)
        values (${wsId}, ${`tv-${Date.now()}.example.com`}, 'verified', 'on', now()) returning id`,
  );
  const [address] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.email_addresses (workspace_id, email_domain_id, local_part, address, display_name, owner_user_id)
        values (${wsId}, ${domain!.id}, 'member', ${`member@tv-${Date.now()}.example.com`}, 'Member', ${member.id})
        returning id`,
  );
  [privateThread, teamThread] = (
    await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.conversations (workspace_id, channel, counterpart, email_address_id, private_to)
          values (${wsId}, 'email', 'friend@example.com', ${address!.id}, ${member.id}),
                 (${wsId}, 'sms', '+15125550199', null, null)
          returning id`,
    )
  ).map((r) => r.id) as [string, string];
});
afterAll(closeAll);

describe('who may view as whom', () => {
  it('down the roles, never across or up, and never as yourself or a stranger', async () => {
    expect(await mayViewAs(owner, admin)).toBe(true);
    expect(await mayViewAs(owner, member)).toBe(true);
    expect(await mayViewAs(admin, member)).toBe(true);
    expect(await mayViewAs(admin, owner)).toBe(false);
    expect(await mayViewAs(member, admin)).toBe(false);
    expect(await mayViewAs(owner, owner)).toBe(false);
    expect(await mayViewAs(owner, stranger)).toBe(false);
    expect(await mayViewAs(stranger, member)).toBe(false);
  });

  it('not by someone shown only their own threads, as someone who has some', async () => {
    await dbs.admin.db.execute(
      sql`insert into app.role_permission_overrides (workspace_id, role, permission, allowed)
          values (${wsId}, 'admin', 'channels.manage', false)`,
    );
    await dbs.admin.db.execute(
      sql`update app.workspaces set settings = jsonb_set(settings, '{inbox}', '{"perPerson": true}')
          where id = ${wsId}`,
    );
    try {
      expect(await mayViewAs(admin, member)).toBe(false);
      expect(await mayViewAs(owner, member)).toBe(true);
    } finally {
      await dbs.admin.db.execute(
        sql`update app.workspaces set settings = settings - 'inbox' where id = ${wsId}`,
      );
      await dbs.admin.db.execute(
        sql`delete from app.role_permission_overrides where workspace_id = ${wsId} and role = 'admin'`,
      );
    }
    expect(await mayViewAs(admin, member)).toBe(true);
  });

  it('a view the rule refuses can’t be written, whatever the request says', async () => {
    expect(await code(() => openView(admin, owner))).toBe('42501');
    expect(await code(() => openView(stranger, member))).toBe('42501');
    // Nor one in someone else's name.
    expect(
      await code(() =>
        as(admin)((tx) =>
          tx.execute(
            sql`insert into app.teammate_views (workspace_id, organization_id, viewer_id, person_id)
                values (${wsId}, ${orgId}, ${owner.id}, ${member.id})`,
          ),
        ),
      ),
    ).toBe('42501');
  });
});

describe('a view', () => {
  let viewId: string;

  beforeAll(async () => {
    viewId = await openView(owner, member);
  });

  it('is its viewer’s alone to read', async () => {
    const read = (u: TestUser) =>
      as(u)((tx) => rows(tx, sql`select id from app.teammate_views where id = ${viewId}`));
    expect(await read(owner)).toHaveLength(1);
    expect(await read(admin)).toHaveLength(0);
    expect(await read(member)).toHaveLength(0);
  });

  it('says whether it holds, to its viewer only', async () => {
    const look = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ live: boolean; person_id: string }>(
          tx,
          sql`select live, person_id from private.teammate_view(${viewId}::uuid)`,
        ),
      );
    expect(await look(owner)).toEqual([{ live: true, person_id: member.id }]);
    expect(await look(admin)).toEqual([]);
  });

  it('is only ever ended', async () => {
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`update app.teammate_views set person_id = ${admin.id} where id = ${viewId}`,
          ),
        ),
      ),
    ).toBe('42501');
    await as(owner)((tx) =>
      tx.execute(sql`update app.teammate_views set ended_at = now() where id = ${viewId}`),
    );
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.teammate_views set ended_at = null where id = ${viewId}`),
        ),
      ),
    ).toBe('42501');
  });
});

describe('read through a view', () => {
  /** As the member, the way the API reads once a view holds: their claims, naming who is looking. */
  const throughView = <T>(fn: Parameters<typeof asUser<T>>[2]) =>
    asUser(dbs.api.db, { ...member.claims, hfos_viewer: owner.id }, fn);

  it('their own mail is theirs alone: the thread and its messages', async () => {
    const threads = (read: typeof throughView) =>
      read((tx) =>
        rows<{ id: string }>(
          tx,
          sql`select id from app.conversations where id in (${privateThread}, ${teamThread})`,
        ),
      );
    const asThemselves = <T>(fn: Parameters<typeof asUser<T>>[2]) =>
      asUser(dbs.api.db, member.claims, fn);
    expect((await threads(asThemselves)).map((r) => r.id).sort()).toEqual(
      [privateThread, teamThread].sort(),
    );
    expect((await threads(throughView)).map((r) => r.id)).toEqual([teamThread]);
  });

  it('even where the business shows each person only their own threads', async () => {
    await dbs.admin.db.execute(
      sql`update app.workspaces set settings = jsonb_set(settings, '{inbox}', '{"perPerson": true}')
          where id = ${wsId}`,
    );
    try {
      const [narrowed] = await throughView((tx) =>
        rows<{ n: boolean }>(tx, sql`select private.inbox_narrowed(${wsId}::uuid) as n`),
      );
      const seen = await throughView((tx) =>
        rows<{ id: string }>(tx, sql`select id from app.conversations where id = ${privateThread}`),
      );
      // The member arm (0083) answers for a private thread's person; through a view it doesn't.
      expect(narrowed?.n).toBe(true);
      expect(seen).toEqual([]);
    } finally {
      await dbs.admin.db.execute(
        sql`update app.workspaces set settings = settings - 'inbox' where id = ${wsId}`,
      );
    }
  });
});

/** Reads as someone: as themselves (`as`), or through a view of them (`through`). */
type Reader = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
/** As `person`, the way the API reads once `viewer`'s view of them holds: their claims, naming who is looking. */
const through =
  (person: TestUser, viewer: TestUser): Reader =>
  (fn) =>
    asUser(dbs.api.db, { ...person.claims, hfos_viewer: viewer.id }, fn);
const ids = (found: Promise<{ id: string }[]>) => found.then((r) => r.map((x) => x.id).sort());

describe('a person’s own things, through a view', () => {
  const checkInId = randomUUID();

  beforeAll(async () => {
    await as(member)((tx) =>
      rows(
        tx,
        sql`insert into app.safety_contacts (workspace_id, user_id, name, phone_e164)
            values (${wsId}, ${member.id}, 'Mum', '+15125550142')`,
      ),
    );
    await as(member)((tx) =>
      rows(
        tx,
        sql`insert into app.safety_checkins (id, workspace_id, user_id, place, started_at, planned_end_at)
            values (${checkInId}, ${wsId}, ${member.id}, '2207 Juniper Trail', now(), now() + interval '1 hour')`,
      ),
    );
    await as(member)((tx) =>
      rows(
        tx,
        sql`insert into app.user_about (user_id, about) values (${member.id}, 'Two kids, one dog.')`,
      ),
    );
    // The check-out was missed and the admin, their teammate contact, was told in the app.
    await asService({ workspaceId: wsId, organizationId: orgId })(async (tx) => {
      await rows(tx, sql`update app.safety_checkins set state = 'alerted' where id = ${checkInId}`);
      await rows(
        tx,
        sql`insert into app.safety_escalations (workspace_id, checkin_id, told_user_id, channel)
            values (${wsId}, ${checkInId}, ${admin.id}, 'app')`,
      );
    });
  });

  const safety = (read: Reader) =>
    read(async (tx) => ({
      contacts: (
        await rows<{ name: string }>(
          tx,
          sql`select name from app.safety_contacts where workspace_id = ${wsId}`,
        )
      ).map((r) => r.name),
      checkIns: (
        await rows<{ place: string }>(
          tx,
          sql`select place from app.safety_checkins where workspace_id = ${wsId}`,
        )
      ).map((r) => r.place),
      told: (
        await rows<{ channel: string }>(
          tx,
          sql`select channel from app.safety_escalations where checkin_id = ${checkInId}`,
        )
      ).map((r) => r.channel),
      about: (
        await rows<{ about: string }>(
          tx,
          sql`select about from app.user_about where user_id = ${member.id}`,
        )
      ).map((r) => r.about),
    }));

  it('their safety contacts, check-in, who was told and About you are theirs, not a viewer’s', async () => {
    expect(await safety(as(member))).toEqual({
      contacts: ['Mum'],
      checkIns: ['2207 Juniper Trail'],
      told: ['app'],
      about: ['Two kids, one dog.'],
    });
    expect(await safety(through(member, owner))).toEqual({
      contacts: [],
      checkIns: [],
      told: [],
      about: [],
    });
  });

  it('a teammate told of a missed check-out reads it as themselves, and nobody viewing as them does', async () => {
    const told = (read: Reader) =>
      read((tx) =>
        rows<{ place: string }>(
          tx,
          sql`select place from private.safety_checkin_for_contact(${wsId}::uuid, ${checkInId}::uuid)`,
        ),
      );
    expect(await told(as(admin))).toEqual([{ place: '2207 Juniper Trail' }]);
    expect(await told(through(admin, owner))).toEqual([]);
  });
});

describe('a private record, through a view', () => {
  const letters = (n: number) =>
    Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join('');
  const ADDON = `tv${letters(8)}`;
  const SEE_ALL = `${ADDON}.all_deals`;
  let support: TestUser;
  let deal: string;
  let task: string;
  let open: string;

  const records = (read: Reader) =>
    ids(
      read((tx) =>
        rows<{ id: string }>(
          tx,
          sql`select id from app.custom_records where id in (${deal}, ${open})`,
        ),
      ),
    );
  const tasks = (read: Reader) =>
    ids(read((tx) => rows<{ id: string }>(tx, sql`select id from app.tasks where id = ${task}`)));
  /** What hangs off it in an add-on's tables, threads and appointments asks this. */
  const unseen = (read: Reader) =>
    read((tx) =>
      rows<{ id: string }>(tx, sql`select u as id from private.unseen_private_records() u`),
    ).then((r) => r.some((x) => x.id === deal));
  const sorted = (...xs: string[]) => [...xs].sort();

  beforeAll(async () => {
    support = await createTestUser('tv-rls-support');
    await rows(
      dbs.admin.db,
      sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify([
        { key: `${ADDON}.use`, defaultRoles: ['admin', 'member'], requires: [] },
        { key: SEE_ALL, defaultRoles: ['admin'], requires: [`${ADDON}.use`] },
      ])}::jsonb)`,
    );
    await as(owner)((tx) =>
      rows(
        tx,
        sql`select * from private.addon_move(${wsId}, ${ADDON}, 'installing', '1.0.0', 1, 1)`,
      ),
    );
    const worker = asService({ workspaceId: wsId, organizationId: orgId });
    await worker((tx) =>
      rows(
        tx,
        sql`update app.addon_installations set state = 'enabled'
            where workspace_id = ${wsId} and addon_id = ${ADDON}`,
      ),
    );
    // This admin doesn't see every deal: an owner turned it off for them.
    await rows(
      dbs.admin.db,
      sql`insert into app.member_permission_overrides (workspace_id, user_id, permission, allowed)
          values (${wsId}, ${admin.id}, ${SEE_ALL}, false)`,
    );
    const [kind] = await worker((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission,
            kept_to_team, see_all_permission)
          values (${wsId}, ${`${ADDON}_deal`}, 'Deal', 'Deals', ${ADDON}, ${`${ADDON}.use`}, true, ${SEE_ALL})
          returning id`,
      ),
    );
    // The member's own deal, and a task on it.
    [{ id: deal }] = (await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_records (workspace_id, type_id, name, created_by)
            values (${wsId}, ${kind!.id}, 'Smith purchase', ${member.id}) returning id`,
      ),
    )) as [{ id: string }];
    [{ id: task }] = (await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.tasks (workspace_id, title, custom_record_id, created_by, assignee_user_id)
            values (${wsId}, 'Order the appraisal', ${deal}, ${member.id}, ${member.id}) returning id`,
      ),
    )) as [{ id: string }];
    // And a record kept to nobody, which every view shows as before.
    const [petKind] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_record_types (workspace_id, key, singular, plural, created_by)
            values (${wsId}, 'pet', 'Pet', 'Pets', ${owner.id}) returning id`,
      ),
    );
    [{ id: open }] = (await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_records (workspace_id, type_id, name, created_by)
            values (${wsId}, ${petKind!.id}, 'Biscuit', ${owner.id}) returning id`,
      ),
    )) as [{ id: string }];
    // Support, with the business open in a look.
    await rows(
      dbs.admin.db,
      sql`insert into platform.staff (user_id, role, status) values (${support.id}, 'agent', 'active')`,
    );
    await rows(
      dbs.admin.db,
      sql`insert into platform.view_as_sessions (staff_user_id, workspace_id, organization_id, reason, expires_at)
          values (${support.id}, ${wsId}, ${orgId}, 'Ticket 3301', now() + interval '1 hour')`,
    );
  });

  it('the person on it still sees it and what hangs off it, as themselves', async () => {
    expect(await records(as(member))).toEqual(sorted(deal, open));
    expect(await tasks(as(member))).toEqual([task]);
    expect(await unseen(as(member))).toBe(false);
  });

  it('an admin who doesn’t see every deal sees none of theirs by viewing as them', async () => {
    expect(await mayViewAs(admin, member)).toBe(true);
    expect(await records(as(admin))).toEqual([open]);
    expect(await records(through(member, admin))).toEqual([open]);
    expect(await tasks(through(member, admin))).toEqual([]);
    expect(await unseen(through(member, admin))).toBe(true);
    const [visible] = await through(
      member,
      admin,
    )((tx) =>
      rows<{ ok: boolean }>(tx, sql`select private.custom_record_visible(${deal}::uuid) as ok`),
    );
    expect(visible?.ok).toBe(false);
  });

  it('an owner, who sees every deal, sees it through a view as before', async () => {
    expect(await records(through(member, owner))).toEqual(sorted(deal, open));
    expect(await tasks(through(member, owner))).toEqual([task]);
    expect(await unseen(through(member, owner))).toBe(false);
  });

  it('support viewing as the owner sees it only once someone on it lets them in', async () => {
    const asOwner = through(owner, support);
    // Everything else the owner sees, support sees through the view.
    expect(
      await ids(
        asOwner((tx) =>
          rows<{ id: string }>(tx, sql`select id from app.conversations where id = ${teamThread}`),
        ),
      ),
    ).toEqual([teamThread]);
    expect(await records(asOwner)).toEqual([open]);
    expect(await tasks(asOwner)).toEqual([]);
    expect(await unseen(asOwner)).toBe(true);

    const [grant] = await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`select * from private.grant_support_access(${wsId}::uuid, null::uuid)`,
      ),
    );
    expect(await records(asOwner)).toEqual(sorted(deal, open));
    expect(await tasks(asOwner)).toEqual([task]);
    expect(await unseen(asOwner)).toBe(false);

    await as(member)((tx) =>
      rows(tx, sql`select private.end_support_access(${wsId}::uuid, ${grant!.id}::uuid)`),
    );
    expect(await records(asOwner)).toEqual([open]);
  });
});

describe('an add-on’s rows kept to their person', () => {
  it('are each hidden from a view, by a restrictive rule beside the one that keeps them', async () => {
    const own = await rows<{ t: string; viewed: boolean }>(
      dbs.admin.db,
      sql`select p.polrelid::regclass::text as t,
            exists (select 1 from pg_policy v where v.polrelid = p.polrelid and not v.polpermissive
                      and v.polcmd in ('r', '*')
                      and pg_get_expr(v.polqual, v.polrelid) like '%read_through_a_view()%') as viewed
          from pg_policy p
          join pg_class c on c.oid = p.polrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname ~ '^addon_[a-z]{2,16}$' and not p.polpermissive and p.polcmd in ('r', '*')
            and p.polroles @> array['authenticated'::regrole::oid]
            and pg_get_expr(p.polqual, p.polrelid) like '%user_id = ( SELECT auth.uid() AS uid)%'`,
    );
    expect(own.length).toBeGreaterThan(30);
    expect(own.filter((r) => !r.viewed).map((r) => r.t)).toEqual([]);
  });
});
