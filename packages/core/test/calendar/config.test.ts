import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  applyPatch,
  CALENDAR_CONFIG_VERSION,
  CalendarConfig,
  configFromPreset,
  ConfigVersionError,
  defaultConfig,
  inferLabels,
  parseConfig,
  PRESET_KEYS,
  resolveTerms,
  upgradeConfig,
  weeklyHoursDayProblem,
  copyWeeklyHoursDay,
  type ConfigPatch,
} from '../../src/calendar/index';
import { catalogs, DALE, MARCO, presetContext, PRIYA, TRUCK, TUNE_UP, WORKFLOW } from './fixtures';

describe('defaults', () => {
  it('fills every module with the plan’s defaults', () => {
    const c = defaultConfig();
    expect(c.version).toBe(1);
    expect(c.public).toBe(false);
    expect(c.team).toEqual({ members: [], assignment: 'fixed', crewSize: 1 });
    expect(c.services).toEqual({ mode: 'none', items: [] });
    expect(c.durations).toEqual({ minutes: [60], customerChooses: false, step: 30 });
    expect(c.capacity).toEqual({ seats: 1, maxPartySize: 1, showSeatsLeft: true });
    expect(c.schedule).toEqual({ mode: 'hours', hours: null });
    expect(c.locations).toEqual({ options: [], customerChooses: false });
    expect(c.resources).toEqual({ required: [] });
    expect(c.buffers).toEqual({ before: 0, after: 0, travelMinutes: 0 });
    expect(c.territory).toEqual({ routing: 'off', territoryIds: [] });
    expect(c.window).toEqual({
      minNoticeMinutes: 240,
      maxDaysAhead: 60,
      dateFrom: null,
      dateTo: null,
      dailyLimitPerPerson: null,
    });
    expect(c.recurring).toEqual({ staffSeries: true, customerSeries: false, maxOccurrences: 12 });
    expect(c.waitlist).toEqual({ enabled: false, offerMinutes: 60 });
    expect(c.intake).toEqual({ questions: [] });
    expect(c.policies).toEqual({
      cancel: { allowed: true, cutoffHours: 24 },
      reschedule: { allowed: true, cutoffHours: 24, maxTimes: 2 },
      policyText: '',
    });
    expect(c.notifications).toEqual({
      confirmation: { text: true, email: true },
      reminders: [
        { kind: 'day_before', at: '16:00' },
        { kind: 'before', minutes: 120 },
      ],
      reminderChannels: { text: true, email: true },
      staffEmail: true,
    });
    expect(c.integrations).toEqual({ checkStaffCalendars: true, writeEvents: true });
    expect(c.crm).toEqual({
      ownership: 'assigned_staff',
      assignContactOwner: false,
      createLead: null,
    });
    // No payment, the business's own deposit, and the business's default account.
    expect(c.payments).toEqual({ mode: 'none', deposit: null, connectionId: null });
    expect(c.automations).toEqual({ workflowIds: [] });
  });

  it('never shares default arrays between documents', () => {
    const a = defaultConfig();
    a.notifications.reminders.push({ kind: 'before', minutes: 30 });
    a.durations.minutes.push(90);
    expect(defaultConfig().notifications.reminders).toHaveLength(2);
    expect(defaultConfig().durations.minutes).toEqual([60]);
  });
});

describe('parse and upgrade', () => {
  it('reads a stored document, filling what is missing and dropping unknown keys', () => {
    const c = parseConfig({ version: 1, team: { members: [{ userId: DALE }] }, legacy: true });
    expect(c.team.members).toEqual([{ userId: DALE, weight: 1, priority: 0, required: false }]);
    expect('legacy' in c).toBe(false);
  });

  it('treats a document without a version as version 1', () => {
    expect(parseConfig({}).version).toBe(CALENDAR_CONFIG_VERSION);
    expect(parseConfig(null)).toEqual(defaultConfig());
  });

  it('refuses a document from a newer app', () => {
    expect(() => parseConfig({ version: 2 })).toThrow(ConfigVersionError);
  });

  it('runs upgrade steps in order up to the target version', () => {
    const steps = {
      1: (doc: Record<string, unknown>) => ({ ...doc, renamed: doc.old, old: undefined }),
      2: (doc: Record<string, unknown>) => ({ ...doc, third: true }),
    };
    expect(upgradeConfig({ version: 1, old: 'x' }, steps, 3)).toEqual({
      version: 3,
      renamed: 'x',
      old: undefined,
      third: true,
    });
    expect(() => upgradeConfig({ version: 1 }, {}, 2)).toThrow(/No upgrade from/);
  });

  it('rejects invalid documents with field errors', () => {
    const bad = [
      { durations: { minutes: [] } },
      { durations: { step: 7 } },
      { team: { members: [{ userId: DALE }, { userId: DALE }] } },
      { team: { members: [{ userId: 'not-a-uuid' }] } },
      { schedule: { hours: [{ day: 1, start: '17:00', end: '09:00' }] } },
      { window: { dateFrom: '2026-10-10', dateTo: '2026-10-01' } },
      { intake: { questions: [{ id: 'q', label: 'Pick', kind: 'select' }] } },
      { resources: { required: [{ resourceId: TRUCK }, { resourceId: TRUCK }] } },
    ];
    for (const patch of bad)
      expect(() => parseConfig({ version: 1, ...patch }), JSON.stringify(patch)).toThrow(ZodError);
  });
});

describe('applyPatch', () => {
  it('merges objects deeply and replaces arrays', () => {
    const base = applyPatch(defaultConfig(), {
      team: { members: [{ userId: DALE }, { userId: PRIYA }] },
    });
    const next = applyPatch(base, {
      team: { members: [{ userId: MARCO, weight: 2 }] },
      capacity: { seats: 6 },
    });
    expect(next.team.members).toEqual([{ userId: MARCO, weight: 2, priority: 0, required: false }]);
    expect(next.team.assignment).toBe('fixed');
    expect(next.capacity).toEqual({ seats: 6, maxPartySize: 1, showSeatsLeft: true });
    expect(base.team.members).toHaveLength(2);
  });

  it('lets null clear a nullable setting and ignores undefined', () => {
    const withHours = applyPatch(defaultConfig(), {
      schedule: { hours: [{ day: 1, start: '09:00', end: '17:00' }] },
      crm: { createLead: { pipelineId: TUNE_UP, stageId: TRUCK } },
    });
    const cleared = applyPatch(withHours, {
      schedule: { hours: null },
      crm: { createLead: null, ownership: undefined },
    });
    expect(cleared.schedule.hours).toBeNull();
    expect(cleared.crm.createLead).toBeNull();
    expect(cleared.crm.ownership).toBe('assigned_staff');
  });

  it('throws when the result is invalid', () => {
    expect(() => applyPatch(defaultConfig(), { capacity: { seats: 0 } })).toThrow(ZodError);
  });

  it('keeps per-service overrides and resolves terms through them', () => {
    const c = applyPatch(defaultConfig(), {
      team: { members: [{ userId: DALE }, { userId: PRIYA }] },
      buffers: { before: 10, after: 5 },
      services: {
        mode: 'choice',
        items: [
          {
            serviceId: TUNE_UP,
            overrides: { minutes: [45], bufferAfter: 30, seats: 3, userIds: [PRIYA] },
          },
        ],
      },
      resources: { required: [{ resourceId: TRUCK, quantity: 1 }] },
    });
    const service = catalogs.services.find((s) => s.id === TUNE_UP)!;
    expect(resolveTerms(c, service)).toMatchObject({
      serviceId: TUNE_UP,
      durations: [45],
      bufferBefore: 10,
      bufferAfter: 30,
      seats: 3,
      maxPartySize: 1,
      eligibleUserIds: [PRIYA],
      requiredResources: [{ resourceId: TRUCK, quantity: 1 }],
    });
    expect(resolveTerms(c, null)).toMatchObject({
      durations: [60],
      bufferBefore: 10,
      bufferAfter: 5,
      eligibleUserIds: null,
    });
  });
});

describe('labels never gate a setting', () => {
  const edits: Record<string, ConfigPatch> = {
    public: { public: false },
    team: {
      team: { members: [{ userId: DALE }, { userId: PRIYA }], assignment: 'weighted', crewSize: 2 },
    },
    services: { services: { mode: 'choice', items: [{ serviceId: TUNE_UP }] } },
    durations: { durations: { minutes: [30, 45], customerChooses: true, step: 15 } },
    capacity: { capacity: { seats: 8, maxPartySize: 2, showSeatsLeft: false } },
    schedule: { schedule: { mode: 'sessions', hours: [{ day: 2, start: '10:00', end: '14:00' }] } },
    locations: {
      locations: {
        options: [{ kind: 'virtual', meetingUrl: 'https://meet.example.com/x' }],
        customerChooses: true,
      },
    },
    resources: { resources: { required: [{ resourceId: TRUCK, quantity: 2 }] } },
    buffers: { buffers: { before: 15, after: 15, travelMinutes: 20 } },
    territory: { territory: { routing: 'zip', territoryIds: [] } },
    window: {
      window: {
        minNoticeMinutes: 60,
        maxDaysAhead: 30,
        dateFrom: '2026-10-01',
        dateTo: '2026-12-31',
        dailyLimitPerPerson: 4,
      },
    },
    recurring: { recurring: { staffSeries: false, customerSeries: true, maxOccurrences: 8 } },
    waitlist: { waitlist: { enabled: true, offerMinutes: 30 } },
    intake: { intake: { questions: [{ id: 'gate', label: 'Gate code', kind: 'short_text' }] } },
    policies: {
      policies: { cancel: { allowed: false }, reschedule: { maxTimes: 5 }, policyText: 'Be home.' },
    },
    notifications: {
      notifications: { reminders: [{ kind: 'before', minutes: 60 }], staffEmail: false },
    },
    integrations: { integrations: { checkStaffCalendars: false, writeEvents: false } },
    crm: { crm: { ownership: 'calendar_owner', assignContactOwner: true } },
    payments: { payments: { mode: 'full' } },
    automations: { automations: { workflowIds: [WORKFLOW] } },
  };

  it.each(PRESET_KEYS)('every module is editable on a %s calendar', (key) => {
    const config = configFromPreset(key, presetContext);
    for (const [module, patch] of Object.entries(edits)) {
      const next = applyPatch(config, patch);
      expect(CalendarConfig.safeParse(next).success, `${key} ${module}`).toBe(true);
      expect(() => inferLabels(next)).not.toThrow();
    }
  });
});

describe('one day’s hours', () => {
  it('says what’s wrong with a day the hours editors show, on the web and the phone', () => {
    const day = (...stretches: [string, string][]) =>
      stretches.map(([start, end]) => ({ day: 1, start, end }));
    expect(weeklyHoursDayProblem([])).toBeNull();
    expect(weeklyHoursDayProblem(day(['09:00', '12:00'], ['13:00', '24:00']))).toBeNull();
    expect(weeklyHoursDayProblem(day(['17:00', '09:00']))).toBe('Ends before it starts.');
    expect(weeklyHoursDayProblem(day(['09:00', '09:00']))).toBe('Ends before it starts.');
    // In any order: the later stretch listed first still overlaps.
    expect(weeklyHoursDayProblem(day(['11:00', '15:00'], ['09:00', '12:00']))).toBe(
      'These hours overlap.',
    );
  });
});

describe('copyWeeklyHoursDay', () => {
  it('gives every day the copied day’s hours, lunch break and all', () => {
    const copied = copyWeeklyHoursDay(
      [
        { day: 1, start: '13:00', end: '17:00' },
        { day: 1, start: '08:00', end: '12:00' },
        { day: 3, start: '10:00', end: '11:00' },
      ],
      1,
    );
    expect(copied).toHaveLength(14);
    expect(copied.filter((h) => h.day === 0)).toEqual([
      { day: 0, start: '08:00', end: '12:00' },
      { day: 0, start: '13:00', end: '17:00' },
    ]);
    expect(copied.some((h) => h.start === '10:00')).toBe(false);
  });

  it('leaves the week alone when the day is closed', () => {
    const week = [{ day: 2, start: '09:00', end: '17:00' }];
    expect(copyWeeklyHoursDay(week, 5)).toBe(week);
  });
});
