/**
 * The guided My calendar setup's Check it over (the owner, 24 Nov 2026, picks M1 a to M4 a): "Save and connect Google
 * Calendar" (or Outlook, or Save my calendar) saves what its questions decide, all together, before the calendar's
 * own sign-in. Each part runs as its own command with all its own rules: the hours and their zone (schedule.set),
 * time off removed and added (time_off.remove, time_off.add) and where the day starts (day_start.set, only when it
 * was asked). Signing in to Google or Outlook, and to Zoom, comes afterwards (calendar_connection.connect,
 * meeting_connection.connect), since only the person can. Always the person's own calendar. Answers that are wrong
 * are refused before anything changes, in the setup's own words.
 */
import { HfosError } from '../errors';
import {
  MY_CALENDAR_SETUP_WORDS,
  MyCalendarSetupSaveInput,
  MyCalendarSetupSaveOutput,
  myCalendarConnected,
  myCalendarHoursLine,
  myCalendarSetupProblems,
  myCalendarSetupQuestions,
  myCalendarTimeOffLabel,
  myCalendarToConnect,
  myCalendarWeekly,
  myCalendarZoneLine,
  sameWeeklyHours,
} from '../guided-setup/my-calendar';
import { localInstant } from '../calendar/engine/zoned';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin, scopeCan } from '../kernel/execute';
import { loadMyCalendarSetup } from '../queries/my-calendar-setup';
import { dayStartSet, scheduleSet, timeOffAdd, timeOffRemove } from './calendar-hours';
import { keepPersonalDraft } from './guided-setup';
import { onboardingSkip } from './onboarding';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const myCalendarSetupSave = defineCommand({
  name: 'my_calendar_setup.save',
  description:
    'Carry out your own guided My calendar setup’s answers, as its Check it over does before Google’s or Microsoft’s sign-in: your weekly hours (the business’s open hours or weekdays 9 to 5, either with a lunch break, or your own days and times) and their time zone, time off removed and added, and where your day starts (only when a calendar you’re on leaves time to drive). It never signs in to Google, Outlook or Zoom; only the person can, and connect says which calendar to sign in to next. Nothing changes when an answer is wrong.',
  risk: 1,
  input: MyCalendarSetupSaveInput,
  output: MyCalendarSetupSaveOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const a = input.answers;
    const now = await loadMyCalendarSetup(ctx.tx, ws, me);
    const asked = myCalendarSetupQuestions(now);
    const problems = asked.flatMap((q) => myCalendarSetupProblems(q, a, now));
    if (problems.length)
      throw HfosError.validation(
        problems.map((p) => ({ path: `answers.${p.path}`, message: p.message })),
        problems[0]!.message,
      );

    const L = MY_CALENDAR_SETUP_WORDS.lines;
    const changed: string[] = [];
    const weekly = myCalendarWeekly(a, now);
    const zone = a.timezone ?? now.businessZone;
    if (!now.weekly || !sameWeeklyHours(weekly, now.weekly) || a.timezone !== now.ownTimezone) {
      await executeCommandWithin(ctx, scheduleSet, {
        workspaceId: ws,
        ownerKind: 'user',
        ownerId: me,
        weekly,
        timezone: a.timezone,
      });
      changed.push(`${L.hours}: ${myCalendarHoursLine(a, now)}`);
      if (a.timezone !== now.ownTimezone)
        changed.push(`${L.zone}: ${myCalendarZoneLine(a.timezone, now)}`);
    }

    // Time off already gone (it ended, or was removed elsewhere) has nothing left to remove.
    const removing = now.timeOff.filter((t) => a.removeTimeOff.includes(t.id));
    for (const t of removing)
      await executeCommandWithin(ctx, timeOffRemove, { workspaceId: ws, exceptionId: t.id });
    if (removing.length) changed.push(`${L.timeOff}: ${removing.length} removed`);
    for (const t of a.timeOff) {
      const when = t.allDay
        ? { startDate: t.startDate, endDate: t.endDate }
        : {
            startsAt: new Date(localInstant(t.startDate, t.start, zone)).toISOString(),
            endsAt: new Date(localInstant(t.endDate, t.end, zone)).toISOString(),
          };
      await executeCommandWithin(ctx, timeOffAdd, {
        workspaceId: ws,
        ownerKind: 'user',
        ownerId: me,
        kind: 'unavailable',
        ...when,
        note: t.note.trim() || null,
      });
      changed.push(`${L.timeOff}: ${myCalendarTimeOffLabel(t)}`);
    }

    if (asked.includes('dayStart')) {
      const address = a.dayStart === 'own' ? a.address.replace(/\s+/g, ' ').trim() || null : null;
      if (address !== now.dayStart) {
        await executeCommandWithin(ctx, dayStartSet, { workspaceId: ws, address });
        changed.push(`${L.dayStart}: ${address ?? L.fromBusiness(now.businessAddress)}`);
      }
    }

    // The answers are spent: coming back starts from what's set now.
    await keepPersonalDraft(ctx, 'my_calendar', null);

    // "Something else, or none" answers Getting started's Connect your calendar, on a teammate's own list (an owner's
    // list doesn't have it). Bringing it back is one click there.
    if (
      a.calendar === 'none' &&
      !myCalendarConnected(now) &&
      !scopeCan(ctx.scope, 'workspace.update')
    )
      await executeCommandWithin(ctx, onboardingSkip, {
        workspaceId: ws,
        step: 'my_calendar',
        skipped: true,
      });

    return {
      connect: myCalendarToConnect(a, now),
      zoom: asked.includes('zoom') && a.zoom,
      changed,
    };
  },
});
