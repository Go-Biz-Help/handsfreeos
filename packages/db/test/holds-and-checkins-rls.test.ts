/**
 * Round six's two kinds of things people mustn't see or undo (20261022000200 and 000300).
 *
 * - **Legal holds:** only someone with `records.hold` (owners and admins) places one, and only by lifting it is one
 *   ever changed; a retention hold is the system's alone. While a legal hold lasts, a record's files aren't deleted or
 *   renamed and its timeline lines aren't changed by people.
 * - **Check-ins:** a person's contacts and check-ins are theirs alone, not their owner's. A teammate they asked to be
 *   told reads one check-in only while they're being told about it, through the one function made for it.
 */
import { randomUUID } from 'node:crypto';
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

const admin$ = dbs.admin.db;

let owner: TestUser;
let agent: TestUser;
let mate: TestUser;
let ws: string;
let org: string;
let record: string;
let file: string;

beforeAll(async () => {
  [owner, agent, mate] = await Promise.all([
    createTestUser('hold-owner'),
    createTestUser('hold-agent'),
    createTestUser('hold-mate'),
  ]);
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(owner, 'Holds', 'Holds Realty'));
  await admin$.insert(workspaceMemberships).values([
    { workspaceId: ws, userId: agent.id, role: 'member' },
    { workspaceId: ws, userId: mate.id, role: 'member' },
  ]);
  const [kind] = await rows<{ id: string }>(
    admin$,
    sql`insert into app.custom_record_types (workspace_id, key, singular, plural)
        values (${ws}, 'matter', 'Matter', 'Matters') returning id`,
  );
  [{ id: record }] = (await rows<{ id: string }>(
    admin$,
    sql`insert into app.custom_records (workspace_id, type_id, name, created_by)
        values (${ws}, ${kind!.id}, 'Okafor matter', ${owner.id}) returning id`,
  )) as [{ id: string }];
  [{ id: file }] = (await rows<{ id: string }>(
    admin$,
    sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, size_bytes,
          status, created_by)
        values (${ws}, 'custom_record', ${record}, ${`${ws}/custom_record/${record}/x/Letter.pdf`}, 'Letter.pdf',
          'application/pdf', 10, 'ready', ${owner.id})
        returning id`,
  )) as [{ id: string }];
}, 90_000);

afterAll(closeAll);

describe('legal holds', () => {
  it('are placed only by someone allowed to, and retention holds only by the system', async () => {
    const place = (u: TestUser, kind = 'legal') =>
      as(u)((tx) =>
        rows(
          tx,
          sql`insert into app.record_holds (workspace_id, custom_record_id, kind, reason, placed_by)
              values (${ws}, ${record}, ${kind}, 'Litigation notice from the buyer’s lawyer', ${u.id})`,
        ),
      );
    expect((await expectPgError(() => place(agent))).code).toBe('42501');
    expect((await expectPgError(() => place(owner, 'retention'))).code).toBe('42501');
    await place(owner);
    // Everyone in the business sees it.
    expect(
      await as(agent)((tx) =>
        rows(tx, sql`select kind from app.record_holds where custom_record_id = ${record}`),
      ),
    ).toEqual([{ kind: 'legal' }]);
  });

  it('keep the record’s files, and change only by being lifted', async () => {
    const del = (u: TestUser) =>
      as(u)((tx) => rows(tx, sql`update app.files set deleted_at = now() where id = ${file}`));
    expect((await expectPgError(() => del(owner))).detail).toBe('record_on_hold');
    expect(
      (
        await expectPgError(() =>
          as(owner)((tx) =>
            rows(
              tx,
              sql`update app.record_holds set reason = 'Something else' where custom_record_id = ${record}`,
            ),
          ),
        )
      ).detail,
    ).toBe('record_hold_fixed');
    await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.record_holds set lifted_at = now(), lifted_by = ${owner.id}, lift_reason = 'Settled'
            where custom_record_id = ${record} and kind = 'legal'`,
      ),
    );
    await del(owner);
  });

  it('are the system’s to keep for retention, with an end once the record is closed', async () => {
    await asService({ workspaceId: ws, organizationId: org })((tx) =>
      rows(
        tx,
        sql`select private.set_retention_hold(${ws}::uuid, ${record}::uuid, false, '2033-10-03T00:00:00Z'::timestamptz)`,
      ),
    );
    const [h] = await rows<{ until: string }>(
      admin$,
      sql`select held_until::date::text as until from app.record_holds
          where custom_record_id = ${record} and kind = 'retention' and lifted_at is null`,
    );
    expect(h!.until).toBe('2033-10-03');
    expect(
      (
        await expectPgError(() =>
          as(owner)((tx) =>
            rows(
              tx,
              sql`select private.set_retention_hold(${ws}::uuid, ${record}::uuid, true, null)`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });
});

describe('check-ins', () => {
  const checkInId = randomUUID();

  it('are each person’s own: not their owner’s, not a teammate’s', async () => {
    await as(agent)((tx) =>
      rows(
        tx,
        sql`insert into app.safety_contacts (workspace_id, user_id, contact_user_id, name)
            values (${ws}, ${agent.id}, ${mate.id}, 'Mate')`,
      ),
    );
    await as(agent)((tx) =>
      rows(
        tx,
        sql`insert into app.safety_checkins (id, workspace_id, user_id, place, started_at, planned_end_at)
            values (${checkInId}, ${ws}, ${agent.id}, '2207 Juniper Trail', now(), now() + interval '30 minutes')`,
      ),
    );
    for (const u of [owner, mate]) {
      expect(await as(u)((tx) => rows(tx, sql`select id from app.safety_checkins`))).toEqual([]);
      expect(await as(u)((tx) => rows(tx, sql`select id from app.safety_contacts`))).toEqual([]);
    }
    // Nobody makes one for someone else.
    expect(
      (
        await expectPgError(() =>
          as(owner)((tx) =>
            rows(
              tx,
              sql`insert into app.safety_checkins (id, workspace_id, user_id, place, started_at, planned_end_at)
                  values (${randomUUID()}, ${ws}, ${agent.id}, 'Somewhere', now(), now() + interval '1 hour')`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('show a teammate who was told the one check-in, only while they’re being told', async () => {
    const seen = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ place: string }>(
          tx,
          sql`select place from private.safety_checkin_for_contact(${ws}::uuid, ${checkInId}::uuid)`,
        ),
      );
    expect(await seen(mate)).toEqual([]);
    await asService({ workspaceId: ws, organizationId: org })(async (tx) => {
      await rows(tx, sql`update app.safety_checkins set state = 'alerted' where id = ${checkInId}`);
      await rows(
        tx,
        sql`insert into app.safety_escalations (workspace_id, checkin_id, told_user_id, channel)
            values (${ws}, ${checkInId}, ${mate.id}, 'app')`,
      );
    });
    expect(await seen(mate)).toEqual([{ place: '2207 Juniper Trail' }]);
    expect(await seen(owner)).toEqual([]);
    // They say they reached the person: it's settled, and the place is theirs no longer.
    expect(
      await as(mate)((tx) =>
        rows(
          tx,
          sql`select private.safety_resolve_as_contact(${ws}::uuid, ${checkInId}::uuid) as ok`,
        ),
      ),
    ).toEqual([{ ok: true }]);
    expect(await seen(mate)).toEqual([]);
  });

  it('never show anyone a contact’s link', async () => {
    // The token's hash isn't granted to people at all: asking for every column is refused.
    const e = await expectPgError(() =>
      as(agent)((tx) => rows(tx, sql`select * from app.safety_escalations limit 1`)),
    );
    expect(e.code).toBe('42501');
    // What they may read (who was told, and when) still reads.
    expect(
      await as(agent)((tx) =>
        rows(
          tx,
          sql`select channel, told_user_id from app.safety_escalations where checkin_id = ${checkInId}`,
        ),
      ),
    ).toEqual([{ channel: 'app', told_user_id: mate.id }]);
  });
});
