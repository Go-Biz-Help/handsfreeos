import { and, asc, eq, isNull } from 'drizzle-orm';
import { intakeSources, pipelineStages, pipelines } from '@hfos/db/schema';
import { workspaceZone } from '../calendar/load';
import { localDayOf } from '../calendar/when';
import {
  INTAKE_CHANNELS,
  INTAKE_DEFAULT_DAILY_CAP,
  INTAKE_NAMES,
  intakeOnByDefault,
  READABLE_SOURCE,
} from '../crm/intake';
import { defineQuery } from '../kernel/define';
import { IntakeListInput, IntakeListOutput } from '../schemas/intake';

type Row = { [K in keyof typeof READABLE_SOURCE]: (typeof intakeSources.$inferSelect)[K] };
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const intakeList = defineQuery({
  name: 'intake.list',
  description:
    'How leads arrive by themselves: the three channels (text, call, email), the forms on the business’s own website and the apps connected to it — whether each opens a lead, where that lead lands, its daily limit and how much of today it has used. Secret keys are never read back.',
  input: IntakeListInput,
  output: IntakeListOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const rows = await ctx.tx
      .select(READABLE_SOURCE)
      .from(intakeSources)
      .where(and(eq(intakeSources.workspaceId, ws), isNull(intakeSources.archivedAt)))
      .orderBy(asc(intakeSources.createdAt));
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
      .where(and(eq(pipelines.workspaceId, ws), isNull(pipelines.archivedAt)))
      .orderBy(asc(pipelines.position), asc(pipelineStages.position));

    const view = (row: Row | null, kind: Row['kind']) => ({
      kind,
      sourceId: row?.id ?? null,
      name: row?.name ?? INTAKE_NAMES[kind],
      active: row ? row.active : intakeOnByDefault(kind),
      createLead: row ? row.createLead : true,
      pipelineId: row?.pipelineId ?? null,
      stageId: row?.stageId ?? null,
      dailyCap: row?.dailyCap ?? INTAKE_DEFAULT_DAILY_CAP,
      todayCount: row && row.dayOn === today ? row.dayCount : 0,
      lastIntakeAt: iso(row?.lastIntakeAt ?? null),
      publicKey: row?.publicKey ?? null,
      secretHint: row?.secretHint ?? null,
      allowedOrigins: row?.allowedOrigins ?? [],
      redirectUrl: row?.redirectUrl ?? null,
      lastUsedAt: iso(row?.lastUsedAt ?? null),
    });

    return {
      // The three channels always show, row or no row; then the forms and keys in the order they were made.
      sources: [
        ...INTAKE_CHANNELS.map((kind) => view(rows.find((r) => r.kind === kind) ?? null, kind)),
        ...rows
          .filter((r) => r.kind === 'website_form' || r.kind === 'api')
          .map((r) => view(r, r.kind)),
      ],
      pipelines: [
        ...boards
          .reduce((m, b) => {
            const p = m.get(b.pipelineId) ?? {
              id: b.pipelineId,
              name: b.pipelineName,
              stages: [],
            };
            p.stages.push({ id: b.stageId, name: b.stageName, kind: b.kind });
            m.set(b.pipelineId, p);
            return m;
          }, new Map<string, { id: string; name: string; stages: { id: string; name: string; kind: string }[] }>())
          .values(),
      ],
    };
  },
});
