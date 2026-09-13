/**
 * Short booking links (0018): every booking and waitlist entry gets its own 8-character base62 reference by
 * default, whoever adds it; nobody can change one; and only the worker can find a booking by it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

const REF = /^[0-9A-Za-z]{8}$/;
const token = () =>
  uniq()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

let owner: TestUser;
let outsider: TestUser;
let wsA: string;
let orgA: string;
let wsB: string;
let orgB: string;

beforeAll(async () => {
  [owner, outsider] = await Promise.all([
    createTestUser('links-owner'),
    createTestUser('links-outsider'),
  ]);
  ({ wsId: wsA, orgId: orgA } = await bootstrapOrganization(owner, 'Links Org A', 'Links A'));
  ({ wsId: wsB, orgId: orgB } = await bootstrapOrganization(outsider, 'Links Org B', 'Links B'));
});
afterAll(closeAll);

interface Seeded {
  readonly calendarId: string;
  readonly appointmentId: string;
  readonly personId: string;
  readonly attendee: { id: string; public_ref: string; manage_version: number };
  readonly entry: { id: string; public_ref: string };
}

/** A booking page's booking and a waitlist entry, added by the worker. */
function seed(ws: string, org: string): Promise<Seeded> {
  return asService({ workspaceId: ws, organizationId: org })(async (tx) => {
    const [cal] = await rows<{ id: string }>(
      tx,
      sql`insert into app.calendars (workspace_id, name, slug, status, public)
          values (${ws}, 'Tune-ups', ${`links-${token()}`}, 'active', true) returning id`,
    );
    const [person] = await rows<{ id: string }>(
      tx,
      sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Mike', 'Ruiz') returning id`,
    );
    const [appt] = await rows<{ id: string }>(
      tx,
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, source)
          values (${ws}, ${cal!.id}, 1, 'AC tune-up', '2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z', 'booking_page')
          returning id`,
    );
    const [attendee] = await rows<Seeded['attendee']>(
      tx,
      sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, source)
          values (${ws}, ${appt!.id}, ${person!.id}, 'booking_page') returning id, public_ref, manage_version`,
    );
    const [entry] = await rows<Seeded['entry']>(
      tx,
      sql`insert into app.waitlist_entries (workspace_id, calendar_id, appointment_id, person_id, source)
          values (${ws}, ${cal!.id}, ${appt!.id}, ${person!.id}, 'booking_page') returning id, public_ref`,
    );
    return {
      calendarId: cal!.id,
      appointmentId: appt!.id,
      personId: person!.id,
      attendee: attendee!,
      entry: entry!,
    };
  });
}

describe('public references', () => {
  it('gives every booking and waitlist entry its own, whoever adds it', async () => {
    const a = await seed(wsA, orgA);
    const b = await seed(wsA, orgA);
    // Staff add a customer to the same appointment: the default runs for people too.
    const [sara] = await asService({ workspaceId: wsA, organizationId: orgA })((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name) values (${wsA}, 'Sara', 'Lee') returning id`,
      ),
    );
    const [staff] = await as(owner)((tx) =>
      rows<{ public_ref: string }>(
        tx,
        sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, created_by)
            values (${wsA}, ${a.appointmentId}, ${sara!.id}, ${owner.id}) returning public_ref`,
      ),
    );
    const refs = [
      a.attendee.public_ref,
      a.entry.public_ref,
      b.attendee.public_ref,
      b.entry.public_ref,
      staff!.public_ref,
    ];
    for (const ref of refs) expect(ref).toMatch(REF);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('never changes: the worker is refused and people have no grant', async () => {
    const a = await seed(wsA, orgA);
    const worker = asService({ workspaceId: wsA, organizationId: orgA });
    const byWorker = await expectPgError(() =>
      worker((tx) =>
        rows(
          tx,
          sql`update app.appointment_attendees set public_ref = 'AAAAAAAA' where id = ${a.attendee.id}`,
        ),
      ),
    );
    expect(byWorker.code).toBe('23514');
    const entryByWorker = await expectPgError(() =>
      worker((tx) =>
        rows(
          tx,
          sql`update app.waitlist_entries set public_ref = 'AAAAAAAA' where id = ${a.entry.id}`,
        ),
      ),
    );
    expect(entryByWorker.code).toBe('23514');
    const byOwner = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`update app.appointment_attendees set public_ref = 'AAAAAAAA' where id = ${a.attendee.id}`,
        ),
      ),
    );
    expect(byOwner.code).toBe('42501');
    // Other columns still change, and the reference stays.
    await worker((tx) =>
      rows(
        tx,
        sql`update app.appointment_attendees set manage_version = 2 where id = ${a.attendee.id}`,
      ),
    );
    const [after] = await worker((tx) =>
      rows<{ public_ref: string }>(
        tx,
        sql`select public_ref from app.appointment_attendees where id = ${a.attendee.id}`,
      ),
    );
    expect(after!.public_ref).toBe(a.attendee.public_ref);
  });
});

describe('finding a link’s booking', () => {
  it('lets the worker find it before it knows the workspace, and nobody else', async () => {
    const a = await seed(wsA, orgA);
    const b = await seed(wsB, orgB);
    const unscoped = asService({});
    const [found] = await unscoped((tx) =>
      rows(tx, sql`select * from private.booking_manage_lookup(${a.attendee.public_ref})`),
    );
    expect(found).toEqual({
      attendee_id: a.attendee.id,
      workspace_id: wsA,
      organization_id: orgA,
      manage_version: 1,
    });
    const [offer] = await unscoped((tx) =>
      rows(tx, sql`select * from private.waitlist_offer_lookup(${b.entry.public_ref})`),
    );
    expect(offer).toEqual({ entry_id: b.entry.id, workspace_id: wsB, organization_id: orgB });
    // Malformed or unknown references find nothing.
    for (const ref of ['short', `${a.attendee.public_ref}x`, "' or true --", 'ZZZZZZZZ'])
      expect(
        await unscoped((tx) => rows(tx, sql`select * from private.booking_manage_lookup(${ref})`)),
      ).toEqual([]);
    // People can't call either lookup, even for their own bookings.
    for (const fn of ['booking_manage_lookup', 'waitlist_offer_lookup']) {
      const e = await expectPgError(() =>
        as(owner)((tx) =>
          rows(tx, sql`select * from ${sql.raw(`private.${fn}`)}(${a.attendee.public_ref})`),
        ),
      );
      expect(e.code).toBe('42501');
    }
  });
});
