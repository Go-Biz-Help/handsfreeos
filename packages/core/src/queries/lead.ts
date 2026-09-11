import { and, asc, desc, eq, isNull, lt, or, sql as dsql, type SQL } from 'drizzle-orm';
import { leads, pipelines, pipelineStages } from '@hfos/db/schema';
import { leadCards } from '../crm/lead-cards';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
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
    if (!pipeline) throw HfosError.notFound('Pipeline not found.');
    const stages = await ctx.tx
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipeline.id))
      .orderBy(asc(pipelineStages.position));
    const cards = await leadCards(
      ctx.tx,
      input.workspaceId,
      and(eq(leads.pipelineId, pipeline.id), isNull(leads.archivedAt))!,
      [asc(leads.position), asc(leads.createdAt)],
    );
    return {
      pipeline,
      pipelines: active,
      stages: stages.map((s) => {
        const inStage = cards.filter((c) => c.stageId === s.id);
        return {
          id: s.id,
          name: s.name,
          kind: s.kind,
          position: s.position,
          count: inStage.length,
          valueCents: inStage.reduce((a, c) => a + c.valueCents, 0),
          leads: inStage,
        };
      }),
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
    const cursor = decodeCursor(input.cursor);
    const conditions: SQL[] = [];
    if (!input.includeArchived) conditions.push(isNull(leads.archivedAt));
    if (input.q)
      conditions.push(dsql`${leads.searchText} like ${'%' + input.q.toLowerCase() + '%'}`);
    if (input.status) conditions.push(eq(leads.status, input.status));
    if (input.pipelineId) conditions.push(eq(leads.pipelineId, input.pipelineId));
    if (input.assigneeUserId) conditions.push(eq(leads.assigneeUserId, input.assigneeUserId));
    if (input.personId) conditions.push(eq(leads.personId, input.personId));
    if (input.companyId) conditions.push(eq(leads.companyId, input.companyId));
    if (cursor) {
      const at = new Date(cursor.sort);
      conditions.push(
        or(lt(leads.updatedAt, at), and(eq(leads.updatedAt, at), lt(leads.id, cursor.id)))!,
      );
    }
    const cards = await leadCards(
      ctx.tx,
      input.workspaceId,
      and(...conditions) ?? dsql`true`,
      [desc(leads.updatedAt), desc(leads.id)],
      input.limit + 1,
    );
    const result = page(cards, input.limit, (c) => ({ sort: c.updatedAt, id: c.id }));
    return { items: result.items, nextCursor: result.nextCursor };
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
    if (!card) throw HfosError.notFound('Lead not found.');
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
    return { lead: card, stages };
  },
});
