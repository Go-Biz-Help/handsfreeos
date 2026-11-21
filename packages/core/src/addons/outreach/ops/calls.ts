/**
 * Networking calls (docs/outreach.md, decision 187; ../calls.ts): the worker notes a call it found on a booking
 * (`outreach.call.note`) and keeps the prep note it pushed before it (`outreach.call.prepped`). Today's thank-you after
 * one is listed with the day's follow-ups (./today.ts), and Today's line and Monday's push count them
 * (`oneOnOnesOf`).
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand } from '../../server';
import {
  CALL_WEEKS_BACK,
  CallNoteInput,
  CallNoteOutput,
  CallPreppedInput,
  CallPreppedOutput,
} from '../calls';
import { outreachAddon } from '../manifest';
import { calls, profiles } from '../tables';
import { inWorkspace } from './common';

/** The person's networking calls by week, as Today's line and Monday's push count them. */
export interface CallWeeks {
  /** This week so far, from Monday in the business's time zone. */
  readonly week: number;
  readonly lastWeek: number;
  /** The week before last. */
  readonly before: number;
  /** Any in the weeks before last week, back to `CALL_WEEKS_BACK`. */
  readonly earlier: number;
  /** They picked a Networking calendar (decision 178). */
  readonly picked: boolean;
}

/**
 * The person's 1-on-1s (decision 187, the owner's 6a): networking calls noted for them, and anything on their own
 * Networking calendar they hosted, that weren't cancelled or missed and have started. Weeks start on Monday in the
 * business's time zone.
 */
export async function oneOnOnesOf(
  tx: Tx,
  workspaceId: string,
  userId: string,
  now: Date,
): Promise<CallWeeks> {
  const at = now.toISOString();
  const [row] = await rows<{
    week: number;
    last_week: number;
    before: number;
    earlier: number;
    picked: boolean;
  }>(
    tx,
    sql`with z as (
          select coalesce((select w.timezone from app.workspaces w where w.id = ${workspaceId}), 'America/Chicago') as tz
        ), b as (
          select (date_trunc('week', ${at}::timestamptz at time zone z.tz) at time zone z.tz) as week_start,
            ((date_trunc('week', ${at}::timestamptz at time zone z.tz) - interval '7 days') at time zone z.tz) as last_start,
            ((date_trunc('week', ${at}::timestamptz at time zone z.tz) - interval '14 days') at time zone z.tz) as before_start,
            ((date_trunc('week', ${at}::timestamptz at time zone z.tz)
              - make_interval(days => 7 * ${CALL_WEEKS_BACK}::int)) at time zone z.tz) as back_start
          from z
        ), mine as (
          select au.networking_calendar_id as calendar_id from addon_outreach.automation au
          where au.workspace_id = ${workspaceId} and au.user_id = ${userId}
        )
        select count(a.id) filter (where a.starts_at >= b.week_start)::int as week,
          count(a.id) filter (where a.starts_at >= b.last_start and a.starts_at < b.week_start)::int as last_week,
          count(a.id) filter (where a.starts_at >= b.before_start and a.starts_at < b.last_start)::int as before,
          count(a.id) filter (where a.starts_at < b.last_start)::int as earlier,
          coalesce((select calendar_id is not null from mine), false) as picked
        from b
        left join app.appointments a on a.workspace_id = ${workspaceId} and a.bin_item_id is null
          and a.status in ('scheduled', 'completed')
          and a.starts_at >= b.back_start and a.starts_at <= ${at}::timestamptz
          and (exists (select 1 from addon_outreach.calls c
                where c.workspace_id = ${workspaceId} and c.appointment_id = a.id and c.user_id = ${userId})
            or (a.calendar_id = (select calendar_id from mine)
              and exists (select 1 from app.appointment_staff s
                where s.appointment_id = a.id and s.user_id = ${userId} and s.role = 'host' and s.active)))
        group by b.week_start`,
  );
  return {
    week: row?.week ?? 0,
    lastWeek: row?.last_week ?? 0,
    before: row?.before ?? 0,
    earlier: row?.earlier ?? 0,
    picked: row?.picked ?? false,
  };
}

/** Today's line shows once the person has a Networking calendar or a networking call lately. */
export const oneOnOnesShown = (w: CallWeeks): boolean =>
  w.picked || w.week > 0 || w.lastWeek > 0 || w.earlier > 0;

export const callNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.call.note',
  description:
    'Worker: someone booked a networking call with a person on the team, through their networking call link or on their Networking calendar under the name of someone they chat with. It’s kept once a booking, for the prep push before it and the thank-you after.',
  risk: 0,
  input: CallNoteInput,
  output: CallNoteOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.call.noted'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [profile] = await ctx.tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, input.profileId)));
    // Whoever it's with still does outreach here, and the booking is still there.
    const [found] = await rows<{ ok: boolean; starts_at: Date | string | null }>(
      ctx.tx,
      sql`select true as ok,
            (select a.starts_at from app.appointments a
              where a.workspace_id = ${ws} and a.id = ${input.appointmentId} and a.bin_item_id is null) as starts_at
          from app.workspace_access
          where workspace_id = ${ws} and user_id = ${input.userId} and 'outreach.use' = any (permissions)`,
    );
    if (!profile || !found?.starts_at) return { callId: null, startsAt: null };
    const startsAt = new Date(found.starts_at).toISOString();
    const [made] = await ctx.tx
      .insert(calls)
      .values({
        workspaceId: ws,
        userId: input.userId,
        profileId: profile.id,
        appointmentId: input.appointmentId,
        personId: input.personId,
        how: input.how,
      })
      .onConflictDoNothing()
      .returning({ id: calls.id });
    if (!made) {
      const [had] = await ctx.tx
        .select({ id: calls.id })
        .from(calls)
        .where(
          and(
            eq(calls.workspaceId, ws),
            eq(calls.appointmentId, input.appointmentId),
            eq(calls.userId, input.userId),
          ),
        );
      return { callId: had?.id ?? null, startsAt };
    }
    await ctx.emit({
      type: 'outreach.call.noted',
      entityType: 'outreach_profile',
      entityId: profile.id,
      payload: {
        userId: input.userId,
        appointmentId: input.appointmentId,
        callId: made.id,
        how: input.how,
      },
    });
    return { callId: made.id, startsAt };
  },
});

export const callPrepped = defineAddonCommand(outreachAddon, {
  name: 'outreach.call.prepped',
  description:
    'Worker: the prep note pushed to the person half an hour before a networking call, kept with the call’s time then.',
  risk: 0,
  input: CallPreppedInput,
  output: CallPreppedOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.call.prepped'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [row] = await ctx.tx
      .update(calls)
      .set({ prep: input.prep, preppedAt: at, preppedFor: new Date(input.for), updatedAt: at })
      .where(and(eq(calls.workspaceId, ws), eq(calls.id, input.callId)))
      .returning({ id: calls.id, profileId: calls.profileId, userId: calls.userId });
    if (!row) return { saved: false };
    await ctx.emit({
      type: 'outreach.call.prepped',
      entityType: 'outreach_profile',
      entityId: row.profileId,
      payload: { userId: row.userId, callId: row.id },
    });
    return { saved: true };
  },
});

export const callCommands = [callNote, callPrepped] as const;
