/**
 * The person's day as HandsFreeOS keeps it, and the feed's lines HandsFreeOS writes itself (../live.ts, decision 41):
 * shared by the live operations (./live.ts) and the warning note (./tidy.ts). Server-only.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { workspaceTimezone } from '../../../crm/records';
import { businessDay } from '../automation';
import {
  clipLine,
  warningLine,
  type DayState,
  type DayVia,
  type LiveDay,
  type StepKind,
} from '../live';
import { days, liveSteps } from '../tables';
import type { Ctx } from './common';

/** The business's day now, and its time zone. */
export async function businessToday(
  ctx: Ctx,
  now = Date.now(),
): Promise<{ today: string; timezone: string }> {
  const timezone = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
  return { today: businessDay(now, timezone), timezone };
}

/** The person's day as kept: nothing pressed today when the row is for an earlier day, or there's none. */
export async function dayOf(ctx: Ctx, userId: string, today: string): Promise<LiveDay> {
  const [row] = await ctx.tx
    .select()
    .from(days)
    .where(and(eq(days.workspaceId, ctx.scope.workspaceId!), eq(days.userId, userId)));
  return dayShown(row, today);
}

export function dayShown(row: typeof days.$inferSelect | undefined, today: string): LiveDay {
  if (!row || row.day !== today)
    return { date: today, state: 'none', why: null, via: null, at: null };
  return {
    date: today,
    state: row.state,
    why: row.why ?? null,
    via: row.via,
    at: row.changedAt.toISOString(),
  };
}

/** A line in the person's feed that HandsFreeOS writes: a day pressed, or a warning. */
export async function writeLine(
  ctx: Ctx,
  userId: string,
  at: Date,
  kind: Extract<StepKind, 'day' | 'stopped'>,
  line: string,
): Promise<void> {
  await ctx.tx.insert(liveSteps).values({
    workspaceId: ctx.scope.workspaceId!,
    userId,
    computerId: null,
    at,
    kind,
    line: clipLine(line),
  });
}

/**
 * Started or stopped, pressed at `at`. Only a change is kept: a press for another day than today, one older than the
 * last press today, one that changes nothing, or any press on a day stopped for a warning, leaves the day as it is.
 * Whether the day changed.
 */
export async function keepDay(
  ctx: Ctx,
  userId: string,
  input: { today: string; state: DayState; via: DayVia; at: Date },
): Promise<boolean> {
  const why = input.state === 'stopped' ? 'person' : null;
  const changed = await rows<{ id: string }>(
    ctx.tx,
    sql`insert into addon_outreach.days as d (workspace_id, user_id, day, state, why, via, changed_at)
        values (${ctx.scope.workspaceId!}, ${userId}, ${input.today}::date, ${input.state}, ${why},
          ${input.via}, ${input.at.toISOString()}::timestamptz)
        on conflict (workspace_id, user_id) do update
          set day = excluded.day, state = excluded.state, why = excluded.why, via = excluded.via,
            changed_at = excluded.changed_at
          where d.day < excluded.day
            or (d.day = excluded.day and d.changed_at <= excluded.changed_at
              and d.why is distinct from 'warning'
              and (d.state, d.why) is distinct from (excluded.state, excluded.why))
        returning d.id`,
  );
  return changed.length > 0;
}

/**
 * A Facebook warning stops the person's day, whatever was pressed and whenever (decision 25): a Start pressed after
 * the moment the warning was seen doesn't undo it. Only a warning from an earlier day than the kept one leaves it be.
 * Writes the feed's line for it.
 */
export async function warnDay(
  ctx: Ctx,
  userId: string,
  at: Date,
  words: string,
  timezone: string,
): Promise<void> {
  const day = businessDay(at.getTime(), timezone);
  await rows(
    ctx.tx,
    sql`insert into addon_outreach.days as d (workspace_id, user_id, day, state, why, via, changed_at)
        values (${ctx.scope.workspaceId!}, ${userId}, ${day}::date, 'stopped', 'warning', 'extension',
          ${at.toISOString()}::timestamptz)
        on conflict (workspace_id, user_id) do update
          set day = excluded.day, state = 'stopped', why = 'warning', via = excluded.via,
            changed_at = case when d.day = excluded.day then greatest(d.changed_at, excluded.changed_at)
              else excluded.changed_at end
          where d.day <= excluded.day`,
  );
  await writeLine(ctx, userId, at, 'stopped', warningLine(words));
}
