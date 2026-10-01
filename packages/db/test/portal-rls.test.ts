/**
 * What a customer signed in to their portal reads (Real Estate round two, step 3): as `portal_actor`, with only their
 * device's session to go on, they see themselves, their business's name, the records they're on through a
 * portal-visible relationship and an add-on's rows about those, only the columns allowed, and only while the session
 * is live and the add-on is on. They write nothing, and nobody else can become them.
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql, type Tx } from '../src/client';
import {
  as,
  asPortal,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join('');
const ADDON = `fx${letters(8)}`;
const SCHEMA = `addon_${ADDON}`;
const TABLE = `${SCHEMA}.milestones`;

let owner: TestUser;
let ws: string;
let otherWs: string;
let linh: string;
let omar: string;
let mine: string;
let theirs: string;
let notAsClient: string;
let session: string;
let omarSession: string;

const admin = () => dbs.admin.db;
const one = async (q: Promise<{ id: string }[]>) => (await q)[0]!.id;
const ids = (r: { id: string }[]) => r.map((x) => x.id).sort();
const sorted = (...x: string[]) => [...x].sort();
const denied = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;

async function person(workspace: string, first: string): Promise<string> {
  return one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, email, notes)
          values (${workspace}, ${first}, 'Client', ${`${first.toLowerCase()}-${letters(5)}@example.com`},
            'Prefers texts after 6')
          returning id`,
    ),
  );
}

/** A live device for this person. */
async function signedIn(personId: string, workspace = ws): Promise<string> {
  const access = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.portal_access (workspace_id, person_id, given_by) values (${workspace}, ${personId}, ${owner.id})
          on conflict (workspace_id, person_id) do update set given_at = excluded.given_at returning id`,
    ),
  );
  return one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.portal_sessions (workspace_id, access_id, person_id, token_hash, expires_at)
          values (${workspace}, ${access}, ${personId}, ${createHash('sha256').update(randomBytes(32)).digest()},
            now() + interval '90 days')
          returning id`,
    ),
  );
}

beforeAll(async () => {
  owner = await createTestUser('portal-rls-owner');
  ({ wsId: ws } = await bootstrapOrganization(owner, 'Portal RLS Org', 'Portal RLS Realty'));
  ({ wsId: otherWs } = await bootstrapOrganization(owner, 'Portal RLS Other', 'Other Realty'));
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, ${ADDON}, 'enabled', '1.0.0')`,
  );
  const kind = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission)
          values (${ws}, ${`${ADDON}_deal`}, 'Deal', 'Deals', ${ADDON}, ${`${ADDON}.write`}) returning id`,
    ),
  );
  const type = async (key: string, label: string, portal: boolean) =>
    one(
      rows<{ id: string }>(
        admin(),
        sql`insert into app.relationship_types (workspace_id, a_end, a_label, b_end, b_record_type_id, b_label,
              addon_id, addon_key, portal_visible)
            values (${ws}, 'person', ${label}, 'custom_record', ${kind}, 'Deal', ${ADDON}, ${`${ADDON}_${key}`},
              ${portal})
            returning id`,
      ),
    );
  const client = await type('client', 'Client', true);
  const vendor = await type('vendor', 'Vendor', false);
  const record = (name: string) =>
    one(
      rows<{ id: string }>(
        admin(),
        sql`insert into app.custom_records (workspace_id, type_id, name, notes)
            values (${ws}, ${kind}, ${name}, 'Seller is motivated') returning id`,
      ),
    );
  [linh, omar] = [await person(ws, 'Linh'), await person(ws, 'Omar')];
  [mine, theirs, notAsClient] = [
    await record('Nguyen purchase'),
    await record('Haddad purchase'),
    await record('Lopez sale'),
  ];
  const relate = (p: string, r: string, t: string) =>
    rows(
      admin(),
      sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id)
          values (${ws}, ${t}, ${p}, ${r})`,
    );
  await relate(linh, mine, client);
  await relate(omar, theirs, client);
  await relate(linh, notAsClient, vendor);

  // The add-on's own table, as its migration would make it.
  await admin().transaction(async (tx: Tx) => {
    await tx.execute(sql`select private.create_addon_schema(${ADDON})`);
    await tx.execute(
      sql.raw(`create table ${TABLE} (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references app.workspaces (id) on delete cascade,
        deal_record_id uuid not null references app.custom_records (id) on delete cascade,
        label text not null,
        agent_note text,
        created_at timestamptz not null default now())`),
    );
    await tx.execute(
      sql`select private.addon_table_policies(${TABLE}::regclass, ${`${ADDON}.read`}, ${`${ADDON}.write`}, null, 'deal_record_id')`,
    );
    await tx.execute(
      sql`select private.addon_portal_policies(${TABLE}::regclass, 'deal_record_id', array['id', 'label']::name[])`,
    );
  });
  for (const [deal, label] of [
    [mine, 'Inspection'],
    [theirs, 'Appraisal'],
    [notAsClient, 'Listing photos'],
  ] as const)
    await rows(
      admin(),
      sql.raw(
        `insert into ${TABLE} (workspace_id, deal_record_id, label, agent_note)
         values ('${ws}', '${deal}', '${label}', 'Call the lender first')`,
      ),
    );
  session = await signedIn(linh);
  omarSession = await signedIn(omar);
});
afterAll(async () => {
  await rows(admin(), sql.raw(`drop schema if exists ${SCHEMA} cascade`));
  await closeAll();
});

describe('a signed-in customer', () => {
  it('sees themselves and their business, and nobody else', async () => {
    const got = await asPortal(session)(async (tx) => ({
      people: ids(await rows<{ id: string }>(tx, sql`select id from app.people`)),
      business: await rows<{ name: string }>(tx, sql`select name from app.workspaces`),
    }));
    expect(got).toEqual({ people: [linh], business: [{ name: 'Portal RLS Realty' }] });
  });

  it('sees the records they’re a client on, and not the ones they’re on another way', async () => {
    const seen = await asPortal(session)((tx) =>
      rows<{ id: string }>(tx, sql`select id from app.custom_records`),
    );
    expect(ids(seen)).toEqual([mine]);
    const omars = await asPortal(omarSession)((tx) =>
      rows<{ id: string }>(tx, sql`select id from app.custom_records`),
    );
    expect(ids(omars)).toEqual([theirs]);
  });

  it('reads an add-on’s rows about them, only the columns it allows', async () => {
    const seen = await asPortal(session)((tx) =>
      rows<{ label: string }>(tx, sql.raw(`select label from ${TABLE}`)),
    );
    expect(seen).toEqual([{ label: 'Inspection' }]);
    expect(
      await denied(() =>
        asPortal(session)((tx) => rows(tx, sql.raw(`select agent_note from ${TABLE}`))),
      ),
    ).toBe('42501');
  });

  it('never reads the business’s notes, or anything else of the business', async () => {
    for (const q of [
      sql`select notes from app.people`,
      sql`select notes from app.custom_records`,
      sql`select id from app.tasks`,
      sql`select id from app.conversations`,
      sql`select id from app.audit_logs`,
      sql`select id from app.portal_sessions`,
      sql`select id from app.portal_codes`,
      sql`select id from app.relationships`,
    ])
      expect(await denied(() => asPortal(session)((tx) => rows(tx, q)))).toBe('42501');
  });

  it('reaches none of the helpers written for people in a business', async () => {
    for (const q of [
      sql`select * from private.unseen_private_records()`,
      sql`select private.user_sees_record(${owner.id}::uuid, ${mine}::uuid)`,
      sql`select * from private.portal_records_for(${ws}::uuid, ${omar}::uuid)`,
    ])
      expect(await denied(() => asPortal(session)((tx) => rows(tx, q)))).toBe('42501');
  });

  it('writes nothing', async () => {
    for (const q of [
      sql`update app.people set first_name = 'L' where id = ${linh}`,
      sql`insert into app.custom_records (workspace_id, type_id, name) select workspace_id, type_id, 'Mine too' from app.custom_records limit 1`,
      sql.raw(`update ${TABLE} set label = 'Done'`),
      sql.raw(`delete from ${TABLE}`),
    ])
      expect(await denied(() => asPortal(session)((tx) => rows(tx, q)))).toBe('42501');
  });
});

describe('files', () => {
  const file = (
    recordType: string,
    recordId: string,
    opts: { visible: boolean; deleted?: boolean; by?: string },
  ) =>
    one(
      rows<{ id: string }>(
        admin(),
        sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, status, portal_visible,
              deleted_at, uploaded_by_person_id)
            values (${ws}, ${recordType}::app.record_type, ${recordId},
              ${`${ws}/${recordType}/${recordId}/${randomUUID()}/f.pdf`}, 'f.pdf', 'ready', ${opts.visible},
              ${opts.deleted ? new Date().toISOString() : null}::timestamptz, ${opts.by ?? null})
            returning id`,
      ),
    );

  it('shows a customer the files shown to them, on their records and on them, and only a few columns', async () => {
    const shared = await file('custom_record', mine, { visible: true });
    const theirsToo = await file('person', linh, { visible: true, by: linh });
    await file('custom_record', mine, { visible: false });
    await file('custom_record', mine, { visible: true, deleted: true });
    await file('custom_record', theirs, { visible: true });
    await file('custom_record', notAsClient, { visible: true });
    await file('person', omar, { visible: true });
    const seen = await asPortal(session)((tx) =>
      rows<{ id: string }>(tx, sql`select id from app.files`),
    );
    expect(ids(seen)).toEqual(sorted(shared, theirsToo));
    expect(
      await denied(() =>
        asPortal(session)((tx) => rows(tx, sql`select object_path from app.files`)),
      ),
    ).toBe('42501');
  });

  it('lets nobody in the business say a customer added one, or put the business’s own papers in a portal', async () => {
    expect(
      await denied(() =>
        as(owner)((tx) =>
          rows(
            tx,
            sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, created_by,
                  uploaded_by_person_id)
                values (${ws}, 'custom_record', ${mine}, ${`${ws}/custom_record/${mine}/${randomUUID()}/x.pdf`}, 'x.pdf',
                  ${owner.id}, ${linh})`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await denied(() =>
        rows(
          admin(),
          sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, portal_visible)
              values (${ws}, 'knowledge', ${randomUUID()}, ${`${ws}/knowledge/${randomUUID()}/x.pdf`}, 'x.pdf', true)`,
        ),
      ),
    ).toBe('23514');
  });
});

describe('when it stops', () => {
  it('sees nothing once the device is signed out, or with no device at all', async () => {
    const gone = await signedIn(linh);
    await rows(
      admin(),
      sql`update app.portal_sessions set ended_at = now(), ended_reason = 'signed_out' where id = ${gone}`,
    );
    for (const s of [gone, randomUUID()]) {
      const seen = await asPortal(s)(async (tx) => [
        ...(await rows<{ id: string }>(tx, sql`select id from app.people`)),
        ...(await rows<{ id: string }>(tx, sql`select id from app.custom_records`)),
      ]);
      expect(seen).toEqual([]);
    }
  });

  it('sees no records of an add-on that is off', async () => {
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled' where workspace_id = ${ws} and addon_id = ${ADDON}`,
    );
    try {
      const seen = await asPortal(session)(async (tx) => [
        ...(await rows<{ id: string }>(tx, sql`select id from app.custom_records`)),
        ...(await rows<{ id: string }>(tx, sql.raw(`select id from ${TABLE}`))),
      ]);
      expect(seen).toEqual([]);
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled' where workspace_id = ${ws} and addon_id = ${ADDON}`,
      );
    }
  });

  it('keeps a session to its own business', async () => {
    const elsewhere = await person(otherWs, 'Linh');
    const s = await signedIn(elsewhere, otherWs);
    const seen = await asPortal(s)((tx) =>
      rows<{ id: string }>(tx, sql`select id from app.custom_records`),
    );
    expect(seen).toEqual([]);
  });
});

describe('nobody else', () => {
  it('can become a customer, or ask what a customer sees', async () => {
    expect(await denied(() => as(owner)((tx) => rows(tx, sql`set local role portal_actor`)))).toBe(
      '42501',
    );
    expect(
      await denied(() => as(owner)((tx) => rows(tx, sql`select * from portal.records()`))),
    ).toBe('42501');
  });

  it('marks a type of the business’s own as shown in the portal', async () => {
    const code = await denied(() =>
      rows(
        admin(),
        sql`insert into app.relationship_types (workspace_id, a_end, a_label, b_end, b_label, portal_visible)
            values (${ws}, 'person', 'Friend', 'person', 'Friend of', true)`,
      ),
    );
    expect(code).toBe('23514');
    expect(
      await denied(() =>
        as(owner)((tx) =>
          rows(
            tx,
            sql`update app.relationship_types set portal_visible = true where workspace_id = ${ws}`,
          ),
        ),
      ),
    ).toBe('42501');
  });

  it('sees the same rows as before', async () => {
    const seen = await as(owner)((tx) =>
      rows<{ id: string }>(tx, sql`select id from app.custom_records where workspace_id = ${ws}`),
    );
    expect(ids(seen)).toEqual(sorted(mine, theirs, notAsClient));
  });
});
