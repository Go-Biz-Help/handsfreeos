import { and, eq } from 'drizzle-orm';
import { leads, pipelineStages } from '@hfos/db/schema';
import { assertAiReach, teammateDealsOn } from '../ai-team/reach';
import { logSystemActivity } from '../crm/activities';
import { placeInStage } from '../crm/positions';
import { HfosError } from '../errors';
import { aiEmployeeOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changedSince, logLaterChange, whoChangedIt } from '../kernel/later-change';
import { LeadMoveStageInput, LeadMoveStageOutput } from '../schemas/lead';

export const leadMoveStage = defineCommand({
  name: 'lead.move_stage',
  description:
    'Move a lead to another stage of its pipeline (and to a spot within it). A lost stage needs a reason.',
  risk: 1,
  input: LeadMoveStageInput,
  output: LeadMoveStageOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['lead.stage_changed', 'lead.won', 'lead.lost', 'lead.reopened'],
  // HandsFreeOS itself: Automations' "Move deals along for you" (forward only, with its reason).
  actors: ['human', 'workflow', 'ai_employee', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, workspaceId)))
      .for('update');
    if (!current) throw HfosError.notFound('Lead not found.');
    if (current.archivedAt)
      throw HfosError.rule('lead_archived', 409, 'Restore the lead before moving it.');
    const [from] = await ctx.tx
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.id, current.stageId));
    const [to] = await ctx.tx
      .select()
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.id, input.stageId),
          eq(pipelineStages.pipelineId, current.pipelineId),
        ),
      );
    if (!from || !to) throw HfosError.notFound('Stage not found.');
    // The AI teammate moves its customer's open lead between open stages. Winning or losing it is a person's call,
    // unless the teammate's settings let it handle deals (M18); reopening one always is.
    const ai = aiEmployeeOf(ctx.actor);
    if (ai) {
      if (current.status !== 'open' || (to.kind !== 'open' && !(await teammateDealsOn(ctx.tx, ai))))
        throw HfosError.rule(
          'stage_not_open',
          409,
          'The AI teammate only moves an open lead between open stages.',
        );
      await assertAiReach(ctx, { leadId: current.id });
    }
    // A phone moves a lead between stages, never within one: already there (moved twice, or on two phones),
    // nothing changes. On the web, leaving out the place still means the bottom of the stage.
    if (ctx.meta.channel === 'mobile' && from.id === to.id && input.afterLeadId === undefined)
      return {
        leadId: current.id,
        stageId: to.id,
        status: current.status,
        position: Number(current.position),
      };
    if (input.because && ctx.actor.type !== 'system')
      throw HfosError.validation([
        { path: 'because', message: 'Only HandsFreeOS gives a reason for its own moves.' },
      ]);
    // HandsFreeOS only ever moves a deal forward, and never out of won or lost.
    if (
      ctx.actor.type === 'system' &&
      (current.status !== 'open' ||
        to.kind === 'lost' ||
        (to.kind === 'open' && to.position <= from.position))
    )
      throw HfosError.rule('forward_only', 409, 'HandsFreeOS only moves an open deal forward.');
    if (to.kind === 'lost' && !input.lostReason)
      throw HfosError.validation([
        { path: 'lostReason', message: 'Add a reason to mark this lead lost.' },
      ]);
    // Someone moved the lead after this move was made (on a phone, perhaps long before it had signal): their move
    // stands, and the timeline says so.
    if (from.id !== to.id && changedSince(ctx.meta, current.stageEnteredAt)) {
      const lead = { type: 'lead', id: current.id };
      const who = await whoChangedIt(ctx.tx, lead, ['lead.stage_changed'], current.stageEnteredAt);
      await logLaterChange(
        ctx,
        {
          key: 'stageId',
          tried: `move ${current.title} to ${to.name}`,
          because: `${who ? `${who} moved it` : 'it was moved'} to ${from.name} after that`,
          changedAt: current.stageEnteredAt,
        },
        lead,
        { leadId: current.id, personId: current.personId, companyId: current.companyId },
      );
      return {
        leadId: current.id,
        stageId: from.id,
        status: current.status,
        position: Number(current.position),
        notApplied: ['stageId'],
      };
    }
    const position = await placeInStage(ctx.tx, to.id, input.afterLeadId, current.id);
    const [row] = await ctx.tx
      .update(leads)
      .set({
        stageId: to.id,
        position,
        lostReason: to.kind === 'lost' ? (input.lostReason ?? current.lostReason) : null,
      })
      .where(eq(leads.id, current.id))
      .returning({
        status: leads.status,
        position: leads.position,
        stageEnteredAt: leads.stageEnteredAt,
        wonAt: leads.wonAt,
        lostAt: leads.lostAt,
        lostReason: leads.lostReason,
      });
    if (!row) throw HfosError.forbidden();
    const stageChanged = from.id !== to.id;
    let eventId: string | null = null;
    if (stageChanged) {
      eventId = await ctx.emit({
        type: 'lead.stage_changed',
        entityType: 'lead',
        entityId: current.id,
        payload: {
          title: current.title,
          from: from.name,
          to: to.name,
          fromStageId: from.id,
          toStageId: to.id,
        },
        before: { title: current.title, stage: from.name, status: current.status },
        after: { title: current.title, stage: to.name, status: row.status },
      });
      if (row.status !== current.status) {
        const type =
          row.status === 'won' ? 'lead.won' : row.status === 'lost' ? 'lead.lost' : 'lead.reopened';
        await ctx.emit({
          type,
          entityType: 'lead',
          entityId: current.id,
          payload: {
            title: current.title,
            valueCents: current.valueCents,
            ...(row.status === 'lost' ? { reason: row.lostReason } : {}),
          },
          before: { status: current.status },
          after: {
            status: row.status,
            ...(row.status === 'lost' ? { reason: row.lostReason } : {}),
          },
          broadcast: false,
        });
      }
      await logSystemActivity(ctx, {
        subtype:
          row.status !== current.status
            ? row.status === 'won'
              ? 'won'
              : row.status === 'lost'
                ? 'lost'
                : 'reopened'
            : 'stage_changed',
        leadId: current.id,
        personId: current.personId,
        companyId: current.companyId,
        body:
          row.status === 'lost'
            ? `Lost: ${row.lostReason ?? ''}`
            : `${from.name} → ${to.name}${input.because ? ` (${input.because})` : ''}`,
        meta: {
          from: from.name,
          to: to.name,
          status: row.status,
          title: current.title,
          ...(input.because ? { because: input.because } : {}),
        },
        eventId,
        // When the lead entered the stage, as the database stamped it: when the person moved it (on a phone, perhaps
        // well before it had signal), or when the move arrived if someone else moved the lead in the meantime.
        occurredAt: row.stageEnteredAt,
      });
    }
    return {
      leadId: current.id,
      stageId: to.id,
      status: row.status,
      position: Number(row.position),
    };
  },
});
