/**
 * Server-side teammate helpers: the business's teammate row, its settings with every default filled in, its
 * training progress, and the catalogs its settings are checked against (built from the database). Reads the
 * database, so it's exported from '@hfos/core/server' only (ai-team/index.ts stays browser-safe).
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  aiTeammates,
  calendars,
  chatWidgets,
  knowledgeProfiles,
  pipelineStages,
  pipelines,
  workspaces,
} from '@hfos/db/schema';
import { parseConfig as parseCalendarConfig } from '../calendar/config';
import { uuidArray } from '../calendar/load';
import { HfosError } from '../errors';
import { emptyKnowledgeProfile, KnowledgeProfile, profileCompleteness } from '../knowledge/profile';
import { workspaceAddresses } from '../messaging/email';
import {
  defaultNumber,
  loadRegistrations,
  readiness,
  workspaceMessaging,
} from '../messaging/store';
import type { WorkspaceRole } from '../permissions';
import { openHoursOf } from '../schemas/workspace';
import { parseStoredDefinition } from '../workflows/load';
import {
  DEFAULT_AI_DAILY_TOKENS,
  workflowTextsNewLeads,
  type TeammateAiUsage,
  type TeammateCatalogs,
} from './catalogs';
import { emptyTeammateConfig, parseTeammateConfig, type TeammateConfig } from './config';

export type TeammateRow = typeof aiTeammates.$inferSelect;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The business's teammate (one per workspace), or null. `forUpdate` locks its row until the transaction ends. */
export async function loadTeammate(
  tx: Tx,
  workspaceId: string,
  opts: { readonly teammateId?: string; readonly forUpdate?: boolean } = {},
): Promise<TeammateRow | null> {
  if (opts.forUpdate)
    await tx.execute(
      sql`select 1 from app.ai_teammates where workspace_id = ${workspaceId} and archived_at is null
          ${opts.teammateId ? sql`and id = ${opts.teammateId}` : sql``} for update`,
    );
  const [row] = await tx
    .select()
    .from(aiTeammates)
    .where(
      and(
        eq(aiTeammates.workspaceId, workspaceId),
        isNull(aiTeammates.archivedAt),
        ...(opts.teammateId ? [eq(aiTeammates.id, opts.teammateId)] : []),
      ),
    );
  return row ?? null;
}

export async function requireTeammate(
  tx: Tx,
  workspaceId: string,
  teammateId: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<TeammateRow> {
  const row = await loadTeammate(tx, workspaceId, { teammateId, forUpdate: opts.forUpdate });
  if (!row) throw HfosError.notFound('AI teammate not found.');
  return row;
}

/** Its stored settings with every default filled in. Settings this app can't read count as the defaults. */
export function teammateConfigOf(row: { readonly config: unknown }): TeammateConfig {
  try {
    return parseTeammateConfig(row.config);
  } catch {
    return emptyTeammateConfig();
  }
}

/**
 * The approvals it needs before it turns automatic, read from the stored settings exactly as the database
 * counts to them (private.teammate_approvals_needed): a positive number, else 20.
 */
export function approvalsNeededOf(rawConfig: unknown): number {
  const autonomy = isRecord(rawConfig) ? rawConfig['autonomy'] : null;
  const n = isRecord(autonomy) ? autonomy['approvalsNeeded'] : null;
  return typeof n === 'number' && n >= 1 && n <= 100_000 ? Math.floor(n) : 20;
}

/** Training progress, for "12 of 20 approved · 3 edited". */
export function teammateProgressOf(row: TeammateRow) {
  const approvalsNeeded = approvalsNeededOf(row.config);
  return {
    status: row.status,
    approvedCount: row.approvedCount,
    editedCount: row.editedCount,
    rejectedCount: row.rejectedCount,
    approvalsNeeded,
    remaining: Math.max(0, approvalsNeeded - row.approvedCount),
    automaticVia: (row.automaticVia as 'threshold' | 'override' | null) ?? null,
  };
}

/** The people its settings name (who hears about hand-offs and qualified leads). */
export function teammateUserIds(config: TeammateConfig): string[] {
  const ids = new Set<string>();
  for (const who of [config.handOff.notify, config.qualify.whenQualified.notify])
    if (who?.kind === 'users')
      for (const u of who.userIds) if (typeof u === 'string' && UUID.test(u)) ids.add(u);
  return [...ids];
}

/**
 * The daily AI limit the worker enforces: ASSISTANT_DAILY_TOKENS when it's a whole number above zero, else the
 * default. The worker reads the same variable, so a deployment that changes it sets it for the API too.
 */
export function aiDailyTokens(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const n = Number(env['ASSISTANT_DAILY_TOKENS'] || DEFAULT_AI_DAILY_TOKENS);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_AI_DAILY_TOKENS;
}

/**
 * Today's AI use: the whole business's, exactly as the worker's budget counts it (private.ai_tokens_today:
 * the Assistant's runs, everyone's, plus app.ai_usage since midnight in the business's zone, cache reads
 * and writes included), and the teammate's part of it since midnight in `timeZone` (the business's zone).
 */
export async function teammateAiUsage(
  tx: Tx,
  workspaceId: string,
  timeZone: string,
  teammateId: string | null,
): Promise<TeammateAiUsage> {
  const [u] = await rows<{ used: string | number | null; teammate: string | number | null }>(
    tx,
    sql`with since as (select date_trunc('day', now() at time zone ${timeZone}) at time zone ${timeZone} as t)
        select
          private.ai_tokens_today(${workspaceId}::uuid) as used,
          coalesce((select sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens)
            from app.ai_usage u, since
            where u.workspace_id = ${workspaceId} and u.source = 'teammate' and u.created_at >= since.t
              ${teammateId ? sql`and u.teammate_id = ${teammateId}::uuid` : sql``}), 0) as teammate`,
  );
  return {
    dailyTokens: aiDailyTokens(),
    usedTokens: Number(u?.used ?? 0),
    teammateTokens: Number(u?.teammate ?? 0),
  };
}

/** A calendar's own visit lengths, in minutes (none when its settings can't be read). */
function lengthsOf(config: unknown): number[] {
  try {
    return [...parseCalendarConfig(config).durations.minutes];
  } catch {
    return [];
  }
}

/** A widget's name in lists: the first site it shows on. */
function widgetName(origins: readonly string[]): string {
  const first = origins[0];
  if (!first) return 'Website chat';
  try {
    return new URL(first).host;
  } catch {
    return first;
  }
}

/**
 * Everything a teammate's settings refer to in one workspace: whether texting is ready, the addresses it can
 * email from, the chat widgets, calendars (bookable online: public and not archived; with their colour and
 * lengths), how much knowledge is published, how complete the profile is and whether it allows prices, today's
 * AI use, the business's open hours, the team (plus anyone the settings still name, marked inactive once they
 * leave), active workflows that text new leads, quiet hours, the industry, and pipelines with their stages.
 */
export async function loadTeammateCatalogs(
  tx: Tx,
  workspaceId: string,
  opts: {
    readonly extraUserIds?: readonly string[];
    /** The teammate whose share of today's AI use to count. */
    readonly teammateId?: string | null;
  } = {},
): Promise<TeammateCatalogs> {
  const [ws] = await tx
    .select({
      timezone: workspaces.timezone,
      industry: workspaces.industry,
      settings: workspaces.settings,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) throw HfosError.notFound('Workspace not found.');
  const messaging = await workspaceMessaging(tx, workspaceId);
  const number = await defaultNumber(tx, workspaceId);
  const regs = await loadRegistrations(tx, workspaceId);
  const addresses = (await workspaceAddresses(tx, workspaceId)).filter((a) => a.usable);
  const widgets = await tx
    .select({ id: chatWidgets.id, origins: chatWidgets.allowedOrigins })
    .from(chatWidgets)
    .where(eq(chatWidgets.workspaceId, workspaceId))
    .orderBy(asc(chatWidgets.createdAt));
  const calendarList = await tx
    .select({
      id: calendars.id,
      name: calendars.name,
      status: calendars.status,
      public: calendars.public,
      color: calendars.color,
      config: calendars.config,
    })
    .from(calendars)
    .where(eq(calendars.workspaceId, workspaceId))
    .orderBy(asc(calendars.name));
  const [knowledge] = await rows<{ published: number }>(
    tx,
    sql`select count(*)::int as published from app.knowledge_items
        where workspace_id = ${workspaceId} and status = 'published'`,
  );
  const [profileRow] = await tx
    .select({ profile: knowledgeProfiles.profile, allowPrices: knowledgeProfiles.allowPrices })
    .from(knowledgeProfiles)
    .where(eq(knowledgeProfiles.workspaceId, workspaceId));
  const profile = profileRow ? KnowledgeProfile.safeParse(profileRow.profile) : null;
  const aiUsage = await teammateAiUsage(
    tx,
    workspaceId,
    ws.timezone || 'UTC',
    opts.teammateId ?? null,
  );
  const team = await rows<{
    id: string;
    role: WorkspaceRole;
    active: boolean;
    name: string | null;
  }>(
    tx,
    sql`with direct as (
          select user_id, role::text as role from app.workspace_memberships where workspace_id = ${workspaceId}
        ), org as (
          select om.user_id, om.role::text as role from app.organization_memberships om
          join app.workspaces w on w.organization_id = om.organization_id
          where w.id = ${workspaceId} and om.user_id not in (select user_id from direct)
        ), named as (
          select x.user_id from (select unnest(${uuidArray(opts.extraUserIds ?? [])}) as user_id) x
          where x.user_id not in (select user_id from direct) and x.user_id not in (select user_id from org)
        ), everyone as (
          select user_id, role, true as active from direct
          union all select user_id, role, true from org
          union all select user_id, 'member', false from named
        )
        select e.user_id as id, e.role, e.active, coalesce(nullif(u.full_name, ''), u.email::text) as name
        from everyone e left join app.users u on u.id = e.user_id`,
  );
  const flows = await rows<{ id: string; name: string; definition: unknown }>(
    tx,
    sql`select w.id, w.name, v.definition from app.workflows w
        join app.workflow_versions v on v.id = w.active_version_id
        where w.workspace_id = ${workspaceId} and w.status = 'active'
        order by w.name`,
  );
  const textsNewLeads = flows.filter((f) => {
    try {
      return workflowTextsNewLeads(parseStoredDefinition(f.definition));
    } catch {
      return false;
    }
  });
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
  return {
    timeZone: ws.timezone,
    textingReady: readiness(number, regs).messagingReady,
    emailAddresses: addresses.map((a) => ({ id: a.id, address: a.address })),
    chatWidgets: widgets.map((w) => ({ id: w.id, name: widgetName(w.origins) })),
    calendars: calendarList.map((c) => ({
      id: c.id,
      name: c.name,
      archived: c.status === 'archived',
      bookableOnline: c.public && c.status !== 'archived',
      color: c.color,
      lengths: lengthsOf(c.config),
    })),
    knowledge: { published: knowledge?.published ?? 0 },
    profile: profileCompleteness(profile?.success ? profile.data : emptyKnowledgeProfile()),
    // The column is what grounding reads (commands/knowledge.ts keeps the document in step).
    pricesAllowed: profileRow?.allowPrices ?? false,
    aiUsage,
    businessHours: openHoursOf(ws.settings as Record<string, unknown> | null),
    members: team
      .map((m) => ({ userId: m.id, name: m.name ?? 'Someone', role: m.role, active: m.active }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    newLeadTextWorkflows: textsNewLeads.map((f) => ({ id: f.id, name: f.name })),
    quietHours: messaging.settings.quietHours,
    industry: ws.industry,
    pipelines: pipelineList.map((p) => ({
      id: p.id,
      name: p.name,
      archived: p.archivedAt !== null,
      stages: stageList
        .filter((s) => s.pipelineId === p.id)
        .map((s) => ({ id: s.id, name: s.name, archived: false })),
    })),
  };
}
