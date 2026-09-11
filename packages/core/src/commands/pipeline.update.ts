import { and, eq } from 'drizzle-orm';
import { pipelines } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { PipelineUpdateInput, PipelineUpdateOutput } from '../schemas/pipeline';

export const pipelineUpdate = defineCommand({
  name: 'pipeline.update',
  description: 'Rename or reorder a pipeline.',
  risk: 1,
  input: PipelineUpdateInput,
  output: PipelineUpdateOutput,
  permission: 'pipelines.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['pipeline.updated'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(pipelines)
      .where(
        and(eq(pipelines.id, input.pipelineId), eq(pipelines.workspaceId, ctx.scope.workspaceId!)),
      );
    if (!current) throw HfosError.notFound('Pipeline not found.');
    const patch: { name?: string; position?: number } = {};
    if (input.name !== undefined && input.name !== current.name) patch.name = input.name;
    if (input.position !== undefined && input.position !== current.position)
      patch.position = input.position;
    const updated = Object.keys(patch);
    if (updated.length === 0) return { pipelineId: current.id, updated: [] };
    await ctx.tx.update(pipelines).set(patch).where(eq(pipelines.id, current.id));
    await ctx.emit({
      type: 'pipeline.updated',
      entityType: 'pipeline',
      entityId: current.id,
      payload: { name: patch.name ?? current.name, fields: updated },
      before: { name: current.name, position: current.position },
      after: { name: patch.name ?? current.name, position: patch.position ?? current.position },
    });
    return { pipelineId: current.id, updated };
  },
});
