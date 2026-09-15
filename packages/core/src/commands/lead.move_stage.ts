import { and, eq } from 'drizzle-orm';
import { leads, pipelineStages } from '@hfos/db/schema';
import { assertAiReach } from '../ai-team/reach';
import { logSystemActivity } from '../crm/activities';
import { placeInStage } from '../crm/positions';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
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
  actors: ['human', 'workflow', 'ai_employee'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, workspaceId)));
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
    // The AI teammate moves its customer's open lead between open stages; winning or losing it is a person's call.
    if (ctx.actor.type === 'ai_employee') {
      if (to.kind !== 'open' || current.status !== 'open')
        throw HfosError.rule(
          'stage_not_open',
          409,
          'The AI teammate only moves an open lead between open stages.',
        );
      await assertAiReach(ctx, { leadId: current.id });
    }
    if (to.kind === 'lost' && !input.lostReason)
      throw HfosError.validation([
        { path: 'lostReason', message: 'Add a reason to mark this lead lost.' },
      ]);
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
        body: row.status === 'lost' ? `Lost: ${row.lostReason ?? ''}` : `${from.name} → ${to.name}`,
        meta: { from: from.name, to: to.name, status: row.status, title: current.title },
        eventId,
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
