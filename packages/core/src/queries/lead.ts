import { and, asc, desc, eq, gte, isNull, or, sql as dsql, type SQL } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { leads, pipelines, pipelineStages } from '@hfos/db/schema';
import { leadCards } from '../crm/lead-cards';
import { BOARD_LEADS_PER_STAGE, boardStages } from '../crm/pipeline-words';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { decodeTimeCursor, page } from '../kernel/pagination';
import { LeadQualification } from '../schemas/ai-team';
import {
  LeadBoardInput,
  LeadBoardOutput,
  LeadGetInput,
  LeadGetOutput,
  LeadListInput,
  LeadListOutput,
} from '../schemas/lead';

export const leadBoard = defineQuery({
  name: 'lead.board',
  description:
    'A pipeline as a board: stages in order, each with its leads, count and total value.',
  input: LeadBoardInput,
  output: LeadBoardOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const active = await ctx.tx
      .select({ id: pipelines.id, name: pipelines.name })
      .from(pipelines)
      .where(and(eq(pipelines.workspaceId, input.workspaceId), isNull(pipelines.archivedAt)))
      .orderBy(asc(pipelines.position), asc(pipelines.createdAt));
    const pipeline = input.pipelineId ? active.find((p) => p.id === input.pipelineId) : active[0];
    if (!pipeline)
      throw HfosError.notFound(
        input.pipelineId
          ? 'That pipeline isn’t there anymore. It may have been archived. Pick another pipeline.'
          : 'This business has no pipelines yet. Add one in Settings → Pipelines.',
      );
    const stages = await ctx.tx
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipeline.id))
      .orderBy(asc(pipelineStages.position));
    // The top of each column, not every lead the pipeline ever won or lost: a stage's count and total cover them all.
    // A column the viewer asked to see more of sends as many as they asked for.
    const shown = Object.fromEntries((input.shown ?? []).map((s) => [s.stageId, s.limit]));
    const cards = await leadCards(
      ctx.tx,
      input.workspaceId,
      and(
        eq(leads.pipelineId, pipeline.id),
        isNull(leads.archivedAt),
        dsql`${leads.id} in (select t.id from (
          select l.id, l.stage_id, row_number() over (partition by l.stage_id order by l.position, l.created_at, l.id) as n
          from app.leads l
          where l.workspace_id = ${input.workspaceId} and l.pipeline_id = ${pipeline.id} and l.archived_at is null
        ) t where t.n <= coalesce((${JSON.stringify(shown)}::jsonb ->> t.stage_id::text)::int, ${BOARD_LEADS_PER_STAGE}))`,
      )!,
      [asc(leads.position), asc(leads.createdAt), asc(leads.id)],
    );
    const totals = await rows<{ stage_id: string; count: number; value_cents: number }>(
      ctx.tx,
      sql`select stage_id, count(*)::int as count, coalesce(sum(value_cents), 0)::float8 as value_cents
          from app.leads
          where workspace_id = ${input.workspaceId} and pipeline_id = ${pipeline.id} and archived_at is null
          group by stage_id`,
    );
    return {
      pipeline,
      pipelines: active,
      // Each stage's count and total come from core, so the web's board and the phone's agree after a move.
      stages: boardStages(
        stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind, position: s.position })),
        cards,
        new Map(
          totals.map((t) => [t.stage_id, { count: t.count, valueCents: Number(t.value_cents) }]),
        ),
      ),
    };
  },
});

export const leadList = defineQuery({
  name: 'lead.list',
  description: 'Leads as a list, newest change first, with filters.',
  input: LeadListInput,
  output: LeadListOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const cursor = decodeTimeCursor(input.cursor);
    const conditions: SQL[] = [];
    if (!input.includeArchived) conditions.push(isNull(leads.archivedAt));
    if (input.q)
      conditions.push(dsql`${leads.searchText} like ${'%' + input.q.toLowerCase() + '%'}`);
    if (input.status) conditions.push(eq(leads.status, input.status));
    if (input.pipelineId) conditions.push(eq(leads.pipelineId, input.pipelineId));
    if (input.assigneeUserId) conditions.push(eq(leads.assigneeUserId, input.assigneeUserId));
    if (input.personId) conditions.push(eq(leads.personId, input.personId));
    if (input.companyId) conditions.push(eq(leads.companyId, input.companyId));
    if (input.createdAfter) conditions.push(gte(leads.createdAt, new Date(input.createdAfter)));
    if (input.withoutNextAction)
      conditions.push(
        eq(leads.status, 'open'),
        or(isNull(leads.nextAction), eq(leads.nextAction, ''))!,
      );
    // At full precision: a stage renumber gives hundreds of leads one updated_at, and a page can end among them.
    if (cursor)
      conditions.push(
        dsql`(${leads.updatedAt}, ${leads.id}) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)`,
      );
    const cards = await leadCards(
      ctx.tx,
      input.workspaceId,
      and(...conditions) ?? dsql`true`,
      [desc(leads.updatedAt), desc(leads.id)],
      input.limit + 1,
    );
    const result = page(cards, input.limit, (c) => ({ sort: c.updatedKey, id: c.id }));
    return {
      items: result.items.map(({ updatedKey: _, ...card }) => card),
      nextCursor: result.nextCursor,
    };
  },
});

export const leadGet = defineQuery({
  name: 'lead.get',
  description: 'One lead with its card details and the stages of its pipeline.',
  input: LeadGetInput,
  output: LeadGetOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [card] = await leadCards(
      ctx.tx,
      input.workspaceId,
      eq(leads.id, input.leadId),
      [asc(leads.id)],
      1,
    );
    if (!card)
      throw HfosError.notFound(
        'That lead isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    const stages = await ctx.tx
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        kind: pipelineStages.kind,
        position: pipelineStages.position,
      })
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, card.pipelineId))
      .orderBy(asc(pipelineStages.position));
    // Its qualifying answers (the column starts as {}): none recorded is null.
    const [row] = await ctx.tx
      .select({ qualification: leads.qualification })
      .from(leads)
      .where(eq(leads.id, input.leadId));
    const raw = row?.qualification;
    const parsed =
      raw && typeof raw === 'object' && Object.keys(raw).length
        ? LeadQualification.safeParse(raw)
        : null;
    return { lead: { ...card, qualification: parsed?.success ? parsed.data : null }, stages };
  },
});
