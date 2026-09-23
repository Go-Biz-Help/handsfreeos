/**
 * Hours and time off. Anyone who books (appointments.write) sets their own; owners and admins
 * (calendars.manage) set anyone's and every resource's and service's. A calendar's own hours live in its
 * settings (calendar.save), not here.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { resources, scheduleExceptions, schedules, services } from '@hfos/db/schema';
import { formatHours } from '../calendar/format';
import {
  ALWAYS_OPEN_HOURS,
  DEFAULT_WEEKLY_HOURS,
  iso,
  userNames,
  workspaceZone,
} from '../calendar/load';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  ScheduleSetInput,
  ScheduleSetOutput,
  TimeOffAddInput,
  TimeOffAddOutput,
  TimeOffRemoveInput,
  TimeOffRemoveOutput,
} from '../schemas/calendar';
import { scopeCan } from '../kernel/execute';

type OwnerKind = 'user' | 'resource' | 'service' | 'calendar';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Your own hours with appointments.write; anything else needs calendars.manage. */
function assertMayEditHours(ctx: CommandContext, ownerKind: OwnerKind, ownerId: string): void {
  const me = requireHuman(ctx).userId;
  if (ownerKind === 'user' && ownerId === me) return;
  if (!scopeCan(ctx.scope, 'calendars.manage'))
    throw HfosError.forbidden(
      ownerKind === 'user'
        ? 'Only owners and admins change someone else’s hours.'
        : 'Only owners and admins change these hours.',
    );
}

async function ownerName(
  tx: Tx,
  workspaceId: string,
  kind: OwnerKind,
  id: string,
): Promise<string> {
  if (kind === 'user') {
    const [ok] = await rows<{ ok: boolean }>(
      tx,
      sql`select private.workspace_has_user(${workspaceId}, ${id}::uuid) as ok`,
    );
    if (!ok?.ok) throw HfosError.notFound('That person isn’t on this team.');
    return (await userNames(tx, [id])).get(id) ?? 'Someone';
  }
  if (kind === 'resource') {
    const [r] = await tx
      .select({ name: resources.name })
      .from(resources)
      .where(and(eq(resources.id, id), eq(resources.workspaceId, workspaceId)));
    if (!r) throw HfosError.notFound('Resource not found.');
    return r.name;
  }
  if (kind === 'service') {
    const [s] = await tx
      .select({ name: services.name })
      .from(services)
      .where(and(eq(services.id, id), eq(services.workspaceId, workspaceId)));
    if (!s) throw HfosError.notFound('Service not found.');
    return s.name;
  }
  return 'The calendar';
}

function ownerOf(ctx: CommandContext, kind: OwnerKind, ownerId: string | undefined): string {
  const id = ownerId ?? (kind === 'user' ? requireHuman(ctx).userId : undefined);
  if (!id)
    throw HfosError.validation([{ path: 'ownerId', message: 'Pick whose hours these are.' }]);
  return id;
}

const ownSchedule = (workspaceId: string, kind: OwnerKind, ownerId: string) =>
  and(
    eq(schedules.workspaceId, workspaceId),
    eq(schedules.ownerKind, kind),
    eq(schedules.ownerId, ownerId),
  )!;

export const scheduleSet = defineCommand({
  name: 'schedule.set',
  description:
    'Set weekly hours for yourself, or (owners and admins) for a teammate, resource or service.',
  risk: 1,
  input: ScheduleSetInput,
  output: ScheduleSetOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['schedule.updated'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const ownerId = ownerOf(ctx, input.ownerKind, input.ownerId);
    assertMayEditHours(ctx, input.ownerKind, ownerId);
    const name = await ownerName(ctx.tx, ws, input.ownerKind, ownerId);
    const [existing] = await ctx.tx
      .select()
      .from(schedules)
      .where(ownSchedule(ws, input.ownerKind, ownerId));
    let scheduleId: string;
    if (existing) {
      await ctx.tx
        .update(schedules)
        .set({
          weekly: input.weekly,
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        })
        .where(eq(schedules.id, existing.id));
      scheduleId = existing.id;
    } else {
      const [row] = await ctx.tx
        .insert(schedules)
        .values({
          workspaceId: ws,
          ownerKind: input.ownerKind,
          ownerId,
          timezone: input.timezone ?? null,
          weekly: input.weekly,
          createdBy: me,
        })
        .returning({ id: schedules.id });
      if (!row) throw HfosError.forbidden();
      scheduleId = row.id;
    }
    const was = existing
      ? formatHours(existing.weekly)
      : input.ownerKind === 'user'
        ? formatHours(DEFAULT_WEEKLY_HOURS)
        : 'always open';
    await ctx.emit({
      type: 'schedule.updated',
      entityType: 'schedule',
      entityId: scheduleId,
      payload: { ownerKind: input.ownerKind, ownerId },
      before: { owner: name, hours: was },
      after: {
        owner: name,
        hours: formatHours(input.weekly),
        ...(input.timezone !== undefined ? { timezone: input.timezone ?? 'workspace' } : {}),
      },
    });
    return { scheduleId };
  },
});

export const timeOffAdd = defineCommand({
  name: 'time_off.add',
  description:
    'Add time off (or extra open time) for yourself, or (owners and admins) a teammate, resource or service. All-day dates are read in the schedule’s zone.',
  risk: 1,
  input: TimeOffAddInput,
  output: TimeOffAddOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['time_off.added'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const ownerId = ownerOf(ctx, input.ownerKind, input.ownerId);
    assertMayEditHours(ctx, input.ownerKind, ownerId);
    const name = await ownerName(ctx.tx, ws, input.ownerKind, ownerId);
    let [schedule] = await ctx.tx
      .select({ id: schedules.id, timezone: schedules.timezone })
      .from(schedules)
      .where(ownSchedule(ws, input.ownerKind, ownerId));
    if (!schedule)
      // A person keeps the default weekdays 9 to 5; a resource or service stays open all week.
      [schedule] = await ctx.tx
        .insert(schedules)
        .values({
          workspaceId: ws,
          ownerKind: input.ownerKind,
          ownerId,
          weekly: input.ownerKind === 'user' ? DEFAULT_WEEKLY_HOURS : ALWAYS_OPEN_HOURS,
          createdBy: me,
        })
        .returning({ id: schedules.id, timezone: schedules.timezone });
    if (!schedule) throw HfosError.forbidden();
    let startsAt: number;
    let endsAt: number;
    const allDay = !!input.startDate;
    if (input.startDate) {
      const endDate = input.endDate ?? input.startDate;
      if (endDate < input.startDate)
        throw HfosError.validation([{ path: 'endDate', message: 'End on or after the start.' }]);
      const zone = schedule.timezone ?? (await workspaceZone(ctx.tx, ws));
      // Postgres converts the local dates in the schedule's zone (days of 23 or 25 hours included).
      const [r] = await rows<{ s: number; e: number }>(
        ctx.tx,
        sql`select round(extract(epoch from ((${input.startDate}::date)::timestamp at time zone ${zone})) * 1000)::float8 as s,
                   round(extract(epoch from (((${endDate}::date) + 1)::timestamp at time zone ${zone})) * 1000)::float8 as e`,
      );
      startsAt = r!.s;
      endsAt = r!.e;
    } else {
      startsAt = Date.parse(input.startsAt!);
      endsAt = Date.parse(input.endsAt!);
      if (endsAt <= startsAt)
        throw HfosError.validation([{ path: 'endsAt', message: 'End after the start.' }]);
    }
    const [row] = await ctx.tx
      .insert(scheduleExceptions)
      .values({
        workspaceId: ws,
        scheduleId: schedule.id,
        kind: input.kind,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        allDay,
        note: input.note ?? null,
        createdBy: me,
      })
      .returning({ id: scheduleExceptions.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'time_off.added',
      entityType: 'schedule',
      entityId: schedule.id,
      payload: { exceptionId: row.id, ownerKind: input.ownerKind, ownerId, kind: input.kind },
      after: {
        owner: name,
        kind: input.kind,
        startsAt: iso(startsAt),
        endsAt: iso(endsAt),
        allDay,
        note: input.note ?? null,
      },
    });
    return {
      exceptionId: row.id,
      scheduleId: schedule.id,
      startsAt: iso(startsAt),
      endsAt: iso(endsAt),
    };
  },
});

export const timeOffRemove = defineCommand({
  name: 'time_off.remove',
  description: 'Remove time off (or extra open time) from a schedule.',
  risk: 1,
  input: TimeOffRemoveInput,
  output: TimeOffRemoveOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['time_off.removed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [row] = await rows<{
      id: string;
      schedule_id: string;
      kind: string;
      all_day: boolean;
      s: number;
      e: number;
      owner_kind: OwnerKind;
      owner_id: string;
    }>(
      ctx.tx,
      sql`select e.id, e.schedule_id, e.kind::text as kind, e.all_day,
            round(extract(epoch from e.starts_at) * 1000)::float8 as s,
            round(extract(epoch from e.ends_at) * 1000)::float8 as e,
            s.owner_kind::text as owner_kind, s.owner_id
          from app.schedule_exceptions e join app.schedules s on s.id = e.schedule_id
          where e.id = ${input.exceptionId} and e.workspace_id = ${ws}`,
    );
    if (!row) throw HfosError.notFound('Time off not found.');
    assertMayEditHours(ctx, row.owner_kind, row.owner_id);
    const name = await ownerName(ctx.tx, ws, row.owner_kind, row.owner_id);
    await ctx.tx.delete(scheduleExceptions).where(eq(scheduleExceptions.id, row.id));
    await ctx.emit({
      type: 'time_off.removed',
      entityType: 'schedule',
      entityId: row.schedule_id,
      payload: { exceptionId: row.id, ownerKind: row.owner_kind, ownerId: row.owner_id },
      before: {
        owner: name,
        kind: row.kind,
        startsAt: iso(row.s),
        endsAt: iso(row.e),
        allDay: row.all_day,
      },
    });
    return { exceptionId: row.id };
  },
});
