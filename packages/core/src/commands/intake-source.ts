/**
 * Lead intake settings (M14, channels.manage: owners and admins). Every way a lead arrives is a row in
 * app.intake_sources; a channel nobody has touched has no row and runs on the defaults, so this command
 * writes the row the first time a business changes anything about it.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { intakeSources, pipelineStages, pipelines } from '@hfos/db/schema';
import { INTAKE_NAMES, intakeSourceOf } from '../crm/intake';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { IntakeSourceUpdateInput, IntakeSourceUpdateOutput } from '../schemas/intake';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** The pipeline and stage a source points at: the business's own, the stage in that pipeline, neither archived. */
async function targetOrThrow(
  ctx: CommandContext,
  pipelineId: string | null,
  stageId: string | null | undefined,
): Promise<{ pipelineId: string | null; stageId: string | null }> {
  if (!pipelineId) return { pipelineId: null, stageId: null };
  const ws = ctx.scope.workspaceId!;
  const [pipeline] = await ctx.tx
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(
      and(
        eq(pipelines.id, pipelineId),
        eq(pipelines.workspaceId, ws),
        isNull(pipelines.archivedAt),
      ),
    );
  if (!pipeline)
    throw HfosError.validation([{ path: 'pipelineId', message: 'Pick one of your pipelines.' }]);
  if (stageId) {
    const [stage] = await ctx.tx
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)));
    if (!stage)
      throw HfosError.validation([{ path: 'stageId', message: 'Pick a stage in that pipeline.' }]);
    return { pipelineId, stageId };
  }
  // A pipeline on its own lands its leads where a lead starts: its first open stage.
  const [first] = await ctx.tx
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.kind, 'open')))
    .orderBy(asc(pipelineStages.position))
    .limit(1);
  if (!first)
    throw HfosError.validation([
      { path: 'pipelineId', message: 'That pipeline has no open stage to put a lead in.' },
    ]);
  return { pipelineId, stageId: first.id };
}

export const intakeSourceUpdate = defineCommand({
  name: 'intake_source.update',
  description:
    'Change how leads arrive on a channel: whether a stranger who texts, calls or emails becomes a customer and a lead, what that lead is filed under, which pipeline and stage it lands in, and how many a day. Only the fields sent change.',
  risk: 2,
  input: IntakeSourceUpdateInput,
  output: IntakeSourceUpdateOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['intake_source.updated'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await intakeSourceOf(ctx.tx, ws, input.kind);
    const target =
      input.pipelineId !== undefined || input.stageId !== undefined
        ? await targetOrThrow(
            ctx,
            input.pipelineId === undefined ? current.pipelineId : input.pipelineId,
            input.stageId,
          )
        : null;
    const next = {
      name: input.name ?? current.name,
      active: input.active ?? current.active,
      createLead: input.createLead ?? current.createLead,
      pipelineId: target ? target.pipelineId : current.pipelineId,
      stageId: target ? target.stageId : current.stageId,
      dailyCap: input.dailyCap ?? current.dailyCap,
    };
    const updated = (Object.keys(next) as (keyof typeof next)[]).filter(
      (k) => next[k] !== current[k],
    );
    if (updated.length === 0) return { kind: input.kind, updated: [] };

    if (current.id)
      await ctx.tx.update(intakeSources).set(next).where(eq(intakeSources.id, current.id));
    else
      await ctx.tx.insert(intakeSources).values({
        workspaceId: ws,
        kind: input.kind,
        ...next,
        createdBy: userIdOf(ctx.actor),
      });

    await ctx.emit({
      type: 'intake_source.updated',
      entityType: 'intake_source',
      entityId: current.id ?? ws,
      payload: { kind: input.kind, updated },
      before: Object.fromEntries(updated.map((k) => [k, current[k]])),
      after: {
        channel: INTAKE_NAMES[input.kind],
        ...Object.fromEntries(updated.map((k) => [k, next[k]])),
      },
    });
    return { kind: input.kind, updated };
  },
});
