/**
 * What quick setup starts from, read from the database (server only): each part as the screen that owns it reads
 * it, so the setup never disagrees with Settings, Knowledge, Calendars or the AI teammate page. Read as the person
 * asking, under row-level security.
 */
import { eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { knowledgeProfiles, knowledgeSources, workspaces } from '@hfos/db/schema';
import { loadTeammate, teammateConfigOf } from '../ai-team/load';
import { WeeklyHours } from '../calendar/config';
import { chatWidgetName } from '../chat/origins';
import { HfosError } from '../errors';
import { emptyKnowledgeProfile, KnowledgeProfile } from '../knowledge/profile';
import { workspaceAddresses } from '../messaging/email';
import { defaultNumber, loadRegistrations, readiness } from '../messaging/store';
import { businessOnboardingOf } from '../onboarding/settings';
import { setupKindOf } from './kinds';
import { AI_SETUP_FACT_TAG, type AiSetupScanState, type AiSetupState } from './state';

const SCAN_STATES: Readonly<Record<string, AiSetupScanState>> = {
  queued: 'running',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'failed',
};

/** The business as quick setup sees it. */
export async function loadAiSetupState(tx: Tx, workspaceId: string): Promise<AiSetupState> {
  const [ws] = await tx
    .select({
      name: workspaces.name,
      industry: workspaces.industry,
      timezone: workspaces.timezone,
      settings: workspaces.settings,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws)
    throw HfosError.notFound(
      'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
    );
  const settings = (ws.settings ?? {}) as Record<string, unknown>;
  const [source] = await tx
    .select({ id: knowledgeSources.id, url: knowledgeSources.url })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.workspaceId, workspaceId));
  const typed = typeof settings['website'] === 'string' ? settings['website'].trim() : '';
  const openHours = WeeklyHours.safeParse(settings['openHours']);

  const row = await loadTeammate(tx, workspaceId);
  const [profileRow] = await tx
    .select({ profile: knowledgeProfiles.profile, allowPrices: knowledgeProfiles.allowPrices })
    .from(knowledgeProfiles)
    .where(eq(knowledgeProfiles.workspaceId, workspaceId));
  const stored = profileRow ? KnowledgeProfile.safeParse(profileRow.profile) : null;
  // The column is what grounding reads (commands/knowledge.ts keeps the document in step).
  const profile: KnowledgeProfile = {
    ...(stored?.success ? stored.data : emptyKnowledgeProfile()),
    allowPrices: profileRow?.allowPrices ?? false,
  };

  const facts = await rows<{
    id: string;
    title: string;
    body: string;
    tags: string[];
    status: string;
  }>(
    tx,
    sql`select id, title, body, tags, status::text as status from app.knowledge_items
        where workspace_id = ${workspaceId} and kind = 'fact' and ${AI_SETUP_FACT_TAG} = any(tags)
        order by created_at`,
  );
  const services = await rows<{ id: string; name: string }>(
    tx,
    sql`select id, name from app.services
        where workspace_id = ${workspaceId} and archived_at is null order by name`,
  );
  const calendars = await rows<{ id: string; name: string }>(
    tx,
    sql`select id, name from app.calendars
        where workspace_id = ${workspaceId} and status = 'active' and public order by name`,
  );
  const [counts] = await rows<{ territories: number; pending: number }>(
    tx,
    sql`select
        (select count(*) from app.territories t where t.workspace_id = ${workspaceId})::int as territories,
        (select count(*) from app.knowledge_suggestions s where s.workspace_id = ${workspaceId}
           and s.status = 'pending' and s.reason = 'scan')::int as pending`,
  );
  const [scan] = source
    ? await rows<{ status: string }>(
        tx,
        sql`select status::text as status from app.knowledge_scans
            where source_id = ${source.id} order by created_at desc limit 1`,
      )
    : [];
  // The team's addresses only: the AI teammate never writes as one person.
  const address =
    (await workspaceAddresses(tx, workspaceId)).find((a) => a.usable && !a.ownerUserId) ?? null;
  const [widget] = await rows<{ id: string; origins: string[] }>(
    tx,
    sql`select id, allowed_origins as origins from app.chat_widgets
        where workspace_id = ${workspaceId} and paused_at is null order by created_at limit 1`,
  );
  const number = await defaultNumber(tx, workspaceId);
  const regs = await loadRegistrations(tx, workspaceId);
  const kind = setupKindOf(ws.industry);

  return {
    businessName: ws.name,
    industry: ws.industry,
    kind,
    goal: businessOnboardingOf(settings).answers?.goal ?? null,
    website: source?.url ?? (typed || null),
    timeZone: ws.timezone,
    openHours: openHours.success ? openHours.data : null,
    teammate: row
      ? {
          id: row.id,
          name: row.name,
          status: row.status,
          revision: row.revision,
          config: teammateConfigOf(row),
        }
      : null,
    profile,
    facts: facts.map((f) => ({
      ...f,
      status: f.status === 'published' || f.status === 'archived' ? f.status : 'draft',
    })),
    services,
    calendars,
    territories: counts?.territories ?? 0,
    emailAddress: address ? { id: address.id, address: address.address } : null,
    chat: widget ? { id: widget.id, name: chatWidgetName(widget.origins) } : null,
    number: number?.status === 'active',
    textingReady: readiness(number, regs).messagingReady,
    scan: {
      state: scan ? (SCAN_STATES[scan.status] ?? 'failed') : 'none',
      pending: counts?.pending ?? 0,
    },
  };
}
