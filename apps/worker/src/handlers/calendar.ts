import { eq } from 'drizzle-orm';
import { calendarConnections, users, workspaces } from '@hfos/db/schema';
import { queueCalendarSync, scheduleRefresh } from '../calendar/sync';
import { calendarReconnectEmail } from '../emails/templates';
import { tenantOf } from '../services';
import type { EventHandler } from './types';

/** A calendar connected, or its person pressed Sync now: read its busy times right away. */
export const onCalendarRefreshWanted: EventHandler = async (ctx) => {
  if (ctx.event.entityId) await scheduleRefresh(ctx.tx, tenantOf(ctx.scope), ctx.event.entityId);
};

/**
 * A calendar lost access (a password reset, a revoked app, Google's weekly limit while in testing): one email
 * to the person whose calendar it is.
 */
export const onCalendarReauthRequired: EventHandler = async (ctx) => {
  if (!ctx.event.entityId) return;
  const scope = tenantOf(ctx.scope);
  const [c] = await ctx.tx
    .select()
    .from(calendarConnections)
    .where(eq(calendarConnections.id, ctx.event.entityId));
  if (!c || c.status !== 'reauth_required') return;
  const [person] = await ctx.tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, c.userId));
  if (!person?.email) return;
  const [w] = await ctx.tx
    .select({ timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId));
  const content = calendarReconnectEmail({
    provider: c.provider,
    account: c.accountEmail ?? 'your calendar',
    lostAt: c.busySyncedAt ?? c.updatedAt,
    timeZone: w?.timezone ?? 'America/Chicago',
    link: `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/my-calendar`,
  });
  await ctx.mailer.send({ to: String(person.email), ...content });
};

/**
 * An appointment was booked, moved, reassigned, cancelled or finished: its events in people's calendars follow.
 * Events about several appointments (a series, whose entity id is the series) list them in `appointmentIds`.
 * An appointment nobody works (a calendar without staff) is skipped: queueCalendarSync only queues one when
 * someone on it has a connected calendar or an event was written for it before.
 */
export const onAppointmentChanged: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const listed = ((ctx.event.payload ?? {}) as Record<string, unknown>)['appointmentIds'];
  const ids = Array.isArray(listed)
    ? listed.filter((id): id is string => typeof id === 'string').slice(0, 100)
    : ctx.event.entityType === 'appointment' && ctx.event.entityId
      ? [ctx.event.entityId]
      : [];
  for (const id of new Set(ids)) await queueCalendarSync(ctx.tx, scope, id);
};
