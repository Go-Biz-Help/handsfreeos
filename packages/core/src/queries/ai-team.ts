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
import { countOf } from '../calendar/format';
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
  type ACTIVITY_PERIODS,
  type TeammateDraftOut,
  type TOOL_CALL_STATUSES,
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
  calendars: c.calendars.map((x) => ({ ...x, lengths: [...x.lengths] })),
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
    'The business’s AI teammate: its settings, what conflicts in them (with fixes), its training progress, its revisions, and the catalogs its settings refer to (with today’s AI use).',
  input: AiTeammateGetInput,
  output: AiTeammateGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const row = await loadTeammate(ctx.tx, input.workspaceId);
    const config = row ? teammateConfigOf(row) : null;
    const loaded = await loadTeammateCatalogs(ctx.tx, input.workspaceId, {
      extraUserIds: config ? teammateUserIds(config) : [],
      teammateId: row?.id ?? null,
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

// ---- Activity ----

type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];
type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number];

/** What a tool call's summary is made from, picked out of its arguments and result in the database. */
type ToolFacts = {
  query?: string;
  title?: string;
  body?: string;
  note?: string;
  reason?: string;
  percent?: number;
  answers?: number;
  found?: number;
  times?: number;
  firstTime?: string;
  appointments?: number;
  held?: string;
  outcome?: string;
  missing?: number;
  updated?: unknown[];
  refusal?: string;
  calendar?: string;
  stage?: string;
};
type ToolCallRow = {
  tool: string;
  status: ToolCallStatus;
  at: string;
  error: string | null;
  facts: ToolFacts | null;
};

/**
 * The few things a call's summary needs, instead of its whole result (a knowledge search returns whole
 * answers). Calendar and stage names come from their ids.
 */
const TOOL_FACTS = sql`jsonb_strip_nulls(jsonb_build_object(
  'query', left(tc.arguments ->> 'query', 120),
  'title', left(tc.arguments ->> 'title', 200),
  'body', left(tc.arguments ->> 'body', 200),
  'note', left(tc.arguments ->> 'note', 200),
  'reason', left(tc.arguments ->> 'reason', 200),
  'percent', case when jsonb_typeof(tc.arguments -> 'percent') = 'number' then tc.arguments -> 'percent' end,
  'answers', case when jsonb_typeof(tc.arguments -> 'answers') = 'array'
    then jsonb_array_length(tc.arguments -> 'answers') end,
  'found', case when jsonb_typeof(tc.result #> '{content,items}') = 'array'
    then jsonb_array_length(tc.result #> '{content,items}') end,
  'times', case when jsonb_typeof(tc.result #> '{content,times}') = 'array'
    then jsonb_array_length(tc.result #> '{content,times}') end,
  'firstTime', left(tc.result #>> '{content,times,0,label}', 120),
  'appointments', case when jsonb_typeof(tc.result #> '{content,appointments}') = 'array'
    then jsonb_array_length(tc.result #> '{content,appointments}') end,
  'held', left(tc.result #>> '{effect,held,summary}', 300),
  'outcome', left(tc.result #>> '{content,status}', 40),
  'missing', case when jsonb_typeof(tc.result #> '{content,missing}') = 'array'
    then jsonb_array_length(tc.result #> '{content,missing}') end,
  'updated', case when jsonb_typeof(tc.result #> '{content,updated}') = 'array'
    then tc.result #> '{content,updated}' end,
  'refusal', left(tc.result #>> '{content,error}', 300),
  'calendar', (select cal.name from app.calendars cal
    where cal.workspace_id = tc.workspace_id and cal.id::text = tc.arguments ->> 'calendarId'),
  'stage', (select s.name from app.pipeline_stages s
    where s.workspace_id = tc.workspace_id and s.id::text = tc.arguments ->> 'stageId')
))`;

type RunRow = {
  id: string;
  triggered_by: string;
  status: 'running' | 'done' | 'superseded' | 'failed';
  outcome: 'replied' | 'drafted' | 'handed_off' | 'no_reply' | null;
  is_test: boolean;
  conversation_id: string | null;
  channel: string | null;
  person_id: string | null;
  person_name: string;
  lead_id: string | null;
  first_body: string | null;
  first_subject: string | null;
  first_media: unknown;
  first_at: Date | string | null;
  message_count: number;
  summary: string | null;
  reply_text: string | null;
  knowledge: unknown[] | null;
  checks: unknown[] | null;
  tools: string[] | null;
  tool_calls: ToolCallRow[] | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  tool_steps: number;
  error: string | null;
  started_at: Date;
  ended_at: Date | null;
  sort_key: string;
};

/** How many days before today each period starts. */
const DAYS_BACK: Readonly<Record<ActivityPeriod, number>> = { today: 0, '7d': 6, '30d': 29 };

/** Midnight `back` days ago in `timeZone`. */
const dayStart = (timeZone: string, back: number) =>
  sql`((date_trunc('day', now() at time zone ${timeZone}) - make_interval(days => ${back})) at time zone ${timeZone})`;

const CHANNELS = ['sms', 'email', 'chat'] as const;
const channelOf = (v: string | null) => CHANNELS.find((c) => c === v) ?? null;

/** Words collapsed to one line and cut to `max` characters. */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const joinAnd = (items: readonly string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

const FIELD_WORDS: Readonly<Record<string, string>> = {
  firstName: 'first name',
  lastName: 'last name',
  email: 'email',
  phone: 'phone number',
  address: 'address',
};

/** One line on what a tool call came back with, for the run sheet (the tool's own name says what it was). */
function toolCallSummary(c: ToolCallRow): string | null {
  const f = c.facts ?? {};
  if (c.status === 'refused' || c.status === 'failed') {
    const why = f.refusal ?? c.error;
    return why ? clip(why, 160) : c.status === 'failed' ? 'It didn’t work.' : 'It wasn’t allowed.';
  }
  if (c.status === 'running') return null;
  const on = f.calendar ? ` on ${f.calendar}` : '';
  switch (c.tool) {
    case 'search_knowledge': {
      const q = f.query ? ` for “${clip(f.query, 60)}”` : '';
      return f.found ? `${countOf(f.found, 'answer', 'answers')} found${q}` : `Nothing found${q}`;
    }
    case 'find_times':
      return f.times
        ? `${countOf(f.times, 'open time', 'open times')}${on}${f.firstTime ? `, from ${f.firstTime}` : ''}`
        : `No open times${on}`;
    case 'my_appointments':
      return f.appointments
        ? countOf(f.appointments, 'upcoming visit', 'upcoming visits')
        : 'No upcoming visits';
    case 'book':
    case 'reschedule':
    case 'cancel':
      return f.held ? clip(f.held, 160) : null;
    case 'record_answers': {
      const recorded = f.answers
        ? `${countOf(f.answers, 'answer', 'answers')} recorded`
        : 'Answers recorded';
      const where =
        f.outcome === 'qualified'
          ? 'qualified'
          : f.outcome === 'not_a_fit'
            ? 'not a fit'
            : f.missing
              ? `${countOf(f.missing, 'question', 'questions')} to go`
              : null;
      return where ? `${recorded} · ${where}` : recorded;
    }
    case 'move_stage':
      return f.stage ? `To ${f.stage}` : null;
    case 'update_customer': {
      const fields = (f.updated ?? [])
        .filter((x): x is string => typeof x === 'string')
        .map((x) => FIELD_WORDS[x] ?? x);
      return fields.length ? `Added their ${joinAnd(fields)}` : 'Nothing new to add';
    }
    case 'add_note':
      return f.body ? clip(f.body, 120) : null;
    case 'create_task':
      return f.title ? clip(f.title, 120) : null;
    case 'offer_discount':
      return typeof f.percent === 'number' ? `${f.percent}% off, waiting for an OK` : null;
    case 'hand_off':
      return f.note ? clip(f.note, 160) : null;
    case 'no_reply':
      return f.reason ? clip(f.reason, 160) : null;
    default:
      return null;
  }
}

/** The start of the customer's message, or what they sent instead of words. */
function excerptOf(r: RunRow): string {
  const photos = Array.isArray(r.first_media) ? r.first_media.length : 0;
  const text =
    (r.first_body ?? '').trim() ||
    (r.first_subject ?? '').trim() ||
    (photos === 1 ? '(sent a photo)' : photos > 1 ? `(sent ${photos} photos)` : '(no text)');
  return clip(text, 200);
}

export const aiTeammateActivity = defineQuery({
  name: 'ai_teammate.activity',
  description:
    'What the AI teammate has been doing: today’s counters and what’s waiting, and its runs newest first (optionally only today’s or the last 7 or 30 days’), each with its channel, the message that started it, and every tool call with a short summary.',
  input: AiTeammateActivityInput,
  output: AiTeammateActivityOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const { timezone } = await workspaceMessaging(ctx.tx, ws);
    const today = dayStart(timezone, 0);
    const since = input.since ? dayStart(timezone, DAYS_BACK[input.since]) : null;
    const [c] = await rows<Record<string, number>>(
      ctx.tx,
      sql`select
            count(*) filter (where r.started_at >= ${today})::int as runs_today,
            count(*) filter (where r.started_at >= ${today} and r.outcome = 'replied')::int as replied_today,
            count(*) filter (where r.started_at >= ${today} and r.outcome = 'drafted')::int as drafted_today,
            count(*) filter (where r.started_at >= ${today} and r.outcome = 'handed_off')::int as handed_off_today,
            count(*) filter (where r.started_at >= ${today} and r.status = 'failed')::int as failed_today,
            count(*) filter (where r.started_at >= ${today} and r.status = 'done'
              and exists (select 1 from app.ai_teammate_tool_calls tc
                where tc.run_id = r.id and tc.tool = 'book' and tc.status in ('done', 'held'))
              and (r.outcome = 'replied' or exists (select 1 from app.ai_teammate_drafts d
                where d.run_id = r.id and d.sent_at is not null)))::int as booked_today,
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
            select r.id, r.triggered_by, r.status, r.outcome, r.is_test, r.conversation_id,
              coalesce(cv.channel::text, (select d.preview #>> '{message,channel}' from app.ai_teammate_drafts d
                where d.run_id = r.id and d.preview #>> '{message,channel}' is not null
                order by d.created_at limit 1)) as channel,
              r.person_id,
              coalesce(nullif(btrim(p.first_name || ' ' || p.last_name), ''), 'Customer') as person_name,
              r.lead_id, fm.body_text as first_body, fm.subject as first_subject, fm.media as first_media,
              fm.occurred_at as first_at, coalesce(cardinality(r.message_ids), 0) as message_count,
              r.summary, r.reply_text, r.knowledge, r.checks,
              (select array_agg(tc.tool order by tc.created_at) from app.ai_teammate_tool_calls tc
                where tc.run_id = r.id) as tools,
              (select json_agg(json_build_object('tool', tc.tool, 'status', tc.status, 'at', tc.created_at,
                  'error', left(tc.error, 300), 'facts', ${TOOL_FACTS}) order by tc.created_at, tc.id)
                from app.ai_teammate_tool_calls tc where tc.run_id = r.id) as tool_calls,
              r.model, r.input_tokens, r.output_tokens, r.tool_steps, r.error, r.started_at, r.ended_at,
              ${SORT_KEY(sql`r.started_at`)} as sort_key
            from app.ai_teammate_runs r
            left join app.people p on p.id = r.person_id
            left join app.conversations cv on cv.id = r.conversation_id
            left join lateral (
              select m.body_text, m.subject, m.media, m.occurred_at from app.messages m
              where m.id = any(r.message_ids)
              order by m.occurred_at, m.created_at limit 1
            ) fm on true
            where r.workspace_id = ${ws} ${since ? sql`and r.started_at >= ${since}` : sql``}
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
        bookedToday: n('booked_today'),
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
        channel: channelOf(r.channel),
        person: r.person_id ? { id: r.person_id, fullName: r.person_name } : null,
        leadId: r.lead_id,
        firstMessage: r.first_at ? { excerpt: excerptOf(r), at: iso(r.first_at)! } : null,
        messageCount: Number(r.message_count),
        summary: r.summary,
        replyText: r.reply_text,
        knowledge: r.knowledge ?? [],
        checks: r.checks ?? [],
        tools: r.tools ?? [],
        toolCalls: (r.tool_calls ?? []).map((tc) => ({
          tool: tc.tool,
          status: tc.status,
          summary: toolCallSummary(tc),
          at: iso(tc.at)!,
        })),
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
