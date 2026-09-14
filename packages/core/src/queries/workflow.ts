/**
 * Workflow reads (everyone in the workspace): the list (runs in the last 30 days, runs going now, the last
 * error, where it came from and whether its template has an update), one workflow with its draft, checks
 * computed now and versions, a version, the catalogs the editors check against, runs (keyset pages) and
 * one run's step log, approvals and AI builder proposals. Templates are the agency's.
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql as dsql } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  workflowProposals,
  workflows,
  workflowTemplates,
  workflowTemplateVersions,
  workflowVersions,
} from '@hfos/db/schema';
import { userNames, uuidArray } from '../calendar/load';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
import type { QueryContext } from '../kernel/types';
import { hasWorkspacePermission } from '../permissions';
import {
  WorkflowApprovalListInput,
  WorkflowApprovalListOutput,
  WorkflowCatalogsInput,
  WorkflowCatalogsOutput,
  WorkflowGetInput,
  WorkflowGetOutput,
  WorkflowListInput,
  WorkflowListOutput,
  WorkflowProposalGetInput,
  WorkflowProposalGetOutput,
  WorkflowRunGetInput,
  WorkflowRunGetOutput,
  WorkflowRunListInput,
  WorkflowRunListOutput,
  WorkflowStatsInput,
  WorkflowStatsOutput,
  WorkflowTemplateGetOutput,
  WorkflowTemplateListInput,
  WorkflowTemplateListOutput,
  WorkflowTemplateRefInput,
  WorkflowVersionGetInput,
  WorkflowVersionGetOutput,
  type WorkflowRunOut,
  type WorkflowSummaryOut,
} from '../schemas/workflow';
import { blankDefinition, type WorkflowDefinition } from '../workflows/definition';
import { describeOps, describeTrigger } from '../workflows/describe';
import {
  loadWorkflow,
  loadWorkflowCatalogs,
  parseStoredDefinition,
  recipeOf,
  workflowIssues,
  type LoadedWorkflowCatalogs,
  type WorkflowRow,
} from '../workflows/load';
import type { WorkflowOp } from '../workflows/ops';
import { placeholdersIn } from '../workflows/recipes';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const inOrganization = (i: { organizationId: string }) => ({
  kind: 'organization' as const,
  organizationId: i.organizationId,
});
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const SORT_KEY = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const textArray = (values: readonly string[]) =>
  sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
const userRef = (id: string | null, names: ReadonlyMap<string, string>) =>
  id ? { id, fullName: names.get(id) ?? 'Someone' } : null;
const asJson = (v: unknown) => (v ?? {}) as Record<string, unknown>;
const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const LIVE_SQL = sql`('running', 'waiting', 'awaiting_approval', 'held')`;

// ---- Summaries ----

type LastRun = NonNullable<WorkflowSummaryOut['lastRun']>;

interface SummaryData {
  readonly stats: Map<string, { runs30d: number; activeRuns: number }>;
  readonly errors: Map<string, { runId: string; stepKey: string; message: string; at: string }>;
  readonly lastRuns: Map<string, LastRun>;
  readonly versions: Map<string, { version: number; definition: WorkflowDefinition }>;
  readonly templates: Map<string, { name: string; latestVersion: number | null }>;
  readonly names: Map<string, string>;
  readonly catalogs: LoadedWorkflowCatalogs;
}

async function summaryData(tx: Tx, ws: string, list: readonly WorkflowRow[]): Promise<SummaryData> {
  const ids = list.map((w) => w.id);
  const stats = await rows<{ workflow_id: string; runs30d: number; active: number }>(
    tx,
    sql`select workflow_id,
          count(*) filter (where started_at > now() - interval '30 days')::int as runs30d,
          count(*) filter (where status in ${LIVE_SQL})::int as active
        from app.workflow_runs
        where workspace_id = ${ws} and not is_test and workflow_id = any(${uuidArray(ids)})
        group by workflow_id`,
  );
  const errors = await rows<{
    workflow_id: string;
    run_id: string;
    step_key: string;
    error: { message?: unknown } | null;
    updated_at: Date;
  }>(
    tx,
    sql`select distinct on (r.workflow_id) r.workflow_id, s.run_id, s.step_key, s.error, s.updated_at
        from app.workflow_run_steps s join app.workflow_runs r on r.id = s.run_id
        where s.workspace_id = ${ws} and s.status in ('failed', 'dead') and not r.is_test
          and r.workflow_id = any(${uuidArray(ids)})
        order by r.workflow_id, s.updated_at desc`,
  );
  const last = await rows<{
    workflow_id: string;
    id: string;
    status: LastRun['status'];
    started_at: Date;
    ended_at: Date | null;
    end_reason: string | null;
    person_id: string | null;
    person_name: string | null;
  }>(
    tx,
    sql`select distinct on (r.workflow_id) r.workflow_id, r.id, r.status::text as status, r.started_at,
          r.ended_at, r.end_reason, r.person_id,
          coalesce(nullif(btrim(p.first_name || ' ' || p.last_name), ''), 'Customer') as person_name
        from app.workflow_runs r left join app.people p on p.id = r.person_id
        where r.workspace_id = ${ws} and not r.is_test and r.workflow_id = any(${uuidArray(ids)})
        order by r.workflow_id, r.started_at desc, r.id desc`,
  );
  const versionIds = list.map((w) => w.activeVersionId).filter((v): v is string => !!v);
  const versions = versionIds.length
    ? await tx
        .select({
          id: workflowVersions.id,
          version: workflowVersions.version,
          definition: workflowVersions.definition,
        })
        .from(workflowVersions)
        .where(inArray(workflowVersions.id, versionIds))
    : [];
  const templates = list.some((w) => w.templateId)
    ? await rows<{ template_id: string; template_name: string; latest_version: number | null }>(
        tx,
        sql`select template_id, template_name, latest_version from private.installed_template_versions(${ws})`,
      )
    : [];
  return {
    stats: new Map(stats.map((s) => [s.workflow_id, { runs30d: s.runs30d, activeRuns: s.active }])),
    errors: new Map(
      errors.map((e) => [
        e.workflow_id,
        {
          runId: e.run_id,
          stepKey: e.step_key,
          message: typeof e.error?.message === 'string' ? e.error.message : 'A step failed.',
          at: iso(e.updated_at)!,
        },
      ]),
    ),
    lastRuns: new Map(
      last.map((r) => [
        r.workflow_id,
        {
          id: r.id,
          status: r.status,
          startedAt: iso(r.started_at)!,
          endedAt: iso(r.ended_at),
          endReason: r.end_reason,
          person: r.person_id ? { id: r.person_id, fullName: r.person_name ?? 'Customer' } : null,
        },
      ]),
    ),
    versions: new Map(
      versions.map((v) => [
        v.id,
        { version: v.version, definition: parseStoredDefinition(v.definition) },
      ]),
    ),
    templates: new Map(
      templates.map((t) => [
        t.template_id,
        { name: t.template_name, latestVersion: t.latest_version },
      ]),
    ),
    names: await userNames(
      tx,
      list.map((w) => w.createdBy).filter((u): u is string => !!u),
    ),
    catalogs: await loadWorkflowCatalogs(tx, ws),
  };
}

function summaryOf(
  row: WorkflowRow,
  draft: WorkflowDefinition,
  data: SummaryData,
): WorkflowSummaryOut {
  const published = row.activeVersionId ? data.versions.get(row.activeVersionId) : undefined;
  const indexed = published?.definition ?? draft;
  const template = row.templateId ? data.templates.get(row.templateId) : undefined;
  const recipe = row.templateId ? null : recipeOf(draft);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    revision: row.revision,
    testedRevision: row.testedRevision,
    tested: row.testedRevision === row.revision,
    activeVersion:
      row.activeVersionId && published
        ? { id: row.activeVersionId, version: published.version }
        : null,
    trigger: {
      kind: row.triggerKind,
      event: row.triggerEvent,
      summary: describeTrigger(indexed.trigger, data.catalogs),
    },
    calendarIds: row.calendarIds,
    allCalendars: row.allCalendars,
    reentry: row.reentry,
    source: row.templateId
      ? {
          kind: 'template',
          recipeKey: null,
          recipeName: null,
          template: {
            id: row.templateId,
            name: template?.name ?? 'Agency template',
            installedVersion: row.templateVersion,
            latestVersion: template?.latestVersion ?? null,
            updateAvailable:
              !!template?.latestVersion && (row.templateVersion ?? 0) < template.latestVersion,
          },
        }
      : recipe
        ? { kind: 'recipe', recipeKey: recipe.key, recipeName: recipe.name, template: null }
        : { kind: 'blank', recipeKey: null, recipeName: null, template: null },
    runs30d: data.stats.get(row.id)?.runs30d ?? 0,
    activeRuns: data.stats.get(row.id)?.activeRuns ?? 0,
    lastError: data.errors.get(row.id) ?? null,
    lastRun: data.lastRuns.get(row.id) ?? null,
    createdBy: userRef(row.createdBy, data.names),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const draftOf = (row: WorkflowRow): WorkflowDefinition => {
  try {
    return parseStoredDefinition(row.definition);
  } catch {
    return blankDefinition();
  }
};

// ---- Workflows ----

export const workflowList = defineQuery({
  name: 'workflow.list',
  description:
    'Every workflow with its trigger, status, runs in the last 30 days and going now, the last error, and where it came from (a recipe, or an agency template with “Update available”).',
  input: WorkflowListInput,
  output: WorkflowListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const list = await ctx.tx
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, ws),
          input.status?.length
            ? inArray(workflows.status, input.status)
            : input.includeArchived
              ? undefined
              : ne(workflows.status, 'archived'),
          input.calendarId
            ? dsql`(${input.calendarId}::uuid = any(${workflows.calendarIds}) or ${workflows.allCalendars})`
            : undefined,
        ),
      )
      .orderBy(asc(dsql`lower(${workflows.name})`), asc(workflows.id));
    const data = await summaryData(ctx.tx, ws, list);
    return { items: list.map((w) => summaryOf(w, draftOf(w), data)) };
  },
});

export const workflowGet = defineQuery({
  name: 'workflow.get',
  description:
    'One workflow: its draft and revision, whether that revision passed a test, its checks computed now, the live version, every version, and where it came from.',
  input: WorkflowGetInput,
  output: WorkflowGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const { row, definition } = await loadWorkflow(ctx.tx, ws, input.workflowId);
    const { issues } = await workflowIssues(ctx.tx, ws, definition);
    const data = await summaryData(ctx.tx, ws, [row]);
    const versions = await ctx.tx
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, row.id))
      .orderBy(desc(workflowVersions.version))
      .limit(100);
    const names = await userNames(
      ctx.tx,
      versions.map((v) => v.publishedBy).filter((u): u is string => !!u),
    );
    return {
      workflow: {
        ...summaryOf(row, definition, data),
        definition: definition as unknown as Record<string, unknown>,
        definitionVersion: row.definitionVersion,
        issues,
        installedRevision: row.installedRevision,
        changedSinceInstall:
          row.templateId !== null &&
          row.installedRevision !== null &&
          row.revision !== row.installedRevision,
      },
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        revision: v.revision,
        source: v.source,
        diff: strings(v.diffSummary),
        publishedBy: userRef(v.publishedBy, names),
        testRunId: v.testRunId,
        createdAt: v.createdAt.toISOString(),
      })),
    };
  },
});

export const workflowVersionGet = defineQuery({
  name: 'workflow.version_get',
  description: 'One published version of a workflow, with the definition it froze.',
  input: WorkflowVersionGetInput,
  output: WorkflowVersionGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [v] = await ctx.tx
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.workspaceId, input.workspaceId),
          eq(workflowVersions.workflowId, input.workflowId),
          eq(workflowVersions.version, input.version),
        ),
      );
    if (!v) throw HfosError.notFound('Version not found.');
    const names = await userNames(ctx.tx, v.publishedBy ? [v.publishedBy] : []);
    return {
      version: {
        id: v.id,
        workflowId: v.workflowId,
        version: v.version,
        revision: v.revision,
        source: v.source,
        diff: strings(v.diffSummary),
        publishedBy: userRef(v.publishedBy, names),
        testRunId: v.testRunId,
        createdAt: v.createdAt.toISOString(),
        definition: parseStoredDefinition(v.definition) as unknown as Record<string, unknown>,
      },
    };
  },
});

export const workflowCatalogs = defineQuery({
  name: 'workflow.catalogs',
  description:
    'What a workflow can refer to here (team, pipelines and stages, tags, calendars, services, other workflows) and whether texting is ready, for the editors’ checks.',
  input: WorkflowCatalogsInput,
  output: WorkflowCatalogsOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    return { catalogs: await loadWorkflowCatalogs(ctx.tx, input.workspaceId) };
  },
});

// ---- Runs ----

type RunRow = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  version_id: string | null;
  version: number | null;
  status: WorkflowRunOut['status'];
  is_test: boolean;
  test_mode: 'simulate' | 'send_to_me' | null;
  test_revision: number | null;
  person_id: string | null;
  person_name: string | null;
  lead_id: string | null;
  appointment_id: string | null;
  conversation_id: string | null;
  cursor: string | null;
  step_count: number;
  end_reason: string | null;
  depth: number;
  started_by: string | null;
  started_at: Date;
  ended_at: Date | null;
  sort_key: string;
};

const runColumns = sql`r.id, r.workflow_id, w.name as workflow_name, r.version_id, v.version, r.status::text as status,
  r.is_test, r.test_mode::text as test_mode, r.test_revision, r.person_id,
  coalesce(nullif(btrim(p.first_name || ' ' || p.last_name), ''), 'Customer') as person_name,
  r.lead_id, r.appointment_id, r.conversation_id, r."cursor" as cursor, r.step_count, r.end_reason, r.depth,
  r.started_by, r.started_at, r.ended_at, ${SORT_KEY(sql`r.started_at`)} as sort_key`;
const runJoins = sql`from app.workflow_runs r
  join app.workflows w on w.id = r.workflow_id
  left join app.workflow_versions v on v.id = r.version_id
  left join app.people p on p.id = r.person_id`;

const runOut = (r: RunRow): WorkflowRunOut => ({
  id: r.id,
  workflow: { id: r.workflow_id, name: r.workflow_name },
  versionId: r.version_id,
  version: r.version,
  status: r.status,
  isTest: r.is_test,
  testMode: r.test_mode,
  testRevision: r.test_revision,
  person: r.person_id ? { id: r.person_id, fullName: r.person_name ?? 'Customer' } : null,
  leadId: r.lead_id,
  appointmentId: r.appointment_id,
  conversationId: r.conversation_id,
  cursor: r.cursor,
  stepCount: r.step_count,
  endReason: r.end_reason,
  depth: r.depth,
  startedBy: r.started_by,
  startedAt: iso(r.started_at)!,
  endedAt: iso(r.ended_at),
});

export const workflowRunList = defineQuery({
  name: 'workflow.run_list',
  description:
    'Runs, newest first: one workflow’s or all, by status or customer. Test runs only when asked. Pages with a cursor.',
  input: WorkflowRunListInput,
  output: WorkflowRunListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const cursor = decodeCursor(input.cursor);
    const list = await rows<RunRow>(
      ctx.tx,
      sql`select ${runColumns} ${runJoins}
          where r.workspace_id = ${input.workspaceId}
            ${input.workflowId ? sql`and r.workflow_id = ${input.workflowId}` : sql``}
            ${input.status?.length ? sql`and r.status::text = any(${textArray(input.status)})` : sql``}
            ${input.personId ? sql`and r.person_id = ${input.personId}` : sql``}
            ${input.onlyTests ? sql`and r.is_test` : input.includeTests ? sql`` : sql`and not r.is_test`}
            ${input.startedAfter ? sql`and r.started_at >= ${input.startedAfter}::timestamptz` : sql``}
            ${input.startedBefore ? sql`and r.started_at < ${input.startedBefore}::timestamptz` : sql``}
            ${cursor ? sql`and (${SORT_KEY(sql`r.started_at`)}, r.id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
          order by r.started_at desc, r.id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return { items: result.items.map(runOut), nextCursor: result.nextCursor };
  },
});

export const workflowStats = defineQuery({
  name: 'workflow.stats',
  description:
    'Workflows today, for the list’s tiles: runs started today and going now, texts and emails sent today, texts holding for quiet hours, approvals to decide, and failed runs. Tests aside.',
  input: WorkflowStatsInput,
  output: WorkflowStatsOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    // "Today" starts at midnight where the business is.
    const today = sql`(date_trunc('day', now() at time zone w.timezone) at time zone w.timezone)`;
    const [runs] = await rows<{
      today: number;
      live: number;
      all30: number;
      waiting30: number;
      approval30: number;
      failed30: number;
    }>(
      ctx.tx,
      sql`select
            count(*) filter (where r.started_at >= ${today})::int as today,
            count(*) filter (where r.status in ${LIVE_SQL})::int as live,
            count(*) filter (where r.started_at > now() - interval '30 days')::int as all30,
            count(*) filter (where r.started_at > now() - interval '30 days' and r.status = 'waiting')::int as waiting30,
            count(*) filter (where r.started_at > now() - interval '30 days' and r.status = 'awaiting_approval')::int as approval30,
            count(*) filter (where r.started_at > now() - interval '30 days' and r.status = 'failed')::int as failed30
          from app.workflow_runs r join app.workspaces w on w.id = r.workspace_id
          where r.workspace_id = ${ws} and not r.is_test`,
    );
    const [steps] = await rows<{ sent: number; held: number }>(
      ctx.tx,
      sql`select
            count(*) filter (where s.status = 'done' and s.finished_at >= ${today} and s.output ? 'messageId')::int as sent,
            count(*) filter (where s.status = 'waiting' and s.output->>'held' = 'quiet_hours')::int as held
          from app.workflow_run_steps s
          join app.workflow_runs r on r.id = s.run_id
          join app.workspaces w on w.id = s.workspace_id
          where s.workspace_id = ${ws} and not r.is_test
            and (s.status = 'waiting' or s.finished_at >= now() - interval '2 days')`,
    );
    const approvals = await rows<{ total: number; name: string }>(
      ctx.tx,
      sql`select count(*) over ()::int as total,
            coalesce(nullif(btrim(p.first_name || ' ' || p.last_name), ''), 'Customer') as name
          from app.workflow_approvals a
          join app.workflow_runs r on r.id = a.run_id
          left join app.people p on p.id = r.person_id
          where a.workspace_id = ${ws} and a.status = 'pending' and not r.is_test
            and (a.expires_at is null or a.expires_at > now())
          order by a.created_at desc
          limit 3`,
    );
    const [failed] = await rows<{ id: string; name: string }>(
      ctx.tx,
      sql`select w.id, w.name from app.workflow_runs r join app.workflows w on w.id = r.workflow_id
          where r.workspace_id = ${ws} and not r.is_test and r.status = 'failed'
            and r.started_at > now() - interval '30 days'
          order by coalesce(r.ended_at, r.started_at) desc, r.id desc
          limit 1`,
    );
    return {
      runsToday: runs?.today ?? 0,
      liveRuns: runs?.live ?? 0,
      messagesToday: steps?.sent ?? 0,
      quietHoursHeld: steps?.held ?? 0,
      approvalsPending: approvals[0]?.total ?? 0,
      approvalCustomers: [...new Set(approvals.map((a) => a.name))].slice(0, 2),
      failedRuns: runs?.failed30 ?? 0,
      failedWorkflow: failed ? { id: failed.id, name: failed.name } : null,
      runs30d: {
        all: runs?.all30 ?? 0,
        waiting: runs?.waiting30 ?? 0,
        awaitingApproval: runs?.approval30 ?? 0,
        failed: runs?.failed30 ?? 0,
      },
    };
  },
});

type ApprovalRow = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  run_id: string;
  step_key: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  approvers: string[];
  preview: Record<string, unknown> | null;
  edits: Record<string, unknown> | null;
  reason: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  via: string | null;
  expires_at: Date | null;
  created_at: Date;
  person_id: string | null;
  person_name: string | null;
  sort_key: string;
};

const approvalSelect = sql`select a.id, a.workflow_id, w.name as workflow_name, a.run_id, a.step_key,
    a.status::text as status, a.approvers, a.preview, a.edits, a.reason, a.decided_by, a.decided_at, a.via,
    a.expires_at, a.created_at, r.person_id,
    coalesce(nullif(btrim(p.first_name || ' ' || p.last_name), ''), 'Customer') as person_name,
    ${SORT_KEY(sql`a.created_at`)} as sort_key
  from app.workflow_approvals a
  join app.workflows w on w.id = a.workflow_id
  join app.workflow_runs r on r.id = a.run_id
  left join app.people p on p.id = r.person_id`;

async function approvalsOut(ctx: QueryContext, list: readonly ApprovalRow[]) {
  const me = requireHuman(ctx).userId;
  const manages = hasWorkspacePermission(ctx.scope.workspaceRole, 'workflows.manage');
  const names = await userNames(ctx.tx, [
    ...list.flatMap((a) => a.approvers),
    ...list.map((a) => a.decided_by).filter((u): u is string => !!u),
  ]);
  const now = Date.now();
  return list.map((a) => ({
    id: a.id,
    workflow: { id: a.workflow_id, name: a.workflow_name },
    runId: a.run_id,
    stepKey: a.step_key,
    status: a.status,
    approvers: a.approvers.map((id) => ({ id, fullName: names.get(id) ?? 'Someone' })),
    preview: asJson(a.preview),
    edits: a.edits,
    reason: a.reason,
    decidedBy: userRef(a.decided_by, names),
    decidedAt: iso(a.decided_at),
    via: a.via,
    expiresAt: iso(a.expires_at),
    createdAt: iso(a.created_at)!,
    person: a.person_id ? { id: a.person_id, fullName: a.person_name ?? 'Customer' } : null,
    canDecide:
      a.status === 'pending' &&
      (!a.expires_at || new Date(a.expires_at).getTime() > now) &&
      (manages || a.approvers.includes(me)),
  }));
}

export const workflowRunGet = defineQuery({
  name: 'workflow.run_get',
  description:
    'One run: whom it is for, where it stands, its variables, the definition it follows, every step it logged, and its approvals.',
  input: WorkflowRunGetInput,
  output: WorkflowRunGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [run] = await rows<
      RunRow & {
        context: Record<string, unknown>;
        visits: Record<string, number>;
        waiting_for: string[];
        stop_on: string[];
        origin_run_id: string | null;
        trigger_event_id: string | null;
        definition: Record<string, unknown> | null;
        test_definition: Record<string, unknown> | null;
      }
    >(
      ctx.tx,
      sql`select ${runColumns}, r.context, r.visits, r.waiting_for, r.stop_on, r.origin_run_id,
            r.trigger_event_id, v.definition, r.test_definition
          ${runJoins}
          where r.workspace_id = ${input.workspaceId} and r.id = ${input.runId}`,
    );
    if (!run) throw HfosError.notFound('Run not found.');
    const steps = await rows<{
      id: string;
      step_key: string;
      status: 'running' | 'done' | 'skipped' | 'waiting' | 'failed' | 'dead';
      attempt: number;
      input: Record<string, unknown> | null;
      output: Record<string, unknown> | null;
      error: Record<string, unknown> | null;
      event_ids: string[];
      next_step_key: string | null;
      tokens: number;
      started_at: Date;
      finished_at: Date | null;
    }>(
      ctx.tx,
      sql`select id, step_key, status::text as status, attempt, input, output, error, event_ids, next_step_key,
            tokens, started_at, finished_at
          from app.workflow_run_steps where run_id = ${run.id}
          order by started_at, created_at, id`,
    );
    const approvals = await rows<ApprovalRow>(
      ctx.tx,
      sql`${approvalSelect} where a.run_id = ${run.id} order by a.created_at, a.id`,
    );
    const definition = run.definition ?? run.test_definition;
    return {
      run: {
        ...runOut(run),
        context: asJson(run.context),
        visits: run.visits ?? {},
        waitingFor: run.waiting_for ?? [],
        stopOn: run.stop_on ?? [],
        originRunId: run.origin_run_id,
        triggerEventId: run.trigger_event_id,
      },
      definition: definition
        ? (parseStoredDefinition(definition) as unknown as Record<string, unknown>)
        : null,
      steps: steps.map((s) => ({
        id: s.id,
        stepKey: s.step_key,
        status: s.status,
        attempt: s.attempt,
        input: s.input,
        output: s.output,
        error: s.error,
        eventIds: s.event_ids ?? [],
        nextStepKey: s.next_step_key,
        tokens: s.tokens,
        startedAt: iso(s.started_at)!,
        finishedAt: iso(s.finished_at),
      })),
      approvals: await approvalsOut(ctx, approvals),
    };
  },
});

export const workflowApprovalList = defineQuery({
  name: 'workflow.approval_list',
  description:
    'Workflow approvals (pending unless asked), newest first, with what will happen and whether you can decide each. Pages with a cursor.',
  input: WorkflowApprovalListInput,
  output: WorkflowApprovalListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const cursor = decodeCursor(input.cursor);
    const list = await rows<ApprovalRow>(
      ctx.tx,
      sql`${approvalSelect}
          where a.workspace_id = ${input.workspaceId} and a.status::text = ${input.status}
            ${input.workflowId ? sql`and a.workflow_id = ${input.workflowId}` : sql``}
            ${cursor ? sql`and (${SORT_KEY(sql`a.created_at`)}, a.id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
          order by a.created_at desc, a.id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return { items: await approvalsOut(ctx, result.items), nextCursor: result.nextCursor };
  },
});

export const workflowProposalGet = defineQuery({
  name: 'workflow.proposal_get',
  description:
    'An AI builder proposal: what was asked, its ops in plain words against the draft it was written for, and whether it can still be applied.',
  input: WorkflowProposalGetInput,
  output: WorkflowProposalGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const [p] = await ctx.tx
      .select()
      .from(workflowProposals)
      .where(
        and(eq(workflowProposals.id, input.proposalId), eq(workflowProposals.workspaceId, ws)),
      );
    if (!p) throw HfosError.notFound('Proposal not found.');
    const current = p.workflowId ? await loadWorkflow(ctx.tx, ws, p.workflowId) : null;
    const catalogs = await loadWorkflowCatalogs(ctx.tx, ws);
    const names = await userNames(ctx.tx, p.createdBy ? [p.createdBy] : []);
    return {
      proposal: {
        id: p.id,
        workflowId: p.workflowId,
        baseRevision: p.baseRevision,
        prompt: p.prompt,
        ops: p.ops.map(asJson),
        summary: p.summary,
        unsupported: strings(p.unsupported),
        changes: describeOps(
          p.ops as unknown as WorkflowOp[],
          current?.definition ?? blankDefinition(),
          catalogs,
        ),
        stale: current !== null && current.row.revision !== p.baseRevision,
        expired: p.expiresAt.getTime() < Date.now(),
        appliedAt: iso(p.appliedAt),
        createdBy: userRef(p.createdBy, names),
        expiresAt: p.expiresAt.toISOString(),
        createdAt: p.createdAt.toISOString(),
      },
    };
  },
});

// ---- Agency templates ----

type TemplateRow = typeof workflowTemplates.$inferSelect;
type InstallCounts = {
  template_id: string;
  total: number;
  installed: number;
  pending: number;
  failed: number;
  behind: number;
};

async function installCounts(tx: Tx, templateIds: readonly string[]) {
  const list = await rows<InstallCounts>(
    tx,
    sql`select i.template_id, count(*)::int as total,
          count(*) filter (where i.status = 'installed')::int as installed,
          count(*) filter (where i.status = 'pending')::int as pending,
          count(*) filter (where i.status = 'failed')::int as failed,
          count(*) filter (where i.status = 'installed' and t.latest_version is not null
            and coalesce(i.installed_version, 0) < t.latest_version)::int as behind
        from app.workflow_template_installs i join app.workflow_templates t on t.id = i.template_id
        where i.template_id = any(${uuidArray(templateIds)})
        group by i.template_id`,
  );
  return new Map(list.map((c) => [c.template_id, c]));
}

function templateSummary(
  t: TemplateRow,
  counts: Map<string, InstallCounts>,
  names: ReadonlyMap<string, string>,
) {
  const c = counts.get(t.id);
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    revision: t.revision,
    latestVersion: t.latestVersion,
    archivedAt: iso(t.archivedAt),
    installs: {
      total: c?.total ?? 0,
      installed: c?.installed ?? 0,
      pending: c?.pending ?? 0,
      failed: c?.failed ?? 0,
      behind: c?.behind ?? 0,
    },
    createdBy: userRef(t.createdBy, names),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export const workflowTemplateList = defineQuery({
  name: 'workflow_template.list',
  description:
    'The agency’s workflow templates with their newest version and installs (installed, pending, failed, behind).',
  input: WorkflowTemplateListInput,
  output: WorkflowTemplateListOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  async handler(ctx, input) {
    const list = await ctx.tx
      .select()
      .from(workflowTemplates)
      .where(
        and(
          eq(workflowTemplates.organizationId, input.organizationId),
          input.includeArchived ? undefined : isNull(workflowTemplates.archivedAt),
        ),
      )
      .orderBy(asc(dsql`lower(${workflowTemplates.name})`), asc(workflowTemplates.id));
    const counts = await installCounts(
      ctx.tx,
      list.map((t) => t.id),
    );
    const names = await userNames(
      ctx.tx,
      list.map((t) => t.createdBy).filter((u): u is string => !!u),
    );
    return { items: list.map((t) => templateSummary(t, counts, names)) };
  },
});

export const workflowTemplateGet = defineQuery({
  name: 'workflow_template.get',
  description:
    'One agency template: its definition and placeholders, versions, and each business it was pushed to (with its mapping and whether it is behind).',
  input: WorkflowTemplateRefInput,
  output: WorkflowTemplateGetOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  async handler(ctx, input) {
    const [t] = await ctx.tx
      .select()
      .from(workflowTemplates)
      .where(
        and(
          eq(workflowTemplates.id, input.templateId),
          eq(workflowTemplates.organizationId, input.organizationId),
        ),
      );
    if (!t) throw HfosError.notFound('Template not found.');
    const def = parseStoredDefinition(t.definition);
    const versions = await ctx.tx
      .select()
      .from(workflowTemplateVersions)
      .where(eq(workflowTemplateVersions.templateId, t.id))
      .orderBy(desc(workflowTemplateVersions.version));
    const installs = await rows<{
      id: string;
      workspace_id: string;
      workspace_name: string;
      workflow_id: string | null;
      installed_version: number | null;
      status: 'pending' | 'installed' | 'failed';
      last_error: string | null;
      mapping: Record<string, unknown>;
      pushed_by: string | null;
      pushed_at: Date | null;
      installed_at: Date | null;
    }>(
      ctx.tx,
      sql`select i.id, i.workspace_id, w.name as workspace_name, i.workflow_id, i.installed_version,
            i.status::text as status, i.last_error, i.mapping, i.pushed_by, i.pushed_at, i.installed_at
          from app.workflow_template_installs i join app.workspaces w on w.id = i.workspace_id
          where i.template_id = ${t.id}
          order by lower(w.name), i.id`,
    );
    const names = await userNames(ctx.tx, [
      ...(t.createdBy ? [t.createdBy] : []),
      ...versions.map((v) => v.publishedBy).filter((u): u is string => !!u),
      ...installs.map((i) => i.pushed_by).filter((u): u is string => !!u),
    ]);
    const counts = await installCounts(ctx.tx, [t.id]);
    return {
      template: {
        ...templateSummary(t, counts, names),
        definition: def as unknown as Record<string, unknown>,
        placeholders: placeholdersIn(def),
      },
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        diff: strings(v.diffSummary),
        publishedBy: userRef(v.publishedBy, names),
        createdAt: v.createdAt.toISOString(),
      })),
      installs: installs.map((i) => ({
        id: i.id,
        workspaceId: i.workspace_id,
        workspaceName: i.workspace_name,
        workflowId: i.workflow_id,
        installedVersion: i.installed_version,
        status: i.status,
        lastError: i.last_error,
        behind:
          i.status === 'installed' &&
          t.latestVersion !== null &&
          (i.installed_version ?? 0) < t.latestVersion,
        mapping: i.mapping ?? {},
        pushedBy: userRef(i.pushed_by, names),
        pushedAt: iso(i.pushed_at),
        installedAt: iso(i.installed_at),
      })),
    };
  },
});
