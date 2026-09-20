/**
 * Server-side workflow helpers: the catalogs a definition is checked against, one workflow with its draft
 * parsed, the trigger index columns, recognising the recipe a workflow came from, and names for display.
 * Reads the database, so it is exported from '@hfos/core/server' only (workflows/index.ts stays browser-safe).
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { calendars, pipelineStages, pipelines, services, tags, workflows } from '@hfos/db/schema';
import { uuidArray, workspaceZone } from '../calendar/load';
import { HfosError } from '../errors';
import { defaultNumber, loadRegistrations, readiness } from '../messaging/store';
import { parseDefinition, type WorkflowDefinition } from './definition';
import { recipeDefinition, WORKFLOW_RECIPES, type WorkflowRecipe } from './recipes';
import { listRefs } from './refs';
import { validateWorkflow, type WorkflowCatalogs, type WorkflowIssue } from './rules';
import { allSteps } from './walk';

/** Catalogs with every optional list filled in. */
export interface LoadedWorkflowCatalogs extends WorkflowCatalogs {
  readonly services: NonNullable<WorkflowCatalogs['services']>;
  readonly workflows: NonNullable<WorkflowCatalogs['workflows']>;
}

/** The people a definition names (assignees, approvers, notify lists, conditions). */
export function refUserIds(def: WorkflowDefinition): string[] {
  return [
    ...new Set(
      listRefs(def)
        .filter((s) => s.kind === 'user' && typeof s.value === 'string')
        .map((s) => s.value as string),
    ),
  ];
}

/**
 * Everything a workflow can refer to in one workspace: the team (current members, plus anyone a definition
 * still names, marked inactive once they leave), pipelines and stages, tags, calendars, services, the other
 * workflows, and whether texting is ready.
 */
export async function loadWorkflowCatalogs(
  tx: Tx,
  workspaceId: string,
  opts: { readonly extraUserIds?: readonly string[] } = {},
): Promise<LoadedWorkflowCatalogs> {
  const team = await rows<{ id: string; name: string | null; active: boolean }>(
    tx,
    sql`with ids as (
          select wm.user_id from app.workspace_memberships wm where wm.workspace_id = ${workspaceId}
          union select unnest(${uuidArray(opts.extraUserIds ?? [])})
        )
        select ids.user_id as id, coalesce(nullif(u.full_name, ''), u.email::text) as name,
          private.workspace_has_user(${workspaceId}, ids.user_id) as active
        from ids left join app.users u on u.id = ids.user_id`,
  );
  const pipelineList = await tx
    .select({ id: pipelines.id, name: pipelines.name, archivedAt: pipelines.archivedAt })
    .from(pipelines)
    .where(eq(pipelines.workspaceId, workspaceId))
    .orderBy(asc(pipelines.position));
  const stageList = await tx
    .select({
      id: pipelineStages.id,
      pipelineId: pipelineStages.pipelineId,
      name: pipelineStages.name,
    })
    .from(pipelineStages)
    .where(eq(pipelineStages.workspaceId, workspaceId))
    .orderBy(asc(pipelineStages.position));
  const tagList = await tx
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.workspaceId, workspaceId))
    .orderBy(asc(tags.name));
  const calendarList = await tx
    .select({ id: calendars.id, name: calendars.name, status: calendars.status })
    .from(calendars)
    .where(eq(calendars.workspaceId, workspaceId))
    .orderBy(asc(calendars.name));
  const serviceList = await tx
    .select({ id: services.id, name: services.name, archivedAt: services.archivedAt })
    .from(services)
    .where(eq(services.workspaceId, workspaceId))
    .orderBy(asc(services.name));
  const workflowList = await tx
    .select({ id: workflows.id, name: workflows.name })
    .from(workflows)
    .where(and(eq(workflows.workspaceId, workspaceId), ne(workflows.status, 'archived')))
    .orderBy(asc(workflows.name));
  const number = await defaultNumber(tx, workspaceId);
  const regs = await loadRegistrations(tx, workspaceId);
  return {
    timeZone: await workspaceZone(tx, workspaceId),
    team: team
      .map((r) => ({ userId: r.id, name: r.name ?? 'Someone', active: r.active }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    pipelines: pipelineList.map((p) => ({
      id: p.id,
      name: p.name,
      archived: p.archivedAt !== null,
      stages: stageList
        .filter((s) => s.pipelineId === p.id)
        .map((s) => ({ id: s.id, name: s.name, archived: false })),
    })),
    tags: tagList.map((t) => ({ id: t.id, name: String(t.name) })),
    calendars: calendarList.map((c) => ({
      id: c.id,
      name: c.name,
      archived: c.status === 'archived',
    })),
    services: serviceList.map((s) => ({ id: s.id, name: s.name, archived: s.archivedAt !== null })),
    workflows: workflowList,
    textingReady: readiness(number, regs).messagingReady,
  };
}

/** Validates a definition against the workspace as it is now. */
export async function workflowIssues(
  tx: Tx,
  workspaceId: string,
  def: WorkflowDefinition,
): Promise<{ issues: WorkflowIssue[]; catalogs: LoadedWorkflowCatalogs }> {
  const catalogs = await loadWorkflowCatalogs(tx, workspaceId, { extraUserIds: refUserIds(def) });
  return { issues: validateWorkflow(def, catalogs, Date.now()), catalogs };
}

export type WorkflowRow = typeof workflows.$inferSelect;

export interface LoadedWorkflow {
  readonly row: WorkflowRow;
  /** The draft, upgraded and parsed with every default. */
  readonly definition: WorkflowDefinition;
}

/** A stored definition (a draft, a version, a template), parsed; a broken one is our fault, not the caller's. */
export function parseStoredDefinition(raw: unknown): WorkflowDefinition {
  try {
    return parseDefinition(raw);
  } catch {
    throw HfosError.internal('This workflow’s saved steps can’t be read.');
  }
}

/** One workflow with its draft parsed. `forUpdate` locks the row (people who manage workflows only). */
export async function loadWorkflow(
  tx: Tx,
  workspaceId: string,
  workflowId: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<LoadedWorkflow> {
  const query = tx
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)));
  const [row] = opts.forUpdate ? await query.for('update') : await query;
  if (!row) throw HfosError.notFound('Workflow not found.');
  return { row, definition: parseStoredDefinition(row.definition) };
}

/** The columns the dispatcher matches on, copied from a definition's trigger. */
export interface TriggerIndex {
  readonly triggerKind: WorkflowDefinition['trigger']['kind'];
  /** The event that starts it, or the date anchor a date trigger counts from ('appointment.ends_at'). */
  readonly triggerEvent: string | null;
  /** Every calendar the definition names (the trigger's filter, booking links). */
  readonly calendarIds: string[];
  /** An appointment trigger whose filter names no calendar: every calendar, now and later. */
  readonly allCalendars: boolean;
  readonly reentry: WorkflowDefinition['settings']['reentry']['mode'];
}

export function triggerIndex(def: WorkflowDefinition): TriggerIndex {
  const t = def.trigger;
  const triggerEvent = t.kind === 'event' ? t.event : t.kind === 'date' ? t.anchor : null;
  const sites = listRefs(def).filter((s) => s.kind === 'calendar');
  const calendarIds = [
    ...new Set(sites.map((s) => s.value).filter((v): v is string => typeof v === 'string')),
  ].slice(0, 200);
  const watchesAppointments = triggerEvent?.startsWith('appointment.') ?? false;
  return {
    triggerKind: t.kind,
    triggerEvent,
    calendarIds,
    allCalendars: watchesAppointments && !sites.some((s) => s.stepId === null),
    reentry: def.settings.reentry.mode,
  };
}

let recipeStepIds: Map<string, Set<string>> | undefined;

/**
 * The recipe a workflow came from, recognised by the recipe's fixed step ids (new steps get random ids, so
 * they never match). The recipe that shares the most steps wins; null when none does.
 */
export function recipeOf(def: WorkflowDefinition): WorkflowRecipe | null {
  recipeStepIds ??= new Map(
    WORKFLOW_RECIPES.map((r) => [
      r.key,
      new Set(allSteps(recipeDefinition(r.key)).map((l) => l.step.id)),
    ]),
  );
  let best: WorkflowRecipe | null = null;
  let bestCount = 0;
  const ids = allSteps(def).map((l) => l.step.id);
  for (const recipe of WORKFLOW_RECIPES) {
    const own = recipeStepIds.get(recipe.key)!;
    const count = ids.filter((id) => own.has(id)).length;
    if (count > bestCount) {
      best = recipe;
      bestCount = count;
    }
  }
  return best;
}

/** Customers' display names ('Customer' when blank or not visible). */
export async function personNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  const map = new Map<string, string>();
  if (!wanted.length) return map;
  const list = await rows<{ id: string; name: string }>(
    tx,
    sql`select p.id, coalesce(nullif(btrim(p.first_name || ' ' || p.last_name), ''), 'Customer') as name
        from app.people p where p.id = any(${uuidArray(wanted)})`,
  );
  for (const r of list) map.set(r.id, r.name);
  for (const id of wanted) if (!map.has(id)) map.set(id, 'Customer');
  return map;
}
