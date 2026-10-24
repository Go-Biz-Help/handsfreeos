/**
 * Funnels, as the screens read them (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md): the list on AI teammate →
 * Funnels with how many people are at each stage, one funnel with what stops it from going on, a customer's funnel
 * line, who's in one, and the teammate's suggestions waiting on Approvals.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { funnelPeople, funnels } from '@hfos/db/schema';
import { userNames } from '../calendar/load';
import { FUNNEL_STATUSES, type FunnelStatus } from '../funnels/definition';
import { funnelIssues } from '../funnels/issues';
import {
  businessOf,
  currentFunnelRow,
  definitionOf,
  funnelPersonOut,
  issueContextOf,
  pipelineOf,
  requireFunnel,
  waitingLeadCount,
  type FunnelRow,
} from '../funnels/load';
import { defineQuery } from '../kernel/define';
import {
  FunnelGetInput,
  FunnelGetOutput,
  FunnelListInput,
  FunnelListOutput,
  FunnelOfPersonInput,
  FunnelOfPersonOutput,
  FunnelPeopleInput,
  FunnelPeopleOutput,
  FunnelSuggestionsInput,
  FunnelSuggestionsOutput,
  type FunnelStageRow,
  type FunnelSummary,
} from '../schemas/funnel';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** How many suggestions Approvals lists at once. */
const SUGGESTIONS_MAX = 100;

interface Counts {
  /** People in it now, by stage. */
  readonly byStage: Map<string, number>;
  readonly people: number;
  readonly paused: number;
  readonly suggestions: number;
}

async function countsOf(tx: Tx, funnelIds: readonly string[]): Promise<Map<string, Counts>> {
  const out = new Map<
    string,
    { byStage: Map<string, number>; people: number; paused: number; suggestions: number }
  >();
  if (!funnelIds.length) return out;
  const list = await tx
    .select({
      funnelId: funnelPeople.funnelId,
      stageId: funnelPeople.stageId,
      status: funnelPeople.status,
      n: sql<number>`count(*)::int`,
    })
    .from(funnelPeople)
    .where(
      and(
        inArray(funnelPeople.funnelId, [...funnelIds]),
        inArray(funnelPeople.status, ['active', 'paused', 'suggested']),
      ),
    )
    .groupBy(funnelPeople.funnelId, funnelPeople.stageId, funnelPeople.status);
  for (const r of list) {
    const c = out.get(r.funnelId) ?? { byStage: new Map(), people: 0, paused: 0, suggestions: 0 };
    if (r.status === 'suggested') c.suggestions += r.n;
    else {
      c.people += r.n;
      if (r.status === 'paused') c.paused += r.n;
      if (r.stageId) c.byStage.set(r.stageId, (c.byStage.get(r.stageId) ?? 0) + r.n);
    }
    out.set(r.funnelId, c);
  }
  return out;
}

function summaryOf(
  f: FunnelRow,
  pipeline: { readonly name: string; readonly stages: readonly FunnelStageRow[] },
  counts: Counts | undefined,
  names: ReadonlyMap<string, string>,
): FunnelSummary {
  const inFunnel = new Set(definitionOf(f).stages.map((s) => s.stageId));
  return {
    id: f.id,
    name: f.name,
    pipelineId: f.pipelineId,
    pipelineName: pipeline.name,
    status: (FUNNEL_STATUSES as readonly string[]).includes(f.status)
      ? (f.status as FunnelStatus)
      : 'draft',
    revision: f.revision,
    stages: pipeline.stages.map((s) => ({
      ...s,
      people: counts?.byStage.get(s.id) ?? 0,
      inFunnel: inFunnel.has(s.id),
    })),
    people: counts?.people ?? 0,
    paused: counts?.paused ?? 0,
    suggestions: counts?.suggestions ?? 0,
    updatedAt: f.updatedAt.toISOString(),
    updatedBy: f.updatedBy ? (names.get(f.updatedBy) ?? null) : null,
  };
}

export const funnelList = defineQuery({
  name: 'funnel.list',
  description:
    'The business’s funnels, each with its pipeline, how many people are at each stage, and whether it’s on.',
  input: FunnelListInput,
  output: FunnelListOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const list = await ctx.tx
      .select()
      .from(funnels)
      .where(and(eq(funnels.workspaceId, input.workspaceId), sql`${funnels.status} <> 'archived'`))
      .orderBy(funnels.createdAt);
    const counts = await countsOf(
      ctx.tx,
      list.map((f) => f.id),
    );
    const names = await userNames(ctx.tx, [
      ...new Set(list.flatMap((f) => (f.updatedBy ? [f.updatedBy] : []))),
    ]);
    const out: FunnelSummary[] = [];
    for (const f of list)
      out.push(summaryOf(f, await pipelineOf(ctx.tx, f.pipelineId), counts.get(f.id), names));
    return { funnels: out };
  },
});

export const funnelGet = defineQuery({
  name: 'funnel.get',
  description:
    'One funnel: its steps, how many people are at each stage, what stops it from going on or is worth a look, and the forms and calendars it can use.',
  input: FunnelGetInput,
  output: FunnelGetOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const f = await requireFunnel(ctx.tx, ws, input.funnelId);
    const def = definitionOf(f);
    const pipeline = await pipelineOf(ctx.tx, f.pipelineId);
    const issueContext = await issueContextOf(ctx.tx, ws, f.pipelineId);
    const names = await userNames(ctx.tx, f.updatedBy ? [f.updatedBy] : []);
    const forms = await rows<{ id: string; name: string }>(
      ctx.tx,
      sql`select id, name from app.forms where workspace_id = ${ws} and status <> 'archived' order by name`,
    );
    const calendars = await rows<{ id: string; name: string }>(
      ctx.tx,
      sql`select id, name from app.calendars where workspace_id = ${ws} and status <> 'archived' order by name`,
    );
    const business = await businessOf(ctx.tx, ws);
    const inFunnel = new Set(def.stages.map((s) => s.stageId));
    const openIds = pipeline.stages
      .filter((s) => s.kind === 'open' && inFunnel.has(s.id))
      .map((s) => s.id);
    return {
      funnel: {
        ...summaryOf(f, pipeline, (await countsOf(ctx.tx, [f.id])).get(f.id), names),
        definition: def,
      },
      issues: funnelIssues(def, issueContext).map((i) => ({
        level: i.level,
        rule: i.rule,
        words: i.words,
      })),
      forms,
      calendars,
      teammate: issueContext.teammate,
      timeZone: business.timeZone,
      businessName: business.name,
      waiting: await waitingLeadCount(ctx.tx, f.pipelineId, openIds),
    };
  },
});

export const funnelOfPerson = defineQuery({
  name: 'funnel.of_person',
  description:
    'The funnel a customer is in, where they are in it and what it sends them next, and the funnels they could be added to.',
  input: FunnelOfPersonInput,
  output: FunnelOfPersonOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const { timeZone } = await businessOf(ctx.tx, ws);
    const row = await currentFunnelRow(ctx.tx, input.personId);
    const current = row ? await funnelPersonOut(ctx.tx, row, { now: Date.now(), timeZone }) : null;
    const open = await ctx.tx
      .select()
      .from(funnels)
      .where(and(eq(funnels.workspaceId, ws), inArray(funnels.status, ['on', 'paused'])))
      .orderBy(funnels.name);
    return {
      current,
      canJoin: open
        .filter((f) => f.id !== row?.funnelId && definitionOf(f).entry.byHand)
        .map((f) => ({ id: f.id, name: f.name })),
      timeZone,
    };
  },
});

export const funnelPeopleList = defineQuery({
  name: 'funnel.people',
  description:
    'Who’s in a funnel (at one stage, or all), the teammate’s suggestions for it, or who left it, newest first.',
  input: FunnelPeopleInput,
  output: FunnelPeopleOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const f = await requireFunnel(ctx.tx, input.workspaceId, input.funnelId);
    const { timeZone } = await businessOf(ctx.tx, input.workspaceId);
    const statuses =
      input.show === 'in'
        ? (['active', 'paused'] as const)
        : input.show === 'suggested'
          ? (['suggested'] as const)
          : (['left'] as const);
    const list = await ctx.tx
      .select()
      .from(funnelPeople)
      .where(
        and(
          eq(funnelPeople.funnelId, f.id),
          inArray(funnelPeople.status, [...statuses]),
          input.stageId ? eq(funnelPeople.stageId, input.stageId) : undefined,
        ),
      )
      .orderBy(
        input.show === 'left' ? desc(funnelPeople.leftAt) : desc(funnelPeople.stageReachedAt),
        desc(funnelPeople.createdAt),
      )
      .limit(input.limit);
    const now = Date.now();
    const people = [];
    for (const r of list)
      people.push(await funnelPersonOut(ctx.tx, r, { now, timeZone, funnel: f }));
    return { people, timeZone };
  },
});

export const funnelSuggestionList = defineQuery({
  name: 'funnel.suggestions',
  description:
    'The teammate’s suggestions of a funnel for a customer, waiting for someone on the team to say yes or no.',
  input: FunnelSuggestionsInput,
  output: FunnelSuggestionsOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const { timeZone } = await businessOf(ctx.tx, input.workspaceId);
    const list = await ctx.tx
      .select({ row: funnelPeople })
      .from(funnelPeople)
      .innerJoin(funnels, eq(funnels.id, funnelPeople.funnelId))
      .where(
        and(
          eq(funnelPeople.workspaceId, input.workspaceId),
          eq(funnelPeople.status, 'suggested'),
          inArray(funnels.status, ['on', 'paused']),
        ),
      )
      .orderBy(desc(funnelPeople.createdAt))
      .limit(SUGGESTIONS_MAX);
    const now = Date.now();
    const suggestions = [];
    for (const { row } of list)
      suggestions.push(await funnelPersonOut(ctx.tx, row, { now, timeZone }));
    return { suggestions };
  },
});

export const funnelQueries = [
  funnelList,
  funnelGet,
  funnelOfPerson,
  funnelPeopleList,
  funnelSuggestionList,
] as const;
