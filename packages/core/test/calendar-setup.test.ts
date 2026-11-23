/**
 * The guided calendar setup (the owner, 22 Nov 2026, picks C1 a to C4 b): which questions each kind asks, what is
 * wrong with an answer in the setup's own words, the settings the answers become, the calendar's card read back from
 * those settings, and Make this calendar (calendar_setup.save) on the local database.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CALENDAR_SETUP_FIRST_KINDS,
  calendarCardLines,
  calendarSetupConfig,
  calendarSetupKindOf,
  calendarSetupLines,
  calendarSetupProblems,
  calendarSetupQuestions,
  calendarSetupStart,
  type CalendarCatalogs,
  type CalendarSetupAnswers,
  type CalendarSetupContext,
} from '../src';
import {
  calendarGet,
  calendarSetupSave,
  guidedSetupGetDraft,
  guidedSetupSaveDraft,
  serviceList,
} from '../src/server';
import { admin, ask, expectHfos, run, setupTeam, WEEKDAYS, type Team } from './calendar-helpers';

const DALE = '00000000-0000-4000-8000-000000000001';
const PRIYA = '00000000-0000-4000-8000-000000000002';
const TUNE_UP = '00000000-0000-4000-8000-000000000010';

const CTX: CalendarSetupContext = {
  businessName: 'Lone Star HVAC',
  businessAddress: '4410 Westpark Dr, Houston, TX 77027',
  timeZone: 'America/Chicago',
  people: [
    { userId: DALE, name: 'Dale Owner', me: true, weekly: WEEKDAYS, defaultHours: false },
    { userId: PRIYA, name: 'Priya Tech', me: false, weekly: WEEKDAYS, defaultHours: true },
  ],
  services: [{ id: TUNE_UP, name: 'AC tune-up', lengths: [60], priceCents: 8900, userIds: [] }],
  resources: [],
  areas: [],
  paymentsReady: false,
  businessDeposit: { kind: 'none' },
  textingReady: false,
};

const start = (kind: Parameters<typeof calendarSetupStart>[0], ctx = CTX): CalendarSetupAnswers =>
  calendarSetupStart(kind, ctx);

describe('the guided calendar setup’s questions, worked out in one place', () => {
  it('offers five plain kinds first and asks each only what fits it', () => {
    expect(CALENDAR_SETUP_FIRST_KINDS).toEqual([
      'appointment',
      'visit',
      'meeting',
      'class',
      'event',
    ]);
    expect(calendarSetupQuestions(start('appointment'))).toEqual([
      'kind',
      'who',
      'what',
      'when',
      'where',
      'remind',
      'pay',
    ]);
    // A room needs no staff, a webinar is always our own video call, and scratch opens every setting instead.
    expect(calendarSetupQuestions(start('resource'))).not.toContain('who');
    expect(calendarSetupQuestions(start('webinar'))).not.toContain('where');
    expect(calendarSetupQuestions(start('scratch'))).toEqual(['kind']);
  });

  it('starts each kind from the business’s own people, services and address', () => {
    const appointment = start('appointment');
    expect(appointment).toMatchObject({
      name: 'Appointments',
      people: [DALE, PRIYA],
      what: 'services',
      places: ['business'],
      address: CTX.businessAddress,
      pay: 'none',
      open: true,
    });
    expect(appointment.services).toEqual([
      expect.objectContaining({ id: TUNE_UP, name: 'AC tune-up', on: true, priceCents: 8900 }),
    ]);
    // A meeting is one person's: the one going through the setup.
    expect(start('meeting').people).toEqual([DALE]);
  });

  it('says what is wrong in the setup’s own words, and asks for an account before taking money', () => {
    expect(calendarSetupProblems(start(null), CTX)[0]).toMatchObject({
      screen: 'kind',
      message: 'Pick what customers book.',
    });
    const solo = { ...CTX, people: CTX.people.slice(0, 1) };
    expect(calendarSetupProblems(start('collective', solo), solo)).toContainEqual(
      expect.objectContaining({
        screen: 'who',
        message: expect.stringContaining('your team has one'),
      }),
    );
    const noServices = { ...start('appointment'), services: [] };
    expect(calendarSetupProblems(noServices, CTX)).toContainEqual(
      expect.objectContaining({ screen: 'what', message: 'Add at least one service.' }),
    );
    const deposit = { ...start('appointment'), pay: 'deposit' as const };
    expect(calendarSetupProblems(deposit, CTX)).toContainEqual(
      expect.objectContaining({ screen: 'pay', rule: 'needs_payment_account' }),
    );
    expect(calendarSetupProblems(deposit, { ...CTX, paymentsReady: true })).toEqual([]);
    const past = { ...start('event'), dates: [{ date: '2020-01-06', time: '18:00' }] };
    expect(calendarSetupProblems(past, CTX)).toContainEqual(
      expect.objectContaining({ screen: 'when', message: expect.stringContaining('has passed') }),
    );
    expect(calendarSetupProblems(start('appointment'), CTX)).toEqual([]);
  });

  it('turns the answers into the calendar’s settings, and reads them back on its card', () => {
    const answers: CalendarSetupAnswers = {
      ...start('appointment'),
      assignment: 'round_robin',
      reminders: [{ kind: 'before', minutes: 120 }],
      changeHours: 12,
    };
    const config = calendarSetupConfig(answers, CTX, {
      services: { [answers.services[0]!.key]: TUNE_UP },
      resourceId: null,
    });
    expect(config.team).toMatchObject({
      assignment: 'round_robin',
      members: [{ userId: DALE }, { userId: PRIYA }],
    });
    expect(config.services).toMatchObject({ mode: 'one', items: [{ serviceId: TUNE_UP }] });
    expect(config.locations.options).toEqual([
      expect.objectContaining({ kind: 'business', address: CTX.businessAddress }),
    ]);
    expect(config.policies.cancel).toEqual({ allowed: true, cutoffHours: 12 });
    expect(config.payments.mode).toBe('none');
    expect(calendarSetupLines(answers, CTX).map((l) => [l.key, l.value])).toEqual([
      ['kind', 'An appointment for a service'],
      ['who', 'Dale and Priya'],
      ['what', 'AC tune-up'],
      ['when', 'Any time the people you picked are working'],
      ['where', 'At your place'],
      ['remind', 'A confirmation and 1 reminder'],
      ['pay', 'They pay later'],
    ]);

    const catalogs: CalendarCatalogs = {
      timeZone: CTX.timeZone,
      team: CTX.people.map((p) => ({ userId: p.userId, name: p.name, active: true })),
      services: [
        {
          id: TUNE_UP,
          name: 'AC tune-up',
          durations: [60],
          bufferBefore: 0,
          bufferAfter: 0,
          eligibleUserIds: [],
          requiredResources: [],
          archived: false,
        },
      ],
      resources: [],
      territories: [],
      pipelines: [],
      textingReady: false,
      paymentsAvailable: false,
      paymentAccounts: [],
      businessDeposit: { kind: 'none' },
    };
    expect(calendarSetupKindOf(config)).toBe('appointment');
    const card = calendarCardLines(config, catalogs);
    expect(card.map((l) => [l.key, l.value, l.section])).toEqual([
      ['kind', 'An appointment for a service', null],
      ['who', 'Dale and Priya', 'team'],
      ['what', 'AC tune-up', 'services'],
      ['when', 'Any time the people you picked are working', 'availability'],
      ['where', 'At your place', 'locations'],
      ['remind', 'A confirmation and 1 reminder', 'notify'],
      ['pay', 'No payment to book', 'payments'],
    ]);
    expect(card.find((l) => l.key === 'who')?.detail).toBe('They take turns.');
    expect(card.find((l) => l.key === 'remind')?.detail).toBe(
      'Cancel or move online up to 12 hours before.',
    );

    // Each kind's settings read back as that kind.
    for (const kind of ['visit', 'meeting', 'class', 'event', 'webinar', 'collective'] as const) {
      const a = start(kind);
      const made = calendarSetupConfig(a, CTX, {
        services: Object.fromEntries(a.services.map((s) => [s.key, TUNE_UP])),
        resourceId: null,
      });
      expect(calendarSetupKindOf(made), kind).toBe(kind);
    }
  });
});

describe('Make this calendar', () => {
  let t: Team;
  beforeAll(async () => {
    t = await setupTeam('calsetup');
  });
  afterAll(closeTestDbs);

  const answersFor = async (patch: Partial<CalendarSetupAnswers> = {}) => {
    const ctx: CalendarSetupContext = {
      ...CTX,
      people: [
        { userId: t.owner.id, name: 'Dale Owner', me: true, weekly: WEEKDAYS, defaultHours: false },
      ],
      services: [],
    };
    const a = calendarSetupStart('appointment', ctx);
    return {
      ...a,
      name: 'Tune-ups',
      services: [
        {
          key: 'new-1',
          id: null,
          name: 'Spring tune-up',
          on: true,
          minutes: 90,
          priceCents: 12900,
          userIds: [],
        },
      ],
      ...patch,
    } satisfies CalendarSetupAnswers;
  };
  const calendarsNamed = async (name: string) =>
    (
      await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.calendars where workspace_id = ${t.wsId} and name = ${name}`,
      )
    )[0]?.n ?? 0;

  it('makes the new service and the calendar with every answer, opens it, and spends the answers', async () => {
    const answers = await answersFor();
    await run(
      guidedSetupSaveDraft,
      { workspaceId: t.wsId, setup: 'calendar', answers: { ...answers, at: 'review' } },
      t.owner,
    );
    const out = await run(calendarSetupSave, { workspaceId: t.wsId, answers }, t.owner);
    expect(out).toMatchObject({ servicesMade: 1, dates: [], slug: 'tune-ups' });
    expect(out.status === 'active' || out.blocked.length > 0).toBe(true);

    const services = await ask(serviceList, { workspaceId: t.wsId }, t.owner);
    const made = services.items.find((s) => s.name === 'Spring tune-up');
    expect(made).toMatchObject({ durations: [90], priceCents: 12900 });

    const got = await ask(
      calendarGet,
      { workspaceId: t.wsId, calendarId: out.calendarId },
      t.owner,
    );
    expect(got.calendar.config.services.items).toEqual([{ serviceId: made!.id }]);
    expect(got.calendar.config.team.members.map((m) => m.userId)).toEqual([t.owner.id]);
    expect(got.calendar.config.notifications.reminders).toEqual(answers.reminders);
    expect(
      (await ask(guidedSetupGetDraft, { workspaceId: t.wsId, setup: 'calendar' }, t.owner)).answers,
    ).toBeNull();
  });

  it('makes nothing when an answer is wrong, and asks for an account before taking money', async () => {
    const before = await calendarsNamed('Deposits');
    const wrong = await expectHfos(
      async () =>
        run(
          calendarSetupSave,
          {
            workspaceId: t.wsId,
            answers: await answersFor({ name: 'Deposits', places: [] }),
          },
          t.owner,
        ),
      'validation',
    );
    expect(wrong.message).toBe('Tick at least one place.');
    const account = await expectHfos(
      async () =>
        run(
          calendarSetupSave,
          { workspaceId: t.wsId, answers: await answersFor({ name: 'Deposits', pay: 'deposit' }) },
          t.owner,
        ),
      'needs_payment_account',
      409,
    );
    expect(account.message).toMatch(/^Connect a payment account first/);
    expect(await calendarsNamed('Deposits')).toBe(before);
  });

  it('is only for people who can change the business’s calendars', async () => {
    await expectHfos(
      async () =>
        run(calendarSetupSave, { workspaceId: t.wsId, answers: await answersFor() }, t.member),
      'forbidden',
    );
  });
});
