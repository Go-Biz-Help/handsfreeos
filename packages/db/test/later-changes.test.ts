/**
 * 0063 on the local database: when things last changed, at the moment each change was made, so a change a phone made
 * before a later one can be told apart (the commands then leave the later one standing).
 * - A conversation's `status_changed_at` is stamped whenever it's opened, closed or snoozed, or its snooze moves, by
 *   whoever writes; anything else about it keeps the stamp, and nobody writes it by hand.
 * - An appointment's `rescheduled_at` is stamped whenever its start moves, and kept otherwise.
 * - A tag taken off a record is remembered with its moment in `record_tag_removals`, which only the trigger writes; a
 *   tag or a business being deleted leaves nothing to remember.
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

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
/** Raw rows give times as text. */
const iso = (d: string | null) => (d === null ? null : new Date(d).toISOString());

let owner: TestUser;
let member: TestUser;
let wsId: string;
let orgId: string;

const worker = () => asService({ workspaceId: wsId, organizationId: orgId });
/** A person's statement inside a transaction the kernel told the moment (or none, as the web's). */
const asPerson =
  (user: TestUser, moment: Date | null) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    as(user)(async (tx) => {
      if (moment)
        await tx.execute(sql`select set_config('app.occurred_at', ${moment.toISOString()}, true)`);
      return fn(tx);
    });

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('later-owner'),
    createTestUser('later-member'),
  ]);
  const org = await bootstrapOrganization(owner, 'Later Org', 'Later HVAC');
  wsId = org.wsId;
  orgId = org.orgId;
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: wsId, userId: member.id, role: 'member' }]);
});
afterAll(closeAll);

let phones = 0;
const nextPhone = () => `+1512555${String(3000 + ++phones)}`;

describe('when a conversation’s status last changed', () => {
  type Stamp = { status: string; status_changed_at: string | null; recent: boolean | null };
  const change = (moment: Date | null, id: string, set: string) =>
    asPerson(
      member,
      moment,
    )((tx) =>
      rows<Stamp>(
        tx,
        sql`update app.conversations set ${sql.raw(set)} where id = ${id}
            returning status::text as status, status_changed_at,
              status_changed_at > now() - interval '1 minute' as recent`,
      ),
    ).then((r) => r[0]!);

  it('is stamped at the change’s moment for a close, a snooze and a reopen, and kept otherwise', async () => {
    const [c] = await worker()((tx) =>
      rows<{ id: string; status_changed_at: string | null }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart)
            values (${wsId}, 'sms', ${nextPhone()}) returning id, status_changed_at`,
      ),
    );
    expect(c!.status_changed_at).toBeNull();

    const closedAt = ago(3 * HOUR);
    expect(
      iso(
        (await change(closedAt, c!.id, `status = 'closed', closed_at = now()`)).status_changed_at,
      ),
    ).toBe(closedAt.toISOString());
    // Marked read, or written by hand: the stamp stays.
    const read = await change(
      ago(HOUR),
      c!.id,
      `unread_count = 0, status_changed_at = '2020-01-01'`,
    );
    expect(iso(read.status_changed_at)).toBe(closedAt.toISOString());

    const snoozedAt = ago(2 * HOUR);
    expect(
      iso(
        (
          await change(
            snoozedAt,
            c!.id,
            `status = 'snoozed', snoozed_until = now() + interval '1 day', closed_at = null`,
          )
        ).status_changed_at,
      ),
    ).toBe(snoozedAt.toISOString());
    // The snooze moving counts as a change too.
    const movedAt = ago(HOUR);
    expect(
      iso(
        (await change(movedAt, c!.id, `snoozed_until = now() + interval '2 days'`))
          .status_changed_at,
      ),
    ).toBe(movedAt.toISOString());

    // A customer's message reopens it through the worker: now.
    const [reopened] = await worker()((tx) =>
      rows<Stamp>(
        tx,
        sql`update app.conversations set status = 'open', snoozed_until = null where id = ${c!.id}
            returning status::text as status, status_changed_at,
              status_changed_at > now() - interval '1 minute' as recent`,
      ),
    );
    expect(reopened).toMatchObject({ status: 'open', recent: true });
  });
});

describe('when an appointment last moved', () => {
  it('is stamped when its start moves, at the change’s moment, and kept otherwise', async () => {
    const appointmentId = await worker()(async (tx) => {
      const [cal] = await rows<{ id: string }>(
        tx,
        sql`insert into app.calendars (workspace_id, name, slug, status, public)
            values (${wsId}, 'Tune-ups', ${`later-${uniq().toLowerCase()}`}, 'active', true) returning id`,
      );
      const [a] = await rows<{ id: string }>(
        tx,
        sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, kind, capacity, title,
              starts_at, ends_at, source)
            values (${wsId}, ${cal!.id}, 1, 'booking', 1, 'AC tune-up', now() + interval '1 day',
              now() + interval '1 day 1 hour', 'booking_page')
            returning id`,
      );
      return a!.id;
    });
    type Moved = { rescheduled_at: string | null; recent: boolean | null };
    const move = (moment: Date | null, set: string) =>
      asPerson(
        owner,
        moment,
      )((tx) =>
        rows<Moved>(
          tx,
          sql`update app.appointments set ${sql.raw(set)} where id = ${appointmentId}
              returning rescheduled_at, rescheduled_at > now() - interval '1 minute' as recent`,
        ),
      ).then((r) => r[0]!);

    const movedAt = ago(2 * HOUR);
    expect(
      iso(
        (
          await move(
            movedAt,
            `starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour'`,
          )
        ).rescheduled_at,
      ),
    ).toBe(movedAt.toISOString());
    expect(iso((await move(ago(HOUR), `title = 'AC tune-up and filters'`)).rescheduled_at)).toBe(
      movedAt.toISOString(),
    );
    // Moved on the web (or by the customer, through the worker): now.
    expect(
      await move(
        null,
        `starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour'`,
      ),
    ).toMatchObject({ recent: true });
  });
});

describe('when a tag came off a record', () => {
  async function taggedPerson(tagName = `VIP ${uniq()}`) {
    return worker()(async (tx) => {
      const [p] = await rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${wsId}, 'Maria') returning id`,
      );
      const [tag] = await rows<{ id: string }>(
        tx,
        sql`insert into app.tags (workspace_id, name) values (${wsId}, ${tagName}) returning id`,
      );
      await tx.execute(
        sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
            values (${wsId}, ${tag!.id}, 'person', ${p!.id})`,
      );
      return { personId: p!.id, tagId: tag!.id };
    });
  }
  const removals = (personId: string) =>
    rows<{ tag_id: string; removed_at: string; recent: boolean }>(
      dbs.admin.db,
      sql`select tag_id, removed_at, removed_at > now() - interval '1 minute' as recent
          from app.record_tag_removals where record_id = ${personId}`,
    );

  it('is remembered at the change’s moment, by the trigger alone', async () => {
    const { personId, tagId } = await taggedPerson();
    const removedAt = ago(2 * HOUR);
    await asPerson(
      member,
      removedAt,
    )((tx) =>
      tx.execute(
        sql`delete from app.record_tags where tag_id = ${tagId} and record_type = 'person' and record_id = ${personId}`,
      ),
    );
    expect(await removals(personId)).toEqual([
      { tag_id: tagId, removed_at: expect.any(String), recent: false },
    ]);
    expect(iso((await removals(personId))[0]!.removed_at)).toBe(removedAt.toISOString());
    // People read it, and write none of it.
    const seen = await as(member)((tx) =>
      rows(tx, sql`select tag_id from app.record_tag_removals where record_id = ${personId}`),
    );
    expect(seen).toHaveLength(1);
    const code = async (statement: ReturnType<typeof sql>) =>
      (await expectPgError(() => as(member)((tx) => tx.execute(statement)))).code;
    expect(
      await code(
        sql`insert into app.record_tag_removals (workspace_id, tag_id, record_type, record_id, removed_at)
            values (${wsId}, ${tagId}, 'person', ${personId}, now())`,
      ),
    ).toBe('42501');
    expect(
      await code(
        sql`update app.record_tag_removals set removed_at = now() where record_id = ${personId}`,
      ),
    ).toBe('42501');

    // Put on again and taken off by the worker: the time moves to now.
    await worker()(async (tx) => {
      await tx.execute(
        sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
            values (${wsId}, ${tagId}, 'person', ${personId})`,
      );
      await tx.execute(
        sql`delete from app.record_tags where tag_id = ${tagId} and record_id = ${personId}`,
      );
    });
    expect((await removals(personId))[0]).toMatchObject({ recent: true });
  });

  it('a tag being deleted takes its rows with it, and leaves nothing to remember', async () => {
    const { personId, tagId } = await taggedPerson();
    await as(owner)((tx) => tx.execute(sql`delete from app.tags where id = ${tagId}`));
    expect(await removals(personId)).toEqual([]);
  });
});
