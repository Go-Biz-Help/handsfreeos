/**
 * Drive times between visits (docs/outreach.md, decision 179) on the local database: where each person's day starts
 * (day_start.set and day_start.get, theirs and the owners' and admins' alone), and a calendar that leaves time to
 * drive refusing a time the worker's drives don't leave room for.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditList, dayStartGet, dayStartSet } from '../src/server';
import {
  admin,
  ask,
  bookOnline,
  expectHfos,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
beforeAll(async () => {
  t = await setupTeam('drives');
});
afterAll(closeTestDbs);

describe('where the day starts', () => {
  it('starts from the business’s address until someone sets their own, which only they and owners see', async () => {
    await rows(
      admin(),
      sql`update app.workspaces set settings = settings || ${JSON.stringify({
        address: {
          line1: '12 Oak St',
          line2: 'Suite 4',
          city: 'Austin',
          state: 'TX',
          postalCode: '78701',
          country: 'US',
        },
      })}::jsonb where id = ${t.wsId}`,
    );
    const first = await ask(dayStartGet, { workspaceId: t.wsId }, t.member);
    expect(first).toEqual({
      userId: t.member.id,
      address: null,
      businessAddress: '12 Oak St, Suite 4, Austin, TX 78701',
    });

    const mine = await run(
      dayStartSet,
      { workspaceId: t.wsId, address: '  88  Elm Ave, Round Rock, TX 78664 ' },
      t.member,
    );
    expect(mine.address).toBe('88 Elm Ave, Round Rock, TX 78664');

    // Someone else's, only for owners and admins.
    await expectHfos(
      () => run(dayStartSet, { workspaceId: t.wsId, userId: t.priya.id, address: 'x 1' }, t.member),
      'forbidden',
      403,
    );
    await expectHfos(
      () => ask(dayStartGet, { workspaceId: t.wsId, userId: t.member.id }, t.priya),
      'forbidden',
      403,
    );
    expect(
      (await ask(dayStartGet, { workspaceId: t.wsId, userId: t.member.id }, t.owner)).address,
    ).toBe('88 Elm Ave, Round Rock, TX 78664');
    await run(
      dayStartSet,
      { workspaceId: t.wsId, userId: t.priya.id, address: '5 Pine Rd, Austin, TX 78702' },
      t.owner,
    );

    // Cleared: back to the business's address. The history never holds the address itself.
    const cleared = await run(dayStartSet, { workspaceId: t.wsId, address: '' }, t.member);
    expect(cleared.address).toBeNull();
    const audit = await ask(auditList, { workspaceId: t.wsId, limit: 20 }, t.owner);
    const lines = JSON.stringify(audit);
    expect(lines).toContain('day_start.set');
    expect(lines).not.toContain('Elm Ave');
    expect(lines).not.toContain('Pine Rd');
  });
});

describe('a calendar that leaves time to drive between visits', () => {
  it('refuses a time too close to the visit before or the start of the day, by the drives given', async () => {
    const cal = await makeCalendar(t, 'Mobile detailing', {
      public: true,
      team: { members: [{ userId: t.marco.id }], assignment: 'fixed' },
      durations: { minutes: [60] },
      locations: { options: [{ kind: 'customer_address' }] },
      buffers: { driveBetween: true },
    });
    const day = nextWeekday(3);
    const before = await bookOnline(t, cal.id, isoAt(day, '11:00'), {
      address: '1 First St, Austin, TX 78701',
    });
    const around = { [before.appointmentId]: 30 };
    const drives = { fromStart: { [t.marco.id]: 45 }, around };
    const address = { address: '9 Ninth St, Austin, TX 78704', drives };

    // 12:00 leaves no time to drive from the 11:00 visit, 12:30 does.
    await expectHfos(() => bookOnline(t, cal.id, isoAt(day, '12:00'), address), 'slot_taken', 409);
    // 10:00 would end as the 11:00 visit starts, with no time to drive there.
    await expectHfos(() => bookOnline(t, cal.id, isoAt(day, '10:00'), address), 'slot_taken', 409);
    // 08:00 is the start of the day: Marco needs 45 minutes from where it starts.
    await expectHfos(() => bookOnline(t, cal.id, isoAt(day, '08:00'), address), 'slot_taken', 409);
    const ok = await bookOnline(t, cal.id, isoAt(day, '12:30'), address);
    expect(ok.userIds).toEqual([t.marco.id]);
    // Without drives (no address on a map), the usual rules: back to back is fine.
    const plain = await bookOnline(t, cal.id, isoAt(day, '13:30'));
    expect(plain.userIds).toEqual([t.marco.id]);
  });
});
