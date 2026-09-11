import { and, count, eq, isNull } from 'drizzle-orm';
import { leads, pipelines } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { PipelineArchiveInput, PipelineArchiveOutput } from '../schemas/pipeline';

export const pipelineArchive = defineCommand({
  name: 'pipeline.archive',
  description: 'Archive a pipeline that has no open leads. The last active pipeline stays.',
  risk: 3,
  input: PipelineArchiveInput,
  output: PipelineArchiveOutput,
  permission: 'pipelines.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['pipeline.archived'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, input.pipelineId), eq(pipelines.workspaceId, workspaceId)));
    if (!current) throw HfosError.notFound('Pipeline not found.');
    if (current.archivedAt) return { pipelineId: current.id };
    const [active] = await ctx.tx
      .select({ n: count() })
      .from(pipelines)
      .where(and(eq(pipelines.workspaceId, workspaceId), isNull(pipelines.archivedAt)));
    if (Number(active?.n ?? 0) <= 1)
      throw HfosError.rule('last_pipeline', 409, 'A workspace keeps at least one pipeline.');
    const [open] = await ctx.tx
      .select({ n: count() })
      .from(leads)
      .where(
        and(eq(leads.pipelineId, current.id), eq(leads.status, 'open'), isNull(leads.archivedAt)),
      );
    if (Number(open?.n ?? 0) > 0)
      throw HfosError.rule(
        'pipeline_has_open_leads',
        409,
        'This pipeline still has open leads. Move or close them first.',
      );
    await ctx.tx
      .update(pipelines)
      .set({ archivedAt: new Date() })
      .where(eq(pipelines.id, current.id));
    await ctx.emit({
      type: 'pipeline.archived',
      entityType: 'pipeline',
      entityId: current.id,
      payload: { name: current.name },
      before: { name: current.name, archived: false },
      after: { name: current.name, archived: true },
    });
    return { pipelineId: current.id };
  },
});
