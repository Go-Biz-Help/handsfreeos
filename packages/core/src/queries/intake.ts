import { and, asc, eq } from 'drizzle-orm';
import { intakeSources, pipelineStages, pipelines } from '@hfos/db/schema';
import { localDayOf } from '../calendar/when';
import { workspaceZone } from '../calendar/load';
import { INTAKE_CHANNELS, INTAKE_DEFAULT_DAILY_CAP, INTAKE_NAMES } from '../crm/intake';
import { defineQuery } from '../kernel/define';
import { IntakeListInput, IntakeListOutput } from '../schemas/intake';

export const intakeList = defineQuery({
  name: 'intake.list',
  description:
    'How leads arrive by themselves: each channel (text, call, email), whether it opens a lead, where that lead lands, its daily limit and how much of today it has used.',
  input: IntakeListInput,
  output: IntakeListOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const rows = await ctx.tx.select().from(intakeSources).where(eq(intakeSources.workspaceId, ws));
    const today = localDayOf(Date.now(), await workspaceZone(ctx.tx, ws));
    const boards = await ctx.tx
      .select({
        pipelineId: pipelines.id,
        pipelineName: pipelines.name,
        stageId: pipelineStages.id,
        stageName: pipelineStages.name,
        kind: pipelineStages.kind,
      })
      .from(pipelines)
      .innerJoin(pipelineStages, eq(pipelineStages.pipelineId, pipelines.id))
      .where(and(eq(pipelines.workspaceId, ws)))
      .orderBy(asc(pipelines.position), asc(pipelineStages.position));
    return {
      sources: INTAKE_CHANNELS.map((kind) => {
        const row = rows.find((r) => r.kind === kind);
        return {
          kind,
          name: row?.name ?? INTAKE_NAMES[kind],
          active: row?.active ?? true,
          createLead: row?.createLead ?? true,
          pipelineId: row?.pipelineId ?? null,
          stageId: row?.stageId ?? null,
          dailyCap: row?.dailyCap ?? INTAKE_DEFAULT_DAILY_CAP,
          todayCount: row?.dayOn === today ? (row?.dayCount ?? 0) : 0,
          lastIntakeAt: row?.lastIntakeAt ? row.lastIntakeAt.toISOString() : null,
        };
      }),
      pipelines: [
        ...boards
          .reduce((m, b) => {
            const p = m.get(b.pipelineId) ?? { id: b.pipelineId, name: b.pipelineName, stages: [] };
            p.stages.push({ id: b.stageId, name: b.stageName, kind: b.kind });
            m.set(b.pipelineId, p);
            return m;
          }, new Map<string, { id: string; name: string; stages: { id: string; name: string; kind: string }[] }>())
          .values(),
      ],
    };
  },
});
