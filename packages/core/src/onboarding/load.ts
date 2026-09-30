/**
 * The facts Getting started works from (server only). Each is read from the same tables, and by the same rules,
 * as the screen that owns it, so a step never disagrees with its own settings page: the number and the carriers'
 * review as Settings → Texting & calls reads them, "enough knowledge" as the AI teammate's own warning does.
 *
 * Read as the person asking, under row-level security. A teammate's list needs only their own phones and calendar,
 * so the business's facts are read only for someone who sets the business up.
 */
import { eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { users, workspaces } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { scopeCan } from '../kernel/execute';
import type { QueryContext } from '../kernel/types';
import { emptyKnowledgeProfile, KnowledgeProfile, profileCompleteness } from '../knowledge/profile';
import { currentNumber, latestByKind, loadRegistrations, readiness } from '../messaging/store';
import { businessOnboardingOf, personalOnboardingOf, type BusinessOnboarding } from './settings';
import {
  isBusinessStep,
  onboardingProgress,
  type DeviceFacts,
  type OnboardingAudience,
  type OnboardingFacts,
  type OnboardingStepKey,
} from './steps';

/** A move from another CRM that is counting or moving on its own. */
const MIGRATION_RUNNING = new Set([
  'connected',
  'scanning',
  'importing',
  'verifying',
  'finalizing',
  'cancelling',
  'rolling_back',
]);
/** A move from another CRM with counts to check, or something that stopped it. */
const MIGRATION_NEEDS_YOU = new Set(['scanned', 'ready', 'paused', 'needs_attention', 'failed']);

async function numberFacts(
  tx: Tx,
  workspaceId: string,
): Promise<NonNullable<OnboardingFacts['business']>['number']> {
  const number = await currentNumber(tx, workspaceId);
  const regs = await loadRegistrations(tx, workspaceId);
  const { nextStep } = readiness(number, regs);
  const latest = [...latestByKind(regs).values()];
  const submitted = latest
    .map((r) => r.submittedAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  return {
    next: nextStep,
    display: number && number.status !== 'failed' ? formatPhone(number.e164) : null,
    since: nextStep === 'awaiting_approval' ? (submitted[0]?.toISOString() ?? null) : null,
    rejectionReason:
      nextStep === 'rejected'
        ? (latest.find((r) => r.status === 'rejected' || r.status === 'failed')?.rejectionReason ??
          null)
        : null,
  };
}

async function businessFacts(
  tx: Tx,
  workspaceId: string,
): Promise<NonNullable<OnboardingFacts['business']>> {
  const [s] = await rows<{
    customers: number;
    importing: boolean;
    migration_statuses: string[] | null;
    calendars: number;
    services: number;
    booking_on: boolean;
    ai_name: string | null;
    published: number;
    profile: unknown;
    pending_suggestions: number;
    scan_running: boolean;
    members: number;
    live_invitations: number;
    mailbox: boolean;
    chat: boolean;
  }>(
    tx,
    sql`select
        (select count(*) from app.people p where p.workspace_id = ${workspaceId} and p.archived_at is null)::int
          + (select count(*) from app.companies c where c.workspace_id = ${workspaceId} and c.archived_at is null)::int
          as customers,
        exists (select 1 from app.imports i where i.workspace_id = ${workspaceId}
                  and i.status in ('pending', 'running')) as importing,
        (select array_agg(distinct m.status::text) from app.migration_scopes ms
           join app.migrations m on m.id = ms.migration_id where ms.workspace_id = ${workspaceId})
          as migration_statuses,
        (select count(*) from app.calendars c where c.workspace_id = ${workspaceId} and c.status = 'active')::int
          as calendars,
        (select count(*) from app.services s where s.workspace_id = ${workspaceId} and s.archived_at is null)::int
          as services,
        exists (select 1 from app.booking_sites b where b.workspace_id = ${workspaceId} and b.enabled)
          and exists (select 1 from app.calendars c where c.workspace_id = ${workspaceId}
                        and c.status = 'active' and c.public) as booking_on,
        (select t.name from app.ai_teammates t where t.workspace_id = ${workspaceId} and t.archived_at is null
           order by t.created_at limit 1) as ai_name,
        (select count(*) from app.knowledge_items k where k.workspace_id = ${workspaceId}
           and k.status = 'published')::int as published,
        (select kp.profile from app.knowledge_profiles kp where kp.workspace_id = ${workspaceId}) as profile,
        (select count(*) from app.knowledge_suggestions ks where ks.workspace_id = ${workspaceId}
           and ks.status = 'pending')::int as pending_suggestions,
        exists (select 1 from app.knowledge_scans sc where sc.workspace_id = ${workspaceId}
                  and sc.status in ('queued', 'running')) as scan_running,
        (select count(*) from app.workspace_memberships wm where wm.workspace_id = ${workspaceId})::int
          as members,
        (select count(*) from app.invitations iv where iv.workspace_id = ${workspaceId}
           and iv.accepted_at is null and iv.revoked_at is null and iv.expires_at > now())::int
          as live_invitations,
        exists (select 1 from app.mailbox_connections mc where mc.workspace_id = ${workspaceId}
                  and mc.status = 'active') as mailbox,
        exists (select 1 from app.chat_widgets w where w.workspace_id = ${workspaceId}
                  and w.last_seen_at is not null and w.paused_at is null) as chat`,
  );
  // Named columns: the sealed tokens are not granted to people at all.
  const payments = await rows<{ status: string; provider: string; capabilities: unknown }>(
    tx,
    sql`select status::text as status, provider::text as provider, capabilities
        from app.payment_connections
        where workspace_id = ${workspaceId} and status <> 'disconnected'
        order by is_default desc, created_at`,
  );
  const active = payments.filter((p) => p.status === 'active');
  const shown = active[0] ?? payments[0] ?? null;
  const can = (p: { capabilities: unknown }, key: string) =>
    (p.capabilities as Record<string, unknown> | null)?.[key] === true;
  const profile = KnowledgeProfile.safeParse(s?.profile ?? {});
  const completeness = profileCompleteness(
    profile.success ? profile.data : emptyKnowledgeProfile(),
  );
  const migrations = s?.migration_statuses ?? [];
  return {
    number: await numberFacts(tx, workspaceId),
    payments: {
      active: active.length > 0,
      // As Settings → Payments says it: nothing on yet means the provider is still checking the account.
      checking:
        active.length > 0 &&
        !active.some((p) =>
          ['card', 'bankTransfer', 'subscriptions', 'refunds'].some((k) => can(p, k)),
        ),
      needsInfo: active.length > 0 && active.every((p) => can(p, 'needsInfo')),
      broken:
        active.length === 0 &&
        payments.some((p) => p.status === 'reauth_required' || p.status === 'error'),
      provider:
        shown?.provider === 'stripe' || shown?.provider === 'square' ? shown.provider : null,
    },
    customers: {
      count: s?.customers ?? 0,
      asYouGo: false,
      running: s?.importing
        ? 'import'
        : migrations.some((m) => MIGRATION_RUNNING.has(m))
          ? 'migration'
          : null,
      migrationNeedsYou: migrations.some((m) => MIGRATION_NEEDS_YOU.has(m)),
    },
    calendar: {
      calendars: s?.calendars ?? 0,
      services: s?.services ?? 0,
      bookingOn: s?.booking_on ?? false,
    },
    ai: {
      name: s?.ai_name ?? null,
      published: s?.published ?? 0,
      profileFilled: completeness.filled,
      profileTotal: completeness.total,
      pendingSuggestions: s?.pending_suggestions ?? 0,
      scanRunning: s?.scan_running ?? false,
    },
    team: { members: s?.members ?? 0, liveInvitations: s?.live_invitations ?? 0 },
    emailChat: { mailbox: s?.mailbox ?? false, chat: s?.chat ?? false },
  };
}

export async function loadOnboardingFacts(
  tx: Tx,
  workspaceId: string,
  userId: string,
  audience: OnboardingAudience,
): Promise<OnboardingFacts> {
  const [p] = await rows<{ phones: number; calendar_connected: boolean }>(
    tx,
    sql`select
        (select count(*) from app.push_devices d where d.user_id = ${userId} and d.disabled_at is null)::int
          as phones,
        exists (select 1 from app.calendar_connections c where c.workspace_id = ${workspaceId}
                  and c.user_id = ${userId} and c.status = 'active') as calendar_connected`,
  );
  return {
    business: audience === 'business' ? await businessFacts(tx, workspaceId) : null,
    person: { phones: p?.phones ?? 0, calendarConnected: p?.calendar_connected ?? false },
  };
}

/** Where one person's guide stands in one business: what `onboarding.status` answers, and what finishing checks. */
export async function loadOnboardingStatus(
  ctx: QueryContext,
  workspaceId: string,
  device: DeviceFacts = {},
) {
  const userId = requireHuman(ctx).userId;
  const audience: OnboardingAudience = scopeCan(ctx.scope, 'workspace.update')
    ? 'business'
    : 'personal';
  const [ws] = await ctx.tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws)
    throw HfosError.notFound(
      'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
    );
  const [me] = await ctx.tx
    .select({ settings: users.settings })
    .from(users)
    .where(eq(users.id, userId));
  const settings = (ws.settings ?? {}) as Record<string, unknown>;
  const business = businessOnboardingOf(settings);
  const personal = personalOnboardingOf(me?.settings, workspaceId);
  const withChoices = withBusinessChoices(
    await loadOnboardingFacts(ctx.tx, workspaceId, userId, audience),
    business,
  );
  const skipped = new Set<OnboardingStepKey>([
    ...(audience === 'business' ? (Object.keys(business.skipped) as OnboardingStepKey[]) : []),
    ...(Object.keys(personal.skipped) as OnboardingStepKey[]),
  ]);
  const progress = onboardingProgress({
    audience,
    answers: business.answers,
    facts: withChoices,
    skipped,
    device,
  });
  const website = typeof settings['website'] === 'string' ? settings['website'] : null;
  const enabled = !business.turnedOff;
  return {
    workspaceId,
    audience,
    enabled,
    answers: business.answers,
    website: website || null,
    ...progress,
    steps: [...progress.steps],
    view: {
      hidden: personal.hidden,
      tourDoneAt: personal.tourDoneAt,
      finishedAt: personal.finishedAt,
      show: enabled && !personal.finishedAt && !personal.hidden,
    },
  };
}

/** The facts with what the business chose on its guide: "Add them as you go" counts customers as done. */
function withBusinessChoices(
  facts: OnboardingFacts,
  business: BusinessOnboarding,
): OnboardingFacts {
  return facts.business && business.customersAsYouGo
    ? {
        ...facts,
        business: { ...facts.business, customers: { ...facts.business.customers, asYouGo: true } },
      }
    : facts;
}

/**
 * One business's own setup, for its agency (`onboarding.clients`, `onboarding.remind`, the daily digest): its
 * business steps in order, never anyone's own list; the count over them; whether the guide is on; and when its own
 * owners last signed in. Read under whatever the transaction may see: the agency's owners and admins, or the worker
 * bound to the business. `askerId` only fills the personal facts nobody reads here.
 */
export async function loadBusinessSetup(tx: Tx, workspaceId: string, askerId: string) {
  const [ws] = await tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) return null;
  const business = businessOnboardingOf((ws.settings ?? {}) as Record<string, unknown>);
  const facts = withBusinessChoices(
    await loadOnboardingFacts(tx, workspaceId, askerId, 'business'),
    business,
  );
  const progress = onboardingProgress({
    audience: 'business',
    answers: business.answers,
    facts,
    skipped: new Set(Object.keys(business.skipped) as OnboardingStepKey[]),
    device: {},
  });
  const steps = progress.steps.filter((s) => isBusinessStep(s.key));
  const counted = steps.filter((s) => s.state !== 'skipped');
  const [signIn] = await rows<{ at: Date | string | null }>(
    tx,
    sql`select private.owners_last_sign_in(${workspaceId}) as at`,
  );
  return {
    enabled: !business.turnedOff,
    answers: business.answers,
    steps,
    done: counted.filter((s) => s.state === 'done' || s.state === 'waiting').length,
    total: counted.length,
    skipped: steps.length - counted.length,
    lastSignInAt: signIn?.at ? new Date(signIn.at).toISOString() : null,
  };
}
