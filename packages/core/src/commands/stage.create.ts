import { and, eq, gt, max, sql } from 'drizzle-orm';
import { pipelines, pipelineStages } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { StageCreateInput, StageCreateOutput } from '../schemas/pipeline';

export const stageCreate = defineCommand({
  name: 'stage.create',
  description: 'Add a stage to a pipeline, at the end or right after another stage.',
  risk: 2,
  input: StageCreateInput,
  output: StageCreateOutput,
  permission: 'pipelines.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['stage.created'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [pipeline] = await ctx.tx
      .select({ id: pipelines.id, name: pipelines.name })
      .from(pipelines)
      .where(and(eq(pipelines.id, input.pipelineId), eq(pipelines.workspaceId, workspaceId)));
    if (!pipeline)
      throw HfosError.notFound(
        'That pipeline isn’t there anymore. Refresh Settings → Pipelines and try again.',
      );
    let position: number;
    if (input.afterStageId) {
      const [after] = await ctx.tx
        .select({ position: pipelineStages.position })
        .from(pipelineStages)
        .where(
          and(
            eq(pipelineStages.id, input.afterStageId),
            eq(pipelineStages.pipelineId, pipeline.id),
          ),
        );
      if (!after)
        throw HfosError.notFound(
          'The stage to add this after isn’t there anymore. It may have been deleted. Refresh and try again.',
        );
      await ctx.tx
        .update(pipelineStages)
        .set({ position: sql`${pipelineStages.position} + 1` })
        .where(
          and(
            eq(pipelineStages.pipelineId, pipeline.id),
            gt(pipelineStages.position, after.position),
          ),
        );
      position = after.position + 1;
    } else {
      const [last] = await ctx.tx
        .select({ m: max(pipelineStages.position) })
        .from(pipelineStages)
        .where(eq(pipelineStages.pipelineId, pipeline.id));
      position = Number(last?.m ?? 0) + 1;
    }
    const [row] = await ctx.tx
      .insert(pipelineStages)
      .values({
        workspaceId,
        pipelineId: pipeline.id,
        name: input.name,
        kind: input.kind,
        position,
      })
      .returning({ id: pipelineStages.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'stage.created',
      entityType: 'pipeline_stage',
      entityId: row.id,
      payload: { name: input.name, kind: input.kind, pipeline: pipeline.name },
      after: { name: input.name, kind: input.kind, position, pipeline: pipeline.name },
    });
    return { stageId: row.id };
  },
});
