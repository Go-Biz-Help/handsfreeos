import { and, eq } from 'drizzle-orm';
import { pipelineStages } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { StageUpdateInput, StageUpdateOutput } from '../schemas/pipeline';

export const stageUpdate = defineCommand({
  name: 'stage.update',
  description:
    'Rename a stage or change what it means (open, won or lost). Kind changes need an empty stage.',
  risk: 2,
  input: StageUpdateInput,
  output: StageUpdateOutput,
  permission: 'pipelines.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['stage.updated'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.id, input.stageId),
          eq(pipelineStages.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!current) throw HfosError.notFound('Stage not found.');
    const patch: { name?: string; kind?: 'open' | 'won' | 'lost' } = {};
    if (input.name !== undefined && input.name !== current.name) patch.name = input.name;
    if (input.kind !== undefined && input.kind !== current.kind) patch.kind = input.kind;
    const updated = Object.keys(patch);
    if (updated.length === 0) return { stageId: current.id, updated: [] };
    await ctx.tx.update(pipelineStages).set(patch).where(eq(pipelineStages.id, current.id));
    await ctx.emit({
      type: 'stage.updated',
      entityType: 'pipeline_stage',
      entityId: current.id,
      payload: { name: patch.name ?? current.name, fields: updated },
      before: { name: current.name, kind: current.kind },
      after: { name: patch.name ?? current.name, kind: patch.kind ?? current.kind },
    });
    return { stageId: current.id, updated };
  },
});
