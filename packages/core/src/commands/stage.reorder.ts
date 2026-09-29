import { and, eq } from 'drizzle-orm';
import { pipelines, pipelineStages } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { StageReorderInput, StageReorderOutput } from '../schemas/pipeline';

export const stageReorder = defineCommand({
  name: 'stage.reorder',
  description: 'Set the order of every stage in a pipeline.',
  risk: 1,
  input: StageReorderInput,
  output: StageReorderOutput,
  permission: 'pipelines.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['stage.reordered'],
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
    const current = await ctx.tx
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        position: pipelineStages.position,
      })
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipeline.id))
      .orderBy(pipelineStages.position);
    const ids = new Set(current.map((s) => s.id));
    if (
      input.stageIds.length !== ids.size ||
      input.stageIds.some((id) => !ids.has(id)) ||
      new Set(input.stageIds).size !== input.stageIds.length
    )
      throw HfosError.validation([
        { path: 'stageIds', message: 'List every stage of the pipeline exactly once.' },
      ]);
    for (const [index, id] of input.stageIds.entries()) {
      await ctx.tx
        .update(pipelineStages)
        .set({ position: index + 1 })
        .where(eq(pipelineStages.id, id));
    }
    const nameOf = new Map(current.map((s) => [s.id, s.name]));
    await ctx.emit({
      type: 'stage.reordered',
      entityType: 'pipeline',
      entityId: pipeline.id,
      payload: { name: pipeline.name },
      before: { order: current.map((s) => s.name) },
      after: { order: input.stageIds.map((id) => nameOf.get(id)) },
    });
    return { pipelineId: pipeline.id, order: input.stageIds };
  },
});
