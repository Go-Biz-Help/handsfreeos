/**
 * A private record's appointments show only as busy (Real Estate round two, step 1). A fixture add-on's private kind
 * (a deal) with a tour on it: the people who see the deal see the appointment and who it's with; a member who isn't
 * on it sees neither, but still sees that its staff are busy then, so nobody double-books. Only people on the deal
 * work it, a Home card about it is sealed with it, and phones don't receive it.
 */
import { randomInt } from 'node:crypto';
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
  type TestUser,
} from './harness';
import { readSyncConfig } from './sync-config';

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join('');
const ADDON = `fx${letters(8)}`;
const SEE_ALL = `${ADDON}.all_deals`;

let owner: TestUser;
let agent: TestUser;
let teammate: TestUser;
let member: TestUser;
let broker: TestUser;
let ws: string;
let org: string;
let deal: string;
let calendar: string;
let person: string;
let tour: string;
let attendee: string;
let plain: string;

const worker = () => asService({ workspaceId: ws, organizationId: org });
const one = async (found: Promise<{ id: string }[]>): Promise<string> => (await found)[0]!.id;
const sorted = (...ids: string[]) => [...ids].sort();

async function sees(u: TestUser, table: string, ids: readonly string[]): Promise<string[]> {
  const found = await as(u)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`select id from ${sql.raw(table)} where id = any(array[${sql.join(
        ids.map((i) => sql`${i}::uuid`),
        sql`, `,
      )}])`,
    ),
  );
  return found.map((r) => r.id).sort();
}

/** An appointment tomorrow at `hour`, made by `u`, worked by `staff`. */
async function appointment(
  u: TestUser,
  opts: { hour: number; record?: string | null; staff: TestUser; title: string },
): Promise<string> {
  return as(u)(async (tx) => {
    const id = await one(
      rows<{ id: string }>(
        tx,
        sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
              source, created_by, custom_record_id, location, notes)
            values (${ws}, ${calendar}, 1, ${opts.title},
              date_trunc('day', now()) + interval '1 day' + make_interval(hours => ${opts.hour}),
              date_trunc('day', now()) + interval '1 day' + make_interval(hours => ${opts.hour + 2}),
              'staff', ${u.id}, ${opts.record ?? null}, '{"kind":"business","address":"418 Maple Ave"}'::jsonb,
              'Lockbox 4417')
            returning id`,
      ),
    );
    await rows(
      tx,
      sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id, during, blocked)
          select ${ws}, a.id, ${opts.staff.id}, tstzrange(a.starts_at, a.ends_at), tstzrange(a.starts_at, a.ends_at)
          from app.appointments a where a.id = ${id}`,
    );
    return id;
  });
}

beforeAll(async () => {
  [owner, agent, teammate, member, broker] = await Promise.all([
    createTestUser('busy-owner'),
    createTestUser('busy-agent'),
    createTestUser('busy-teammate'),
    createTestUser('busy-member'),
    createTestUser('busy-broker'),
  ]);
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(owner, 'Busy Org', 'Busy Realty'));
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: ws, userId: agent.id, role: 'member' },
    { workspaceId: ws, userId: teammate.id, role: 'member' },
    { workspaceId: ws, userId: member.id, role: 'member' },
    { workspaceId: ws, userId: broker.id, role: 'member' },
  ]);
  await rows(
    dbs.admin.db,
    sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify([
      { key: `${ADDON}.use`, defaultRoles: ['admin', 'member'], requires: [] },
      { key: SEE_ALL, defaultRoles: ['admin'], requires: [`${ADDON}.use`] },
    ])}::jsonb)`,
  );
  await as(owner)((tx) =>
    rows(tx, sql`select * from private.addon_move(${ws}, ${ADDON}, 'installing', '1.0.0', 1, 1)`),
  );
  await worker()((tx) =>
    rows(
      tx,
      sql`update app.addon_installations set state = 'enabled' where workspace_id = ${ws} and addon_id = ${ADDON}`,
    ),
  );
  await rows(
    dbs.admin.db,
    sql`insert into app.member_permission_overrides (workspace_id, user_id, permission, allowed)
        values (${ws}, ${broker.id}, ${SEE_ALL}, true)`,
  );
  const kind = await one(
    worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission,
            kept_to_team, see_all_permission)
          values (${ws}, ${`${ADDON}_deal`}, 'Deal', 'Deals', ${ADDON}, ${`${ADDON}.use`}, true, ${SEE_ALL})
          returning id`,
      ),
    ),
  );
  deal = await one(
    as(agent)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_records (workspace_id, type_id, name, created_by, team_user_ids)
          values (${ws}, ${kind}, 'Nguyen purchase', ${agent.id}, array[${teammate.id}]::uuid[])
          returning id`,
      ),
    ),
  );
  calendar = await one(
    worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.calendars (workspace_id, name, slug, status, public)
            values (${ws}, 'Showings', ${`showings-${letters(6)}`}, 'active', false) returning id`,
      ),
    ),
  );
  person = await one(
    rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Linh', 'Nguyen') returning id`,
    ),
  );
  tour = await appointment(agent, { hour: 10, record: deal, staff: agent, title: 'Home tour' });
  attendee = await one(
    as(agent)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, source, created_by)
            values (${ws}, ${tour}, ${person}, 'staff', ${agent.id}) returning id`,
      ),
    ),
  );
  plain = await appointment(member, { hour: 15, staff: member, title: 'Estimate walkthrough' });
});
afterAll(closeAll);

describe('an appointment on a private record', () => {
  it('is sealed, and so is who it’s with', async () => {
    const [a] = await rows<{ sealed: boolean }>(
      dbs.admin.db,
      sql`select sealed from app.appointments where id = ${tour}`,
    );
    const [t] = await rows<{ sealed: boolean }>(
      dbs.admin.db,
      sql`select sealed from app.appointment_attendees where id = ${attendee}`,
    );
    const [p] = await rows<{ sealed: boolean }>(
      dbs.admin.db,
      sql`select sealed from app.appointments where id = ${plain}`,
    );
    expect([a!.sealed, t!.sealed, p!.sealed]).toEqual([true, true, false]);
  });

  it('is seen only by the people who see the record', async () => {
    for (const u of [agent, teammate, owner, broker]) {
      expect(await sees(u, 'app.appointments', [tour, plain])).toEqual(sorted(tour, plain));
      expect(await sees(u, 'app.appointment_attendees', [attendee])).toEqual([attendee]);
    }
    expect(await sees(member, 'app.appointments', [tour, plain])).toEqual([plain]);
    expect(await sees(member, 'app.appointment_attendees', [attendee])).toEqual([]);
  });

  it('still shows its staff as busy to everyone else, and nothing more', async () => {
    const staffRows = await as(member)((tx) =>
      rows<{ user_id: string }>(
        tx,
        sql`select user_id from app.appointment_staff where appointment_id = ${tour}`,
      ),
    );
    expect(staffRows.map((r) => r.user_id)).toEqual([agent.id]);
    const busy = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ user_id: string; hours: number }>(
          tx,
          sql`select user_id, extract(epoch from ends_at - starts_at)::int / 3600 as hours
              from private.private_busy(${ws}, array[${agent.id}, ${member.id}]::uuid[], now(), now() + interval '3 days')`,
        ),
      );
    expect(await busy(member)).toEqual([{ user_id: agent.id, hours: 2 }]);
    // The people who can open it see the appointment itself instead.
    expect(await busy(teammate)).toEqual([]);
    expect(await busy(owner)).toEqual([]);
  });

  it('can’t be changed by someone who doesn’t see it', async () => {
    const changed = await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`update app.appointments set notes = 'Moved' where id = ${tour} returning id`,
      ),
    );
    expect(changed).toEqual([]);
  });

  it('is worked only by people on the record', async () => {
    const added = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id, during, blocked)
              select ${ws}, a.id, ${member.id}, tstzrange(a.starts_at, a.ends_at), tstzrange(a.starts_at, a.ends_at)
              from app.appointments a where a.id = ${tour}`,
        ),
      ),
    );
    expect(added.detail).toBe('appointment_staff_not_on_record');
    // Nor can an appointment someone off the record works be put on it.
    const moved = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.appointments set custom_record_id = ${deal} where id = ${plain}`),
      ),
    );
    expect(moved.detail).toBe('appointment_staff_not_on_record');
  });

  it('seals a Home card about it', async () => {
    const item = await one(
      worker()((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, title, fingerprint)
            values (${ws}, 'unconfirmed_appointment', 'appointment', ${tour}, 'Home tour', ${`a:${tour}`})
            returning id`,
        ),
      ),
    );
    const [card] = await rows<{ custom_record_id: string; sealed: boolean }>(
      dbs.admin.db,
      sql`select custom_record_id, sealed from app.attention_items where id = ${item}`,
    );
    expect(card).toEqual({ custom_record_id: deal, sealed: true });
    expect(await sees(member, 'app.attention_items', [item])).toEqual([]);
    expect(await sees(agent, 'app.attention_items', [item])).toEqual([item]);
  });

  it('never reaches a phone in business_v1', () => {
    const { queries } = readSyncConfig();
    for (const table of ['appointments', 'appointment_attendees']) {
      const q = queries.find((x) => x.stream === 'business_v1' && x.table === table);
      expect(q?.where, table).toMatch(/sealed = false/);
    }
  });
});
