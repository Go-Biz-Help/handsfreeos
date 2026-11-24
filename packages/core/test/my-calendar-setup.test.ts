/**
 * The guided My calendar setup (the owner, 24 Nov 2026: M1 a, M2 a, M3 a, M4 a): its own logic
 * (guided-setup/my-calendar.ts) with no database (where the answers start, which questions are asked, the hours they
 * make, what is wrong with one, which calendar to sign in to, the lines beside the questions and on Settings → My
 * calendar), then on the local database: answers kept per person as they're given (guided_setup.save_draft under
 * my_calendar), and Check it over's save (my_calendar_setup.save) setting the hours, time off and the Getting started
 * step, nothing changing when an answer is wrong.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  MY_CALENDAR_SETUP_WORDS as W,
  MY_CALENDAR_WEEKDAYS,
  formatHours,
  guidedSetupPermission,
  isPersonalGuidedSetup,
  myCalendarIsSetUp,
  myCalendarSettingsLines,
  myCalendarSetupAnswersOf,
  myCalendarSetupFirstProblem,
  myCalendarSetupLines,
  myCalendarSetupProblems,
  myCalendarSetupQuestionOf,
  myCalendarSetupQuestions,
  myCalendarSetupStart,
  myCalendarTimeOffLabel,
  myCalendarTimeOffProblem,
  myCalendarToConnect,
  myCalendarWeekly,
  sameWeeklyHours,
  withLunch,
  type MyCalendarSetupAnswers,
  type MyCalendarSetupContext,
} from '../src';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  guidedSetupGetDraft,
  guidedSetupSaveDraft,
  myCalendarSetupGet,
  myCalendarSetupSave,
  onboardingStatus,
  organizationCreate,
} from '../src/server';

const OPEN_8_TO_5 = [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '17:00' }));

/** Someone who has set nothing up yet, at a business open weekdays 8 to 5. */
const NEW: MyCalendarSetupContext = {
  userId: '0d3f1e3a-6a1b-4c55-9a52-1b2c3d4e5f60',
  fullName: 'Marco Member',
  businessZone: 'America/Chicago',
  businessHours: OPEN_8_TO_5,
  weekly: null,
  ownTimezone: null,
  timeOff: [],
  connection: null,
  drive: false,
  dayStart: null,
  businessAddress: '100 Congress Ave, Austin, TX',
  zoom: false,
  meeting: null,
};

const GOOGLE = {
  id: '1d3f1e3a-6a1b-4c55-9a52-1b2c3d4e5f61',
  provider: 'google' as const,
  status: 'active' as const,
  accountEmail: 'marco@gmail.test',
  busySyncedAt: null,
};

const answers = (over: Partial<MyCalendarSetupAnswers> = {}): MyCalendarSetupAnswers => ({
  ...myCalendarSetupStart(NEW),
  ...over,
});

describe('where the answers start', () => {
  it('starts someone new on the business’s open hours, no calendar picked, and Zoom to connect', () => {
    expect(myCalendarSetupStart(NEW)).toMatchObject({
      calendar: null,
      hours: 'business',
      ownHours: OPEN_8_TO_5,
      lunch: false,
      lunchStart: '12:00',
      lunchEnd: '13:00',
      timezone: null,
      timeOff: [],
      removeTimeOff: [],
      dayStart: 'business',
      address: '',
      zoom: true,
    });
  });

  it('starts from what is set now: the calendar connected, and saved hours read back as the three choices', () => {
    expect(myCalendarSetupStart({ ...NEW, connection: GOOGLE }).calendar).toBe('google');
    // Never "none" to start with, even with hours saved: Getting started's step is a real pick.
    expect(myCalendarSetupStart({ ...NEW, weekly: MY_CALENDAR_WEEKDAYS }).calendar).toBeNull();
    expect(myCalendarSetupStart({ ...NEW, weekly: MY_CALENDAR_WEEKDAYS })).toMatchObject({
      hours: 'weekdays',
      lunch: false,
    });
    expect(
      myCalendarSetupStart({ ...NEW, weekly: withLunch(OPEN_8_TO_5, '12:30', '13:15') }),
    ).toMatchObject({ hours: 'business', lunch: true, lunchStart: '12:30', lunchEnd: '13:15' });
    const odd = [{ day: 6, start: '10:00', end: '14:00' }];
    expect(myCalendarSetupStart({ ...NEW, weekly: odd })).toMatchObject({
      hours: 'own',
      ownHours: odd,
    });
    expect(
      myCalendarSetupStart({
        ...NEW,
        dayStart: '12 Elm St, Austin, TX',
        ownTimezone: 'America/Denver',
      }),
    ).toMatchObject({
      dayStart: 'own',
      address: '12 Elm St, Austin, TX',
      timezone: 'America/Denver',
    });
  });

  it('reads saved answers back a field at a time, leaving one that no longer fits at its start', () => {
    const start = myCalendarSetupStart(NEW);
    expect(
      myCalendarSetupAnswersOf({ calendar: 'microsoft', hours: 'sometimes', lunch: true }, start),
    ).toEqual({ ...start, calendar: 'microsoft', lunch: true });
    expect(myCalendarSetupAnswersOf(null, start)).toEqual(start);
  });

  it('is each person’s own, for whoever takes appointments', () => {
    expect(isPersonalGuidedSetup('my_calendar')).toBe(true);
    expect(isPersonalGuidedSetup('calendar')).toBe(false);
    expect(guidedSetupPermission('my_calendar')).toBe('appointments.write');
  });

  it('is set up once a calendar is connected or hours of their own are saved', () => {
    expect(myCalendarIsSetUp(NEW)).toBe(false);
    expect(myCalendarIsSetUp({ ...NEW, weekly: MY_CALENDAR_WEEKDAYS })).toBe(true);
    expect(
      myCalendarIsSetUp({ ...NEW, connection: { ...GOOGLE, status: 'reauth_required' } }),
    ).toBe(true);
    expect(myCalendarIsSetUp({ ...NEW, connection: { ...GOOGLE, status: 'pending' } })).toBe(false);
  });
});

describe('which questions, and the hours they make', () => {
  it('asks where the day starts only with drive times, and Zoom only while it’s needed and not connected', () => {
    expect(myCalendarSetupQuestions(NEW)).toEqual(['calendar', 'hours', 'timeOff']);
    expect(myCalendarSetupQuestions({ ...NEW, drive: true, zoom: true })).toEqual([
      'calendar',
      'hours',
      'timeOff',
      'dayStart',
      'zoom',
    ]);
    expect(
      myCalendarSetupQuestions({
        ...NEW,
        zoom: true,
        meeting: { status: 'active', accountEmail: null },
      }),
    ).toEqual(['calendar', 'hours', 'timeOff']);
    expect(
      myCalendarSetupQuestions({
        ...NEW,
        zoom: true,
        meeting: { status: 'error', accountEmail: null },
      }),
    ).toContain('zoom');
  });

  it('reads saved hours back whatever order their keys come in, as the database gives them', () => {
    const fromDb = OPEN_8_TO_5.map(({ day, start, end }) => ({ day, end, start })).reverse();
    expect(sameWeeklyHours(fromDb, OPEN_8_TO_5)).toBe(true);
    expect(sameWeeklyHours(fromDb.slice(1), OPEN_8_TO_5)).toBe(false);
    expect(myCalendarSetupStart({ ...NEW, weekly: fromDb })).toMatchObject({
      hours: 'business',
      lunch: false,
    });
  });

  it('makes the business’s hours or weekdays 9 to 5, with lunch taken out of every day, or their own', () => {
    expect(myCalendarWeekly(answers(), NEW)).toEqual(OPEN_8_TO_5);
    expect(myCalendarWeekly(answers({ hours: 'weekdays', lunch: true }), NEW)).toEqual(
      [1, 2, 3, 4, 5].flatMap((day) => [
        { day, start: '09:00', end: '12:00' },
        { day, start: '13:00', end: '17:00' },
      ]),
    );
    const own = [{ day: 2, start: '07:00', end: '11:00' }];
    // Lunch is for the first two choices only.
    expect(myCalendarWeekly(answers({ hours: 'own', ownHours: own, lunch: true }), NEW)).toEqual(
      own,
    );
    // A lunch outside a day's hours leaves it whole.
    expect(withLunch([{ day: 6, start: '14:00', end: '18:00' }], '12:00', '13:00')).toEqual([
      { day: 6, start: '14:00', end: '18:00' },
    ]);
  });
});

describe('what stops Next', () => {
  it('lets good answers through', () => {
    for (const q of myCalendarSetupQuestions({ ...NEW, drive: true, zoom: true }))
      expect(myCalendarSetupProblems(q, answers({ calendar: 'google' }), NEW)).toEqual([]);
    expect(myCalendarSetupFirstProblem(answers({ calendar: 'none' }), NEW)).toBeNull();
  });

  it('says what is wrong in plain words, on the answer it’s about', () => {
    expect(myCalendarSetupProblems('calendar', answers(), NEW)).toEqual([
      { path: 'calendar', message: W.problems.calendar },
    ]);
    expect(myCalendarSetupFirstProblem(answers(), NEW)).toBe('calendar');
    expect(myCalendarSetupProblems('hours', answers({ hours: 'own', ownHours: [] }), NEW)).toEqual([
      { path: 'ownHours', message: W.problems.noDays },
    ]);
    expect(
      myCalendarSetupProblems(
        'hours',
        answers({ lunch: true, lunchStart: '13:00', lunchEnd: '12:00' }),
        NEW,
      ),
    ).toEqual([{ path: 'lunchEnd', message: W.problems.lunchEnd }]);
    expect(
      myCalendarSetupProblems(
        'hours',
        answers({ lunch: true, lunchStart: '06:00', lunchEnd: '20:00' }),
        NEW,
      ),
    ).toEqual([{ path: 'lunchStart', message: W.problems.lunchAll }]);
    expect(myCalendarSetupProblems('hours', answers(), { businessHours: [] })).toEqual([
      { path: 'hours', message: W.problems.businessClosed },
    ]);
    expect(
      myCalendarSetupProblems('dayStart', answers({ dayStart: 'own', address: ' ' }), NEW),
    ).toEqual([{ path: 'address', message: W.problems.address }]);
  });

  it('checks each time off before it’s added', () => {
    const day = {
      allDay: true,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      start: '09:00',
      end: '12:00',
    };
    expect(myCalendarTimeOffProblem(day)).toBeNull();
    expect(myCalendarTimeOffProblem({ ...day, endDate: '2026-12-23' })).toBe(W.problems.timeOffEnd);
    expect(myCalendarTimeOffProblem({ ...day, startDate: 'Christmas' })).toBe(
      W.problems.timeOffDate,
    );
    expect(myCalendarTimeOffProblem({ ...day, allDay: false, end: '08:00' })).toBe(
      W.problems.timeOffEndTime,
    );
  });

  it('finds the question a refusal is about, from its path', () => {
    expect(myCalendarSetupQuestionOf('answers.calendar')).toBe('calendar');
    expect(myCalendarSetupQuestionOf('answers.lunchEnd')).toBe('hours');
    expect(myCalendarSetupQuestionOf('answers.removeTimeOff.0')).toBe('timeOff');
    expect(myCalendarSetupQuestionOf('answers.address')).toBe('dayStart');
    expect(myCalendarSetupQuestionOf('answers.zoom')).toBe('zoom');
    expect(myCalendarSetupQuestionOf('workspaceId')).toBeNull();
  });
});

describe('which calendar to sign in to', () => {
  it('signs in to the one picked unless it’s connected and working already', () => {
    expect(myCalendarToConnect({ calendar: 'google' }, NEW)).toBe('google');
    expect(myCalendarToConnect({ calendar: 'google' }, { connection: GOOGLE })).toBeNull();
    expect(
      myCalendarToConnect({ calendar: 'google' }, { connection: { ...GOOGLE, status: 'error' } }),
    ).toBe('google');
    expect(myCalendarToConnect({ calendar: 'microsoft' }, { connection: GOOGLE })).toBe(
      'microsoft',
    );
    expect(myCalendarToConnect({ calendar: 'none' }, NEW)).toBeNull();
    expect(myCalendarToConnect({ calendar: null }, NEW)).toBeNull();
  });
});

describe('the lines', () => {
  it('says time off as a person would', () => {
    const t = { allDay: true, start: '09:00', end: '12:00' };
    expect(myCalendarTimeOffLabel({ ...t, startDate: '2026-12-24', endDate: '2026-12-24' })).toBe(
      'Dec 24',
    );
    expect(
      myCalendarTimeOffLabel({
        ...t,
        startDate: '2026-11-26',
        endDate: '2026-11-27',
        note: 'Thanksgiving',
      }),
    ).toBe('Nov 26 to 27, Thanksgiving');
    expect(myCalendarTimeOffLabel({ ...t, startDate: '2026-11-30', endDate: '2026-12-02' })).toBe(
      'Nov 30 to Dec 2',
    );
    expect(
      myCalendarTimeOffLabel({
        ...t,
        allDay: false,
        startDate: '2026-12-24',
        endDate: '2026-12-24',
      }),
    ).toBe('Dec 24, 9:00 AM to 12:00 PM');
  });

  it('says each answer in a line, for the list and Check it over', () => {
    const lines = myCalendarSetupLines(
      answers({
        calendar: 'google',
        hours: 'weekdays',
        lunch: true,
        timeOff: [
          {
            key: 'a',
            allDay: true,
            startDate: '2026-12-24',
            endDate: '2026-12-24',
            start: '09:00',
            end: '12:00',
            note: '',
          },
        ],
      }),
      NEW,
    );
    expect(lines.map((l) => l.id)).toEqual(['calendar', 'hours', 'timezone', 'timeOff']);
    expect(lines.find((l) => l.id === 'calendar')!.value).toBe('Google Calendar');
    expect(lines.find((l) => l.id === 'hours')!.value).toBe(
      `${formatHours(MY_CALENDAR_WEEKDAYS)}${W.lines.withLunch('12:00 PM', '1:00 PM')}`,
    );
    expect(lines.find((l) => l.id === 'timeOff')!.value).toBe('Dec 24.');
    const connected = myCalendarSetupLines(answers({ calendar: 'google' }), {
      ...NEW,
      connection: GOOGLE,
    });
    expect(connected[0]!.value).toBe(W.lines.connectedAs('Google Calendar', 'marco@gmail.test'));
  });

  it('reads Settings’ answers from what is set now', () => {
    const lines = myCalendarSettingsLines(NEW);
    expect(lines.map((l) => [l.id, l.value])).toEqual([
      ['hours', W.lines.usual],
      ['timezone', W.lines.sameZone('Central Time')],
      ['timeOff', W.lines.noTimeOff],
    ]);
    const set = myCalendarSettingsLines({
      ...NEW,
      weekly: MY_CALENDAR_WEEKDAYS,
      drive: true,
      zoom: true,
      timeOff: [
        {
          id: '2d3f1e3a-6a1b-4c55-9a52-1b2c3d4e5f62',
          startsAt: '2026-12-24T06:00:00.000Z',
          endsAt: '2026-12-25T06:00:00.000Z',
          allDay: true,
          note: 'Christmas Eve',
        },
      ],
    });
    expect(set.map((l) => l.id)).toEqual(['hours', 'timezone', 'timeOff', 'dayStart', 'zoom']);
    expect(set.find((l) => l.id === 'hours')!.value).toBe(formatHours(MY_CALENDAR_WEEKDAYS));
    expect(set.find((l) => l.id === 'timeOff')!.value).toBe(
      W.lines.comingUp(1, 'Dec 24, Christmas Eve'),
    );
    expect(set.find((l) => l.id === 'dayStart')!.value).toBe(
      W.lines.fromBusiness('100 Congress Ave, Austin, TX'),
    );
    expect(set.find((l) => l.id === 'zoom')!.value).toBe(W.lines.zoomNot);
  });
});

// ---------- on the local database ----------

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code']) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).code).toBe(code);
    return e as HfosError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

/** A whole day `days` from now, in Chicago, as the date fields take it. */
const dayFromNow = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'America/Chicago',
  });

describe('My calendar’s answers, kept per person, and Check it over', () => {
  let owner: TestUser;
  let member: TestUser;
  let wsId: string;

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('my-calendar-owner', { fullName: 'Dale Owner' }),
      createTestUser('my-calendar-member', { fullName: 'Marco Member' }),
    ]);
    const org = await run(organizationCreate, { businessName: 'My Calendar HVAC' }, owner);
    wsId = org.workspaceId;
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${wsId}, ${member.id}, 'member')`,
    );
  });
  afterAll(closeTestDbs);

  const ctxOf = (u: TestUser) => ask(myCalendarSetupGet, { workspaceId: wsId }, u);
  const draftOf = (u: TestUser) =>
    ask(guidedSetupGetDraft, { workspaceId: wsId, setup: 'my_calendar' }, u);

  it('reads each person’s own calendar, with nothing set up yet', async () => {
    const ctx = await ctxOf(member);
    expect(ctx).toMatchObject({
      userId: member.id,
      fullName: 'Marco Member',
      weekly: null,
      timeOff: [],
      connection: null,
      drive: false,
      zoom: false,
      meeting: null,
    });
    expect(myCalendarIsSetUp(ctx)).toBe(false);
    expect((await ctxOf(owner)).userId).toBe(owner.id);
  });

  it('keeps each person’s answers as they’re given, never anyone else’s', async () => {
    const start = myCalendarSetupStart(await ctxOf(member));
    await run(
      guidedSetupSaveDraft,
      { workspaceId: wsId, setup: 'my_calendar', answers: { ...start, calendar: 'microsoft' } },
      member,
    );
    expect((await draftOf(member)).answers).toMatchObject({ calendar: 'microsoft' });
    expect((await draftOf(owner)).answers).toBeNull();
    await run(
      guidedSetupSaveDraft,
      { workspaceId: wsId, setup: 'my_calendar', answers: { ...start, calendar: 'google' } },
      owner,
    );
    expect((await draftOf(owner)).answers).toMatchObject({ calendar: 'google' });
    expect((await draftOf(member)).answers).toMatchObject({ calendar: 'microsoft' });
  });

  it('refuses a lunch that ends before it starts, in the setup’s words, and changes nothing', async () => {
    const ctx = await ctxOf(member);
    const a = {
      ...myCalendarSetupStart(ctx),
      calendar: 'none' as const,
      lunch: true,
      lunchStart: '13:00',
      lunchEnd: '12:00',
    };
    const err = await expectHfos(
      () => run(myCalendarSetupSave, { workspaceId: wsId, answers: a }, member),
      'validation',
    );
    expect(err.details).toEqual([{ path: 'answers.lunchEnd', message: W.problems.lunchEnd }]);
    expect((await ctxOf(member)).weekly).toBeNull();
    expect((await draftOf(member)).answers).not.toBeNull();
  });

  it('saves a teammate’s hours and time off, spends the answers, and ticks off Getting started’s step', async () => {
    const ctx = await ctxOf(member);
    const off = dayFromNow(10);
    const a: MyCalendarSetupAnswers = {
      ...myCalendarSetupStart(ctx),
      calendar: 'none',
      hours: 'weekdays',
      lunch: true,
      timeOff: [
        {
          key: 'k1',
          allDay: true,
          startDate: off,
          endDate: off,
          start: '09:00',
          end: '12:00',
          note: ' Dentist ',
        },
      ],
    };
    const out = await run(myCalendarSetupSave, { workspaceId: wsId, answers: a }, member);
    expect(out.connect).toBeNull();
    expect(out.zoom).toBe(false);
    expect(out.changed).toHaveLength(2);

    const now = await ctxOf(member);
    expect(now.weekly).toEqual(withLunch(MY_CALENDAR_WEEKDAYS, '12:00', '13:00'));
    expect(now.timeOff.map((t) => [t.allDay, t.note])).toEqual([[true, 'Dentist']]);
    expect(myCalendarSetupStart(now)).toMatchObject({ hours: 'weekdays', lunch: true });
    expect((await draftOf(member)).answers).toBeNull();
    // The owner's calendar is untouched.
    expect((await ctxOf(owner)).weekly).toBeNull();

    const status = await ask(onboardingStatus, { workspaceId: wsId }, member);
    expect(status.steps.find((s) => s.key === 'my_calendar')?.state).toBe('skipped');

    // Saving the same again changes nothing; taking the time off away removes it.
    const again = await run(
      myCalendarSetupSave,
      {
        workspaceId: wsId,
        answers: {
          ...myCalendarSetupStart(now),
          calendar: 'none',
          removeTimeOff: [now.timeOff[0]!.id],
        },
      },
      member,
    );
    expect(again.changed).toEqual([`${W.lines.timeOff}: 1 removed`]);
    const after = await ctxOf(member);
    expect(after.timeOff).toEqual([]);
    expect(after.weekly).toEqual(now.weekly);
  });

  it('says which calendar to sign in to next, and never signs in itself', async () => {
    const ctx = await ctxOf(owner);
    const out = await run(
      myCalendarSetupSave,
      { workspaceId: wsId, answers: { ...myCalendarSetupStart(ctx), calendar: 'google' } },
      owner,
    );
    expect(out.connect).toBe('google');
    const now = await ctxOf(owner);
    expect(now.connection).toBeNull();
    expect(now.weekly).toEqual(now.businessHours);
  });
});
