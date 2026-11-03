/**
 * Scheduling a webinar (webinar.schedule) on the real database. The owner's ask: a webinar can be made without a
 * webinar calendar, and the calendar is made with it.
 *
 * What's worth holding:
 *   - with no webinar calendar, one is made (Webinars, from the Webinar preset, the person scheduling presenting) and
 *     turned on, and the next webinar goes on it rather than a new one;
 *   - a repeat books every date on the same weekday and clock time, as one series;
 *   - warnings ask once for every date, nothing is booked until then, and Publish anyway books over them;
 *   - a calendar that isn't a webinar one is refused, and so is making one without permission to manage calendars;
 *   - with video calls off, nothing is made.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isWebinarCalendar, parseConfig, zonedParts } from '../src/calendar/index';
import { webinarSchedule } from '../src/server';
import {
  admin,
  CHI,
  DAY,
  expectHfos,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;

const schedule = (input: Record<string, unknown>, u = t.owner) =>
  run(webinarSchedule, { workspaceId: t.wsId, ...input }, u);

const calendarCount = async () =>
  (
    await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.calendars where workspace_id = ${t.wsId}`,
    )
  )[0]!.n;

const sessions = (calendarId: string) =>
  rows<{
    id: string;
    kind: string;
    title: string;
    capacity: number;
    starts_at: string;
    series_id: string | null;
  }>(
    admin(),
    sql`select id, kind, title, capacity, starts_at, series_id from app.appointments
        where calendar_id = ${calendarId} and status = 'scheduled' order by starts_at`,
  );

beforeAll(async () => {
  t = await setupTeam('webinar-schedule');
});
afterAll(closeTestDbs);

describe('with no webinar calendar', () => {
  it('makes nothing while video calls are off', async () => {
    await expectHfos(
      () => schedule({ title: 'Live demo', startsAt: isoAt(nextWeekday(2, 5), '10:00') }),
      'video_calls_off',
      409,
    );
    expect(await calendarCount()).toBe(0);
    await rows(admin(), sql`update app.workspaces set video_calls = true where id = ${t.wsId}`);
  });

  it('needs someone who may manage calendars to make it', async () => {
    const e = await expectHfos(
      () => schedule({ title: 'Live demo', startsAt: isoAt(nextWeekday(2, 5), '10:00') }, t.member),
      'no_webinar_calendar',
      403,
    );
    expect(e.message).toContain('Settings → Calendars');
    expect(await calendarCount()).toBe(0);
  });

  it('makes a Webinars calendar, turned on, with the person scheduling presenting', async () => {
    const out = await schedule({
      title: 'Live demo',
      startsAt: isoAt(nextWeekday(2, 5), '10:00'),
      seats: 40,
    });
    expect(out).toMatchObject({ calendarName: 'Webinars', calendarMade: true, seriesId: null });
    const [cal] = await rows<{ status: string; config: unknown }>(
      admin(),
      sql`select status, config from app.calendars where id = ${out.calendarId}`,
    );
    expect(cal!.status).toBe('active');
    expect(isWebinarCalendar(parseConfig(cal!.config))).toBe(true);
    const [s] = await sessions(out.calendarId);
    expect(s).toMatchObject({
      id: out.appointmentIds[0],
      kind: 'session',
      title: 'Live demo',
      capacity: 40,
    });
    const staff = await rows<{ user_id: string }>(
      admin(),
      sql`select user_id from app.appointment_staff where appointment_id = ${s!.id}`,
    );
    expect(staff.map((r) => r.user_id)).toEqual([t.owner.id]);
  });
});

describe('with a webinar calendar', () => {
  let calendarId: string;
  beforeAll(async () => {
    const [cal] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.calendars where workspace_id = ${t.wsId} and name = 'Webinars'`,
    );
    calendarId = cal!.id;
  });

  it('puts the next webinar on it, for anyone who books', async () => {
    const out = await schedule(
      { title: 'Q and A', startsAt: isoAt(nextWeekday(3, 5), '09:00') },
      t.member,
    );
    expect(out).toMatchObject({ calendarId, calendarMade: false });
    expect(await calendarCount()).toBe(1);
  });

  it('repeats on the same weekday and time, as one series', async () => {
    const first = nextWeekday(4, 5);
    const out = await schedule({
      title: 'Weekly demo',
      startsAt: isoAt(first, '11:00'),
      repeat: 'week',
      times: 4,
    });
    expect(out.appointmentIds).toHaveLength(4);
    expect(out.seriesId).not.toBeNull();
    const list = (await sessions(calendarId)).filter((s) => s.series_id === out.seriesId);
    expect(list.map((s) => s.title)).toEqual(Array(4).fill('Weekly demo'));
    for (const s of list) {
      const p = zonedParts(new Date(s.starts_at).getTime(), CHI);
      expect([p.hour, p.minute]).toEqual([11, 0]);
    }
    const gaps = list
      .slice(1)
      .map((s, i) => new Date(s.starts_at).getTime() - new Date(list[i]!.starts_at).getTime());
    for (const gap of gaps) expect(Math.round(gap / DAY)).toBe(7);
  });

  it('asks once about warnings for every date, then publishes anyway', async () => {
    const before = (await sessions(calendarId)).length;
    const input = {
      title: 'Evening demo',
      // Everyone works 8 to 5, so 7 PM is outside the presenter's hours on every date.
      startsAt: isoAt(nextWeekday(1, 5), '19:00'),
      repeat: 'two_weeks',
      times: 3,
    };
    const e = await expectHfos(() => schedule(input), 'needs_confirmation', 409);
    expect(e.message).toContain('Publish anyway');
    expect((await sessions(calendarId)).length).toBe(before);
    const out = await schedule({ ...input, acknowledgeWarnings: true });
    expect(out.appointmentIds).toHaveLength(3);
    expect(out.skipped).toEqual([]);
  });

  it('refuses a calendar that isn’t a webinar one', async () => {
    const plain = await makeCalendar(t, 'Tune-ups', {
      team: { members: [{ userId: t.priya.id }] },
    });
    await expectHfos(
      () =>
        schedule({
          calendarId: plain.id,
          title: 'Live demo',
          startsAt: isoAt(nextWeekday(2, 5), '10:00'),
        }),
      'not_a_webinar_calendar',
      409,
    );
  });
});
