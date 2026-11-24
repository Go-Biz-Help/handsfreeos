/**
 * What the guided My calendar setup reads (the owner, 24 Nov 2026, M1 a to M4 a), in one go for the web and the
 * phone: the person's own hours, time off still coming up, their Google or Outlook calendar, where their day starts,
 * their Zoom account, and whether a calendar they're on leaves time to drive or makes Zoom links (which decides what
 * it asks). Always the person's own: owners and admins open a teammate's from Members on today's page.
 */
import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import {
  calendarConnections,
  calendarMembers,
  calendars,
  meetingConnections,
  scheduleExceptions,
  schedules,
  workspaces,
} from '@hfos/db/schema';
import { CalendarConfig } from '../calendar/config';
import { dayStartShown } from '../calendar/day-start';
import { userNames, workspaceZone } from '../calendar/load';
import {
  MyCalendarSetupGetInput,
  MyCalendarSetupGetOutput,
  type MyCalendarSetupContext,
} from '../guided-setup/my-calendar';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { openHoursOf } from '../schemas/workspace';

/** Which of the calendars someone is on leave time to drive, and which make Zoom links. */
async function calendarsTheyreOn(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<{ drive: boolean; zoom: boolean }> {
  const list = await tx
    .select({ config: calendars.config })
    .from(calendars)
    .innerJoin(calendarMembers, eq(calendarMembers.calendarId, calendars.id))
    .where(
      and(
        eq(calendars.workspaceId, workspaceId),
        eq(calendarMembers.userId, userId),
        ne(calendars.status, 'archived'),
      ),
    );
  let drive = false;
  let zoom = false;
  for (const row of list) {
    // A calendar whose settings don't read (an old shape) asks nothing extra.
    const got = CalendarConfig.safeParse(row.config);
    if (!got.success) continue;
    const c = got.data;
    if (c.buffers.driveBetween) drive = true;
    if (
      c.locations.options.some((o) => o.kind === 'virtual' && o.video === 'zoom') ||
      c.services.items.some((s) => s.overrides.video === 'zoom')
    )
      zoom = true;
  }
  return { drive, zoom };
}

/** Everything the setup reads for the person signed in. */
export async function loadMyCalendarSetup(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<MyCalendarSetupContext> {
  const [ws] = await tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const businessZone = await workspaceZone(tx, workspaceId);
  const [sched] = await tx
    .select({ id: schedules.id, weekly: schedules.weekly, timezone: schedules.timezone })
    .from(schedules)
    .where(
      and(
        eq(schedules.workspaceId, workspaceId),
        eq(schedules.ownerKind, 'user'),
        eq(schedules.ownerId, userId),
      ),
    );
  const timeOff = sched
    ? await tx
        .select({
          id: scheduleExceptions.id,
          startsAt: scheduleExceptions.startsAt,
          endsAt: scheduleExceptions.endsAt,
          allDay: scheduleExceptions.allDay,
          note: scheduleExceptions.note,
        })
        .from(scheduleExceptions)
        .where(
          and(
            eq(scheduleExceptions.scheduleId, sched.id),
            eq(scheduleExceptions.kind, 'unavailable'),
            gt(scheduleExceptions.endsAt, new Date()),
          ),
        )
        .orderBy(scheduleExceptions.startsAt)
        .limit(50)
    : [];
  const [conn] = await tx
    .select({
      id: calendarConnections.id,
      provider: calendarConnections.provider,
      status: calendarConnections.status,
      accountEmail: calendarConnections.accountEmail,
      busySyncedAt: calendarConnections.busySyncedAt,
    })
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.workspaceId, workspaceId),
        eq(calendarConnections.userId, userId),
        inArray(calendarConnections.status, ['active', 'reauth_required', 'error']),
      ),
    )
    .orderBy(desc(calendarConnections.createdAt))
    .limit(1);
  const [meeting] = await tx
    .select({ status: meetingConnections.status, accountEmail: meetingConnections.accountEmail })
    .from(meetingConnections)
    .where(
      and(
        eq(meetingConnections.workspaceId, workspaceId),
        eq(meetingConnections.userId, userId),
        inArray(meetingConnections.status, ['active', 'reauth_required', 'error']),
      ),
    )
    .orderBy(desc(meetingConnections.createdAt))
    .limit(1);
  const start = await dayStartShown(tx, workspaceId, userId);
  const on = await calendarsTheyreOn(tx, workspaceId, userId);
  const names = await userNames(tx, [userId]);
  return {
    userId,
    fullName: names.get(userId) ?? 'You',
    businessZone,
    businessHours: openHoursOf((ws?.settings ?? null) as Record<string, unknown> | null),
    weekly: sched?.weekly ?? null,
    ownTimezone: sched?.timezone ?? null,
    timeOff: timeOff.map((t) => ({
      id: t.id,
      startsAt: t.startsAt.toISOString(),
      endsAt: t.endsAt.toISOString(),
      allDay: t.allDay,
      note: t.note,
    })),
    connection: conn
      ? {
          id: conn.id,
          provider: conn.provider,
          status: conn.status,
          accountEmail: conn.accountEmail,
          busySyncedAt: conn.busySyncedAt?.toISOString() ?? null,
        }
      : null,
    drive: on.drive,
    dayStart: start.address,
    businessAddress: start.businessAddress,
    zoom: on.zoom,
    meeting: meeting ? { status: meeting.status, accountEmail: meeting.accountEmail } : null,
  };
}

export const myCalendarSetupGet = defineQuery({
  name: 'my_calendar_setup.get',
  description:
    'Your own calendar as the guided My calendar setup reads it: your hours (null while the usual weekdays 9 to 5 apply), their time zone, time off still coming up, your Google or Outlook calendar, where your day starts and your Zoom account, with the business’s open hours, zone and address, and whether a calendar you’re on leaves time to drive (drive) or makes Zoom links (zoom).',
  input: MyCalendarSetupGetInput,
  output: MyCalendarSetupGetOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    return loadMyCalendarSetup(ctx.tx, input.workspaceId, requireHuman(ctx).userId);
  },
});
