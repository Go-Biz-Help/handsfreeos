/**
 * Funnels (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md): making and changing one, turning it on, and who's
 * in it. The pipeline is the truth: a person's stage in their funnel is their lead's stage, so moving someone moves
 * their lead (lead.move_stage), and the funnel follows. The worker does the rest as the system: who gets in by a
 * rule, the messages, and the moves HandsFreeOS sees. The teammate moves people on by what they write
 * (`reply` moves) and suggests who might fit.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { funnelPeople, funnels, leads, pipelines } from '@hfos/db/schema';
import { assertAiReach } from '../ai-team/reach';
import { userNames, uuidArray } from '../calendar/load';
import { logSystemActivity } from '../crm/activities';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import {
  emptyFunnel,
  FUNNEL_LIMITS,
  type FunnelAddedBy,
  type FunnelDefinition,
  type FunnelLeftReason,
  type FunnelPauseReason,
  type FunnelPersonStatus,
  type FunnelStatus,
} from '../funnels/definition';
import { definitionFromDraft, matchDraftStages } from '../funnels/draft';
import { funnelUnknownBlanks } from '../funnels/fill';
import { leaveFunnel } from '../funnels/follow';
import { funnelBlocker, funnelIssues } from '../funnels/issues';
import {
  currentFunnelRow,
  definitionOf,
  funnelOfPipeline,
  issueContextOf,
  pipelineOf,
  requireFunnel,
  requireFunnelPerson,
  waitingLeadCount,
  type FunnelPersonRow,
  type FunnelRow,
} from '../funnels/load';
import { funnelMoveCause } from '../funnels/words';
import { aiEmployeeOf, requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { FRESH_MINUTES } from '../mobile';
import { executeCommandWithin } from '../kernel/execute';
import { isUniqueViolation } from '../kernel/pg-errors';
import type { CommandContext } from '../kernel/types';
import type { FunnelStageRow } from '../schemas/funnel';
import {
  FunnelAddPersonInput,
  FunnelAddPersonOutput,
  FunnelArchiveInput,
  FunnelArchiveOutput,
  FunnelCreateInput,
  FunnelCreateOutput,
  FunnelDecideSuggestionInput,
  FunnelDecideSuggestionOutput,
  FunnelMovePersonInput,
  FunnelMovePersonOutput,
  FunnelNoteProgressInput,
  FunnelNoteProgressOutput,
  FunnelPauseInput,
  FunnelPauseOutput,
  FunnelPausePersonInput,
  FunnelPausePersonOutput,
  FunnelRemovePersonInput,
  FunnelRemovePersonOutput,
  FunnelSaveInput,
  FunnelSaveOutput,
  FunnelSuggestInput,
  FunnelSuggestOutput,
  FunnelTurnOnInput,
  FunnelTurnOnOutput,
} from '../schemas/funnel';
import { leadCreate } from './lead.create';
import { leadMoveStage } from './lead.move_stage';
import { pipelineCreate } from './pipeline.create';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** The most people a save moves off a stage taken out of the funnel. */
export const FUNNEL_MOVE_ON_SAVE_MAX = 500;

/** What `seen` and `sent` keep at most (the table's own checks). */
const SEEN_MAX = 20;
const SENT_MAX = 40;

const full = () =>
  HfosError.rule(
    'funnels_full',
    409,
    `This business has ${FUNNEL_LIMITS.funnels} funnels, the most it keeps. Archive one it no longer uses under AI teammate → Funnels, then make this one.`,
  );

const nameTaken = (name: string) =>
  HfosError.conflict(
    `There’s already a funnel called ${name}. Give this one another name.`,
    'funnel_name_taken',
  );

const notOn = (f: Pick<FunnelRow, 'name' | 'status'>) =>
  HfosError.rule(
    'funnel_not_on',
    409,
    f.status === 'paused'
      ? `${f.name} is paused, so it isn’t taking anyone in. Turn it back on under AI teammate → Funnels.`
      : `${f.name} isn’t on yet. Turn it on under AI teammate → Funnels, then add people to it.`,
  );

const capital = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

async function refuseTakenName(ctx: CommandContext, name: string, exceptId: string | null) {
  const [t] = await rows<{ id: string }>(
    ctx.tx,
    sql`select id from app.funnels
        where workspace_id = ${ctx.scope.workspaceId!} and status <> 'archived' and lower(name) = lower(${name})
          and (${exceptId}::uuid is null or id <> ${exceptId}::uuid)
        limit 1`,
  );
  if (t) throw nameTaken(name);
}

/** The open stages of the funnel, in the pipeline's order: where people can be. */
function openStagesOf(def: FunnelDefinition, stages: readonly FunnelStageRow[]): FunnelStageRow[] {
  const inFunnel = new Set(def.stages.map((s) => s.stageId));
  return stages.filter((s) => s.kind === 'open' && inFunnel.has(s.id));
}

/**
 * What a saved funnel must hold to: its stages are the pipeline's, its moves and start go to stages in it, a won or
 * lost stage (where people leave) has nothing of its own, and the forms, calendars and blanks it names are real.
 */
async function checkParts(
  ctx: CommandContext,
  def: FunnelDefinition,
  pipeline: { readonly name: string; readonly stages: readonly FunnelStageRow[] },
): Promise<void> {
  const ws = ctx.scope.workspaceId!;
  const issues: { path: string; message: string }[] = [];
  const stageById = new Map(pipeline.stages.map((s) => [s.id, s]));
  const inFunnel = new Set(def.stages.map((s) => s.stageId));
  def.stages.forEach((s, i) => {
    const stage = stageById.get(s.stageId);
    const at = `definition.stages.${i}`;
    if (!stage) {
      issues.push({
        path: `${at}.stageId`,
        message: `That stage isn’t in the ${pipeline.name} pipeline anymore. Take it out of the funnel.`,
      });
      return;
    }
    if (stage.kind !== 'open' && (s.messages.length || s.moves.length))
      issues.push({
        path: at,
        message: `People leave the funnel at ${stage.name}, so it has no messages or moves. Put them on an open stage.`,
      });
    s.moves.forEach((m, j) => {
      if (!inFunnel.has(m.to))
        issues.push({ path: `${at}.moves.${j}.to`, message: 'Pick a stage that’s in the funnel.' });
    });
    s.messages.forEach((m, j) => {
      const unknown = m.wording === 'exact' ? funnelUnknownBlanks(m.text) : [];
      if (unknown.length)
        issues.push({
          path: `${at}.messages.${j}.text`,
          message: `HandsFreeOS doesn’t fill in {${unknown[0]}}. Use {first_name}, {session_time}, {join_link} or {business}.`,
        });
    });
  });
  const start = def.entry.startStageId;
  if (start && (!inFunnel.has(start) || stageById.get(start)?.kind !== 'open'))
    issues.push({
      path: 'definition.entry.startStageId',
      message: 'People start at an open stage that’s in the funnel. Pick another.',
    });
  const formIds = new Set<string>();
  const calendarIds = new Set<string>();
  for (const r of def.entry.rules) {
    if (r.kind === 'form') formIds.add(r.formId);
    if (r.kind === 'booking') calendarIds.add(r.calendarId);
  }
  for (const s of def.stages)
    for (const m of s.moves)
      if (m.kind === 'event') {
        if (m.formId) formIds.add(m.formId);
        if (m.calendarId) calendarIds.add(m.calendarId);
      }
  if (formIds.size) {
    const found = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.forms where workspace_id = ${ws} and status <> 'archived'
            and id = any(${uuidArray([...formIds])})`,
    );
    if (found.length < formIds.size)
      issues.push({
        path: 'definition',
        message:
          'A form this funnel uses isn’t there anymore. Pick another form where it’s marked.',
      });
  }
  if (calendarIds.size) {
    const found = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.calendars where workspace_id = ${ws} and status <> 'archived'
            and id = any(${uuidArray([...calendarIds])})`,
    );
    if (found.length < calendarIds.size)
      issues.push({
        path: 'definition',
        message:
          'A calendar this funnel uses isn’t there anymore. Pick another calendar where it’s marked.',
      });
  }
  if (issues.length)
    throw HfosError.validation(
      issues,
      'Some parts of the funnel need attention. Fix the ones marked, then save again.',
    );
}

/** The stages whose part of the funnel changed or is new: the worker schedules their messages again. */
function changedStages(before: FunnelDefinition, after: FunnelDefinition): string[] {
  const old = new Map(before.stages.map((s) => [s.stageId, JSON.stringify(s)]));
  return after.stages.filter((s) => old.get(s.stageId) !== JSON.stringify(s)).map((s) => s.stageId);
}

async function funnelOfRow(ctx: CommandContext, row: FunnelPersonRow): Promise<FunnelRow> {
  const [f] = await ctx.tx.select().from(funnels).where(eq(funnels.id, row.funnelId));
  if (!f) throw HfosError.notFound();
  return f;
}

const personEvent = (row: FunnelPersonRow) => ({
  funnelId: row.funnelId,
  funnelPersonId: row.id,
  personId: row.personId,
  leadId: row.leadId,
  stageId: row.stageId,
});

/**
 * Puts a person in a funnel, as `addedBy`: at their lead's stage when it's one of the funnel's open stages, else
 * `stageId`, the funnel's start, or its first open stage. A person already in another funnel leaves it first. Their
 * lead in the funnel's pipeline is opened for them when they have none, and moved to where they start. A waiting
 * suggestion for this funnel is taken up rather than doubled.
 */
export async function addToFunnel(
  ctx: CommandContext,
  funnel: FunnelRow,
  opts: {
    readonly personId: string;
    readonly leadId?: string;
    readonly stageId?: string;
    readonly addedBy: FunnelAddedBy;
    readonly suggestion?: FunnelPersonRow;
  },
): Promise<{ row: FunnelPersonRow; already: boolean }> {
  const ws = ctx.scope.workspaceId!;
  const person = await requirePerson(ctx.tx, ws, opts.personId);
  const def = definitionOf(funnel);
  const pipeline = await pipelineOf(ctx.tx, funnel.pipelineId);
  const open = openStagesOf(def, pipeline.stages);
  if (!open.length)
    throw HfosError.rule(
      'funnel_no_open_stage',
      409,
      `${funnel.name} has no open stage to start people at. Add one under AI teammate → Funnels.`,
    );
  const openIds = new Set(open.map((s) => s.id));
  if (opts.stageId && !openIds.has(opts.stageId))
    throw HfosError.validation([
      { path: 'stageId', message: `Pick an open stage that’s in ${funnel.name}.` },
    ]);
  const current = await currentFunnelRow(ctx.tx, person.id, { forUpdate: true });
  if (current?.funnelId === funnel.id) return { row: current, already: true };

  const leadQuery = ctx.tx
    .select({ id: leads.id, stageId: leads.stageId, status: leads.status })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, ws),
        eq(leads.personId, person.id),
        eq(leads.pipelineId, funnel.pipelineId),
        isNull(leads.archivedAt),
        opts.leadId ? eq(leads.id, opts.leadId) : eq(leads.status, 'open'),
      ),
    )
    .orderBy(desc(leads.stageEnteredAt))
    .limit(1);
  let [lead] = await leadQuery;
  if (opts.leadId && !lead)
    throw HfosError.notFound(
      `That lead isn’t in ${pipeline.name} anymore. It may have been archived or moved. Refresh and try again.`,
    );
  if (lead && lead.status !== 'open')
    throw HfosError.rule(
      'lead_not_open',
      409,
      `That lead is already ${lead.status}, so it can’t go through ${funnel.name}. Reopen it on the Pipeline first.`,
    );
  const start =
    opts.stageId ??
    (lead && openIds.has(lead.stageId) ? lead.stageId : null) ??
    (def.entry.startStageId && openIds.has(def.entry.startStageId)
      ? def.entry.startStageId
      : null) ??
    open[0]!.id;

  if (current) await leaveFunnel(ctx, current, await funnelOfRow(ctx, current), 'other_funnel');
  if (!lead) {
    const made = await executeCommandWithin(ctx, leadCreate, {
      workspaceId: ws,
      title: funnel.name,
      personId: person.id,
      pipelineId: funnel.pipelineId,
      stageId: start,
    });
    lead = { id: made.output.leadId, stageId: made.output.stageId, status: 'open' };
  } else if (lead.stageId !== start) {
    // A person moves it as they like; HandsFreeOS moves it by the funnel's say, which may go back a stage.
    await executeCommandWithin(ctx, leadMoveStage, {
      workspaceId: ws,
      leadId: lead.id,
      stageId: start,
      ...(ctx.actor.type === 'human' ? {} : { funnelId: funnel.id }),
    });
  }

  const now = new Date();
  const joined = {
    leadId: lead.id,
    stageId: start,
    status: 'active' as const,
    stageReachedAt: now,
    seen: [],
    sent: [],
  };
  const [waiting] = opts.suggestion
    ? [opts.suggestion]
    : await ctx.tx
        .select()
        .from(funnelPeople)
        .where(
          and(
            eq(funnelPeople.funnelId, funnel.id),
            eq(funnelPeople.personId, person.id),
            eq(funnelPeople.status, 'suggested'),
          ),
        );
  let row: FunnelPersonRow | undefined;
  try {
    [row] = waiting
      ? await ctx.tx
          .update(funnelPeople)
          .set(joined)
          .where(eq(funnelPeople.id, waiting.id))
          .returning()
      : await ctx.tx
          .insert(funnelPeople)
          .values({
            ...joined,
            workspaceId: ws,
            funnelId: funnel.id,
            personId: person.id,
            addedBy: opts.addedBy,
            addedByUser: ctx.actor.type === 'human' ? ctx.actor.userId : null,
          })
          .returning();
  } catch (e) {
    if (isUniqueViolation(e, 'funnel_people_one_at_a_time'))
      throw HfosError.conflict(
        'They were just put in a funnel by someone else. Refresh to see where they are.',
        'funnel_person_taken',
      );
    throw e;
  }
  if (!row) throw HfosError.forbidden();
  const stageName = pipeline.stages.find((s) => s.id === start)?.name ?? '';
  const eventId = await ctx.emit({
    type: 'funnel.person_added',
    entityType: 'funnel',
    entityId: funnel.id,
    payload: { ...personEvent(row), addedBy: opts.addedBy },
    after: { funnel: funnel.name, stage: stageName },
    broadcast: false,
  });
  await logSystemActivity(ctx, {
    subtype: 'funnel_joined',
    personId: person.id,
    leadId: lead.id,
    body: funnel.name,
    meta: { funnel: funnel.name, funnelId: funnel.id, stage: stageName, addedBy: opts.addedBy },
    eventId,
  });
  return { row, already: false };
}

// ---- Making and changing one ----

export const funnelCreate = defineCommand({
  name: 'funnel.create',
  description:
    'Make a funnel on a pipeline (or on a new one made from its stages), from the AI’s draft or empty. It starts as a draft, taking nobody in.',
  risk: 1,
  input: FunnelCreateInput,
  output: FunnelCreateOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['funnel.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    await refuseTakenName(ctx, input.name, null);
    const [count] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.funnels where workspace_id = ${ws} and status <> 'archived'`,
    );
    if ((count?.n ?? 0) >= FUNNEL_LIMITS.funnels) throw full();
    let pipelineId: string;
    if (input.newPipeline) {
      // Its own permission, checked by pipeline.create.
      const made = await executeCommandWithin(ctx, pipelineCreate, {
        workspaceId: ws,
        name: input.newPipeline.name,
        stages: input.newPipeline.stages,
      });
      pipelineId = made.output.pipelineId;
    } else {
      const [p] = await ctx.tx
        .select({ id: pipelines.id, name: pipelines.name })
        .from(pipelines)
        .where(
          and(
            eq(pipelines.id, input.pipelineId!),
            eq(pipelines.workspaceId, ws),
            isNull(pipelines.archivedAt),
          ),
        );
      if (!p)
        throw HfosError.notFound(
          'That pipeline isn’t there anymore. It may have been archived. Pick another one, or make a new one.',
        );
      const there = await funnelOfPipeline(ctx.tx, p.id);
      if (there)
        throw HfosError.rule(
          'pipeline_has_funnel',
          409,
          `${p.name} already runs ${there.name}, and a pipeline runs one funnel. Open ${there.name} under AI teammate → Funnels, or pick another pipeline.`,
        );
      pipelineId = p.id;
    }
    const pipeline = await pipelineOf(ctx.tx, pipelineId);
    let definition: FunnelDefinition;
    if (input.draft) {
      const map = matchDraftStages(input.draft, pipeline.stages);
      for (const [name, id] of Object.entries(input.stageMap ?? {})) {
        if (!pipeline.stages.some((s) => s.id === id))
          throw HfosError.validation([
            {
              path: 'stageMap',
              message: `That stage isn’t in ${pipeline.name}. Refresh and match the stages again.`,
            },
          ]);
        map.set(name.trim().toLowerCase(), id);
      }
      definition = definitionFromDraft(input.draft, map, input.description ?? '');
    } else
      definition = {
        ...emptyFunnel(pipeline.stages.map((s) => s.id)),
        description: input.description ?? '',
      };
    let row: FunnelRow | undefined;
    try {
      [row] = await ctx.tx
        .insert(funnels)
        .values({
          workspaceId: ws,
          pipelineId,
          name: input.name,
          status: 'draft',
          definition,
          revision: 1,
          createdBy: me,
          updatedBy: me,
        })
        .returning();
    } catch (e) {
      if (isUniqueViolation(e, 'funnels_name_unique')) throw nameTaken(input.name);
      if (isUniqueViolation(e, 'funnels_one_per_pipeline'))
        throw HfosError.conflict(
          `Someone just made a funnel on ${pipeline.name}. Refresh to see it.`,
          'pipeline_has_funnel',
        );
      throw e;
    }
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'funnel.created',
      entityType: 'funnel',
      entityId: row.id,
      payload: { funnelId: row.id, pipelineId, name: row.name },
      after: { name: row.name, pipeline: pipeline.name },
    });
    return { funnelId: row.id, pipelineId, revision: row.revision };
  },
});

export const funnelSave = defineCommand({
  name: 'funnel.save',
  description:
    'Save a funnel’s name and steps. People in it stay at their stage, and what changed reaches them right away. People at a stage taken out move to the stage picked for them.',
  risk: 2,
  input: FunnelSaveInput,
  output: FunnelSaveOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['funnel.saved', 'funnel.person_left'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    const row = await requireFunnel(ctx.tx, ws, input.funnelId, { forUpdate: true });
    if (row.revision !== input.revision) {
      const who =
        row.updatedBy && row.updatedBy !== me
          ? ((await userNames(ctx.tx, [row.updatedBy])).get(row.updatedBy) ?? 'Someone')
          : null;
      throw HfosError.conflict(
        who
          ? `${who} changed this funnel while you were working on it. Refresh to see their changes, then make yours again.`
          : 'You changed this funnel in another tab or window. Refresh to see it, then make this change again.',
        'funnel_changed',
      );
    }
    const name = input.name ?? row.name;
    if (name.toLowerCase() !== row.name.toLowerCase()) await refuseTakenName(ctx, name, row.id);
    const pipeline = await pipelineOf(ctx.tx, row.pipelineId);
    const def = input.definition;
    await checkParts(ctx, def, pipeline);
    const before = definitionOf(row);
    const stageName = (id: string) => pipeline.stages.find((s) => s.id === id)?.name ?? 'a stage';

    // People at a stage taken out go where the person saving said.
    const kept = new Set(def.stages.map((s) => s.stageId));
    const open = new Set(openStagesOf(def, pipeline.stages).map((s) => s.id));
    const gone = before.stages.map((s) => s.stageId).filter((id) => !kept.has(id));
    const at = gone.length
      ? await rows<{ stage_id: string; n: number }>(
          ctx.tx,
          sql`select stage_id, count(*)::int as n from app.funnel_people
              where funnel_id = ${row.id} and status in ('active', 'paused')
                and stage_id = any(${uuidArray(gone)})
              group by stage_id`,
        )
      : [];
    for (const a of at) {
      const to = input.moveFrom?.[a.stage_id];
      const who = a.n === 1 ? 'Someone is' : `${a.n} people are`;
      if (!to)
        throw HfosError.rule(
          'funnel_stage_has_people',
          409,
          `${who} at ${stageName(a.stage_id)}, which you took out of the funnel. Pick the stage they go to instead, then save.`,
        );
      if (!open.has(to))
        throw HfosError.validation([
          {
            path: `moveFrom.${a.stage_id}`,
            message: 'Pick an open stage that’s still in the funnel.',
          },
        ]);
      if (a.n > FUNNEL_MOVE_ON_SAVE_MAX)
        throw HfosError.rule(
          'funnel_stage_too_full',
          409,
          `${a.n} people are at ${stageName(a.stage_id)}, more than the ${FUNNEL_MOVE_ON_SAVE_MAX} a save moves at once. Move some on the Pipeline first, then take it out.`,
        );
    }

    // A funnel that's on keeps running, so it can't be saved with something that stops it.
    if (row.status === 'on') {
      const blocker = funnelBlocker(
        funnelIssues(def, await issueContextOf(ctx.tx, ws, row.pipelineId)).filter(
          (i) => i.rule !== 'no_teammate' && i.rule !== 'teammate_off',
        ),
      );
      if (blocker)
        throw HfosError.rule(
          'funnel_not_ready',
          409,
          `${row.name} is on, so it can’t be saved like this. ${blocker.words}`,
        );
    }

    const revision = row.revision + 1;
    try {
      await ctx.tx
        .update(funnels)
        .set({ name, definition: def, revision, updatedBy: me })
        .where(eq(funnels.id, row.id));
    } catch (e) {
      if (isUniqueViolation(e, 'funnels_name_unique')) throw nameTaken(name);
      throw e;
    }
    // Now that the funnel has their new stage, move their leads there; the funnel follows each.
    for (const a of at) {
      const to = input.moveFrom![a.stage_id]!;
      const people = await ctx.tx
        .select()
        .from(funnelPeople)
        .where(
          and(
            eq(funnelPeople.funnelId, row.id),
            eq(funnelPeople.stageId, a.stage_id),
            inArray(funnelPeople.status, ['active', 'paused']),
          ),
        );
      for (const p of people) {
        const [lead] = p.leadId
          ? await ctx.tx
              .select({ status: leads.status, archivedAt: leads.archivedAt })
              .from(leads)
              .where(eq(leads.id, p.leadId))
          : [];
        if (!lead || lead.archivedAt || lead.status !== 'open') {
          await leaveFunnel(ctx, p, { id: row.id, name }, 'lead_gone');
          continue;
        }
        await executeCommandWithin(ctx, leadMoveStage, {
          workspaceId: ws,
          leadId: p.leadId!,
          stageId: to,
        });
      }
    }
    await ctx.emit({
      type: 'funnel.saved',
      entityType: 'funnel',
      entityId: row.id,
      payload: {
        funnelId: row.id,
        revision,
        status: row.status,
        changedStageIds: changedStages(before, def),
        removedStageIds: gone,
      },
      before: { name: row.name, revision: row.revision },
      after: { name, revision },
    });
    return { funnelId: row.id, revision };
  },
});

export const funnelTurnOn = defineCommand({
  name: 'funnel.turn_on',
  description:
    'Turn a funnel on, so its rules take people in and the AI teammate follows it. Refused while something stops it from running.',
  risk: 2,
  input: FunnelTurnOnInput,
  output: FunnelTurnOnOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['funnel.turned_on'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    const row = await requireFunnel(ctx.tx, ws, input.funnelId, { forUpdate: true });
    const def = definitionOf(row);
    const blocker = funnelBlocker(
      funnelIssues(def, await issueContextOf(ctx.tx, ws, row.pipelineId)),
    );
    if (blocker) throw HfosError.rule('funnel_not_ready', 409, blocker.words);
    if (row.status === 'on' && !input.addExisting)
      return { funnelId: row.id, status: 'on' as const, adding: 0 };
    if (row.status !== 'on')
      await ctx.tx
        .update(funnels)
        .set({ status: 'on', turnedOnAt: new Date(), updatedBy: me })
        .where(eq(funnels.id, row.id));
    const pipeline = await pipelineOf(ctx.tx, row.pipelineId);
    const adding = input.addExisting
      ? await waitingLeadCount(
          ctx.tx,
          row.pipelineId,
          openStagesOf(def, pipeline.stages).map((s) => s.id),
        )
      : 0;
    await ctx.emit({
      type: 'funnel.turned_on',
      entityType: 'funnel',
      entityId: row.id,
      payload: {
        funnelId: row.id,
        pipelineId: row.pipelineId,
        from: row.status,
        addExisting: input.addExisting,
      },
      before: { status: row.status },
      after: { status: 'on', ...(adding ? { adding } : {}) },
    });
    return { funnelId: row.id, status: 'on' as const, adding };
  },
});

export const funnelPause = defineCommand({
  name: 'funnel.pause',
  description:
    'Pause a funnel: it takes nobody in and sends nothing until it’s turned back on. People in it stay where they are.',
  risk: 1,
  input: FunnelPauseInput,
  output: FunnelPauseOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['funnel.paused'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const row = await requireFunnel(ctx.tx, ctx.scope.workspaceId!, input.funnelId, {
      forUpdate: true,
    });
    if (row.status !== 'on') return { funnelId: row.id, status: row.status as FunnelStatus };
    await ctx.tx
      .update(funnels)
      .set({ status: 'paused', updatedBy: me })
      .where(eq(funnels.id, row.id));
    await ctx.emit({
      type: 'funnel.paused',
      entityType: 'funnel',
      entityId: row.id,
      payload: { funnelId: row.id },
      before: { status: row.status },
      after: { status: 'paused' },
    });
    return { funnelId: row.id, status: 'paused' as const };
  },
});

export const funnelArchive = defineCommand({
  name: 'funnel.archive',
  description:
    'Archive a funnel: everyone in it leaves, nothing more is sent, and its pipeline and name are free for another.',
  risk: 2,
  input: FunnelArchiveInput,
  output: FunnelArchiveOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['funnel.archived'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const row = await requireFunnel(ctx.tx, ctx.scope.workspaceId!, input.funnelId, {
      forUpdate: true,
    });
    await ctx.tx
      .update(funnels)
      .set({ status: 'archived', updatedBy: me })
      .where(eq(funnels.id, row.id));
    const left = await ctx.tx
      .update(funnelPeople)
      .set({
        status: 'left',
        leftReason: 'funnel_archived',
        leftAt: new Date(),
        pausedReason: null,
      })
      .where(
        and(eq(funnelPeople.funnelId, row.id), inArray(funnelPeople.status, ['active', 'paused'])),
      )
      .returning({ id: funnelPeople.id });
    await ctx.tx
      .update(funnelPeople)
      .set({ status: 'declined' })
      .where(and(eq(funnelPeople.funnelId, row.id), eq(funnelPeople.status, 'suggested')));
    await ctx.emit({
      type: 'funnel.archived',
      entityType: 'funnel',
      entityId: row.id,
      payload: { funnelId: row.id, left: left.length },
      before: { name: row.name, status: row.status },
      after: { status: 'archived', ...(left.length ? { left: left.length } : {}) },
    });
    return { funnelId: row.id, left: left.length };
  },
});

// ---- Who's in it ----

export const funnelAddPerson = defineCommand({
  name: 'funnel.add_person',
  description:
    'Put a customer in a funnel, at their lead’s stage or where it starts. They leave any other funnel first, and get a lead in its pipeline if they have none.',
  risk: 1,
  input: FunnelAddPersonInput,
  output: FunnelAddPersonOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['funnel.person_added', 'funnel.person_left'],
  // HandsFreeOS adds people by the funnel's rules, and the leads already there when it's turned on.
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const funnel = await requireFunnel(ctx.tx, ctx.scope.workspaceId!, input.funnelId);
    const human = ctx.actor.type === 'human';
    if (
      input.addedBy &&
      (human ? input.addedBy !== 'hand' : input.addedBy !== 'rule' && input.addedBy !== 'turn_on')
    )
      throw HfosError.validation([
        {
          path: 'addedBy',
          message: human
            ? 'People add others by hand.'
            : 'HandsFreeOS adds people by a rule, or on turning it on.',
        },
      ]);
    const addedBy: FunnelAddedBy = human ? 'hand' : (input.addedBy ?? 'rule');
    if (human && !definitionOf(funnel).entry.byHand)
      throw HfosError.rule(
        'funnel_by_hand_off',
        409,
        `${funnel.name} doesn’t take people added by hand. Turn on “Add people by hand” in its step 3 under AI teammate → Funnels.`,
      );
    if (funnel.status === 'draft' || (funnel.status === 'paused' && !human)) throw notOn(funnel);
    const { row, already } = await addToFunnel(ctx, funnel, {
      personId: input.personId,
      leadId: input.leadId,
      stageId: input.stageId,
      addedBy,
    });
    return { funnelPersonId: row.id, leadId: row.leadId!, stageId: row.stageId!, already };
  },
});

export const funnelRemovePerson = defineCommand({
  name: 'funnel.remove_person',
  description:
    'Take a customer out of their funnel. Nothing more from it is sent to them; their lead stays where it is.',
  risk: 1,
  input: FunnelRemovePersonInput,
  output: FunnelRemovePersonOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['funnel.person_left'],
  // HandsFreeOS takes them out on STOP, or when their lead is archived or deleted.
  actors: ['human', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    if (input.reason && ctx.actor.type === 'human')
      throw HfosError.validation([
        { path: 'reason', message: 'Only HandsFreeOS gives a reason for taking someone out.' },
      ]);
    const row = await requireFunnelPerson(ctx.tx, ctx.scope.workspaceId!, input.funnelPersonId, {
      forUpdate: true,
    });
    if (row.status !== 'active' && row.status !== 'paused')
      return { funnelPersonId: row.id, changed: false };
    const reason: FunnelLeftReason = input.reason ?? 'removed';
    await leaveFunnel(ctx, row, await funnelOfRow(ctx, row), reason);
    return { funnelPersonId: row.id, changed: true };
  },
});

export const funnelPausePerson = defineCommand({
  name: 'funnel.pause_person',
  description:
    'Pause or pick up a customer’s funnel. Paused, nothing from it is sent to them, and only what they do (a booking, a join) moves them on; picked up, what’s still ahead is scheduled again.',
  risk: 1,
  input: FunnelPausePersonInput,
  output: FunnelPausePersonOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['funnel.paused_for_person', 'funnel.resumed_for_person'],
  // HandsFreeOS pauses it when someone on the team takes the conversation, and picks it up when it's handed back.
  actors: ['human', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    const human = ctx.actor.type === 'human';
    if (input.reason && human)
      throw HfosError.validation([
        { path: 'reason', message: 'Only HandsFreeOS gives a reason for pausing.' },
      ]);
    const row = await requireFunnelPerson(ctx.tx, ctx.scope.workspaceId!, input.funnelPersonId, {
      forUpdate: true,
    });
    // Paused by hand, it waits for a person: handing the conversation back doesn't pick it up.
    const stays = input.paused
      ? row.status !== 'active'
      : row.status !== 'paused' || (!human && row.pausedReason === 'by_hand');
    if (stays)
      return { funnelPersonId: row.id, status: row.status as FunnelPersonStatus, changed: false };
    const funnel = await funnelOfRow(ctx, row);
    const reason: FunnelPauseReason = human ? 'by_hand' : (input.reason ?? 'by_hand');
    await ctx.tx
      .update(funnelPeople)
      .set(
        input.paused
          ? { status: 'paused', pausedReason: reason }
          : { status: 'active', pausedReason: null },
      )
      .where(eq(funnelPeople.id, row.id));
    const eventId = await ctx.emit({
      type: input.paused ? 'funnel.paused_for_person' : 'funnel.resumed_for_person',
      entityType: 'funnel',
      entityId: funnel.id,
      payload: { ...personEvent(row), ...(input.paused ? { reason } : { was: row.pausedReason }) },
      after: { funnel: funnel.name, status: input.paused ? 'paused' : 'active' },
      broadcast: false,
    });
    await logSystemActivity(ctx, {
      subtype: input.paused ? 'funnel_paused' : 'funnel_resumed',
      personId: row.personId,
      leadId: row.leadId,
      body: funnel.name,
      meta: { funnel: funnel.name, funnelId: funnel.id, ...(input.paused ? { reason } : {}) },
      eventId,
    });
    return {
      funnelPersonId: row.id,
      status: input.paused ? ('paused' as const) : ('active' as const),
      changed: true,
    };
  },
});

export const funnelMovePerson = defineCommand({
  name: 'funnel.move_person',
  description:
    'Move a customer on in their funnel by one of their stage’s moves: their lead goes to that stage, and its messages start.',
  risk: 1,
  input: FunnelMovePersonInput,
  output: FunnelMovePersonOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: [],
  // HandsFreeOS by what it sees (a booking, a form, time passing); the teammate by what they write.
  actors: ['system', 'ai_employee'],
  async handler(ctx, input) {
    const row = await requireFunnelPerson(ctx.tx, ctx.scope.workspaceId!, input.funnelPersonId, {
      forUpdate: true,
    });
    const unchanged = {
      funnelPersonId: row.id,
      stageId: row.stageId ?? input.stageId,
      changed: false,
    };
    const live = row.status === 'active' || row.status === 'paused';
    if (!live || !row.leadId || !row.stageId || row.stageId === input.stageId) return unchanged;
    const ai = aiEmployeeOf(ctx.actor);
    if (ai) await assertAiReach(ctx, { personId: row.personId, leadId: row.leadId });
    const funnel = await funnelOfRow(ctx, row);
    const move = definitionOf(funnel)
      .stages.find((s) => s.stageId === row.stageId)
      ?.moves.find((m) => m.id === input.moveId);
    // Paused, what they do still says where they are (a booking, a join); time passing and the teammate don't.
    if (row.status === 'paused' && move?.kind !== 'event') return unchanged;
    if (!move || move.to !== input.stageId || (move.kind === 'reply') !== !!ai)
      throw HfosError.rule(
        'funnel_move_refused',
        409,
        'That move isn’t in their stage of the funnel anymore, so they weren’t moved. Someone may have just changed the funnel.',
      );
    const because = capital(input.because ?? funnelMoveCause(move));
    const pipeline = await pipelineOf(ctx.tx, funnel.pipelineId);
    const to = pipeline.stages.find((s) => s.id === input.stageId);
    const moved = await executeCommandWithin(ctx, leadMoveStage, {
      workspaceId: ctx.scope.workspaceId!,
      leadId: row.leadId,
      stageId: input.stageId,
      funnelId: funnel.id,
      because,
      ...(to?.kind === 'lost' ? { lostReason: because } : {}),
    });
    return {
      funnelPersonId: row.id,
      stageId: moved.output.stageId,
      changed: moved.output.stageId !== row.stageId,
    };
  },
});

export const funnelNoteProgress = defineCommand({
  name: 'funnel.note_progress',
  description:
    'Note what a customer did at their funnel stage, which of its messages went, and the booking it’s timed around.',
  risk: 0,
  input: FunnelNoteProgressInput,
  output: FunnelNoteProgressOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const row = await requireFunnelPerson(ctx.tx, ctx.scope.workspaceId!, input.funnelPersonId, {
      forUpdate: true,
    });
    // A note for the stage they've just left is dropped: the new stage starts afresh.
    if ((row.status !== 'active' && row.status !== 'paused') || row.stageId !== input.stageId)
      return { changed: false };
    const seen =
      input.seen && !row.seen.includes(input.seen)
        ? [...row.seen, input.seen].slice(-SEEN_MAX)
        : row.seen;
    const sent = [...new Set([...row.sent, ...(input.sent ?? [])])].slice(-SENT_MAX);
    const appointmentId =
      input.appointmentId === undefined ? row.appointmentId : input.appointmentId;
    if (seen === row.seen && sent.length === row.sent.length && appointmentId === row.appointmentId)
      return { changed: false };
    await ctx.tx
      .update(funnelPeople)
      .set({ seen, sent, appointmentId })
      .where(eq(funnelPeople.id, row.id));
    return { changed: true };
  },
});

// ---- The teammate's suggestions ----

export const funnelSuggest = defineCommand({
  name: 'funnel.suggest',
  description:
    'Suggest putting the customer in a funnel that fits them, with why. Someone on the team says yes or no on Approvals.',
  risk: 0,
  input: FunnelSuggestInput,
  output: FunnelSuggestOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['funnel.suggested'],
  actors: ['ai_employee', 'system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    await assertAiReach(ctx, { personId: input.personId });
    const funnel = await requireFunnel(ctx.tx, ws, input.funnelId);
    if (funnel.status !== 'on') throw notOn(funnel);
    if (!definitionOf(funnel).entry.aiSuggests)
      throw HfosError.rule(
        'funnel_suggestions_off',
        409,
        `${funnel.name} doesn’t take the teammate’s suggestions. Someone on the team can turn them on in its step 3.`,
      );
    await requirePerson(ctx.tx, ws, input.personId);
    // In it now, suggested already, or turned down before: nothing new.
    const [there] = await rows<{ id: string; status: string }>(
      ctx.tx,
      sql`select id, status from app.funnel_people
          where funnel_id = ${funnel.id} and person_id = ${input.personId}
            and status in ('active', 'paused', 'suggested', 'declined')
          order by created_at desc limit 1`,
    );
    if (there)
      return { funnelPersonId: there.status === 'declined' ? null : there.id, already: true };
    let row: FunnelPersonRow | undefined;
    try {
      [row] = await ctx.tx
        .insert(funnelPeople)
        .values({
          workspaceId: ws,
          funnelId: funnel.id,
          personId: input.personId,
          status: 'suggested',
          addedBy: 'ai',
          suggestedWhy: input.why,
        })
        .returning();
    } catch (e) {
      if (isUniqueViolation(e, 'funnel_people_one_suggestion'))
        return { funnelPersonId: null, already: true };
      throw e;
    }
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'funnel.suggested',
      entityType: 'funnel',
      entityId: funnel.id,
      payload: {
        funnelId: funnel.id,
        funnelPersonId: row.id,
        personId: input.personId,
        why: input.why,
      },
      after: { funnel: funnel.name, why: input.why },
    });
    return { funnelPersonId: row.id, already: false };
  },
});

export const funnelDecideSuggestion = defineCommand({
  name: 'funnel.decide_suggestion',
  description:
    'Say yes or no to the teammate’s suggestion of a funnel for a customer. Yes puts them in it, as adding them would.',
  risk: 1,
  input: FunnelDecideSuggestionInput,
  output: FunnelDecideSuggestionOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['funnel.person_added', 'funnel.person_left', 'funnel.suggestion_declined'],
  // Yes starts the funnel's messages to them.
  offline: { freshMinutes: FRESH_MINUTES },
  async handler(ctx, input) {
    const row = await requireFunnelPerson(ctx.tx, ctx.scope.workspaceId!, input.funnelPersonId, {
      forUpdate: true,
    });
    if (row.status !== 'suggested')
      return { funnelPersonId: row.id, status: row.status as FunnelPersonStatus };
    const funnel = await funnelOfRow(ctx, row);
    if (!input.accept) {
      await ctx.tx
        .update(funnelPeople)
        .set({ status: 'declined' })
        .where(eq(funnelPeople.id, row.id));
      await ctx.emit({
        type: 'funnel.suggestion_declined',
        entityType: 'funnel',
        entityId: funnel.id,
        payload: { funnelId: funnel.id, funnelPersonId: row.id, personId: row.personId },
        after: { funnel: funnel.name },
        broadcast: false,
      });
      return { funnelPersonId: row.id, status: 'declined' as const };
    }
    if (funnel.status !== 'on' && funnel.status !== 'paused') throw notOn(funnel);
    const { row: joined } = await addToFunnel(ctx, funnel, {
      personId: row.personId,
      addedBy: 'ai',
      suggestion: row,
    });
    return { funnelPersonId: joined.id, status: joined.status as FunnelPersonStatus };
  },
});

export const funnelCommands = [
  funnelCreate,
  funnelSave,
  funnelTurnOn,
  funnelPause,
  funnelArchive,
  funnelAddPerson,
  funnelRemovePerson,
  funnelPausePerson,
  funnelMovePerson,
  funnelNoteProgress,
  funnelSuggest,
  funnelDecideSuggestion,
] as const;
