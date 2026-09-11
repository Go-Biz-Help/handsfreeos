import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { leads, pipelines, pipelineStages } from '@hfos/db/schema';
import { defineQuery } from '../kernel/define';
import { PipelineListInput, PipelineListOutput } from '../schemas/pipeline';

export const pipelineList = defineQuery({
  name: 'pipeline.list',
  description: 'The workspace’s pipelines with their stages and how many leads sit in each.',
  input: PipelineListInput,
  output: PipelineListOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const conditions = [eq(pipelines.workspaceId, input.workspaceId)];
    if (!input.includeArchived) conditions.push(isNull(pipelines.archivedAt));
    const list = await ctx.tx
      .select()
      .from(pipelines)
      .where(and(...conditions))
      .orderBy(asc(pipelines.position), asc(pipelines.createdAt));
    const stages = await ctx.tx
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.workspaceId, input.workspaceId))
      .orderBy(asc(pipelineStages.position));
    const counts = await ctx.tx
      .select({ stageId: leads.stageId, n: count() })
      .from(leads)
      .where(and(eq(leads.workspaceId, input.workspaceId), isNull(leads.archivedAt)))
      .groupBy(leads.stageId);
    const countOf = new Map(counts.map((c) => [c.stageId, Number(c.n)]));
    const firstActive = list.find((p) => !p.archivedAt);
    return {
      pipelines: list.map((p) => ({
        id: p.id,
        name: p.name,
        position: p.position,
        isDefault: p.id === firstActive?.id,
        archivedAt: p.archivedAt?.toISOString() ?? null,
        stages: stages
          .filter((s) => s.pipelineId === p.id)
          .map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            position: s.position,
            leadCount: countOf.get(s.id) ?? 0,
          })),
      })),
    };
  },
});
