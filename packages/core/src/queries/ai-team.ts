/**
 * The AI teammate's queries (M7): the teammate with its issues, progress, revisions and catalogs (the
 * builder), its drafts (Approvals and the inbox), and what it has been doing (Activity).
 */
import { and, desc, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { aiTeammateRevisions } from '@hfos/db/schema';
import {
  loadTeammate,
  loadTeammateCatalogs,
  teammateConfigOf,
  teammateProgressOf,
  teammateUserIds,
} from '../ai-team/load';
import type { TeammateCatalogs } from '../ai-team/catalogs';
import { isPatchFix, validateTeammate, type TeammateIssue } from '../ai-team/rules';
import { userNames } from '../calendar/load';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
import { workspaceMessaging } from '../messaging/store';
import { hasWorkspacePermission } from '../permissions';
import {
  AiTeammateActivityInput,
  AiTeammateActivityOutput,
  AiTeammateDraftListInput,
  AiTeammateDraftListOutput,
  AiTeammateGetInput,
  AiTeammateGetOutput,
  TeammateDraftEdits,
  TeammateDraftPreview,
  type TeammateDraftOut,
} from '../schemas/ai-team';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** The catalogs and issues as plain (mutable) lists, the shape the output schema describes. */
const catalogsOut = (c: TeammateCatalogs) => ({
  ...c,
  emailAddresses: [...c.emailAddresses],
  chatWidgets: [...c.chatWidgets],
  calendars: [...c.calendars],
  businessHours: c.businessHours ? [...c.businessHours] : null,
  members: [...c.members],
  newLeadTextWorkflows: [...c.newLeadTextWorkflows],
  pipelines: c.pipelines?.map((p) => ({ ...p, stages: [...p.stages] })),
});
const issuesOut = (issues: readonly TeammateIssue[]) =>
  issues.map((i) => ({
    ...i,
    fields: [...i.fields],
    fixes: i.fixes.map((f) =>
      isPatchFix(f) ? { ...f, patch: f.patch as Record<string, unknown> } : { ...f },
    ),
  }));
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const SORT_KEY = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const aiTeammateGet = defineQuery({
  name: 'ai_teammate.get',
  description:
    'The business’s AI teammate: its settings, what conflicts in them (with fixes), its training progress, its revisions, and the catalogs its settings refer to.',
  input: AiTeammateGetInput,
  output: AiTeammateGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const row = await loadTeammate(ctx.tx, input.workspaceId);
    const config = row ? teammateConfigOf(row) : null;
    const loaded = await loadTeammateCatalogs(ctx.tx, input.workspaceId, {
      extraUserIds: config ? teammateUserIds(config) : [],
    });
    const catalogs = catalogsOut(loaded);
    const canManage = hasWorkspacePermission(ctx.scope.workspaceRole, 'ai_team.manage');
    if (!row || !config)
      return { teammate: null, issues: [], progress: null, revisions: [], catalogs, canManage };
    const revs = await ctx.tx
      .select()
      .from(aiTeammateRevisions)
      .where(
        and(
          eq(aiTeammateRevisions.teammateId, row.id),
          eq(aiTeammateRevisions.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(desc(aiTeammateRevisions.revision))
      .limit(50);
    const names = await userNames(
      ctx.tx,
      revs.map((r) => r.changedBy).filter((id): id is string => !!id),
    );
    return {
      teammate: {
        id: row.id,
        name: row.name,
        status: row.status,
        config: config as unknown as Record<string, unknown>,
        configVersion: row.configVersion,
        revision: row.revision,
        labels: row.labels,
        trainingStartedAt: iso(row.trainingStartedAt),
        automaticSince: iso(row.automaticSince),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      issues: issuesOut(validateTeammate(config, loaded, Date.now())),
      progress: teammateProgressOf(row),
      revisions: revs.map((r) => ({
        revision: r.revision,
        labels: r.labels,
        diffSummary: (r.diffSummary as unknown[]).filter((s): s is string => typeof s === 'string'),
        changedBy: r.changedBy
          ? { id: r.changedBy, fullName: names.get(r.changedBy) ?? 'Former member' }
          : null,
        createdAt: r.createdAt.toISOString(),
      })),
      catalogs,
      canManage,
    };
  },
});

type DraftRow = {
  id: string;
  kind: 'reply' | 'approval';
  status: TeammateDraftOut['status'];
  teammate_id: string;
  teammate_name: string;
  run_id: string | null;
  conversation_id: string | null;
  channel: string | null;
  person_id: string | null;
  person_name: string;
  lead_id: string | null;
  lead_title: string | null;
  preview: unknown;
  edits: unknown;
  reason: string | null;
  decided_by: string | null;
  decided_name: string | null;
  decided_at: Date | null;
  via: string | null;
  expires_at: Date | null;
  created_at: Date;
  sort_key: string;
};

function draftOut(r: DraftRow, manages: boolean): TeammateDraftOut {
  const preview = TeammateDraftPreview.safeParse(r.preview ?? {});
  const edits = r.edits ? TeammateDraftEdits.safeParse(r.edits) : null;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    teammate: { id: r.teammate_id, name: r.teammate_name },
    runId: r.run_id,
    conversationId: r.conversation_id,
    channel: r.channel,
    person: r.person_id ? { id: r.person_id, fullName: r.person_name } : null,
    lead: r.lead_id && r.lead_title ? { id: r.lead_id, title: r.lead_title } : null,
    preview: preview.success ? preview.data : TeammateDraftPreview.parse({}),
    edits: edits?.success ? edits.data : null,
    reason: r.reason,
    decidedBy: r.decided_by
      ? { id: r.decided_by, fullName: r.decided_name ?? 'Former member' }
      : null,
    decidedAt: iso(r.decided_at),
    via: r.via,
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at)!,
    canDecide: r.status === 'pending' && (r.kind === 'reply' || manages),
  };
}

export const aiTeammateDraftList = defineQuery({
  name: 'ai_teammate.draft_list',
  description:
    'The AI teammate’s drafts: those waiting for a person (oldest first), or decided ones (newest first), optionally one kind or one conversation’s.',
  input: AiTeammateDraftListInput,
  output: AiTeammateDraftListOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const cursor = decodeCursor(input.cursor);
    const oldestFirst = input.status === 'pending';
    const list = await rows<DraftRow>(
      ctx.tx,
      sql`select * from (
            select d.id, d.kind, d.status::text as status, d.teammate_id, t.name as teammate_name, d.run_id,
              d.conversation_id, c.channel::text as channel, d.person_id,
              coalesce(nullif(btrim(p.first_name || ' ' || p.last_name), ''), 'Customer') as person_name,
              d.lead_id, l.title as lead_title, d.preview, d.edits, d.reason, d.decided_by,
              coalesce(nullif(u.full_name, ''), u.email::text) as decided_name, d.decided_at, d.via, d.expires_at,
              d.created_at, ${SORT_KEY(sql`d.created_at`)} as sort_key
            from app.ai_teammate_drafts d
            join app.ai_teammates t on t.id = d.teammate_id
            left join app.conversations c on c.id = d.conversation_id
            left join app.people p on p.id = d.person_id
            left join app.leads l on l.id = d.lead_id
            left join app.users u on u.id = d.decided_by
            where d.workspace_id = ${input.workspaceId}
              ${input.status === 'pending' ? sql`and d.status = 'pending'` : input.status === 'decided' ? sql`and d.status <> 'pending'` : sql``}
              ${input.kind ? sql`and d.kind = ${input.kind}` : sql``}
              ${input.conversationId ? sql`and d.conversation_id = ${input.conversationId}` : sql``}
          ) x
          ${cursor ? (oldestFirst ? sql`where (x.sort_key, x.id) > (${cursor.sort}, ${cursor.id}::uuid)` : sql`where (x.sort_key, x.id) < (${cursor.sort}, ${cursor.id}::uuid)`) : sql``}
          order by ${oldestFirst ? sql`x.sort_key asc, x.id asc` : sql`x.sort_key desc, x.id desc`}
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    const manages = hasWorkspacePermission(ctx.scope.workspaceRole, 'ai_team.manage');
    return { items: result.items.map((r) => draftOut(r, manages)), nextCursor: result.nextCursor };
  },
});

type RunRow = {
  id: string;
  triggered_by: string;
  status: 'running' | 'done' | 'superseded' | 'failed';
  outcome: 'replied' | 'drafted' | 'handed_off' | 'no_reply' | null;
  is_test: boolean;
  conversation_id: string | null;
  person_id: string | null;
  person_name: string;
  lead_id: string | null;
  summary: string | null;
  reply_text: string | null;
  knowledge: unknown[] | null;
  checks: unknown[] | null;
  tools: string[] | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  tool_steps: number;
  error: string | null;
  started_at: Date;
  ended_at: Date | null;
  sort_key: string;
};

export const aiTeammateActivity = defineQuery({
  name: 'ai_teammate.activity',
  description:
    'What the AI teammate has been doing: today’s counters and what’s waiting, and its runs newest first with the tools, knowledge and checks each used.',
  input: AiTeammateActivityInput,
  output: AiTeammateActivityOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const { timezone } = await workspaceMessaging(ctx.tx, ws);
    const today = sql`(date_trunc('day', now() at time zone ${timezone}) at time zone ${timezone})`;
    const [c] = await rows<Record<string, number>>(
      ctx.tx,
      sql`select
            count(*) filter (where r.started_at >= ${today})::int as runs_today,
            count(*) filter (where r.started_at >= ${today} and r.outcome = 'replied')::int as replied_today,
            count(*) filter (where r.started_at >= ${today} and r.outcome = 'drafted')::int as drafted_today,
            count(*) filter (where r.started_at >= ${today} and r.outcome = 'handed_off')::int as handed_off_today,
            count(*) filter (where r.started_at >= ${today} and r.status = 'failed')::int as failed_today,
            (select count(*)::int from app.ai_teammate_drafts d
              where d.workspace_id = ${ws} and d.status = 'pending') as pending_drafts,
            (select count(*)::int from app.conversations c
              where c.workspace_id = ${ws} and c.status = 'open' and c.needs_person_since is not null) as needs_person,
            (select count(*)::int from app.conversations c
              where c.workspace_id = ${ws} and c.status = 'open' and c.handled_by = 'ai') as handled_by_ai
          from app.ai_teammate_runs r where r.workspace_id = ${ws} and not r.is_test`,
    );
    const cursor = decodeCursor(input.cursor);
    const list = await rows<RunRow>(
      ctx.tx,
      sql`select * from (
            select r.id, r.triggered_by, r.status, r.outcome, r.is_test, r.conversation_id, r.person_id,
              coalesce(nullif(btrim(p.first_name || ' ' || p.last_name), ''), 'Customer') as person_name,
              r.lead_id, r.summary, r.reply_text, r.knowledge, r.checks,
              (select array_agg(tc.tool order by tc.created_at) from app.ai_teammate_tool_calls tc
                where tc.run_id = r.id) as tools,
              r.model, r.input_tokens, r.output_tokens, r.tool_steps, r.error, r.started_at, r.ended_at,
              ${SORT_KEY(sql`r.started_at`)} as sort_key
            from app.ai_teammate_runs r
            left join app.people p on p.id = r.person_id
            where r.workspace_id = ${ws}
          ) x
          ${cursor ? sql`where (x.sort_key, x.id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
          order by x.sort_key desc, x.id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    const n = (k: string) => Number(c?.[k] ?? 0);
    return {
      counters: {
        runsToday: n('runs_today'),
        repliedToday: n('replied_today'),
        draftedToday: n('drafted_today'),
        handedOffToday: n('handed_off_today'),
        failedToday: n('failed_today'),
        pendingDrafts: n('pending_drafts'),
        needsPerson: n('needs_person'),
        handledByAi: n('handled_by_ai'),
      },
      runs: result.items.map((r) => ({
        id: r.id,
        triggeredBy: r.triggered_by,
        status: r.status,
        outcome: r.outcome,
        isTest: r.is_test,
        conversationId: r.conversation_id,
        person: r.person_id ? { id: r.person_id, fullName: r.person_name } : null,
        leadId: r.lead_id,
        summary: r.summary,
        replyText: r.reply_text,
        knowledge: r.knowledge ?? [],
        checks: r.checks ?? [],
        tools: r.tools ?? [],
        model: r.model,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        toolSteps: Number(r.tool_steps),
        error: r.error,
        startedAt: iso(r.started_at)!,
        endedAt: iso(r.ended_at),
      })),
      nextCursor: result.nextCursor,
    };
  },
});
