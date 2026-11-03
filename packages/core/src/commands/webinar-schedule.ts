/**
 * Schedule a webinar (docs/video-calls.md "Webinars"): one date, or the same time every week, every 2 weeks or every
 * month, on a webinar calendar (fixed sessions on a HandsFreeOS video call, the Webinar preset). The owner's ask: a
 * webinar can be made without a webinar calendar, and the calendar is made with it.
 *
 * - **Which calendar:** the one asked for, else the business's webinar calendar (an active one first, then the oldest).
 * - **None yet:** a "Webinars" calendar is made from the Webinar preset, with the person scheduling as its presenter,
 *   and turned on. Making one needs calendars.manage, so anyone else is told who can.
 * - **The dates** go through session.publish (one) or series.create (a repeat), with their own rules, so a repeat
 *   books every date that fits and lists the rest. Warnings (outside hours, busy, time off) ask first, for every date
 *   at once, and "Publish anyway" books over them.
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import { calendars, workspaces } from '@hfos/db/schema';
import { parseConfig } from '../calendar/config';
import { RecurrenceRule } from '../calendar/engine/recurrence';
import { localDateOf, zonedParts } from '../calendar/engine/zoned';
import { loadCalendar } from '../calendar/load';
import {
  isWebinarCalendar,
  WEBINAR_CALENDAR_NAME,
  webinarRepeatDefault,
  webinarRepeatRule,
} from '../calendar/webinars';
import { fmtDateShort } from '../calendar/when';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin, scopeCan } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import { WebinarScheduleInput, WebinarScheduleOutput } from '../schemas/calendar';
import { calendarCreate, calendarSetStatus } from './calendar';
import { seriesCreate, sessionPublish } from './appointment';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const HH_MM = (at: number, timeZone: string) => {
  const p = zonedParts(at, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/** The business's webinar calendars that can take dates: active ones first, then the oldest. */
async function webinarCalendars(ctx: CommandContext) {
  const list = await ctx.tx
    .select({
      id: calendars.id,
      name: calendars.name,
      status: calendars.status,
      config: calendars.config,
    })
    .from(calendars)
    .where(and(eq(calendars.workspaceId, ctx.scope.workspaceId!), ne(calendars.status, 'archived')))
    .orderBy(asc(calendars.createdAt));
  return list
    .filter((c) => {
      try {
        return isWebinarCalendar(parseConfig(c.config));
      } catch {
        return false;
      }
    })
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'));
}

/** The calendar the webinar goes on, made (and turned on) when the business has none. */
async function calendarFor(
  ctx: CommandContext,
  calendarId: string | undefined,
): Promise<{ calendarId: string; made: boolean }> {
  const ws = ctx.scope.workspaceId!;
  if (calendarId) {
    const calendar = await loadCalendar(ctx.tx, ws, calendarId);
    if (!isWebinarCalendar(calendar.config))
      throw HfosError.rule(
        'not_a_webinar_calendar',
        409,
        `${calendar.name} isn’t a webinar calendar. Pick a calendar with Fixed sessions on a HandsFreeOS video call, or leave the calendar out to use your Webinars one.`,
      );
    return { calendarId: calendar.id, made: false };
  }
  const [found] = await webinarCalendars(ctx);
  if (found) return { calendarId: found.id, made: false };
  if (!scopeCan(ctx.scope, 'calendars.manage'))
    throw HfosError.rule(
      'no_webinar_calendar',
      403,
      'This business has no webinar calendar yet, and making one needs permission to manage calendars. Ask an owner or admin to schedule the first webinar, or to add a Webinar calendar in Settings → Calendars → New calendar.',
    );
  const made = await executeCommandWithin(ctx, calendarCreate, {
    workspaceId: ws,
    name: WEBINAR_CALENDAR_NAME,
    preset: 'webinar',
  });
  const { calendarId: id } = made.output;
  try {
    await executeCommandWithin(ctx, calendarSetStatus, {
      workspaceId: ws,
      calendarId: id,
      status: 'active',
    });
  } catch (e) {
    // Its sessions still publish, and Settings → Calendars says what's left before it can be turned on.
    if (!(e instanceof HfosError)) throw e;
  }
  return { calendarId: id, made: true };
}

/** The dates of a repeat that only warnings held back, said once so "Publish anyway" covers them all. */
function warnedDates(
  skipped: readonly { date: string; reason: string; warning: boolean }[],
  total: number,
): HfosError {
  const warned = skipped.filter((s) => s.warning);
  const lines = warned.slice(0, 3).map((s) => {
    const why = s.reason.trim();
    return `${fmtDateShort(s.date)}: ${why}${/[.!?]$/.test(why) ? '' : '.'}`;
  });
  const more = warned.length > 3 ? ` And ${warned.length - 3} more.` : '';
  const head =
    warned.length === total
      ? `Every date needs a second look.`
      : `${warned.length} of the ${total} dates need a second look.`;
  return new HfosError(
    'conflict',
    409,
    `${head} ${lines.join(' ')}${more} Publish anyway to schedule them too, or pick another time.`,
    { warnings: [], skipped: warned },
    'needs_confirmation',
  );
}

export const webinarSchedule = defineCommand({
  name: 'webinar.schedule',
  description:
    'Schedule a webinar on HandsFreeOS video: one date, or the same time every week, every 2 weeks or every month. It goes on the business’s webinar calendar, which is made (as Webinars, with you presenting) when there isn’t one.',
  risk: 2,
  input: WebinarScheduleInput,
  output: WebinarScheduleOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [business] = await ctx.tx
      .select({ videoCalls: workspaces.videoCalls })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    if (business?.videoCalls !== true)
      throw HfosError.rule(
        'video_calls_off',
        409,
        'HandsFreeOS video calls aren’t on for this business yet, and a webinar runs on them. Ask HandsFreeOS support to turn them on.',
      );
    const { calendarId, made } = await calendarFor(ctx, input.calendarId);
    const calendar = await loadCalendar(ctx.tx, ws, calendarId);
    const startsAt = Date.parse(input.startsAt);
    const common = {
      workspaceId: ws,
      calendarId,
      durationMinutes: input.durationMinutes,
      userIds: input.userIds,
      capacity: input.seats,
      title: input.title,
      notes: input.notes,
    };
    const result = { calendarId, calendarName: calendar.name, calendarMade: made };

    if (input.repeat === 'none') {
      const one = await executeCommandWithin(ctx, sessionPublish, {
        ...common,
        startsAt: input.startsAt,
        acknowledgeWarnings: input.acknowledgeWarnings,
      });
      return {
        ...result,
        appointmentIds: [one.output.appointmentId],
        seriesId: null,
        skipped: [],
        warnings: one.output.warnings,
      };
    }

    const rule = RecurrenceRule.parse(
      webinarRepeatRule(
        input.repeat,
        input.times ?? webinarRepeatDefault(input.repeat),
        HH_MM(startsAt, calendar.timeZone),
      ),
    );
    const repeat = {
      ...common,
      firstDate: localDateOf(startsAt, calendar.timeZone),
      rule,
      acknowledgeWarnings: input.acknowledgeWarnings,
    };
    let out;
    try {
      out = (await executeCommandWithin(ctx, seriesCreate, repeat)).output;
    } catch (e) {
      // Every date held back: when only warnings did it, ask once for all of them.
      const skipped =
        (e instanceof HfosError && e.rule === 'series_no_fit'
          ? (e.details as { skipped?: { date: string; reason: string; warning: boolean }[] })
              ?.skipped
          : undefined) ?? [];
      if (!input.acknowledgeWarnings && skipped.length && skipped.every((s) => s.warning))
        throw warnedDates(skipped, skipped.length);
      throw e;
    }
    if (!input.acknowledgeWarnings && out.skipped.some((s) => s.warning))
      throw warnedDates(out.skipped, out.appointmentIds.length + out.skipped.length);
    return {
      ...result,
      appointmentIds: out.appointmentIds,
      seriesId: out.seriesId,
      skipped: out.skipped,
      warnings: [],
    };
  },
});

export const webinarScheduleCommands = [webinarSchedule] as const;
