import { and, asc, eq, isNull } from 'drizzle-orm';
import { leads, pipelines, pipelineStages } from '@hfos/db/schema';
import { AI_TEAMMATE_SOURCE, assertAiReach } from '../ai-team/reach';
import { logSystemActivity } from '../crm/activities';
import { insertWithId, madeBefore } from '../crm/client-ids';
import { placeInStage } from '../crm/positions';
import { requireCompany, requirePerson, setRecordTags } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import { LeadCreateInput, LeadCreateOutput } from '../schemas/lead';

export const leadCreate = defineCommand({
  name: 'lead.create',
  description:
    'Add a lead for a person or company. It starts in the first open stage of the pipeline.',
  risk: 1,
  input: LeadCreateInput,
  output: LeadCreateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['lead.created'],
  // A booking can open a lead (a calendar's CRM settings): the worker runs this as the system actor. So can
  // a workflow step, and the AI teammate for the customer it's talking to.
  actors: ['human', 'system', 'workflow', 'ai_employee'],
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    await assertAiReach(ctx, { personId: input.personId, companyId: input.companyId });
    const earlier = await madeBefore(ctx.tx, 'leads', input.id, workspaceId);
    if (earlier) return { leadId: earlier.id, stageId: earlier.stageId };
    // The AI teammate opens a plain lead in an open stage: no owner, value or tags. (A lead its booking opens
    // follows the calendar's settings, which the business chose.)
    const aiDirect = ctx.actor.type === 'ai_employee' && ctx.commandName === 'lead.create';
    if (aiDirect) {
      const refused = [
        ...(input.assigneeUserId ? ['assigneeUserId'] : []),
        ...(input.valueCents !== 0 ? ['valueCents'] : []),
        ...(input.tagIds?.length ? ['tagIds'] : []),
      ];
      if (refused.length)
        throw HfosError.validation(
          refused.map((path) => ({
            path,
            message: 'The AI teammate doesn’t set this. Someone on the team can.',
          })),
        );
    }
    if (input.personId) await requirePerson(ctx.tx, workspaceId, input.personId);
    if (input.companyId) await requireCompany(ctx.tx, workspaceId, input.companyId);
    const [pipeline] = input.pipelineId
      ? await ctx.tx
          .select()
          .from(pipelines)
          .where(
            and(
              eq(pipelines.id, input.pipelineId),
              eq(pipelines.workspaceId, workspaceId),
              isNull(pipelines.archivedAt),
            ),
          )
      : await ctx.tx
          .select()
          .from(pipelines)
          .where(and(eq(pipelines.workspaceId, workspaceId), isNull(pipelines.archivedAt)))
          .orderBy(asc(pipelines.position), asc(pipelines.createdAt))
          .limit(1);
    if (!pipeline) throw HfosError.notFound('Pipeline not found.');
    const [stage] = input.stageId
      ? await ctx.tx
          .select()
          .from(pipelineStages)
          .where(
            and(eq(pipelineStages.id, input.stageId), eq(pipelineStages.pipelineId, pipeline.id)),
          )
      : await ctx.tx
          .select()
          .from(pipelineStages)
          .where(and(eq(pipelineStages.pipelineId, pipeline.id), eq(pipelineStages.kind, 'open')))
          .orderBy(asc(pipelineStages.position))
          .limit(1);
    if (!stage) throw HfosError.notFound('Stage not found.');
    if (aiDirect && stage.kind !== 'open')
      throw HfosError.rule(
        'stage_not_open',
        409,
        'The AI teammate adds leads to open stages only. Someone on the team can win or lose a lead.',
      );
    const position = await placeInStage(ctx.tx, stage.id, undefined, null);
    const [row] = await insertWithId('leads', input.id, () =>
      ctx.tx
        .insert(leads)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId,
          pipelineId: pipeline.id,
          stageId: stage.id,
          personId: input.personId ?? null,
          companyId: input.companyId ?? null,
          title: input.title,
          valueCents: input.valueCents,
          source: input.source ?? (ctx.actor.type === 'ai_employee' ? AI_TEAMMATE_SOURCE : null),
          assigneeUserId: input.assigneeUserId ?? null,
          expectedCloseOn: input.expectedCloseOn ?? null,
          nextAction: input.nextAction ?? null,
          nextActionAt: input.nextActionAt ? new Date(input.nextActionAt) : null,
          lostReason: stage.kind === 'lost' ? 'Created as lost' : null,
          position,
          createdBy: userIdOf(ctx.actor),
        })
        .returning(),
    );
    if (!row) throw HfosError.forbidden();
    if (input.tagIds?.length)
      await setRecordTags(
        ctx.tx,
        workspaceId,
        'lead',
        row.id,
        input.tagIds,
        userIdOf(ctx.actor),
        changeMoment(ctx.meta),
      );
    const eventId = await ctx.emit({
      type: 'lead.created',
      entityType: 'lead',
      entityId: row.id,
      payload: {
        title: row.title,
        valueCents: row.valueCents,
        stage: stage.name,
        pipeline: pipeline.name,
      },
      after: {
        title: row.title,
        stage: stage.name,
        pipeline: pipeline.name,
        valueCents: row.valueCents,
        nextAction: row.nextAction,
      },
    });
    await logSystemActivity(ctx, {
      subtype: 'lead_created',
      leadId: row.id,
      personId: row.personId,
      companyId: row.companyId,
      body: row.title,
      meta: { stage: stage.name, valueCents: row.valueCents },
      eventId,
    });
    return { leadId: row.id, stageId: stage.id };
  },
});
