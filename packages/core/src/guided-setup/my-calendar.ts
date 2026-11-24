/**
 * The guided My calendar setup (the owner, 24 Nov 2026: M1 a, M2 a, M3 a, M4 a). Everyone sets up their own: up to
 * five questions, one at a time (which calendar they keep their days in, when customers can book them, time off
 * coming up, where their day starts and Zoom), then Check it over, where "Save and connect Google Calendar" (or
 * Outlook) saves the answers (my_calendar_setup.save) and opens the calendar's own sign-in last, which comes straight
 * back to Done. Where the day starts is asked only when a calendar they're on leaves time to drive, and Zoom only
 * when one makes Zoom links and theirs isn't connected. "Something else, or none" connects nothing.
 *
 * Their hours are three choices (M2 a): the business's open hours, weekdays 9 to 5, or their own days and times, with
 * a lunch break switch for the first two. Nothing on Settings → My calendar is dropped: every day's hours, extra open
 * time, Google Meet transcripts, Sync now, Disconnect and Zoom's settings check stay under All settings (M3 a).
 *
 * What the web and the phone both decide lives here: the answers as they are saved (guided_setup.save_draft, under
 * `my_calendar`, kept per person), where they start, what is wrong with one, the hours they make, and the lines
 * beside the questions, on Check it over and on Settings → My calendar. Browser-safe.
 */
import { z } from 'zod';
import { WeeklyHours, weeklyHoursDayProblem } from '../calendar/config';
import {
  isClock,
  isLocalDate,
  localDateOf,
  parseClock,
  zonedParts,
} from '../calendar/engine/zoned';
import { formatHours } from '../calendar/format';
import { fmtMonthDay } from '../calendar/when';
import { zonePickLabel } from '../calendar/zone-pick';
import { formatClock } from '../messaging/quiet-hours';
import { isoDateTime, timezone, uuid } from '../schemas/common';

export const MY_CALENDAR_SETUP_QUESTIONS = [
  'calendar',
  'hours',
  'timeOff',
  'dayStart',
  'zoom',
] as const;
export type MyCalendarSetupQuestion = (typeof MY_CALENDAR_SETUP_QUESTIONS)[number];
/** A question, or Check it over. */
export type MyCalendarSetupScreen = MyCalendarSetupQuestion | 'review';
export const myCalendarSetupScreen = z.enum([...MY_CALENDAR_SETUP_QUESTIONS, 'review']);

export const MY_CALENDAR_PROVIDERS = ['google', 'microsoft'] as const;
export type MyCalendarProvider = (typeof MY_CALENDAR_PROVIDERS)[number];

/** Weekdays, 9 to 5: what someone has before they save hours of their own. */
export const MY_CALENDAR_WEEKDAYS: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '09:00',
  end: '17:00',
}));

const clock = z.string().refine(isClock, { error: 'Use a time like 09:00.' });
const date = z.string().refine(isLocalDate, { error: 'Use a date like 2026-12-24.' });

/** Time off added on question 3, kept until Check it over saves it. */
export const MyCalendarTimeOffDraft = z.object({
  /** Tells the rows apart while they're being added. */
  key: z.string().min(1).max(40),
  allDay: z.boolean(),
  /** All day: the first and last day off, both included. Part of a day: the day, and endDate is the same. */
  startDate: date,
  endDate: date,
  /** Part of a day only: from and to, on their clock. */
  start: clock,
  end: clock,
  note: z.string().max(500),
});
export type MyCalendarTimeOffDraft = z.infer<typeof MyCalendarTimeOffDraft>;

/** The answers as the screens keep them. */
export const MyCalendarSetupAnswers = z.object({
  /** Which calendar they keep their days in; null until they pick. none: something else, or none at all. */
  calendar: z.enum([...MY_CALENDAR_PROVIDERS, 'none']).nullable(),
  /** The business's open hours, weekdays 9 to 5, or their own. */
  hours: z.enum(['business', 'weekdays', 'own']),
  /** Set my own's days and times. */
  ownHours: WeeklyHours,
  /** A lunch break on every day they work (the business's hours or weekdays 9 to 5 only). */
  lunch: z.boolean(),
  lunchStart: clock,
  lunchEnd: clock,
  /** The zone their hours are in; null follows the business's. */
  timezone: timezone.nullable(),
  /** Time off to add. */
  timeOff: z.array(MyCalendarTimeOffDraft).max(20),
  /** Time off already saved that they removed on question 3. */
  removeTimeOff: z.array(uuid).max(50),
  /** Where the drive to their first visit of a day starts: the business's address, or one of their own. */
  dayStart: z.enum(['business', 'own']),
  address: z.string().max(300),
  /** Connect Zoom on Done, for their online appointments' links. */
  zoom: z.boolean(),
});
export type MyCalendarSetupAnswers = z.infer<typeof MyCalendarSetupAnswers>;

// ---------- what the setup reads ----------

export const MyCalendarSetupGetInput = z.object({ workspaceId: uuid });
const TimeOffSaved = z.object({
  id: uuid,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  allDay: z.boolean(),
  note: z.string().nullable(),
});
export const MyCalendarSetupGetOutput = z.object({
  userId: uuid,
  fullName: z.string(),
  /** The business's zone, which hours without their own follow. */
  businessZone: z.string(),
  /** The business's open hours (Settings → Workspace). */
  businessHours: WeeklyHours,
  /** Their own hours; null while none are saved (weekdays 9 to 5 apply). */
  weekly: WeeklyHours.nullable(),
  /** Their hours' own zone; null follows the business's. */
  ownTimezone: z.string().nullable(),
  /** Their time off that hasn't ended yet, soonest first. */
  timeOff: z.array(TimeOffSaved),
  /** Their Google or Outlook calendar; null when none is connected (or a sign-in was never finished). */
  connection: z
    .object({
      id: uuid,
      provider: z.enum(MY_CALENDAR_PROVIDERS),
      status: z.enum(['pending', 'active', 'reauth_required', 'error', 'disconnected']),
      accountEmail: z.string().nullable(),
      busySyncedAt: isoDateTime.nullable(),
    })
    .nullable(),
  /** A calendar they're on leaves time to drive between visits: where their day starts is asked. */
  drive: z.boolean(),
  /** Their own start address; null starts the day from the business's. */
  dayStart: z.string().nullable(),
  /** The business's address, where a day starts when they've set none; null when it has none. */
  businessAddress: z.string().nullable(),
  /** A calendar they're on makes a Zoom link for each online appointment. */
  zoom: z.boolean(),
  /** Their Zoom account; null when none is connected. */
  meeting: z
    .object({
      status: z.enum(['pending', 'active', 'reauth_required', 'error', 'disconnected']),
      accountEmail: z.string().nullable(),
    })
    .nullable(),
});
export type MyCalendarSetupContext = z.infer<typeof MyCalendarSetupGetOutput>;

/** Their Google or Outlook calendar is connected and working (or only needs signing in again). */
export const myCalendarConnected = (ctx: Pick<MyCalendarSetupContext, 'connection'>) =>
  !!ctx.connection &&
  ctx.connection.status !== 'pending' &&
  ctx.connection.status !== 'disconnected';

const zoomConnected = (ctx: Pick<MyCalendarSetupContext, 'meeting'>) =>
  ctx.meeting?.status === 'active';

/**
 * They've set up their calendar, with these questions or before them: a calendar connected, or hours of their own
 * saved. Until then Settings → My calendar offers the setup (M1 a).
 */
export const myCalendarIsSetUp = (ctx: Pick<MyCalendarSetupContext, 'connection' | 'weekly'>) =>
  myCalendarConnected(ctx) || ctx.weekly !== null;

/** The zone their hours are in. */
export const myCalendarZone = (
  ctx: Pick<MyCalendarSetupContext, 'businessZone' | 'ownTimezone'>,
  a?: Pick<MyCalendarSetupAnswers, 'timezone'>,
) => (a ? (a.timezone ?? ctx.businessZone) : (ctx.ownTimezone ?? ctx.businessZone));

// ---------- hours ----------

const sortedHours = (h: WeeklyHours) =>
  [...h].sort(
    (a, b) => a.day - b.day || a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
  );
/** The same hours, in whatever order they're listed. */
export const sameWeeklyHours = (a: WeeklyHours, b: WeeklyHours) =>
  JSON.stringify(sortedHours(a)) === JSON.stringify(sortedHours(b));
const sameHours = sameWeeklyHours;

/** Hours with a lunch break taken out of every stretch it falls in. */
export function withLunch(hours: WeeklyHours, start: string, end: string): WeeklyHours {
  if (!isClock(start) || !isClock(end) || parseClock(end) <= parseClock(start))
    return sortedHours(hours);
  const s = parseClock(start);
  const e = parseClock(end);
  return sortedHours(hours).flatMap((h) => {
    const hs = parseClock(h.start);
    const he = parseClock(h.end);
    if (e <= hs || s >= he) return [h];
    const out: WeeklyHours = [];
    if (s > hs) out.push({ day: h.day, start: h.start, end: start });
    if (e < he) out.push({ day: h.day, start: end, end: h.end });
    return out;
  });
}

/** The hours before the lunch break: the business's, weekdays 9 to 5, or their own. */
function baseHours(
  a: Pick<MyCalendarSetupAnswers, 'hours' | 'ownHours'>,
  ctx: Pick<MyCalendarSetupContext, 'businessHours'>,
): WeeklyHours {
  if (a.hours === 'own') return sortedHours(a.ownHours);
  return sortedHours(a.hours === 'business' ? ctx.businessHours : MY_CALENDAR_WEEKDAYS);
}

/** The weekly hours these answers save (schedule.set). */
export function myCalendarWeekly(
  a: Pick<MyCalendarSetupAnswers, 'hours' | 'ownHours' | 'lunch' | 'lunchStart' | 'lunchEnd'>,
  ctx: Pick<MyCalendarSetupContext, 'businessHours'>,
): WeeklyHours {
  const base = baseHours(a, ctx);
  return a.hours !== 'own' && a.lunch ? withLunch(base, a.lunchStart, a.lunchEnd) : base;
}

/**
 * Saved hours read back as the three choices: the business's or weekdays 9 to 5, either with every working day broken
 * by the same lunch, or their own.
 */
function hoursPickOf(
  weekly: WeeklyHours,
  business: WeeklyHours,
): Pick<MyCalendarSetupAnswers, 'hours' | 'lunch' | 'lunchStart' | 'lunchEnd'> | null {
  const plain = { lunch: false, lunchStart: '12:00', lunchEnd: '13:00' };
  if (sameHours(weekly, business)) return { hours: 'business', ...plain };
  if (sameHours(weekly, MY_CALENDAR_WEEKDAYS)) return { hours: 'weekdays', ...plain };
  // The same gap on every day they work, two stretches each: that's a lunch break.
  const days = [...new Set(weekly.map((h) => h.day))];
  const gaps = days.map((d) => {
    const list = sortedHours(weekly.filter((h) => h.day === d));
    return list.length === 2 ? { day: d, a: list[0]!, b: list[1]! } : null;
  });
  if (!days.length || gaps.some((g) => !g)) return null;
  const first = gaps[0]!;
  if (gaps.some((g) => g!.a.end !== first.a.end || g!.b.start !== first.b.start)) return null;
  const merged = gaps.map((g) => ({ day: g!.day, start: g!.a.start, end: g!.b.end }));
  const lunch = { lunch: true, lunchStart: first.a.end, lunchEnd: first.b.start };
  if (sameHours(merged, business)) return { hours: 'business', ...lunch };
  if (sameHours(merged, MY_CALENDAR_WEEKDAYS)) return { hours: 'weekdays', ...lunch };
  return null;
}

// ---------- where the answers start ----------

/**
 * Where the answers start: what's set now, so the same questions change it. No calendar picked until one is connected,
 * and with nothing set up yet the business's open hours (M2 a), no time off to add, the day starting from the business, and Zoom to
 * connect when it's asked.
 */
export function myCalendarSetupStart(ctx: MyCalendarSetupContext): MyCalendarSetupAnswers {
  const picked = ctx.weekly ? hoursPickOf(ctx.weekly, ctx.businessHours) : null;
  const connected = myCalendarConnected(ctx);
  return {
    // Never "none" to start with: Getting started's Connect your calendar opens this, so it's always a real pick.
    calendar: connected ? ctx.connection!.provider : null,
    hours: ctx.weekly ? (picked?.hours ?? 'own') : 'business',
    ownHours: sortedHours(ctx.weekly ?? ctx.businessHours),
    lunch: picked?.lunch ?? false,
    lunchStart: picked?.lunchStart ?? '12:00',
    lunchEnd: picked?.lunchEnd ?? '13:00',
    timezone: ctx.ownTimezone,
    timeOff: [],
    removeTimeOff: [],
    dayStart: ctx.dayStart ? 'own' : 'business',
    address: ctx.dayStart ?? '',
    zoom: true,
  };
}

/** Saved answers read back over where they start, a field at a time: one that no longer fits is left at its start. */
export function myCalendarSetupAnswersOf(
  raw: unknown,
  start: MyCalendarSetupAnswers,
): MyCalendarSetupAnswers {
  const from = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...start };
  for (const [key, schema] of Object.entries(MyCalendarSetupAnswers.shape)) {
    const got = (schema as z.ZodType).safeParse(from[key]);
    if (got.success) out[key] = got.data;
  }
  return out as MyCalendarSetupAnswers;
}

/** The questions this person is asked: where the day starts only with drive times, Zoom only when it's needed. */
export function myCalendarSetupQuestions(
  ctx: Pick<MyCalendarSetupContext, 'drive' | 'zoom' | 'meeting'>,
): MyCalendarSetupQuestion[] {
  return MY_CALENDAR_SETUP_QUESTIONS.filter((q) => {
    if (q === 'dayStart') return ctx.drive;
    if (q === 'zoom') return ctx.zoom && !zoomConnected(ctx);
    return true;
  });
}

/** The calendar to sign in to after saving; null when it's connected already, or they keep none. */
export function myCalendarToConnect(
  a: Pick<MyCalendarSetupAnswers, 'calendar'>,
  ctx: Pick<MyCalendarSetupContext, 'connection'>,
): MyCalendarProvider | null {
  if (!a.calendar || a.calendar === 'none') return null;
  const c = ctx.connection;
  if (c && c.provider === a.calendar && c.status === 'active') return null;
  return a.calendar;
}

// ---------- what is wrong ----------

export interface MyCalendarSetupProblem {
  readonly path: keyof MyCalendarSetupAnswers;
  readonly message: string;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** What's wrong with one time off before it's added; null when it can go on the list. */
export function myCalendarTimeOffProblem(
  t: Pick<MyCalendarTimeOffDraft, 'allDay' | 'startDate' | 'endDate' | 'start' | 'end'>,
): string | null {
  const P = MY_CALENDAR_SETUP_WORDS.problems;
  if (!isLocalDate(t.startDate) || !isLocalDate(t.endDate)) return P.timeOffDate;
  if (t.allDay) return t.endDate < t.startDate ? P.timeOffEnd : null;
  if (!isClock(t.start) || !isClock(t.end)) return P.timeOffTime;
  return parseClock(t.end) <= parseClock(t.start) ? P.timeOffEndTime : null;
}

/** What stops Next on a question; empty when it can go on. */
export function myCalendarSetupProblems(
  q: MyCalendarSetupScreen,
  a: MyCalendarSetupAnswers,
  ctx: Pick<MyCalendarSetupContext, 'businessHours'>,
): MyCalendarSetupProblem[] {
  const P = MY_CALENDAR_SETUP_WORDS.problems;
  const out: MyCalendarSetupProblem[] = [];
  switch (q) {
    case 'calendar':
      if (!a.calendar) out.push({ path: 'calendar', message: P.calendar });
      break;
    case 'hours': {
      if (a.hours === 'own') {
        if (!a.ownHours.length) {
          out.push({ path: 'ownHours', message: P.noDays });
          break;
        }
        for (let day = 0; day < 7; day++) {
          const problem = weeklyHoursDayProblem(a.ownHours.filter((h) => h.day === day));
          if (problem) {
            out.push({ path: 'ownHours', message: `${DAY_NAMES[day]}: ${problem}` });
            break;
          }
        }
        break;
      }
      if (!baseHours(a, ctx).length) {
        out.push({ path: 'hours', message: P.businessClosed });
        break;
      }
      if (!a.lunch) break;
      if (parseClock(a.lunchEnd) <= parseClock(a.lunchStart))
        out.push({ path: 'lunchEnd', message: P.lunchEnd });
      else if (!myCalendarWeekly(a, ctx).length)
        out.push({ path: 'lunchStart', message: P.lunchAll });
      break;
    }
    case 'timeOff':
      for (const t of a.timeOff) {
        const problem = myCalendarTimeOffProblem(t);
        if (problem) {
          out.push({ path: 'timeOff', message: problem });
          break;
        }
      }
      break;
    case 'dayStart':
      if (a.dayStart === 'own' && !a.address.trim())
        out.push({ path: 'address', message: P.address });
      break;
    case 'zoom':
    case 'review':
      break;
  }
  return out;
}

/** The first question with something wrong, for Check it over; null when all is well. */
export function myCalendarSetupFirstProblem(
  a: MyCalendarSetupAnswers,
  ctx: Pick<MyCalendarSetupContext, 'businessHours' | 'drive' | 'zoom' | 'meeting'>,
): MyCalendarSetupQuestion | null {
  return (
    myCalendarSetupQuestions(ctx).find((q) => myCalendarSetupProblems(q, a, ctx).length > 0) ?? null
  );
}

/** The question a refusal from saving is about, from its path ("answers.address"); null when it's about none. */
export function myCalendarSetupQuestionOf(path: string): MyCalendarSetupQuestion | null {
  const key = path.split('.').filter((p) => p !== 'answers')[0] ?? '';
  if (key === 'calendar') return 'calendar';
  if (['hours', 'ownHours', 'lunch', 'lunchStart', 'lunchEnd', 'timezone', 'weekly'].includes(key))
    return 'hours';
  if (key === 'timeOff' || key === 'removeTimeOff') return 'timeOff';
  if (key === 'dayStart' || key === 'address') return 'dayStart';
  if (key === 'zoom') return 'zoom';
  return null;
}

// ---------- what saving does ----------

export const MyCalendarSetupSaveInput = z.object({
  workspaceId: uuid,
  answers: MyCalendarSetupAnswers,
});
export const MyCalendarSetupSaveOutput = z.object({
  /** Sign in to this calendar next; null when it's connected already, or they keep none. */
  connect: z.enum(MY_CALENDAR_PROVIDERS).nullable(),
  /** Done offers Connect Zoom: they said yes, and it isn't connected. */
  zoom: z.boolean(),
  /** What changed, one line each. */
  changed: z.array(z.string()),
});
export type MyCalendarSetupSaveOutput = z.infer<typeof MyCalendarSetupSaveOutput>;

// ---------- the lines ----------

export interface MyCalendarSetupLine {
  /** The question that changes it. */
  readonly key: MyCalendarSetupQuestion;
  /** Tells the lines apart: the hours question has two. */
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

/** "Nov 26 to 27", "Nov 30 to Dec 2", "Dec 24", "Dec 24, 9:00 AM to 12:00 PM", each with its note after a comma. */
export function myCalendarTimeOffLabel(
  t: Pick<MyCalendarTimeOffDraft, 'allDay' | 'startDate' | 'endDate' | 'start' | 'end'> & {
    readonly note?: string | null;
  },
): string {
  const note = t.note?.trim() ? `, ${t.note.trim()}` : '';
  if (!t.allDay) {
    const day = fmtMonthDay(t.startDate);
    const ends = t.endDate !== t.startDate ? `${fmtMonthDay(t.endDate)}, ` : '';
    return `${day}, ${formatClock(t.start)} to ${ends}${formatClock(t.end)}${note}`;
  }
  if (t.endDate === t.startDate) return `${fmtMonthDay(t.startDate)}${note}`;
  const sameMonth = t.startDate.slice(0, 7) === t.endDate.slice(0, 7);
  const to = sameMonth ? String(Number(t.endDate.slice(8))) : fmtMonthDay(t.endDate);
  return `${fmtMonthDay(t.startDate)} to ${to}${note}`;
}

const clockOf = (at: number, zone: string) => {
  const p = zonedParts(at, zone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/** Saved time off as question 3 lists it, in their zone. */
export function myCalendarSavedTimeOff(
  t: MyCalendarSetupContext['timeOff'][number],
  zone: string,
): Omit<MyCalendarTimeOffDraft, 'key'> {
  const s = Date.parse(t.startsAt);
  const e = Date.parse(t.endsAt);
  return {
    allDay: t.allDay,
    startDate: localDateOf(s, zone),
    endDate: localDateOf(t.allDay ? e - 1 : e, zone),
    start: clockOf(s, zone),
    end: clockOf(e, zone),
    note: t.note ?? '',
  };
}

/** "Mon–Fri 8:00 AM–5:00 PM, with lunch from 12:00 PM to 1:00 PM". */
export function myCalendarHoursLine(
  a: Pick<MyCalendarSetupAnswers, 'hours' | 'ownHours' | 'lunch' | 'lunchStart' | 'lunchEnd'>,
  ctx: Pick<MyCalendarSetupContext, 'businessHours'>,
): string {
  const W = MY_CALENDAR_SETUP_WORDS.lines;
  const base = baseHours(a, ctx);
  if (!base.length) return W.noHours;
  const lunch =
    a.hours !== 'own' && a.lunch && isClock(a.lunchStart) && isClock(a.lunchEnd)
      ? W.withLunch(formatClock(a.lunchStart), formatClock(a.lunchEnd))
      : '';
  return `${formatHours(base)}${lunch}`;
}

/** "Same as the business (Central Time)", or the zone they picked. */
export function myCalendarZoneLine(
  zone: string | null,
  ctx: Pick<MyCalendarSetupContext, 'businessZone'>,
): string {
  const W = MY_CALENDAR_SETUP_WORDS.lines;
  return zone && zone !== ctx.businessZone
    ? zonePickLabel(zone)
    : W.sameZone(zonePickLabel(ctx.businessZone));
}

/** The time off still coming up once the answers are saved: what's kept, then what's added. */
function timeOffAfter(a: MyCalendarSetupAnswers, ctx: MyCalendarSetupContext): string[] {
  const zone = myCalendarZone(ctx, a);
  return [
    ...ctx.timeOff
      .filter((t) => !a.removeTimeOff.includes(t.id))
      .map((t) => myCalendarTimeOffLabel(myCalendarSavedTimeOff(t, zone))),
    ...a.timeOff.map((t) => myCalendarTimeOffLabel(t)),
  ];
}

/** One line for each answer, for the list beside the questions and Check it over. */
export function myCalendarSetupLines(
  a: MyCalendarSetupAnswers,
  ctx: MyCalendarSetupContext,
): MyCalendarSetupLine[] {
  const W = MY_CALENDAR_SETUP_WORDS.lines;
  return myCalendarSetupQuestions(ctx).flatMap((key): MyCalendarSetupLine[] => {
    switch (key) {
      case 'calendar': {
        const c = ctx.connection;
        const value = !a.calendar
          ? W.notPicked
          : a.calendar === 'none'
            ? W.none
            : c && c.provider === a.calendar && c.status === 'active' && c.accountEmail
              ? W.connectedAs(providerName(a.calendar), c.accountEmail)
              : providerName(a.calendar);
        return [{ key, id: 'calendar', label: W.calendar, value }];
      }
      case 'hours':
        return [
          { key, id: 'hours', label: W.hours, value: myCalendarHoursLine(a, ctx) },
          { key, id: 'timezone', label: W.zone, value: myCalendarZoneLine(a.timezone, ctx) },
        ];
      case 'timeOff': {
        const list = timeOffAfter(a, ctx);
        return [
          {
            key,
            id: 'timeOff',
            label: W.timeOff,
            value: list.length ? `${list.join('. ')}.` : W.noTimeOff,
          },
        ];
      }
      case 'dayStart':
        return [
          {
            key,
            id: 'dayStart',
            label: W.dayStart,
            value:
              a.dayStart === 'own' && a.address.trim()
                ? a.address.trim()
                : W.fromBusiness(ctx.businessAddress),
          },
        ];
      case 'zoom':
        return [
          {
            key,
            id: 'zoom',
            label: W.zoom,
            value: a.zoom
              ? W.zoomAfter(
                  myCalendarToConnect(a, ctx)
                    ? providerName(a.calendar as MyCalendarProvider)
                    : null,
                )
              : W.zoomNotNow,
          },
        ];
    }
  });
}

/**
 * Settings → My calendar's answers (M3 a), read from what's set now, so they're never out of step with All settings:
 * when customers can book them, their time zone, time off, where their day starts (with drive times), and Zoom (when
 * a calendar they're on uses it, or it's connected).
 */
export function myCalendarSettingsLines(ctx: MyCalendarSetupContext): MyCalendarSetupLine[] {
  const W = MY_CALENDAR_SETUP_WORDS.lines;
  const zone = myCalendarZone(ctx);
  const upcoming = ctx.timeOff.map((t) => myCalendarTimeOffLabel(myCalendarSavedTimeOff(t, zone)));
  const lines: MyCalendarSetupLine[] = [
    {
      key: 'hours',
      id: 'hours',
      label: W.hours,
      value: ctx.weekly ? formatHours(ctx.weekly) || W.noHours : W.usual,
    },
    {
      key: 'hours',
      id: 'timezone',
      label: W.zone,
      value: myCalendarZoneLine(ctx.ownTimezone, ctx),
    },
    {
      key: 'timeOff',
      id: 'timeOff',
      label: W.timeOff,
      value: upcoming.length ? W.comingUp(upcoming.length, upcoming[0]!) : W.noTimeOff,
    },
  ];
  if (ctx.drive)
    lines.push({
      key: 'dayStart',
      id: 'dayStart',
      label: W.dayStart,
      value: ctx.dayStart ?? W.fromBusiness(ctx.businessAddress),
    });
  if (ctx.zoom || ctx.meeting)
    lines.push({
      key: 'zoom',
      id: 'zoom',
      label: W.zoom,
      value:
        ctx.meeting?.status === 'active'
          ? W.zoomConnected(ctx.meeting.accountEmail)
          : ctx.meeting && ctx.meeting.status !== 'pending' && ctx.meeting.status !== 'disconnected'
            ? W.zoomReconnect
            : W.zoomNot,
    });
  return lines;
}

/** "Google Calendar", "Outlook". */
export const providerName = (p: MyCalendarProvider) =>
  p === 'google'
    ? MY_CALENDAR_SETUP_WORDS.calendar.google
    : MY_CALENDAR_SETUP_WORDS.calendar.outlook;

/** The chips on Done: "Mon–Fri 8:00 AM–5:00 PM", "Lunch 12:00 PM to 1:00 PM", "2 times off", "Starts from home". */
export function myCalendarDoneChips(ctx: MyCalendarSetupContext): string[] {
  const W = MY_CALENDAR_SETUP_WORDS.done;
  const a = myCalendarSetupStart(ctx);
  const chips = [formatHours(myCalendarWeekly({ ...a, lunch: false }, ctx)) || W.noHours];
  if (a.hours !== 'own' && a.lunch)
    chips.push(W.lunch(formatClock(a.lunchStart), formatClock(a.lunchEnd)));
  if (ctx.timeOff.length) chips.push(W.timesOff(ctx.timeOff.length));
  if (ctx.drive && ctx.dayStart) chips.push(W.ownStart);
  return chips;
}

// ---------- words ----------

/** Everything the My calendar setup says, on the web and the phone. */
export const MY_CALENDAR_SETUP_WORDS = {
  pageTitle: 'Set up my calendar',
  settingUp: (business: string) => `Setting up your calendar at ${business}`,
  soFar: 'Your calendar so far',
  startedFrom: 'Started from your business’s open hours and time zone. Change anything.',
  startedFromSaved: 'Started from what’s set now. Change anything.',
  skip: 'Skip, I’ll do it in Settings',
  notAllowed: 'Your role here doesn’t take appointments.',
  notAllowedHint:
    'Ask an owner of this business to let you take appointments, then set up your calendar.',
  calendar: {
    title: 'Which calendar do you keep your days in?',
    hint: 'Connect it, and nobody can book you when you’re already busy there.',
    google: 'Google Calendar',
    googleHint: 'Gmail or Google Workspace.',
    outlook: 'Outlook',
    outlookHint: 'Outlook.com, Hotmail or Microsoft 365.',
    none: 'Something else, or none',
    noneHint:
      'Like Apple Calendar or a paper diary. You’ll add time off here instead, so nobody books you then.',
    connected: 'Connected',
    privacy: 'We only see when you’re busy,',
    privacyRest: ' never what it is or who it’s with.',
    oneplace: 'Your appointments show up there too,',
    oneplaceRest: ' so your whole day is in one place.',
    note: (provider: string) =>
      `You sign in to ${provider} at the end, after you check your answers. It comes straight back here.`,
    noteAny: 'You sign in at the end, after you check your answers. It comes straight back here.',
    notePhone: 'You sign in at the end. It opens in your browser and comes back here.',
  },
  hours: {
    title: 'When can customers book you?',
    hint: 'They only get times inside these hours, and never over something already on your calendar.',
    hintPhone: 'Only inside these hours, and never over your busy times.',
    business: 'Same as the business',
    businessHint: (hours: string) => `${hours}. These are your open hours in Settings → Workspace.`,
    businessBadge: 'Open hours',
    weekdays: 'Weekdays, 9 to 5',
    weekdaysHint: 'Monday to Friday, 9 AM to 5 PM.',
    own: 'Set my own',
    ownHint: 'Pick your days and times. Two shifts in a day work too.',
    ownOpenHint: 'Starts from the business’s hours. Change any day.',
    ownTip: '+ adds a break or a second shift. Copy gives every day the same hours.',
    lunch: 'Take a lunch break',
    lunchHint: 'Nobody can book you then, every day you work.',
    lunchOwn:
      'The lunch break switch hides while you set your own, since your days show their breaks.',
    zone: 'Your time zone',
    zoneHint: 'The business’s. Pick another if you work from somewhere else.',
    sameZone: (zone: string) => `Same as the business (${zone})`,
    to: 'to',
    notWorking: 'Not working',
  },
  timeOff: {
    title: 'Any time off coming up?',
    hint: (provider: string | null) =>
      provider
        ? `Nobody can book you then. If it’s already on your ${provider}, it counts by itself.`
        : 'Nobody can book you then.',
    add: 'Add time off',
    addButton: 'Add',
    allDay: 'All day',
    from: 'From',
    to: 'To',
    day: 'Day',
    startTime: 'From',
    endTime: 'To',
    note: 'Note (optional)',
    notePlaceholder: 'Like Thanksgiving',
    remove: (label: string) => `Remove ${label}`,
    allDayTag: 'All day',
    none: 'Nothing coming up yet.',
    tip: 'Nothing coming up? Just press Next. You can add time off any day from Settings → My calendar, or ask the Assistant.',
  },
  dayStart: {
    title: 'Where do you start your day?',
    hint: 'It’s how the drive to your first job is worked out, so you’re never booked too early.',
    only: 'Only when your calendars leave time to drive',
    business: 'From the business',
    businessHint: (address: string | null) =>
      address
        ? `${address}. The address in Settings → Workspace.`
        : 'The business’s address, once it’s added in Settings → Workspace.',
    own: 'From home, or somewhere else',
    ownHint: 'Type the address you set out from.',
    placeholder: 'Street, city, state and ZIP',
    pickHint: 'Pick it from the list as you type, so the drive time is right.',
    note: 'Customers never see this address. It’s only used to work out drive times.',
  },
  zoom: {
    title: 'Connect Zoom for your online appointments?',
    hint: 'Your online appointments use Zoom, so each one gets its own Zoom link from your account.',
    only: 'Only when a calendar you’re on uses Zoom',
    yes: 'Yes, connect Zoom',
    yesHint: (provider: string | null) =>
      provider
        ? `Right after ${provider}. It takes one sign-in.`
        : 'At the end. It takes one sign-in.',
    notNow: 'Not now',
    notNowHint: 'Your online appointments go out without a Zoom link until you connect it.',
    note: 'Calendars that use HandsFreeOS video calls or Google Meet need nothing here. Google Meet links come with your Google Calendar.',
  },
  review: {
    title: 'Check it over',
    kicker: 'Almost done',
    hintConnect: (provider: string) =>
      `Change anything, then save. Next, ${provider} asks you to sign in.`,
    hintSave: 'Change anything, then save.',
    aside: 'Each answer is saved. Saving uses them all at once.',
    signInNote: (provider: string) =>
      provider === 'Google Calendar'
        ? 'Google asks if HandsFreeOS may see when you’re busy and add your appointments. Allow both, and it comes straight back here.'
        : 'Microsoft asks if HandsFreeOS may see when you’re busy and add your appointments. Accept, and it comes straight back here.',
    saveConnect: (provider: string) => `Save and connect ${provider}`,
    save: 'Save my calendar',
    saved: 'Your calendar is saved.',
  },
  done: {
    title: 'Your calendar is connected',
    titleSaved: 'Your calendar is set up',
    hint: (provider: string) =>
      `Nobody can book you over something on your ${provider}, and your appointments show up there.`,
    hintNone: 'Customers can book you inside your hours, and never during your time off.',
    checked: 'Busy times checked just now',
    checkedAt: (when: string) => `Busy times checked ${when}`,
    checking: 'Checking your busy times. It takes a minute.',
    connectedBadge: 'Connected',
    notYet: 'Not connected yet',
    notYetHint: (provider: string) =>
      `${provider} didn’t finish connecting. Try again, and allow everything it asks.`,
    tryAgain: (provider: string) => `Connect ${provider}`,
    zoomTitle: 'One more: connect Zoom.',
    zoomRest: ' Then your online appointments get their links.',
    zoomButton: 'Connect Zoom',
    zoomDone: 'Zoom is connected.',
    lunch: (from: string, to: string) => `Lunch ${from} to ${to}`,
    timesOff: (n: number) => `${n} ${n === 1 ? 'time off' : 'times off'}`,
    ownStart: 'Starts from your own address',
    noHours: 'No hours',
    change: 'Change any of it in Settings → My calendar.',
    backHome: 'Back to Getting started',
    backSettings: 'Back to My calendar',
  },
  summary: {
    lead: 'Your hours, time off and calendar. Everyone sets their own.',
    setUp: 'Set up my calendar',
    setUpHint: (n: number) =>
      `${n === 3 ? 'Three' : n === 4 ? 'Four' : 'Five'} quick questions, then connect Google or Outlook. About 2 minutes.`,
    start: 'Start',
    resume: 'Pick up where you left off',
    until: 'Until then',
    untilHint: (hours: string) =>
      `Customers can book you ${hours}, even over things already on your own calendar.`,
    connected: 'Connected',
    needsSignIn: 'Sign in again',
    checked: (when: string) =>
      `Busy times checked ${when}. Your appointments show there as events.`,
    notChecked: 'Busy times are being checked for the first time.',
    syncNow: 'Sync now',
    synced: 'Checking your busy times now.',
    noCalendar: 'No calendar connected',
    noCalendarHint:
      'Customers can book you over things on your own calendar. Connect Google or Outlook to stop that.',
    connect: 'Connect a calendar',
    answers: 'Your answers',
    again: 'Go through the questions again',
    change: 'Change',
    allSettings: 'All settings',
    hideAll: 'Hide all settings',
    under: 'Under All settings',
    underHint:
      'Today’s page, unchanged: every day’s hours one by one, extra open time, each time off with remove, Google Meet transcripts, Disconnect, and Zoom’s settings check. Nothing is taken away.',
    fix: 'Your calendar needs you to sign in again. Open All settings to reconnect it.',
  },
  phone: {
    row: 'My calendar',
    rowHint: 'Your hours, time off and Google or Outlook',
    signInHint: 'The sign-in opens in your browser, then comes back here.',
    back: 'Back in the app? Pull down to check your calendar connected.',
  },
  lines: {
    calendar: 'Your calendar',
    notPicked: 'Not picked yet',
    none: 'Something else, or none',
    connectedAs: (provider: string, email: string) => `${provider} (${email}), connected`,
    hours: 'When customers can book you',
    withLunch: (from: string, to: string) => `, with lunch from ${from} to ${to}`,
    noHours: 'No hours, so nobody can book you',
    usual: 'Weekdays 9 to 5, the usual until you set your own',
    zone: 'Your time zone',
    sameZone: (zone: string) => `Same as the business (${zone})`,
    timeOff: 'Time off',
    noTimeOff: 'None coming up',
    comingUp: (n: number, next: string) => `${n} coming up. Next: ${next}`,
    dayStart: 'Where your day starts',
    fromBusiness: (address: string | null) =>
      address ? `From the business (${address})` : 'From the business',
    zoom: 'Zoom',
    zoomAfter: (provider: string | null) =>
      provider ? `Connect it after ${provider}` : 'Connect it at the end',
    zoomNotNow: 'Not now',
    zoomConnected: (email: string | null) => (email ? `${email}, connected` : 'Connected'),
    zoomReconnect: 'Needs you to sign in again',
    zoomNot: 'Not connected',
  },
  problems: {
    calendar: 'Pick the calendar you keep your days in, or Something else, or none.',
    noDays: 'Turn on at least one day, so customers can book you.',
    businessClosed: 'The business has no open hours yet. Pick Weekdays, 9 to 5, or Set my own.',
    lunchEnd: 'End the lunch break after it starts.',
    lunchAll: 'Your lunch break covers all your hours. Shorten it, or turn it off.',
    timeOffDate: 'Pick the days of your time off.',
    timeOffEnd: 'End your time off on or after the day it starts.',
    timeOffTime: 'Pick when your time off starts and ends.',
    timeOffEndTime: 'End your time off after it starts.',
    address: 'Type the address you start your day from, or pick From the business.',
  },
} as const;
