import { and, count, eq, max } from 'drizzle-orm';
import { leads, pipelineStages } from '@hfos/db/schema';
import { POSITION_GAP } from '../crm/positions';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { StageDeleteInput, StageDeleteOutput } from '../schemas/pipeline';

export const stageDelete = defineCommand({
  name: 'stage.delete',
  description: 'Delete a stage. Leads in it move to another stage of the same kind.',
  risk: 3,
  input: StageDeleteInput,
  output: StageDeleteOutput,
  permission: 'pipelines.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['stage.deleted'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [stage] = await ctx.tx
      .select()
      .from(pipelineStages)
      .where(
        and(eq(pipelineStages.id, input.stageId), eq(pipelineStages.workspaceId, workspaceId)),
      );
    if (!stage) throw HfosError.notFound('Stage not found.');
    const [inStage] = await ctx.tx
      .select({ n: count() })
      .from(leads)
      .where(eq(leads.stageId, stage.id));
    const leadCount = Number(inStage?.n ?? 0);
    let moved = 0;
    if (leadCount > 0) {
      if (!input.moveLeadsToStageId)
        throw HfosError.rule('stage_has_leads', 409, 'Pick a stage to move the leads to first.');
      const [target] = await ctx.tx
        .select()
        .from(pipelineStages)
        .where(
          and(
            eq(pipelineStages.id, input.moveLeadsToStageId),
            eq(pipelineStages.pipelineId, stage.pipelineId),
          ),
        );
      if (!target || target.id === stage.id) throw HfosError.notFound('Target stage not found.');
      if (target.kind !== stage.kind)
        throw HfosError.validation([
          {
            path: 'moveLeadsToStageId',
            message: `Leads can only move to another ${stage.kind} stage.`,
          },
        ]);
      const [last] = await ctx.tx
        .select({ m: max(leads.position) })
        .from(leads)
        .where(eq(leads.stageId, target.id));
      const offset = Number(last?.m ?? 0) + POSITION_GAP;
      const movedRows = await ctx.tx
        .update(leads)
        .set({ stageId: target.id, position: offset })
        .where(eq(leads.stageId, stage.id))
        .returning({ id: leads.id });
      moved = movedRows.length;
    }
    await ctx.tx.delete(pipelineStages).where(eq(pipelineStages.id, stage.id));
    await ctx.emit({
      type: 'stage.deleted',
      entityType: 'pipeline_stage',
      entityId: stage.id,
      payload: { name: stage.name, movedLeads: moved },
      before: { name: stage.name, kind: stage.kind },
      after: null,
    });
    return { stageId: stage.id, movedLeads: moved };
  },
});
