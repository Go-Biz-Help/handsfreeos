import { and, count, eq, isNull } from 'drizzle-orm';
import { pipelines, pipelineStages } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { PipelineCreateInput, PipelineCreateOutput } from '../schemas/pipeline';

export const DEFAULT_STAGES = [
  { name: 'New', kind: 'open' },
  { name: 'Contacted', kind: 'open' },
  { name: 'Estimate sent', kind: 'open' },
  { name: 'Won', kind: 'won' },
  { name: 'Lost', kind: 'lost' },
] as const;

export const pipelineCreate = defineCommand({
  name: 'pipeline.create',
  description:
    'Add a pipeline with its stages (the default template is New, Contacted, Estimate sent, Won, Lost).',
  risk: 2,
  input: PipelineCreateInput,
  output: PipelineCreateOutput,
  permission: 'pipelines.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['pipeline.created'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const stages = input.stages ?? DEFAULT_STAGES;
    for (const kind of ['open', 'won', 'lost'] as const) {
      if (!stages.some((s) => s.kind === kind))
        throw HfosError.validation([
          { path: 'stages', message: `Add at least one ${kind} stage.` },
        ]);
    }
    const names = new Set(stages.map((s) => s.name.toLowerCase()));
    if (names.size !== stages.length)
      throw HfosError.validation([{ path: 'stages', message: 'Stage names must be unique.' }]);
    const [existing] = await ctx.tx
      .select({ n: count() })
      .from(pipelines)
      .where(and(eq(pipelines.workspaceId, workspaceId), isNull(pipelines.archivedAt)));
    const [row] = await ctx.tx
      .insert(pipelines)
      .values({
        workspaceId,
        name: input.name,
        position: Number(existing?.n ?? 0),
        createdBy: userIdOf(ctx.actor),
      })
      .returning({ id: pipelines.id, name: pipelines.name });
    if (!row) throw HfosError.forbidden();
    await ctx.tx.insert(pipelineStages).values(
      stages.map((s, i) => ({
        workspaceId,
        pipelineId: row.id,
        name: s.name,
        kind: s.kind,
        position: i + 1,
      })),
    );
    await ctx.emit({
      type: 'pipeline.created',
      entityType: 'pipeline',
      entityId: row.id,
      payload: { name: row.name, stages: stages.map((s) => s.name) },
      after: { name: row.name, stages: stages.map((s) => `${s.name} (${s.kind})`) },
    });
    return { pipelineId: row.id };
  },
});
