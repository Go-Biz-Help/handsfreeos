/**
 * Calendar commands on the local database: one calendar reshaped without losing anything, revision
 * conflicts, blocking issues, the impact review, permissions, catalogs, hours and time off.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, applyPatch, type CalendarConfig } from '../src/calendar/index';
import {
  appointmentCreate,
  appointmentList,
  bookingSiteGet,
  bookingSiteUpdate,
  calendarAvailability,
  calendarCreate,
  calendarGet,
  calendarList,
  calendarRestoreRevision,
  calendarSave,
  calendarSetSlug,
  calendarSetStatus,
  resourceArchive,
  resourceCreate,
  resourceList,
  resourceUpdate,
  scheduleSet,
  scheduleTeam,
  serviceArchive,
  serviceCreate,
  serviceList,
  serviceUpdate,
  territoryCreate,
  territoryDelete,
  territoryList,
  territoryUpdate,
  timeOffAdd,
  timeOffRemove,
} from '../src/server';
import {
  admin,
  ask,
  askSystem,
  customer,
  expectHfos,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  saveCalendar,
  setupTeam,
  WEEKDAYS,
  type Team,
} from './calendar-helpers';

let t: Team;
beforeAll(async () => {
  t = await setupTeam('calcmd');
});
afterAll(closeTestDbs);

const get = (calendarId: string) => ask(calendarGet, { workspaceId: t.wsId, calendarId }, t.owner);
const staffOf = async (appointmentId: string) =>
  (
    await rows<{ user_id: string }>(
      admin(),
      sql`select user_id from app.appointment_staff where appointment_id = ${appointmentId}`,
    )
  ).map((r) => r.user_id);
const statusOf = async (appointmentId: string) =>
  (
    await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.appointments where id = ${appointmentId}`,
    )
  )[0]?.status;

describe('one universal calendar', () => {
  it('turns Personal into Round Robin, Service and Group, keeping its id, link and appointments', async () => {
    const service = await run(
      serviceCreate,
      { workspaceId: t.wsId, name: 'AC tune-up', durations: [60, 90], bufferAfter: 15 },
      t.owner,
    );
    const created = await run(
      calendarCreate,
      { workspaceId: t.wsId, name: 'Dale’s calendar', preset: 'personal' },
      t.owner,
    );
    expect(created).toMatchObject({ revision: 1, slug: 'dale-s-calendar' });
    expect(created.labels.primary).toBe('personal');
    await run(
      calendarSetStatus,
      { workspaceId: t.wsId, calendarId: created.calendarId, status: 'active' },
      t.owner,
    );
    const day = nextWeekday(2);
    const maria = await customer(t, 'Maria');
    const booked = await run(
      appointmentCreate,
      {
        workspaceId: t.wsId,
        calendarId: created.calendarId,
        startsAt: isoAt(day, '10:00'),
        personId: maria,
      },
      t.owner,
    );
    expect(booked).toMatchObject({ userIds: [t.owner.id], warnings: [] });

    const team = [{ userId: t.owner.id }, { userId: t.priya.id }, { userId: t.marco.id }];
    const rr = await saveCalendar(t, created.calendarId, {
      team: { members: team, assignment: 'round_robin' },
    });
    expect(rr.revision).toBe(2);
    expect(rr.labels.primary).toBe('round_robin');
    expect(rr.diff).toEqual(
      expect.arrayContaining([
        'Added Priya Tech',
        'Added Marco Tech',
        'Assignment: fixed person → round robin',
      ]),
    );
    const svc = await saveCalendar(t, created.calendarId, {
      services: { mode: 'choice', items: [{ serviceId: service.serviceId }] },
    });
    expect(svc.revision).toBe(3);
    expect(svc.labels.tags).toEqual(['round_robin', 'service']);
    const group = await saveCalendar(t, created.calendarId, {
      capacity: { seats: 6, maxPartySize: 2 },
    });
    expect(group.revision).toBe(4);
    expect(group.labels.primary).toBe('group');

    const { calendar, revisions } = await get(created.calendarId);
    expect(calendar).toMatchObject({
      id: created.calendarId,
      slug: created.slug,
      revision: 4,
      status: 'active',
      permanentPath: `/book/c/${created.calendarId}`,
    });
    expect(revisions.map((r) => r.revision)).toEqual([4, 3, 2, 1]);
    expect(revisions[3]!.diff).toEqual(['Created from Personal']);
    expect(revisions[0]!.changedBy).toMatchObject({ id: t.owner.id });
    const list = await ask(
      appointmentList,
      {
        workspaceId: t.wsId,
        from: isoAt(day, '00:00'),
        to: isoAt(addDays(day, 1), '00:00'),
        calendarIds: [created.calendarId],
      },
      t.owner,
    );
    expect(list.items.map((a) => a.id)).toEqual([booked.appointmentId]);
    expect(list.items[0]!.attendees[0]).toMatchObject({ personId: maria });

    // The relational mirrors and the event follow the settings.
    const members = await rows(
      admin(),
      sql`select user_id from app.calendar_members where calendar_id = ${created.calendarId}`,
    );
    expect(members).toHaveLength(3);
    const services = await rows(
      admin(),
      sql`select service_id from app.calendar_services where calendar_id = ${created.calendarId}`,
    );
    expect(services).toHaveLength(1);
    const [updated] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where entity_id = ${created.calendarId}
          and event_type = 'calendar.updated' order by created_at desc limit 1`,
    );
    expect(updated!.payload).toMatchObject({
      labelsBefore: ['round_robin', 'service'],
      labelsAfter: ['group', 'round_robin', 'service'],
      revision: 4,
    });
  });

  it('refuses a stale draft with revision_conflict', async () => {
    const cal = await makeCalendar(t, 'Stale', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
    });
    const { calendar } = await get(cal.id);
    const config = calendar.config as CalendarConfig;
    await run(
      calendarSave,
      {
        workspaceId: t.wsId,
        calendarId: cal.id,
        baseRevision: calendar.revision,
        draft: applyPatch(config, { capacity: { seats: 2 } }),
      },
      t.owner,
    );
    const err = await expectHfos(
      () =>
        run(
          calendarSave,
          {
            workspaceId: t.wsId,
            calendarId: cal.id,
            baseRevision: calendar.revision,
            draft: applyPatch(config, { durations: { minutes: [30] } }),
          },
          t.owner,
        ),
      'revision_conflict',
      409,
    );
    expect(err.details).toEqual({ revision: calendar.revision + 1 });
  });

  it('blocks setting conflicts on an active calendar; drafts and paused calendars save with them', async () => {
    const cal = await makeCalendar(t, 'Blocking', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
    });
    const err = await expectHfos(
      () => saveCalendar(t, cal.id, { team: { assignment: 'collective' } }),
      'calendar_issues',
      422,
    );
    const issues = (err.details as { issues: { code: string; fixes: unknown[] }[] }).issues;
    expect(issues.map((i) => i.code)).toContain('collective_needs_two');
    expect(issues.find((i) => i.code === 'collective_needs_two')!.fixes.length).toBeGreaterThan(0);

    await run(
      calendarSetStatus,
      { workspaceId: t.wsId, calendarId: cal.id, status: 'paused' },
      t.owner,
    );
    const paused = await saveCalendar(t, cal.id, { team: { assignment: 'collective' } });
    expect(paused.issues.map((i) => i.code)).toContain('collective_needs_two');
    await expectHfos(
      () =>
        run(
          calendarSetStatus,
          { workspaceId: t.wsId, calendarId: cal.id, status: 'active' },
          t.owner,
        ),
      'calendar_issues',
      422,
    );

    const draft = await run(
      calendarCreate,
      { workspaceId: t.wsId, name: 'Draft pair', preset: 'collective' },
      t.owner,
    );
    expect(draft.issues.map((i) => i.code)).toContain('collective_needs_two');
    const again = await saveCalendar(t, draft.calendarId, { durations: { minutes: [45] } });
    expect(again.revision).toBe(2);
  });

  it('asks about upcoming appointments before removing someone, then keeps, reassigns or cancels them', async () => {
    const day = nextWeekday(3);
    const scenario = async (name: string, clock: string) => {
      const cal = await makeCalendar(t, name, {
        public: true,
        team: {
          members: [{ userId: t.priya.id }, { userId: t.marco.id }],
          assignment: 'round_robin',
        },
      });
      const person = await customer(t, name);
      const ids: string[] = [];
      for (const date of [day, addDays(day, 1)])
        ids.push(
          (
            await run(
              appointmentCreate,
              {
                workspaceId: t.wsId,
                calendarId: cal.id,
                startsAt: isoAt(date, clock),
                userIds: [t.priya.id],
                personId: person,
              },
              t.owner,
            )
          ).appointmentId,
        );
      const err = await expectHfos(
        () => saveCalendar(t, cal.id, { team: { members: [{ userId: t.marco.id }] } }),
        'impact_review_required',
        409,
      );
      expect((err.details as { impacts: unknown[] }).impacts).toEqual([
        expect.objectContaining({
          key: `member:${t.priya.id}`,
          code: 'member_removed',
          count: 2,
          message: 'Priya Tech has 2 upcoming appointments',
          decisions: ['keep', 'reassign', 'cancel_and_notify'],
        }),
      ]);
      const decide = (decision: string) =>
        saveCalendar(
          t,
          cal.id,
          { team: { members: [{ userId: t.marco.id }] } },
          { impactDecisions: { [`member:${t.priya.id}`]: decision } },
        );
      return { ids: ids.sort(), decide };
    };

    const keep = await scenario('Keep them', '09:00');
    const kept = await keep.decide('keep');
    expect(kept.actions).toEqual({ kept: keep.ids, reassigned: [], cancelled: [] });
    for (const id of keep.ids) expect(await staffOf(id)).toEqual([t.priya.id]);

    const move = await scenario('Move them', '11:00');
    const moved = await move.decide('reassign');
    expect([...moved.actions.reassigned].sort()).toEqual(move.ids);
    for (const id of move.ids) expect(await staffOf(id)).toEqual([t.marco.id]);

    const drop = await scenario('Drop them', '14:00');
    const dropped = await drop.decide('cancel_and_notify');
    expect([...dropped.actions.cancelled].sort()).toEqual(drop.ids);
    for (const id of drop.ids) expect(await statusOf(id)).toBe('cancelled');
    const events = await rows<{ payload: { by: string; notify: boolean } }>(
      admin(),
      sql`select payload from app.events where event_type = 'appointment.cancelled'
          and entity_id in (${drop.ids[0]}, ${drop.ids[1]})`,
    );
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ by: 'calendar_change', notify: true }),
      expect.objectContaining({ by: 'calendar_change', notify: true }),
    ]);
  });

  it('restores an earlier revision as a new one', async () => {
    const cal = await makeCalendar(t, 'Restorable', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
    });
    await saveCalendar(t, cal.id, { durations: { minutes: [30] } });
    const { calendar } = await get(cal.id);
    const restored = await run(
      calendarRestoreRevision,
      {
        workspaceId: t.wsId,
        calendarId: cal.id,
        revision: cal.revision,
        baseRevision: calendar.revision,
      },
      t.owner,
    );
    expect(restored.revision).toBe(calendar.revision + 1);
    expect(restored.diff[0]).toBe(`Restored revision ${cal.revision}`);
    expect(restored.diff).toContain('Lengths: 30 minutes → 1 hour');
  });
});

describe('permissions', () => {
  it('lets a member book but not manage calendars; the system reads availability', async () => {
    const cal = await makeCalendar(t, 'Members book', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
    });
    const day = nextWeekday(4);
    const booked = await run(
      appointmentCreate,
      { workspaceId: t.wsId, calendarId: cal.id, startsAt: isoAt(day, '15:00') },
      t.member,
    );
    expect(booked.userIds).toEqual([t.priya.id]);
    await expectHfos(
      () => run(calendarCreate, { workspaceId: t.wsId, name: 'Nope' }, t.member),
      'forbidden',
      403,
    );
    await expectHfos(
      () => saveCalendar(t, cal.id, { capacity: { seats: 3 } }, {}, t.member),
      'forbidden',
      403,
    );
    await expectHfos(
      () => run(serviceCreate, { workspaceId: t.wsId, name: 'Nope' }, t.member),
      'forbidden',
      403,
    );
    await run(scheduleSet, { workspaceId: t.wsId, weekly: WEEKDAYS }, t.member);
    await expectHfos(
      () => run(scheduleSet, { workspaceId: t.wsId, ownerId: t.priya.id, weekly: [] }, t.member),
      'forbidden',
      403,
    );
    const { calendar } = await ask(
      calendarGet,
      { workspaceId: t.wsId, calendarId: cal.id },
      t.member,
    );
    expect(calendar.id).toBe(cal.id);

    const open = await askSystem(
      calendarAvailability,
      {
        workspaceId: t.wsId,
        calendarId: cal.id,
        from: isoAt(day, '00:00'),
        to: isoAt(addDays(day, 1), '00:00'),
      },
      t.scope,
    );
    expect(open.timezone).toBe('America/Chicago');
    expect(open.slots.map((s) => s.startsAt)).toContain(isoAt(day, '08:00'));
    expect(open.slots.map((s) => s.startsAt)).not.toContain(isoAt(day, '15:00'));
  });
});

describe('catalogs', () => {
  it('manages services, resources, territories and the booking site, and flags an archived service', async () => {
    const svc = await run(
      serviceCreate,
      {
        workspaceId: t.wsId,
        name: 'Duct cleaning',
        durations: [120, 180],
        defaultDuration: 180,
        staffUserIds: [t.marco.id],
        hours: WEEKDAYS,
      },
      t.owner,
    );
    const up = await run(
      serviceUpdate,
      { workspaceId: t.wsId, serviceId: svc.serviceId, bufferBefore: 15, durations: [120] },
      t.owner,
    );
    expect(up.updated).toEqual(
      expect.arrayContaining(['bufferBefore', 'durations', 'defaultDuration']),
    );
    const services = await ask(serviceList, { workspaceId: t.wsId }, t.owner);
    expect(services.items.find((s) => s.id === svc.serviceId)).toMatchObject({
      durations: [120],
      defaultDuration: 120,
      bufferBefore: 15,
      staffUserIds: [t.marco.id],
      hours: WEEKDAYS,
    });
    await expectHfos(
      () => run(serviceCreate, { workspaceId: t.wsId, name: 'duct cleaning' }, t.owner),
      'name_taken',
      409,
    );
    const cal = await makeCalendar(t, 'Ducts', {
      public: true,
      team: { members: [{ userId: t.marco.id }] },
      services: { mode: 'one', items: [{ serviceId: svc.serviceId }] },
    });
    const archived = await run(
      serviceArchive,
      { workspaceId: t.wsId, serviceId: svc.serviceId },
      t.owner,
    );
    expect(archived.calendars.map((c) => c.id)).toContain(cal.id);
    const { calendar } = await get(cal.id);
    expect(calendar.issues.map((i) => i.code)).toContain('service_archived');

    const truck = await run(
      resourceCreate,
      { workspaceId: t.wsId, name: 'Truck 9', kind: 'vehicle', quantity: 2 },
      t.owner,
    );
    await run(
      resourceUpdate,
      { workspaceId: t.wsId, resourceId: truck.resourceId, quantity: 1, hours: WEEKDAYS },
      t.owner,
    );
    const resources = await ask(resourceList, { workspaceId: t.wsId }, t.owner);
    expect(resources.items.find((r) => r.id === truck.resourceId)).toMatchObject({
      quantity: 1,
      kind: 'vehicle',
      hours: WEEKDAYS,
    });
    await run(resourceArchive, { workspaceId: t.wsId, resourceId: truck.resourceId }, t.owner);
    expect(
      (await ask(resourceList, { workspaceId: t.wsId }, t.owner)).items.some(
        (r) => r.id === truck.resourceId,
      ),
    ).toBe(false);

    const north = await run(
      territoryCreate,
      {
        workspaceId: t.wsId,
        name: 'North',
        postalCodes: ['75202', '75201', '75201'],
        userIds: [t.priya.id],
      },
      t.owner,
    );
    await run(
      territoryUpdate,
      { workspaceId: t.wsId, territoryId: north.territoryId, userIds: [t.priya.id, t.marco.id] },
      t.owner,
    );
    const territories = await ask(territoryList, { workspaceId: t.wsId }, t.member);
    expect(territories.items.find((x) => x.id === north.territoryId)).toMatchObject({
      name: 'North',
      postalCodes: ['75201', '75202'],
    });
    expect([...territories.items.find((x) => x.id === north.territoryId)!.userIds].sort()).toEqual(
      [t.priya.id, t.marco.id].sort(),
    );
    await run(territoryDelete, { workspaceId: t.wsId, territoryId: north.territoryId }, t.owner);

    await expectHfos(
      () => run(bookingSiteUpdate, { workspaceId: t.wsId, slug: 'manage', name: 'X' }, t.owner),
      'booking_slug_reserved',
      400,
    );
    const slug = `lone-star-${Date.now()}`;
    const site = await run(
      bookingSiteUpdate,
      { workspaceId: t.wsId, slug, name: 'Lone Star' },
      t.owner,
    );
    await run(
      bookingSiteUpdate,
      { workspaceId: t.wsId, slug, name: 'Lone Star HVAC', intro: 'Book a visit' },
      t.owner,
    );
    expect((await ask(bookingSiteGet, { workspaceId: t.wsId }, t.owner)).site).toMatchObject({
      id: site.siteId,
      name: 'Lone Star HVAC',
      path: `/book/${slug}`,
    });

    const renamed = await run(
      calendarSetSlug,
      { workspaceId: t.wsId, calendarId: cal.id, slug: 'duct-visits' },
      t.owner,
    );
    expect(renamed.previousSlug).toBe(cal.slug);
    const listed = await ask(calendarList, { workspaceId: t.wsId }, t.member);
    expect(listed.items.find((c) => c.id === cal.id)).toMatchObject({
      bookingPath: `/book/${slug}/duct-visits`,
      permanentPath: `/book/c/${cal.id}`,
    });
    const retired = await rows<{ slug: string }>(
      admin(),
      sql`select slug from app.calendar_slugs where calendar_id = ${cal.id}`,
    );
    expect(retired.map((r) => r.slug)).toEqual([cal.slug]);
  });
});

describe('hours and time off', () => {
  it('sets hours and all-day time off in the schedule’s zone (a 23-hour day), and shows the team', async () => {
    await run(
      scheduleSet,
      { workspaceId: t.wsId, weekly: [{ day: 1, start: '07:00', end: '15:00' }] },
      t.member,
    );
    // Daylight saving starts on 2027-03-14 in Chicago: that local date is 23 hours long.
    const off = await run(
      timeOffAdd,
      { workspaceId: t.wsId, startDate: '2027-03-14', note: 'Spring break' },
      t.member,
    );
    expect(off.startsAt).toBe('2027-03-14T06:00:00.000Z');
    expect(off.endsAt).toBe('2027-03-15T05:00:00.000Z');
    const team = await ask(
      scheduleTeam,
      {
        workspaceId: t.wsId,
        from: '2027-03-13T06:00:00.000Z',
        to: '2027-03-16T05:00:00.000Z',
        userIds: [t.member.id, t.priya.id],
      },
      t.member,
    );
    const mike = team.people.find((p) => p.userId === t.member.id)!;
    expect(mike.weekly).toEqual([{ day: 1, start: '07:00', end: '15:00' }]);
    expect(mike.defaultHours).toBe(false);
    expect(mike.timeOff).toEqual([
      expect.objectContaining({ id: off.exceptionId, allDay: true, note: 'Spring break' }),
    ]);
    // Monday 07:00 to 15:00 CDT.
    expect(mike.hours).toEqual([
      { startsAt: '2027-03-15T12:00:00.000Z', endsAt: '2027-03-15T20:00:00.000Z' },
    ]);
    await expectHfos(
      () =>
        run(
          timeOffAdd,
          { workspaceId: t.wsId, ownerId: t.priya.id, startDate: '2027-03-15' },
          t.member,
        ),
      'forbidden',
      403,
    );
    await expectHfos(
      () => run(timeOffRemove, { workspaceId: t.wsId, exceptionId: off.exceptionId }, t.priya),
      'forbidden',
      403,
    );
    await run(timeOffRemove, { workspaceId: t.wsId, exceptionId: off.exceptionId }, t.member);
    await run(scheduleSet, { workspaceId: t.wsId, weekly: WEEKDAYS }, t.member);
  });
});
