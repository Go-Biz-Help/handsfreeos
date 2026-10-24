/**
 * The pipeline is the truth: a lead's stage is its person's stage in the funnel. lead.move_stage calls
 * `funnelFollowsLead` whoever moved it (a person on the board, the funnel's own rules, the teammate), so a move
 * starts that stage's messages, and a won or lost stage ends the funnel for them. Server side, in the mover's
 * transaction.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { funnelPeople, funnels } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import type { CommandContext } from '../kernel/types';
import type { FunnelLeftReason } from './definition';
import { definitionOf, type FunnelPersonRow, type FunnelRow } from './load';

/** The events lead.move_stage may emit through this, for its `emits`. */
export const FUNNEL_FOLLOW_EVENTS = ['funnel.stage_reached', 'funnel.person_left'] as const;

/** Takes the person out of their funnel, says so on their timeline, and tells the worker. */
export async function leaveFunnel(
  ctx: CommandContext,
  row: FunnelPersonRow,
  funnel: Pick<FunnelRow, 'id' | 'name'>,
  reason: FunnelLeftReason,
  /** The won or lost stage that ended it, kept as where they finished. */
  endedAt?: string,
): Promise<void> {
  await ctx.tx
    .update(funnelPeople)
    .set({
      status: 'left',
      leftReason: reason,
      leftAt: new Date(),
      pausedReason: null,
      ...(endedAt ? { stageId: endedAt } : {}),
    })
    .where(eq(funnelPeople.id, row.id));
  const eventId = await ctx.emit({
    type: 'funnel.person_left',
    entityType: 'funnel',
    entityId: funnel.id,
    payload: {
      funnelId: funnel.id,
      funnelPersonId: row.id,
      personId: row.personId,
      leadId: row.leadId,
      stageId: endedAt ?? row.stageId,
      reason,
    },
    after: { funnel: funnel.name, reason },
    broadcast: false,
  });
  await logSystemActivity(ctx, {
    subtype: 'funnel_left',
    personId: row.personId,
    leadId: row.leadId,
    body: funnel.name,
    meta: { funnel: funnel.name, funnelId: funnel.id, reason },
    eventId,
  });
}

/**
 * A lead moved to `to`: its person's funnel row follows. An open stage in the funnel starts afresh (what they've
 * done and been sent is per stage); a won or lost stage, or one the funnel doesn't have, ends it for them.
 */
export async function funnelFollowsLead(
  ctx: CommandContext,
  leadId: string,
  to: { readonly id: string; readonly name: string; readonly kind: 'open' | 'won' | 'lost' },
  fromStageId: string,
): Promise<void> {
  const [row] = await ctx.tx
    .select()
    .from(funnelPeople)
    .where(and(eq(funnelPeople.leadId, leadId), inArray(funnelPeople.status, ['active', 'paused'])))
    .for('update');
  if (!row || row.stageId === to.id) return;
  const [funnel] = await ctx.tx.select().from(funnels).where(eq(funnels.id, row.funnelId));
  if (!funnel) return;
  if (to.kind !== 'open')
    return leaveFunnel(ctx, row, funnel, to.kind === 'won' ? 'won' : 'lost', to.id);
  const def = definitionOf(funnel);
  if (!def.stages.some((s) => s.stageId === to.id)) return leaveFunnel(ctx, row, funnel, 'outside');
  await ctx.tx
    .update(funnelPeople)
    .set({ stageId: to.id, stageReachedAt: new Date(), seen: [], sent: [] })
    .where(eq(funnelPeople.id, row.id));
  await ctx.emit({
    type: 'funnel.stage_reached',
    entityType: 'funnel',
    entityId: funnel.id,
    payload: {
      funnelId: funnel.id,
      funnelPersonId: row.id,
      personId: row.personId,
      leadId,
      stageId: to.id,
      fromStageId,
    },
    after: { funnel: funnel.name, stage: to.name },
    broadcast: false,
  });
}

/**
 * Whether a machine's move of this lead is the funnel's own: the funnel runs on the lead's pipeline and has the
 * stage. Such a move may go back, or to a won or lost stage, because a person wrote the rule.
 */
export async function funnelMoveAllowed(
  ctx: CommandContext,
  funnelId: string,
  lead: { readonly pipelineId: string },
  toStageId: string,
): Promise<boolean> {
  const [funnel] = await ctx.tx
    .select()
    .from(funnels)
    .where(and(eq(funnels.id, funnelId), eq(funnels.workspaceId, ctx.scope.workspaceId!)));
  if (!funnel || funnel.status === 'archived' || funnel.pipelineId !== lead.pipelineId)
    return false;
  return definitionOf(funnel).stages.some((s) => s.stageId === toStageId);
}
