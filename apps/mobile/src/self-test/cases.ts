/**
 * `@hfos/core`'s time-zone, calendar, quiet-hours and formatting assertions, ported from its Vitest suites so they
 * run on the phone's JavaScript engine (Hermes), whose Intl wraps the OS's own date libraries. The assertions are
 * copied as written; the "probes" group adds checks the suites don't have but the phone needs (other zones, alias
 * handling, raw formatToParts output). Expected values are what Node's V8 produces, which is what the web runs.
 */
import {
  applyPatch,
  computeSlots,
  defaultConfig,
  expandRecurrence,
  expandWeeklyHours,
  formatClock,
  isValidTimeZone,
  localDateOf,
  localInstant,
  money,
  moneyRounded,
  quietHoursState,
  recurrenceDates,
  RecurrenceRule,
  render,
  whenLabel,
  zonedInstants,
  zonedParts,
  zonedTime,
  zoneOffsetMinutes,
  type ConfigPatch,
  type Interval,
  type Slot,
  type SlotInput,
  type StaffInput,
} from '@hfos/core';
import type { Case } from './runner';

const CHI = 'America/Chicago';
const iso = (at: number | Date) => new Date(at).toISOString();
const rule = (input: Record<string, unknown>) => RecurrenceRule.parse(input);

const ZONED = 'packages/core/test/calendar/zoned.test.ts';
const ENGINE = 'packages/core/test/calendar/engine.test.ts';
const MESSAGING = 'packages/core/test/messaging.test.ts';
const MONEY = 'packages/core/test/money-format.test.ts';
const TEMPLATES = 'packages/core/test/workflows/conditions-templates.test.ts';
const PROBE = 'on-device probe (not in the core suites)';

// ---- engine.test.ts's hand-made scenario helpers ----

const MON = '2026-06-01';
const CAL = 'this-calendar';
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = uid(11);
const local = (date: string, clock: string) => localInstant(date, clock, CHI);
const span = (date: string, from: string, to: string): Interval => ({
  start: local(date, from),
  end: local(date, to),
});
const person = (
  userId: string,
  windows: Interval[],
  extra: Partial<StaffInput> = {},
): StaffInput => ({
  userId,
  windows,
  busy: [],
  bookings: [],
  ...extra,
});
const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: CHI,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const clocks = (slots: readonly Slot[]) => slots.map((s) => clockFormat.format(s.start));
function world(patch: ConfigPatch, over: Partial<SlotInput> = {}): SlotInput {
  return {
    config: applyPatch(applyPatch(defaultConfig(), { window: { minNoticeMinutes: 0 } }), patch),
    calendarId: CAL,
    timeZone: CHI,
    now: local('2026-05-31', '12:00'),
    from: local(MON, '00:00'),
    to: local(MON, '24:00'),
    staff: [],
    ...over,
  };
}
const solo = { team: { members: [{ userId: A }] } };
const nineToFive = (userId: string, date = MON) => person(userId, [span(date, '09:00', '17:00')]);

export const CASES: readonly Case[] = [
  // ---- zoned.test.ts: zoned time in America/Chicago ----
  {
    group: 'Zoned time',
    name: 'reads ordinary wall times in both offsets',
    source: ZONED,
    run: (t) => {
      t.is(iso(zonedTime(2026, 1, 15, 9, 0, CHI)), '2026-01-15T15:00:00.000Z');
      t.is(iso(zonedTime(2026, 7, 1, 9, 0, CHI)), '2026-07-01T14:00:00.000Z');
      t.equal(zonedParts(Date.parse('2026-07-01T14:00:00Z'), CHI), {
        year: 2026,
        month: 7,
        day: 1,
        hour: 9,
        minute: 0,
        weekday: 3,
      });
    },
  },
  {
    group: 'Zoned time',
    name: '2:30 AM on 2026-03-08 never happens and is read as 3:30 AM CDT',
    source: ZONED,
    run: (t) => {
      t.equal(zonedInstants(2026, 3, 8, 2, 30, CHI), []);
      const at = zonedTime(2026, 3, 8, 2, 30, CHI);
      t.is(iso(at), '2026-03-08T08:30:00.000Z');
      t.match(zonedParts(at, CHI), { hour: 3, minute: 30 });
      t.is(zoneOffsetMinutes(Date.parse('2026-03-08T07:59:00Z'), CHI), -360);
      t.is(zoneOffsetMinutes(Date.parse('2026-03-08T08:00:00Z'), CHI), -300);
    },
  },
  {
    group: 'Zoned time',
    name: '1:30 AM on 2026-11-01 happens twice and is read as the second (CST)',
    source: ZONED,
    run: (t) => {
      const both = zonedInstants(2026, 11, 1, 1, 30, CHI);
      t.equal(both.map(iso), ['2026-11-01T06:30:00.000Z', '2026-11-01T07:30:00.000Z']);
      for (const at of both) t.match(zonedParts(at, CHI), { hour: 1, minute: 30 }, iso(at));
      t.is(iso(zonedTime(2026, 11, 1, 1, 30, CHI)), '2026-11-01T07:30:00.000Z');
    },
  },
  {
    group: 'Zoned time',
    name: 'keeps the edges of each change exact',
    source: ZONED,
    run: (t) => {
      t.is(iso(zonedTime(2026, 3, 8, 1, 59, CHI)), '2026-03-08T07:59:00.000Z');
      t.is(iso(zonedTime(2026, 3, 8, 3, 0, CHI)), '2026-03-08T08:00:00.000Z');
      t.is(iso(zonedTime(2026, 11, 1, 0, 59, CHI)), '2026-11-01T05:59:00.000Z');
      t.is(iso(zonedTime(2026, 11, 1, 2, 0, CHI)), '2026-11-01T08:00:00.000Z');
    },
  },
  {
    group: 'Zoned time',
    name: 'turns hours into windows of the right length on change days',
    source: ZONED,
    run: (t) => {
      const day = (date: string, start: string, end: string) => {
        const from = localInstant(date, '00:00', CHI) - 3_600_000;
        const to = localInstant(date, '24:00', CHI) + 3_600_000;
        const [w] = expandWeeklyHours([{ day: 0, start, end }], from, to, CHI);
        return (w!.end - w!.start) / 3_600_000;
      };
      t.is(day('2026-03-08', '09:00', '17:00'), 8, 'spring 9-5');
      t.is(day('2026-11-01', '09:00', '17:00'), 8, 'fall 9-5');
      t.is(day('2026-03-08', '00:00', '03:00'), 2, 'spring 0-3');
      t.is(day('2026-11-01', '00:00', '03:00'), 4, 'fall 0-3');
      t.is(day('2026-03-08', '00:00', '24:00'), 23, 'spring whole day');
      t.is(day('2026-11-01', '00:00', '24:00'), 25, 'fall whole day');
    },
  },
  // ---- zoned.test.ts: recurrence ----
  {
    group: 'Recurrence',
    name: 'keeps a weekly 9:00 AM series at 9:00 across the spring change',
    source: ZONED,
    run: (t) => {
      const out = expandRecurrence(
        rule({ freq: 'weekly', localTime: '09:00', count: 3 }),
        '2026-03-02',
        CHI,
      );
      t.equal(
        out.map((o) => iso(o.startsAt)),
        ['2026-03-02T15:00:00.000Z', '2026-03-09T14:00:00.000Z', '2026-03-16T14:00:00.000Z'],
      );
      t.equal(
        out.map((o) => o.index),
        [0, 1, 2],
      );
    },
  },
  {
    group: 'Recurrence',
    name: 'keeps it at 9:00 across the fall change',
    source: ZONED,
    run: (t) => {
      const out = expandRecurrence(
        rule({ freq: 'weekly', localTime: '09:00', count: 2 }),
        '2026-10-26',
        CHI,
      );
      t.equal(
        out.map((o) => iso(o.startsAt)),
        ['2026-10-26T14:00:00.000Z', '2026-11-02T15:00:00.000Z'],
      );
    },
  },
  {
    group: 'Recurrence',
    name: 'applies the gap and repeat rules to occurrences that land on them',
    source: ZONED,
    run: (t) => {
      const spring = expandRecurrence(
        rule({ freq: 'weekly', localTime: '02:30', count: 2 }),
        '2026-03-01',
        CHI,
      );
      t.equal(
        spring.map((o) => iso(o.startsAt)),
        ['2026-03-01T08:30:00.000Z', '2026-03-08T08:30:00.000Z'],
      );
      const fall = expandRecurrence(
        rule({ freq: 'weekly', localTime: '01:30', count: 2 }),
        '2026-10-25',
        CHI,
      );
      t.equal(
        fall.map((o) => iso(o.startsAt)),
        ['2026-10-25T06:30:00.000Z', '2026-11-01T07:30:00.000Z'],
      );
    },
  },
  {
    group: 'Recurrence',
    name: 'repeats every other week, on the same date and on the same weekday',
    source: ZONED,
    run: (t) => {
      t.equal(
        recurrenceDates(
          rule({ freq: 'weekly', interval: 2, weekdays: [1, 3], localTime: '10:00', count: 4 }),
          '2026-09-09',
        ),
        ['2026-09-09', '2026-09-21', '2026-09-23', '2026-10-05'],
      );
      t.equal(
        recurrenceDates(rule({ freq: 'monthly_date', localTime: '10:00', count: 4 }), '2026-01-31'),
        ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31'],
      );
      t.equal(
        recurrenceDates(rule({ freq: 'monthly_nth', localTime: '10:00', count: 3 }), '2026-09-08'),
        ['2026-09-08', '2026-10-13', '2026-11-10'],
      );
    },
  },
  {
    group: 'Recurrence',
    name: 'stops at the until date, 52 occurrences and 12 months; validates the rule (zod)',
    source: ZONED,
    run: (t) => {
      t.equal(
        recurrenceDates(
          rule({ freq: 'weekly', localTime: '10:00', until: '2026-09-28' }),
          '2026-09-14',
        ),
        ['2026-09-14', '2026-09-21', '2026-09-28'],
      );
      const daily = recurrenceDates(
        rule({
          freq: 'weekly',
          weekdays: [1, 2, 3, 4, 5],
          localTime: '10:00',
          until: '2027-06-01',
        }),
        '2026-09-14',
      );
      t.is(daily.length, 52, 'weekday series length');
      const monthly = recurrenceDates(
        rule({ freq: 'monthly_date', localTime: '10:00', until: '2028-12-31' }),
        '2026-09-14',
      );
      t.is(monthly.length, 13, 'monthly series length');
      t.is(monthly.at(-1), '2027-09-14');
      t.is(
        RecurrenceRule.safeParse({ freq: 'weekly', localTime: '09:00' }).success,
        false,
        'no end',
      );
      t.is(
        RecurrenceRule.safeParse({ freq: 'weekly', localTime: '09:00', count: 53 }).success,
        false,
        'count 53',
      );
      t.is(
        RecurrenceRule.safeParse({ freq: 'weekly', localTime: '09:00', count: 2, interval: 13 })
          .success,
        false,
        'interval 13',
      );
      t.is(
        RecurrenceRule.safeParse({ freq: 'daily', localTime: '09:00', count: 2 }).success,
        false,
        'daily',
      );
    },
  },
  // ---- engine.test.ts ----
  {
    group: 'Calendar engine',
    name: 'keeps 9:00 AM the first slot across the spring change',
    source: ENGINE,
    run: (t) => {
      const hours = [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' }));
      const from = local('2026-03-06', '00:00');
      const to = local('2026-03-10', '00:00');
      const slots = computeSlots(
        world(solo, {
          from,
          to,
          now: from - 86_400_000,
          staff: [person(A, expandWeeklyHours(hours, from, to, CHI))],
        }),
      );
      const firstOf = (date: string) =>
        new Date(slots.find((s) => s.start >= local(date, '00:00'))!.start).toISOString();
      t.is(firstOf('2026-03-06'), '2026-03-06T15:00:00.000Z');
      t.is(firstOf('2026-03-09'), '2026-03-09T14:00:00.000Z');
      t.is(
        slots.filter((s) => s.start >= local('2026-03-09', '00:00')).length,
        15,
        'slots on Monday',
      );
    },
  },
  {
    group: 'Calendar engine',
    name: 'steps through the repeated hour on 2026-11-01',
    source: ENGINE,
    run: (t) => {
      const date = '2026-11-01';
      const slots = computeSlots(
        world(
          { ...solo, durations: { step: 60 } },
          {
            from: local(date, '00:00'),
            to: local(date, '24:00'),
            now: local('2026-10-30', '00:00'),
            staff: [person(A, [span(date, '00:00', '04:00')])],
          },
        ),
      );
      t.equal(
        slots.map((s) => new Date(s.start).toISOString().slice(11, 16)),
        ['05:00', '06:00', '07:00', '08:00', '09:00'],
      );
      t.equal(clocks(slots), ['00:00', '01:00', '01:00', '02:00', '03:00'], 'h23 clocks');
    },
  },
  {
    group: 'Calendar engine',
    name: 'hours mode steps from local midnight and from the calendar’s hours',
    source: ENGINE,
    run: (t) => {
      const slots = computeSlots(
        world(solo, { staff: [person(A, [span(MON, '09:00', '12:00')])] }),
      );
      t.equal(clocks(slots), ['09:00', '09:30', '10:00', '10:30', '11:00'], 'from midnight');
      const fromHours = computeSlots(
        world(solo, { staff: [nineToFive(A)], calendarWindows: [span(MON, '09:15', '12:00')] }),
      );
      t.equal(clocks(fromHours), ['09:15', '09:45', '10:15', '10:45'], 'from the calendar’s hours');
    },
  },
  // ---- messaging.test.ts ----
  {
    group: 'Quiet hours',
    name: 'works out quiet hours in the business’s time zone, across midnight',
    source: MESSAGING,
    run: (t) => {
      const window = { enabled: true, start: '20:00', end: '08:00' };
      t.equal(quietHoursState(window, CHI, new Date('2026-09-11T02:30:00Z')), {
        quiet: true,
        localTime: '21:30',
        endsAt: '08:00',
      });
      t.is(quietHoursState(window, CHI, new Date('2026-09-11T18:00:00Z')).quiet, false, 'daytime');
      t.is(quietHoursState({ ...window, enabled: false }, CHI).quiet, false, 'turned off');
      t.is(formatClock('20:00'), '8:00 PM');
      t.is(formatClock('00:15'), '12:15 AM');
    },
  },
  // ---- money-format.test.ts ----
  {
    group: 'Formatting',
    name: 'money shows cents only when there are any, minus in front, whole dollars round half up',
    source: MONEY,
    run: (t) => {
      t.is(money(0), '$0');
      t.is(money(4_000), '$40');
      t.is(money(1_850_000), '$18,500');
      t.is(money(1_850_050), '$18,500.50');
      t.is(money(1), '$0.01');
      t.is(money(null), '$0');
      t.is(money(Number.NaN), '$0');
      t.is(money(-4_000), '-$40');
      t.is(money(-8_950), '-$89.50');
      t.is(moneyRounded(1_850_050), '$18,501');
      t.is(moneyRounded(50), '$1');
      t.is(moneyRounded(49), '$0');
    },
  },
  // ---- conditions-templates.test.ts ----
  {
    group: 'Formatting',
    name: 'workflow templates fill the time and date filters in the business’s zone',
    source: TEMPLATES,
    run: (t) => {
      const vars = {
        person: { first_name: 'maria lopez', name: 'Maria Lopez', tags: ['vip', 'new'] },
        business: { name: 'Lone Star HVAC' },
        appointment: { starts_at: '2026-09-16T19:30:00Z' },
        ai: { message: '' },
      };
      const out = render(
        'Hi {{person.first_name | first | upper}}! {{ business.name }} at {{appointment.starts_at | time}} on {{appointment.starts_at|date}}. {{person.tags | first}} {{lead.title}} {{ai.message}}',
        vars,
        { timeZone: CHI },
      );
      t.is(out.text, 'Hi MARIA! Lone Star HVAC at 2:30 PM on Wed, Sep 16. vip  ');
      t.equal(out.missing, ['lead.title', 'ai.message']);
    },
  },
  // ---- probes ----
  {
    group: 'Probes',
    name: 'offsets in other zones (no DST, half and quarter hours, 30-minute DST)',
    source: PROBE,
    run: (t) => {
      const jul = Date.parse('2026-07-01T12:00:00Z');
      const jan = Date.parse('2026-01-15T12:00:00Z');
      t.is(zoneOffsetMinutes(jul, 'America/New_York'), -240, 'New York summer');
      t.is(zoneOffsetMinutes(jan, 'America/New_York'), -300, 'New York winter');
      t.is(zoneOffsetMinutes(jul, 'America/Phoenix'), -420, 'Phoenix summer');
      t.is(zoneOffsetMinutes(jan, 'America/Phoenix'), -420, 'Phoenix winter');
      t.is(zoneOffsetMinutes(jul, 'Pacific/Honolulu'), -600, 'Honolulu');
      t.is(zoneOffsetMinutes(jul, 'America/St_Johns'), -150, "St John's summer");
      t.is(zoneOffsetMinutes(jul, 'Asia/Kolkata'), 330, 'Kolkata');
      t.is(zoneOffsetMinutes(jul, 'Asia/Kathmandu'), 345, 'Kathmandu');
      t.is(zoneOffsetMinutes(jan, 'Australia/Lord_Howe'), 660, 'Lord Howe January');
      t.is(zoneOffsetMinutes(jul, 'Australia/Lord_Howe'), 630, 'Lord Howe July');
      t.is(zoneOffsetMinutes(jul, 'UTC'), 0, 'UTC');
    },
  },
  {
    group: 'Probes',
    name: 'raw formatToParts at local midnight gives hour "00" with h23',
    source: PROBE,
    run: (t) => {
      const midnight = Date.parse('2026-09-16T05:00:00Z');
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: CHI,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
      }).formatToParts(midnight);
      const part = (type: string) => parts.find((p) => p.type === type)?.value;
      t.is(part('hour'), '00', 'hour part');
      t.is(part('minute'), '00', 'minute part');
      t.is(part('weekday'), 'Wed', 'weekday part');
      t.is(part('month'), '09', 'month part');
      t.is(part('day'), '16', 'day part');
      t.is(part('year'), '2026', 'year part');
      t.equal(zonedParts(midnight, CHI), {
        year: 2026,
        month: 9,
        day: 16,
        hour: 0,
        minute: 0,
        weekday: 3,
      });
    },
  },
  {
    group: 'Probes',
    name: 'time-zone names the web accepts and refuses',
    source: PROBE,
    run: (t) => {
      t.is(isValidTimeZone('America/Chicago'), true, 'America/Chicago');
      t.is(isValidTimeZone('UTC'), true, 'UTC');
      t.is(isValidTimeZone('Etc/GMT+6'), true, 'Etc/GMT+6');
      t.is(isValidTimeZone('US/Central'), true, 'US/Central (IANA link)');
      t.is(isValidTimeZone('EST'), true, 'EST (IANA link)');
      t.is(isValidTimeZone('CST'), true, 'CST (V8 accepts it)');
      t.is(isValidTimeZone('GMT+5'), false, 'GMT+5');
      t.is(isValidTimeZone('America/Chicgo'), false, 'misspelt');
      t.is(isValidTimeZone('Mars/Olympus'), false, 'made up');
      t.is(isValidTimeZone(''), false, 'empty');
    },
  },
  {
    group: 'Probes',
    name: 'Action Center and texting words: dates near midnight and across the date line',
    source: PROBE,
    run: (t) => {
      t.is(whenLabel(Date.parse('2026-09-17T15:00:00Z'), CHI), 'Thu, Sep 17 at 10:00 AM');
      t.is(whenLabel(Date.parse('2026-09-17T04:59:00Z'), CHI), 'Wed, Sep 16 at 11:59 PM');
      t.is(localDateOf(Date.parse('2026-09-16T11:30:00Z'), 'Pacific/Auckland'), '2026-09-16');
      t.is(localDateOf(Date.parse('2026-09-16T12:30:00Z'), 'Pacific/Auckland'), '2026-09-17');
      t.is(localDateOf(Date.parse('2026-09-16T09:59:00Z'), 'Pacific/Honolulu'), '2026-09-15');
    },
  },
];
