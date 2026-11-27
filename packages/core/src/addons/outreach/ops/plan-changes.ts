/**
 * What a person changed on today's plan on a network, as kept (../plan-changes.ts, decision 195 step 3): read by the
 * plan (./plan.ts) and by today's list as the extension is given it (./today.ts), so it sits apart from both.
 * Server-only.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Platform } from '../networks';
import type { PlanChange } from '../plan-changes';
import { planChanges } from '../tables';
import type { Ctx } from './common';

/** A change as kept: with its row, and what the plan's row said. */
export interface KeptChange extends PlanChange {
  readonly id: string;
  readonly title: string;
}

/** The person's changes to today's plan on a network, the earliest first. An earlier day's count for nothing. */
export async function changesOf(
  ctx: Ctx,
  me: string,
  platform: Platform,
  today: string,
): Promise<KeptChange[]> {
  const found = await ctx.tx
    .select({
      id: planChanges.id,
      key: planChanges.key,
      change: planChanges.change,
      at: planChanges.at,
      title: planChanges.title,
      madeAt: planChanges.madeAt,
    })
    .from(planChanges)
    .where(
      and(
        eq(planChanges.workspaceId, ctx.scope.workspaceId!),
        eq(planChanges.userId, me),
        eq(planChanges.platform, platform),
        eq(planChanges.day, today),
      ),
    )
    .orderBy(asc(planChanges.madeAt), asc(planChanges.id));
  return found.map((row) => ({
    id: row.id,
    key: row.key,
    change: row.change,
    at: row.at ? row.at.getTime() : null,
    made: row.madeAt.getTime(),
    title: row.title,
  }));
}
