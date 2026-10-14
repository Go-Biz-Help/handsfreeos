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
let member: TestUser;
let teammate: TestUser;
let outsider: TestUser;
let wsA: string;
let orgA: string;
let wsB: string;
let orgB: string;

const worker = (ws: string, org: string) => asService({ workspaceId: ws, organizationId: org });
const unscoped = asService({});
/** Lower-case letters and digits only, for names that must pass the slug checks. */
const token = () =>
  uniq()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  [owner, member, teammate, outsider] = await Promise.all([
    createTestUser('cal-owner'),
    createTestUser('cal-member'),
    createTestUser('cal-teammate'),
    createTestUser('cal-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Calendar Org A', 'Calendar A');
  wsA = a.wsId;
  orgA = a.orgId;
  const b = await bootstrapOrganization(outsider, 'Calendar Org B', 'Calendar B');
  wsB = b.wsId;
  orgB = b.orgId;
  // The member works for both businesses.
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: wsA, userId: member.id, role: 'member' },
    { workspaceId: wsA, userId: teammate.id, role: 'member' },
    { workspaceId: wsB, userId: member.id, role: 'member' },
  ]);
});
afterAll(closeAll);

/** An active, public calendar made by the worker. */
async function calendar(ws: string, org: string): Promise<string> {
  const [c] = await worker(
    ws,
    org,
  )((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.calendars (workspace_id, name, slug, status, public)
          values (${ws}, 'Tune-ups', ${`cal-${token()}`}, 'active', true) returning id`,
    ),
  );
  return c!.id;
}

/** Books one person as the booking page would: the worker, one transaction. */
function book(
  ws: string,
  org: string,
  calendarId: string,
  userId: string,
  from: string,
  to: string,
) {
  return worker(
    ws,
    org,
  )(async (tx) => {
    const [a] = await rows<{ id: string }>(
      tx,
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, source)
          values (${ws}, ${calendarId}, 1, 'AC tune-up', ${from}::timestamptz, ${to}::timestamptz, 'booking_page')
          returning id`,
    );
    await rows(
      tx,
      sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id) values (${ws}, ${a!.id}, ${userId})`,
    );
    return a!.id;
  });
}

const setStatus = (id: string, status: string) =>
  worker(
    wsA,
    orgA,
  )((tx) =>
    rows(
      tx,
      sql`update app.appointments set status = ${status}::app.appointment_status where id = ${id}`,
    ),
  );

describe('one person, one place at a time', () => {
  it('refuses overlapping time for the same person and allows back-to-back', async () => {
    const cal = await calendar(wsA, orgA);
    await book(wsA, orgA, cal, member.id, '2026-10-06T14:00:00Z', '2026-10-06T15:00:00Z');
    const overlap = await expectPgError(() =>
      book(wsA, orgA, cal, member.id, '2026-10-06T14:30:00Z', '2026-10-06T15:30:00Z'),
    );
    expect(overlap.code).toBe('23P01');
    await book(wsA, orgA, cal, member.id, '2026-10-06T15:00:00Z', '2026-10-06T16:00:00Z');
    // Someone else can take the overlapping time.
    await book(wsA, orgA, cal, teammate.id, '2026-10-06T14:30:00Z', '2026-10-06T15:30:00Z');
  });

  it('frees cancelled time; restoring or moving onto booked time fails', async () => {
    const cal = await calendar(wsA, orgA);
    const nine = await book(
      wsA,
      orgA,
      cal,
      member.id,
      '2026-10-07T14:00:00Z',
      '2026-10-07T15:00:00Z',
    );
    const ten = await book(
      wsA,
      orgA,
      cal,
      member.id,
      '2026-10-07T15:00:00Z',
      '2026-10-07T16:00:00Z',
    );
    await setStatus(nine, 'cancelled');
    const [held] = await rows<{ active: boolean }>(
      dbs.admin.db,
      sql`select active from app.appointment_staff where appointment_id = ${nine}`,
    );
    expect(held!.active).toBe(false);
    await book(wsA, orgA, cal, member.id, '2026-10-07T14:00:00Z', '2026-10-07T15:00:00Z');
    expect((await expectPgError(() => setStatus(nine, 'scheduled'))).code).toBe('23P01');
    const moved = await expectPgError(() =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows(
          tx,
          sql`update app.appointments set starts_at = '2026-10-07T14:30:00Z', ends_at = '2026-10-07T15:30:00Z'
              where id = ${ten}`,
        ),
      ),
    );
    expect(moved.code).toBe('23P01');
  });

  it('keeps each business separate: the same person booked at the same time elsewhere is fine', async () => {
    const calA = await calendar(wsA, orgA);
    const calB = await calendar(wsB, orgB);
    await book(wsA, orgA, calA, member.id, '2026-10-08T14:00:00Z', '2026-10-08T15:00:00Z');
    await book(wsB, orgB, calB, member.id, '2026-10-08T14:00:00Z', '2026-10-08T15:00:00Z');
  });

  it('takes the ranges from the appointment, buffers included, whatever the caller sends', async () => {
    const cal = await calendar(wsA, orgA);
    const [a] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
              buffer_before, buffer_after)
            values (${wsA}, ${cal}, 1, 'Install walkthrough', '2026-10-09T14:00:00Z', '2026-10-09T15:00:00Z', 30, 15)
            returning id`,
      ),
    );
    // A member adds the crew (appointments.write), trying to forge the ranges.
    await as(member)((tx) =>
      rows(
        tx,
        sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id, role, during, active)
            values (${wsA}, ${a!.id}, ${teammate.id}, 'crew', '[2020-01-01,2020-01-02)', false)`,
      ),
    );
    const [staff] = await rows<{
      during_from: number;
      during_to: number;
      blocked_from: number;
      blocked_to: number;
      active: boolean;
    }>(
      dbs.admin.db,
      sql`select (extract(epoch from lower(during)) * 1000)::float8 as during_from,
            (extract(epoch from upper(during)) * 1000)::float8 as during_to,
            (extract(epoch from lower(blocked)) * 1000)::float8 as blocked_from,
            (extract(epoch from upper(blocked)) * 1000)::float8 as blocked_to, active
          from app.appointment_staff where appointment_id = ${a!.id}`,
    );
    expect([iso(staff!.during_from), iso(staff!.during_to)]).toEqual([
      '2026-10-09T14:00:00.000Z',
      '2026-10-09T15:00:00.000Z',
    ]);
    expect([iso(staff!.blocked_from), iso(staff!.blocked_to)]).toEqual([
      '2026-10-09T13:30:00.000Z',
      '2026-10-09T15:15:00.000Z',
    ]);
    expect(staff!.active).toBe(true);
  });
});

describe('what people write on appointments', () => {
  it('members book as themselves; the booking page, reminder state and provider ids stay the worker’s', async () => {
    const cal = await calendar(wsA, orgA);
    const [person] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name) values (${wsA}, 'Mike', 'Ruiz') returning id`,
      ),
    );
    const add = (source: string) =>
      as(member)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
                source, created_by)
              values (${wsA}, ${cal}, 1, 'Tune-up', '2026-10-11T14:00:00Z', '2026-10-11T15:00:00Z',
                ${source}::app.appointment_source, ${member.id})
              returning id`,
        ),
      );
    expect((await expectPgError(() => add('booking_page'))).code).toBe('42501');
    expect((await expectPgError(() => add('ai_teammate'))).code).toBe('42501');
    const [a] = await add('staff');
    const attendee = (state: string) =>
      as(member)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, reminder_state, created_by)
              values (${wsA}, ${a!.id}, ${person!.id}, ${state}::jsonb, ${member.id}) returning id`,
        ),
      );
    expect((await expectPgError(() => attendee('{"day_before": "sent"}'))).code).toBe('42501');
    // The booking page's and the AI teammate's bookings are the worker's to write.
    for (const source of ['booking_page', 'ai_teammate'])
      expect(
        (
          await expectPgError(() =>
            as(member)((tx) =>
              rows(
                tx,
                sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, source, created_by)
                    values (${wsA}, ${a!.id}, ${person!.id}, ${source}::app.appointment_source, ${member.id})`,
              ),
            ),
          )
        ).code,
      ).toBe('42501');
    const [at] = await attendee('{}');
    const marked = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`update app.appointment_attendees set reminder_state = '{"day_before": "sent"}' where id = ${at!.id}`,
        ),
      ),
    );
    expect(marked.code).toBe('42501');
    const relabelled = await expectPgError(() =>
      as(member)((tx) =>
        rows(tx, sql`update app.appointments set source = 'booking_page' where id = ${a!.id}`),
      ),
    );
    expect(relabelled.code).toBe('42501');
    const pushed = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.appointment_calendar_events (workspace_id, appointment_id, user_id, provider_event_id)
              values (${wsA}, ${a!.id}, ${member.id}, 'evt_1')`,
        ),
      ),
    );
    expect(pushed.code).toBe('42501');
    const moved = await as(member)((tx) =>
      rows(
        tx,
        sql`update app.appointments set starts_at = '2026-10-11T16:00:00Z', ends_at = '2026-10-11T17:00:00Z'
            where id = ${a!.id} returning id`,
      ),
    );
    expect(moved).toHaveLength(1);
  });
});

describe('who manages calendars and hours', () => {
  it('members can’t write calendars or services; owners can; the whole team reads them', async () => {
    const addService = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.services (workspace_id, name, durations, default_duration, created_by)
              values (${wsA}, ${`Tune-up ${token()}`}, '{60,90}', 90, ${u.id}) returning id`,
        ),
      );
    expect((await expectPgError(() => addService(member))).code).toBe('42501');
    const [svc] = await addService(owner);
    const addCalendar = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.calendars (workspace_id, name, slug, created_by)
              values (${wsA}, 'Dale', ${`dale-${token()}`}, ${u.id}) returning id`,
        ),
      );
    expect((await expectPgError(() => addCalendar(member))).code).toBe('42501');
    const [cal] = await addCalendar(owner);
    const renamed = await as(member)((tx) =>
      rows(tx, sql`update app.calendars set name = 'Mine now' where id = ${cal!.id} returning id`),
    );
    expect(renamed).toHaveLength(0);
    const repriced = await as(member)((tx) =>
      rows(tx, sql`update app.services set price_cents = 1 where id = ${svc!.id} returning id`),
    );
    expect(repriced).toHaveLength(0);
    const mirrored = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.calendar_services (workspace_id, calendar_id, service_id) values (${wsA}, ${cal!.id}, ${svc!.id})`,
        ),
      ),
    );
    expect(mirrored.code).toBe('42501');
    const seen = await as(member)((tx) =>
      rows(tx, sql`select id from app.calendars where id = ${cal!.id}`),
    );
    expect(seen).toHaveLength(1);
    const hidden = await as(outsider)((tx) =>
      rows(tx, sql`select id from app.services where id = ${svc!.id}`),
    );
    expect(hidden).toHaveLength(0);
    // A service a calendar uses can't be deleted out from under it.
    await as(owner)((tx) =>
      rows(
        tx,
        sql`insert into app.calendar_services (workspace_id, calendar_id, service_id) values (${wsA}, ${cal!.id}, ${svc!.id})`,
      ),
    );
    const inUse = await expectPgError(() =>
      as(owner)((tx) => rows(tx, sql`delete from app.services where id = ${svc!.id}`)),
    );
    expect(inUse.code).toBe('23503');
  });

  it('everyone edits their own hours and time off, never a teammate’s; owners edit anyone’s', async () => {
    const weekdays = JSON.stringify([{ day: 1, start: '08:00', end: '17:00' }]);
    const setHours = (u: TestUser, whose: TestUser) =>
      as(u)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.schedules (workspace_id, owner_kind, owner_id, weekly, created_by)
              values (${wsA}, 'user', ${whose.id}, ${weekdays}::jsonb, ${u.id}) returning id`,
        ),
      );
    const [mine] = await setHours(member, member);
    expect((await expectPgError(() => setHours(member, teammate))).code).toBe('42501');
    const [theirs] = await setHours(owner, teammate);
    const edit = (u: TestUser, scheduleId: string) =>
      as(u)((tx) =>
        rows(
          tx,
          sql`update app.schedules set weekly = '[{"day": 2, "start": "09:00", "end": "24:00"}]'
              where id = ${scheduleId} returning id`,
        ),
      );
    expect(await edit(member, mine!.id)).toHaveLength(1);
    expect(await edit(member, theirs!.id)).toHaveLength(0);
    expect(await edit(owner, theirs!.id)).toHaveLength(1);
    const timeOff = (u: TestUser, scheduleId: string) =>
      as(u)((tx) =>
        rows(
          tx,
          sql`insert into app.schedule_exceptions (workspace_id, schedule_id, starts_at, ends_at, all_day, created_by)
              values (${wsA}, ${scheduleId}, '2026-10-12T05:00:00Z', '2026-10-13T05:00:00Z', true, ${u.id})
              returning id`,
        ),
      );
    expect(await timeOff(member, mine!.id)).toHaveLength(1);
    expect((await expectPgError(() => timeOff(member, theirs!.id))).code).toBe('42501');
    expect(await timeOff(owner, theirs!.id)).toHaveLength(1);
  });

  it('refuses hours that don’t make sense and zones that don’t follow daylight saving', async () => {
    const saveHours = (weekly: unknown, zone: string | null = null) =>
      worker(
        wsA,
        orgA,
      )(async (tx) => {
        const [r] = await rows<{ id: string }>(
          tx,
          sql`insert into app.resources (workspace_id, name) values (${wsA}, ${`Truck ${token()}`}) returning id`,
        );
        return rows(
          tx,
          sql`insert into app.schedules (workspace_id, owner_kind, owner_id, timezone, weekly)
              values (${wsA}, 'resource', ${r!.id}, ${zone}, ${JSON.stringify(weekly)}::jsonb) returning id`,
        );
      });
    expect(
      (await expectPgError(() => saveHours([{ day: 1, start: '17:00', end: '09:00' }]))).code,
    ).toBe('23514');
    expect(
      (await expectPgError(() => saveHours([{ day: 7, start: '09:00', end: '17:00' }]))).code,
    ).toBe('23514');
    expect((await expectPgError(() => saveHours({ day: 1 }))).code).toBe('23514');
    expect(await expectPgError(() => saveHours([], 'CST'))).toMatchObject({
      code: '23514',
      detail: 'timezone_invalid',
    });
    expect(
      await saveHours([{ day: 1, start: '22:00', end: '24:00' }], 'America/Phoenix'),
    ).toHaveLength(1);
  });
});

describe('calendar connections', () => {
  it('people connect only their own calendar, never read its tokens, and can only disconnect it', async () => {
    const state = `cal-state-${token()}`;
    const connect = (u: TestUser, whose: TestUser) =>
      as(u)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.calendar_connections (workspace_id, user_id, provider, oauth_state_hash,
                oauth_state_expires_at, created_by)
              values (${wsA}, ${whose.id}, 'google', ${state}, now() + interval '10 minutes', ${u.id})
              returning id`,
        ),
      );
    expect((await expectPgError(() => connect(owner, member))).code).toBe('42501');
    const forged = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.calendar_connections (workspace_id, user_id, provider, token_enc, created_by)
              values (${wsA}, ${member.id}, 'google', 'sealed:v1:forged', ${member.id})`,
        ),
      ),
    );
    expect(forged.code).toBe('42501');
    const [c] = await connect(member, member);

    const found = await unscoped((tx) =>
      rows(
        tx,
        sql`select kind, connection_id, workspace_id, organization_id, user_id, provider
            from private.oauth_connection_by_state(${state})`,
      ),
    );
    expect(found).toEqual([
      {
        kind: 'calendar',
        connection_id: c!.id,
        workspace_id: wsA,
        organization_id: orgA,
        user_id: member.id,
        provider: 'google',
      },
    ]);
    const asPerson = await expectPgError(() =>
      as(member)((tx) => rows(tx, sql`select * from private.oauth_connection_by_state(${state})`)),
    );
    expect(asPerson.code).toBe('42501');

    await worker(
      wsA,
      orgA,
    )(async (tx) => {
      await rows(
        tx,
        sql`update app.calendar_connections set status = 'active', account_email = ${`mike-${token()}@example.com`},
              token_enc = 'sealed:v1:not-a-real-token', connected_at = now()
            where id = ${c!.id}`,
      );
      await rows(
        tx,
        sql`insert into app.calendar_busy_blocks (workspace_id, connection_id, user_id, starts_at, ends_at)
            values (${wsA}, ${c!.id}, ${member.id}, '2026-10-06T19:00:00Z', '2026-10-06T20:00:00Z')`,
      );
    });
    for (const column of ['token_enc', 'pkce_verifier_enc', 'token_key_id', 'oauth_state_hash']) {
      const sealed = await expectPgError(() =>
        as(member)((tx) => rows(tx, sql.raw(`select ${column} from app.calendar_connections`))),
      );
      expect(sealed.code).toBe('42501');
    }
    const own = await as(member)((tx) =>
      rows(
        tx,
        sql`select status::text as status from app.calendar_connections where id = ${c!.id}`,
      ),
    );
    expect(own).toEqual([{ status: 'active' }]);
    const byTeammate = await as(teammate)((tx) =>
      rows(tx, sql`select id from app.calendar_connections where id = ${c!.id}`),
    );
    expect(byTeammate).toHaveLength(0);
    const byOwner = await as(owner)((tx) =>
      rows(tx, sql`select id from app.calendar_connections where id = ${c!.id}`),
    );
    expect(byOwner).toHaveLength(1);
    // The team view shows everyone's busy time.
    const busy = await as(teammate)((tx) =>
      rows(tx, sql`select id from app.calendar_busy_blocks where connection_id = ${c!.id}`),
    );
    expect(busy).toHaveLength(1);

    const reactivate = await expectPgError(() =>
      as(member)((tx) =>
        rows(tx, sql`update app.calendar_connections set status = 'error' where id = ${c!.id}`),
      ),
    );
    expect(reactivate.code).toBe('42501');
    const teammateDisconnect = await as(teammate)((tx) =>
      rows(
        tx,
        sql`update app.calendar_connections set status = 'disconnected' where id = ${c!.id} returning id`,
      ),
    );
    expect(teammateDisconnect).toHaveLength(0);
    await as(member)((tx) =>
      rows(
        tx,
        sql`update app.calendar_connections set status = 'disconnected' where id = ${c!.id}`,
      ),
    );
    const [after] = await rows(
      dbs.admin.db,
      sql`select status::text as status, token_enc is null as token_gone, disconnected_at is not null as at,
            (select count(*)::int from app.calendar_busy_blocks b where b.connection_id = c.id) as blocks
          from app.calendar_connections c where c.id = ${c!.id}`,
    );
    expect(after).toEqual({ status: 'disconnected', token_gone: true, at: true, blocks: 0 });
  });

  it('the OAuth state lookup still finds pending mailboxes', async () => {
    const state = `mail-state-${token()}`;
    const [m] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.mailbox_connections (workspace_id, provider, user_id, status, oauth_state_hash,
              oauth_state_expires_at, created_by)
            values (${wsA}, 'microsoft', ${owner.id}, 'pending', ${state}, now() + interval '10 minutes', ${owner.id})
            returning id`,
      ),
    );
    const either = await unscoped((tx) =>
      rows(
        tx,
        sql`select kind, connection_id, provider from private.oauth_connection_by_state(${state})`,
      ),
    );
    expect(either).toEqual([{ kind: 'mailbox', connection_id: m!.id, provider: 'microsoft' }]);
    const mailboxOnly = await unscoped((tx) =>
      rows(tx, sql`select connection_id from private.mailbox_connection_by_state(${state})`),
    );
    expect(mailboxOnly).toEqual([{ connection_id: m!.id }]);
  });
});

describe('meeting connections (Zoom)', () => {
  it('people connect only their own Zoom, never read its tokens, and can only disconnect it', async () => {
    const state = `zoom-state-${token()}`;
    const connect = (u: TestUser, whose: TestUser) =>
      as(u)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.meeting_connections (workspace_id, user_id, provider, oauth_state_hash,
                oauth_state_expires_at, created_by)
              values (${wsA}, ${whose.id}, 'zoom', ${state}, now() + interval '10 minutes', ${u.id})
              returning id`,
        ),
      );
    expect((await expectPgError(() => connect(owner, member))).code).toBe('42501');
    const forged = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.meeting_connections (workspace_id, user_id, provider, token_enc, created_by)
              values (${wsA}, ${member.id}, 'zoom', 'sealed:v1:forged', ${member.id})`,
        ),
      ),
    );
    expect(forged.code).toBe('42501');
    const [c] = await connect(member, member);

    const found = await unscoped((tx) =>
      rows(
        tx,
        sql`select kind, connection_id, workspace_id, user_id, provider
            from private.oauth_connection_by_state(${state})`,
      ),
    );
    expect(found).toEqual([
      {
        kind: 'meeting',
        connection_id: c!.id,
        workspace_id: wsA,
        user_id: member.id,
        provider: 'zoom',
      },
    ]);
    const startedBy = await unscoped((tx) =>
      rows(tx, sql`select private.oauth_state_started_by(${state}) as by`),
    );
    expect(startedBy).toEqual([{ by: member.id }]);

    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`update app.meeting_connections set status = 'active', account_email = ${`mike-${token()}@zoom.example`},
              token_enc = 'sealed:v1:not-a-real-token', connected_at = now()
            where id = ${c!.id}`,
      ),
    );
    for (const column of [
      'token_enc',
      'pkce_verifier_enc',
      'token_key_id',
      'oauth_state_hash',
      'external_user_id',
    ]) {
      const sealed = await expectPgError(() =>
        as(member)((tx) => rows(tx, sql.raw(`select ${column} from app.meeting_connections`))),
      );
      expect(sealed.code).toBe('42501');
    }
    const byTeammate = await as(teammate)((tx) =>
      rows(tx, sql`select id from app.meeting_connections where id = ${c!.id}`),
    );
    expect(byTeammate).toHaveLength(0);
    const byOwner = await as(owner)((tx) =>
      rows(tx, sql`select id from app.meeting_connections where id = ${c!.id}`),
    );
    expect(byOwner).toHaveLength(1);
    const reactivate = await expectPgError(() =>
      as(member)((tx) =>
        rows(tx, sql`update app.meeting_connections set status = 'error' where id = ${c!.id}`),
      ),
    );
    expect(reactivate.code).toBe('42501');
    await as(member)((tx) =>
      rows(tx, sql`update app.meeting_connections set status = 'disconnected' where id = ${c!.id}`),
    );
    const [after] = await rows(
      dbs.admin.db,
      sql`select status::text as status, token_enc is null as token_gone, disconnected_at is not null as at
          from app.meeting_connections where id = ${c!.id}`,
    );
    expect(after).toEqual({ status: 'disconnected', token_gone: true, at: true });
  });
});

describe('call transcripts', () => {
  it('only the worker keeps them; the business reads them, nobody else does; they go with the appointment', async () => {
    const cal = await calendar(wsA, orgA);
    const appt = await book(
      wsA,
      orgA,
      cal,
      member.id,
      '2026-11-02T15:00:00Z',
      '2026-11-02T16:00:00Z',
    );
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`insert into app.appointment_transcripts (workspace_id, appointment_id, provider, external_id, body)
            values (${wsA}, ${appt}, 'zoom', 'f1', 'Mike: hello')`,
      ),
    );
    // The same file twice keeps one copy.
    const twice = await expectPgError(() =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows(
          tx,
          sql`insert into app.appointment_transcripts (workspace_id, appointment_id, provider, external_id, body)
              values (${wsA}, ${appt}, 'zoom', 'f1', 'again')`,
        ),
      ),
    );
    expect(twice.code).toBe('23505');
    const read = (u: TestUser) =>
      as(u)((tx) =>
        rows(tx, sql`select body from app.appointment_transcripts where appointment_id = ${appt}`),
      );
    expect(await read(teammate)).toEqual([{ body: 'Mike: hello' }]);
    expect(await read(outsider)).toEqual([]);
    const written = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.appointment_transcripts (workspace_id, appointment_id, provider, external_id, body)
              values (${wsA}, ${appt}, 'zoom', 'f2', 'forged')`,
        ),
      ),
    );
    expect(written.code).toBe('42501');
    // Another business's worker can't hang one on this appointment.
    const crossed = await expectPgError(() =>
      worker(
        wsB,
        orgB,
      )((tx) =>
        rows(
          tx,
          sql`insert into app.appointment_transcripts (workspace_id, appointment_id, provider, external_id, body)
              values (${wsB}, ${appt}, 'zoom', 'f3', 'x')`,
        ),
      ),
    );
    expect(crossed.code).toBe('23514');
    // Zoom's webhook finds the appointment by its meeting only through the worker's lookup.
    await rows(
      dbs.admin.db,
      sql`update app.appointments set location = '{"kind":"virtual","video":"zoom","meetingId":"8123"}'::jsonb
          where id = ${appt}`,
    );
    expect(
      await unscoped((tx) =>
        rows(tx, sql`select appointment_id from private.appointment_by_meeting_id('8123')`),
      ),
    ).toEqual([{ appointment_id: appt }]);
    await rows(dbs.admin.db, sql`delete from app.appointments where id = ${appt}`);
    const [left] = await rows<{ n: number }>(
      dbs.admin.db,
      sql`select count(*)::int as n from app.appointment_transcripts where appointment_id = ${appt}`,
    );
    expect(left!.n).toBe(0);
  });
});

describe('the booking site', () => {
  let site: string;

  it('has one name across HandsFreeOS, whatever the capitals; reserved names are refused', async () => {
    site = `lone-star-${token()}`;
    const open = (u: TestUser, ws: string, slug: string) =>
      as(u)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.booking_sites (workspace_id, slug, name, created_by)
              values (${ws}, ${slug}, 'Lone Star HVAC', ${u.id}) returning id`,
        ),
      );
    expect((await expectPgError(() => open(member, wsA, site))).code).toBe('42501');
    await open(owner, wsA, site);
    expect((await expectPgError(() => open(outsider, wsB, site.toUpperCase()))).code).toBe('23505');
    expect(await expectPgError(() => open(outsider, wsB, 'Manage'))).toMatchObject({
      code: '23514',
      detail: 'booking_slug_reserved',
    });
    expect((await expectPgError(() => open(outsider, wsB, 'lone star'))).code).toBe('23514');
  });

  it('routes signed-out visitors to a calendar, following a rename and the permanent link', async () => {
    const first = `tune-up-${token()}`;
    const second = `ac-tune-up-${token()}`;
    const [cal] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.calendars (workspace_id, name, slug, status, public, created_by)
            values (${wsA}, 'AC tune-up', ${first}, 'active', true, ${owner.id}) returning id`,
      ),
    );
    await as(owner)((tx) =>
      rows(tx, sql`update app.calendars set slug = ${second} where id = ${cal!.id}`),
    );
    const retired = await as(member)((tx) =>
      rows(tx, sql`select slug from app.calendar_slugs where calendar_id = ${cal!.id}`),
    );
    expect(retired).toEqual([{ slug: first }]);

    const route = (siteSlug: string, calendarSlug: string | null) =>
      unscoped((tx) =>
        rows(
          tx,
          sql`select workspace_id, organization_id, timezone, site_slug, calendar_id, calendar_slug,
                calendar_status::text as calendar_status, calendar_public, redirected
              from private.booking_route(${siteSlug}, ${calendarSlug})`,
        ),
      );
    expect(await route(site.toUpperCase(), second)).toEqual([
      {
        workspace_id: wsA,
        organization_id: orgA,
        timezone: 'America/Chicago',
        site_slug: site,
        calendar_id: cal!.id,
        calendar_slug: second,
        calendar_status: 'active',
        calendar_public: true,
        redirected: false,
      },
    ]);
    expect(await route(site, first)).toMatchObject([
      { calendar_id: cal!.id, calendar_slug: second, redirected: true },
    ]);
    expect(await route('c', cal!.id)).toMatchObject([
      { site_slug: site, calendar_id: cal!.id, calendar_slug: second, redirected: true },
    ]);
    expect(await route(site, null)).toMatchObject([{ workspace_id: wsA, calendar_id: null }]);
    expect(await route(site, 'no-such-calendar')).toEqual([]);
    expect(await route(`nobody-${token()}`, second)).toEqual([]);
    expect(await route('c', 'not-a-calendar-id')).toEqual([]);
    const asPerson = await expectPgError(() =>
      as(owner)((tx) => rows(tx, sql`select * from private.booking_route(${site}, ${second})`)),
    );
    expect(asPerson.code).toBe('42501');
  });
});

describe('the system scope', () => {
  it('can’t read, change or point at another workspace’s calendar data', async () => {
    const cal = await calendar(wsA, orgA);
    const appt = await book(
      wsA,
      orgA,
      cal,
      teammate.id,
      '2026-10-10T14:00:00Z',
      '2026-10-10T15:00:00Z',
    );
    const other = worker(wsB, orgB);
    expect(
      await other((tx) => rows(tx, sql`select id from app.calendars where id = ${cal}`)),
    ).toHaveLength(0);
    expect(
      await other((tx) => rows(tx, sql`select id from app.appointments where id = ${appt}`)),
    ).toHaveLength(0);
    expect(
      await other((tx) =>
        rows(tx, sql`select user_id from app.appointment_staff where appointment_id = ${appt}`),
      ),
    ).toHaveLength(0);
    const cancelled = await other((tx) =>
      rows(
        tx,
        sql`update app.appointments set status = 'cancelled' where id = ${appt} returning id`,
      ),
    );
    expect(cancelled).toHaveLength(0);
    const planted = await expectPgError(() =>
      other((tx) =>
        rows(tx, sql`insert into app.services (workspace_id, name) values (${wsA}, 'Planted')`),
      ),
    );
    expect(planted.code).toBe('42501');
    const borrowed = await expectPgError(() =>
      other((tx) =>
        rows(
          tx,
          sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at)
              values (${wsB}, ${cal}, 1, 'Borrowed calendar', '2026-10-10T14:00:00Z', '2026-10-10T15:00:00Z')`,
        ),
      ),
    );
    expect(borrowed.detail).toBe('record_workspace_mismatch');
    expect(
      await unscoped((tx) => rows(tx, sql`select id from app.calendars where id = ${cal}`)),
    ).toHaveLength(0);
  });
});

describe('private.expand_schedule', () => {
  /** A schedule on a fresh resource, so each case has its own owner. */
  async function schedule(
    zone: string | null,
    weekly: { day: number; start: string; end: string }[],
    available: [string, string][] = [],
  ): Promise<string> {
    return worker(
      wsA,
      orgA,
    )(async (tx) => {
      const [r] = await rows<{ id: string }>(
        tx,
        sql`insert into app.resources (workspace_id, name) values (${wsA}, ${`Room ${token()}`}) returning id`,
      );
      const [s] = await rows<{ id: string }>(
        tx,
        sql`insert into app.schedules (workspace_id, owner_kind, owner_id, timezone, weekly)
            values (${wsA}, 'resource', ${r!.id}, ${zone}, ${JSON.stringify(weekly)}::jsonb) returning id`,
      );
      for (const [from, to] of available)
        await rows(
          tx,
          sql`insert into app.schedule_exceptions (workspace_id, schedule_id, kind, starts_at, ends_at)
              values (${wsA}, ${s!.id}, 'available', ${from}::timestamptz, ${to}::timestamptz)`,
        );
      return s!.id;
    });
  }
  type Window = { starts_ms: number; ends_ms: number };
  const expand = (u: TestUser, scheduleId: string, from: string, to: string) =>
    as(u)((tx) =>
      rows<Window>(
        tx,
        sql`select (extract(epoch from starts_at) * 1000)::float8 as starts_ms,
              (extract(epoch from ends_at) * 1000)::float8 as ends_ms
            from private.expand_schedule(${scheduleId}::uuid, ${from}::timestamptz, ${to}::timestamptz)`,
      ),
    );
  const windows = (w: Window[]) => w.map((x) => [iso(x.starts_ms), iso(x.ends_ms)]);
  const hours = (w: Window[]) => w.reduce((h, x) => h + (x.ends_ms - x.starts_ms) / 3_600_000, 0);

  it('keeps Chicago’s 09:00-17:00 the day clocks spring forward: 8 hours from 14:00Z', async () => {
    // Sunday 2026-03-08, in the workspace's zone (America/Chicago) since the schedule has none.
    const id = await schedule(null, [{ day: 0, start: '09:00', end: '17:00' }]);
    const w = await expand(member, id, '2026-03-08T06:00:00Z', '2026-03-09T05:00:00Z');
    expect(windows(w)).toEqual([['2026-03-08T14:00:00.000Z', '2026-03-08T22:00:00.000Z']]);
    expect(hours(w)).toBe(8);
  });

  it('counts the repeated hour the day clocks fall back: 00:00-04:00 is 5 hours', async () => {
    // Sunday 2026-11-01: 00:00 is still daylight time (05:00Z), 04:00 is standard time (10:00Z).
    const id = await schedule(null, [{ day: 0, start: '00:00', end: '04:00' }]);
    const w = await expand(member, id, '2026-11-01T05:00:00Z', '2026-11-02T06:00:00Z');
    expect(windows(w)).toEqual([['2026-11-01T05:00:00.000Z', '2026-11-01T10:00:00.000Z']]);
    expect(hours(w)).toBe(5);
  });

  it('Phoenix, which stays on standard time, is the control', async () => {
    const id = await schedule('America/Phoenix', [
      { day: 0, start: '00:00', end: '04:00' },
      { day: 0, start: '09:00', end: '17:00' },
    ]);
    const spring = await expand(member, id, '2026-03-08T07:00:00Z', '2026-03-09T07:00:00Z');
    expect(windows(spring)).toEqual([
      ['2026-03-08T07:00:00.000Z', '2026-03-08T11:00:00.000Z'],
      ['2026-03-08T16:00:00.000Z', '2026-03-09T00:00:00.000Z'],
    ]);
    const fall = await expand(member, id, '2026-11-01T07:00:00Z', '2026-11-02T07:00:00Z');
    expect(windows(fall)[0]).toEqual(['2026-11-01T07:00:00.000Z', '2026-11-01T11:00:00.000Z']);
    expect(hours(fall)).toBe(12);
  });

  it('adds available exceptions, runs to 24:00, clips to the range and stays in the caller’s workspaces', async () => {
    const id = await schedule(
      null,
      [{ day: 0, start: '20:00', end: '24:00' }],
      [['2026-03-07T16:00:00Z', '2026-03-07T18:00:00Z']],
    );
    const w = await expand(member, id, '2026-03-07T00:00:00Z', '2026-03-09T06:00:00Z');
    expect(windows(w)).toEqual([
      ['2026-03-07T16:00:00.000Z', '2026-03-07T18:00:00.000Z'],
      // Sunday 20:00-24:00 in daylight time.
      ['2026-03-09T01:00:00.000Z', '2026-03-09T05:00:00.000Z'],
    ]);
    const clipped = await expand(member, id, '2026-03-09T02:00:00Z', '2026-03-09T03:00:00Z');
    expect(windows(clipped)).toEqual([['2026-03-09T02:00:00.000Z', '2026-03-09T03:00:00.000Z']]);
    expect(await expand(outsider, id, '2026-03-07T00:00:00Z', '2026-03-09T06:00:00Z')).toEqual([]);
    const otherWorker = await worker(
      wsB,
      orgB,
    )((tx) =>
      rows(
        tx,
        sql`select * from private.expand_schedule(${id}::uuid, '2026-03-07T00:00:00Z', '2026-03-09T06:00:00Z')`,
      ),
    );
    expect(otherWorker).toEqual([]);
  });
});
