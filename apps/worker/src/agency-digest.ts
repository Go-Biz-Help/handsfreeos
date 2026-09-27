/**
 * The daily agency digest. Around 8 AM where an organization is, each of its owners and admins gets one email
 * about its businesses that need a look: workflow runs that failed in the last 24 hours, approvals waiting (and
 * for how long), paused workflows and agency templates with an update available, plus the knowledge suggestions
 * waiting at a business already listed. Suggestions alone list nothing: they often wait for days.
 *
 * It stands in for the agency hearing about every client's failures and approvals as they happen. Those go to
 * each business's own owners and admins (workspaceManagers), so a person's digest leaves out the businesses
 * where they are an owner or admin themselves. Someone left with nothing to read gets nothing, so a business
 * owner whose organization is just their business never gets one.
 *
 * Two jobs:
 * - `agency_digest.plan`, one, daily (ensureRecurringJobs): gives every organization a pending
 *   `agency_digest.send` job at its next 8 AM. The empty scope sees no organizations, so it lists them through
 *   private.organization_timezones().
 * - `agency_digest.send`, one per organization, bound to it: sends that day's digest once, then re-arms for the
 *   next 8 AM, worked out again each time so it follows daylight saving. A digest that went out is recorded as
 *   `organization.digest_sent` with its day, and a day already recorded is skipped. Each business is read in a
 *   transaction bound to that business.
 *
 * An organization's time zone is the one most of its businesses use, or America/Chicago (the SQL function).
 */
import { randomUUID } from 'node:crypto';
import { addDays, localDateOf, localInstant, scheduleJob, uuidArray } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { agencyDigestEmail, type DigestBusiness } from './emails/templates';
import type { JobContext, JobHandler, JobMap } from './jobs';
import { errorMessage } from './outbox';
import { recordSystemEvent } from './system-event';

export const DIGEST_JOBS = {
  /** Daily and global: every organization's send job waits for its next 8 AM. */
  plan: 'agency_digest.plan',
  /** One per organization: that day's digest, then the next 8 AM. */
  send: 'agency_digest.send',
} as const;
export const DIGEST_PLAN_KEY = 'plan:agency_digest';
export const digestJobKey = (organizationId: string): string => `agency-digest:${organizationId}`;

const SEND_AT = '08:00';
/** Organizations per planning statement. */
const PLAN_CHUNK = 2000;
const DAY = 86_400_000;

/** The next 8 AM in `timeZone` after `now`. */
export function nextDigestAt(now: number, timeZone: string): number {
  const today = localDateOf(now, timeZone);
  const at = localInstant(today, SEND_AT, timeZone);
  return at > now ? at : localInstant(addDays(today, 1), SEND_AT, timeZone);
}

/** The organization's send job, at its next 8 AM; one already waiting stays as it is. */
export async function scheduleDigest(
  tx: Tx,
  organizationId: string,
  timeZone: string,
  now: number,
): Promise<void> {
  await scheduleJob(tx, {
    kind: DIGEST_JOBS.send,
    dedupeKey: digestJobKey(organizationId),
    runAt: new Date(nextDigestAt(now, timeZone)),
    payload: {},
    workspaceId: null,
    organizationId,
  });
}

/** Daily: every organization has its digest waiting (new ones get theirs within a day). */
export const planDigests: JobHandler = async (ctx) => {
  await asWorker(ctx.db, {}, async (tx) => {
    const list = await rows<{ organization_id: string; timezone: string }>(
      tx,
      sql`select organization_id, timezone from private.organization_timezones()`,
    );
    // A statement per PLAN_CHUNK organizations, not one each: the same insert as scheduleDigest.
    for (let i = 0; i < list.length; i += PLAN_CHUNK) {
      const chunk = list.slice(i, i + PLAN_CHUNK);
      const keys = chunk.map((o) => sql`${digestJobKey(o.organization_id)}`);
      const at = chunk.map(
        (o) => sql`${new Date(nextDigestAt(ctx.now, o.timezone)).toISOString()}`,
      );
      await tx.execute(
        sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
            select o.org, null, ${DIGEST_JOBS.send}, o.key, o.at, '{}'::jsonb
            from unnest(${uuidArray(chunk.map((o) => o.organization_id))},
              array[${sql.join(keys, sql`, `)}]::text[],
              array[${sql.join(at, sql`, `)}]::timestamptz[]) as o(org, key, at)
            on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
      );
    }
  });
  return { rescheduleAt: new Date(ctx.now + DAY) };
};

interface Recipient extends Record<string, unknown> {
  id: string;
  email: string;
  full_name: string;
  settings: Record<string, unknown>;
}

interface Attention extends Record<string, unknown> {
  failed_runs: number;
  approvals: number;
  oldest_approval: Date | string | null;
  paused: string[];
  behind: string[];
  suggestions: number;
  own_managers: string[];
}

interface Listed {
  readonly business: DigestBusiness;
  /** The business's own owners and admins: they hear about it as it happens. */
  readonly ownManagers: ReadonlySet<string>;
}

const wantsDigest = (u: Recipient) =>
  (u.settings as { notifications?: { agencyDigest?: boolean } }).notifications?.agencyDigest !==
  false;

/** What one business has that needs a look, read bound to that business; null when nothing does. */
async function lookAt(
  ctx: JobContext,
  organizationId: string,
  b: { id: string; name: string },
  now: number,
): Promise<Listed | null> {
  const since = new Date(now - DAY).toISOString();
  const [a] = await asWorker(ctx.db, { workspaceId: b.id, organizationId }, (tx) =>
    rows<Attention>(
      tx,
      sql`select
            (select count(*)::int from app.workflow_runs r
              where r.workspace_id = ${b.id} and r.status = 'failed' and not r.is_test
                and r.ended_at > ${since}::timestamptz) as failed_runs,
            (select count(*)::int from app.workflow_approvals a
              where a.workspace_id = ${b.id} and a.status = 'pending') as approvals,
            (select min(a.created_at) from app.workflow_approvals a
              where a.workspace_id = ${b.id} and a.status = 'pending') as oldest_approval,
            (select coalesce(array_agg(w.name order by lower(w.name)), '{}') from app.workflows w
              where w.workspace_id = ${b.id} and w.status = 'paused') as paused,
            (select coalesce(array_agg(t.name order by lower(t.name)), '{}')
              from app.workflow_template_installs i join app.workflow_templates t on t.id = i.template_id
              where i.workspace_id = ${b.id} and i.status = 'installed' and t.latest_version is not null
                and coalesce(i.installed_version, 0) < t.latest_version) as behind,
            (select count(*)::int from app.knowledge_suggestions s
              where s.workspace_id = ${b.id} and s.status = 'pending') as suggestions,
            (select coalesce(array_agg(m.user_id::text), '{}') from app.workspace_memberships m
              where m.workspace_id = ${b.id} and m.role in ('owner', 'admin')) as own_managers`,
    ),
  );
  if (!a) return null;
  if (a.failed_runs === 0 && a.approvals === 0 && a.paused.length === 0 && a.behind.length === 0)
    return null;
  const home = `${ctx.webUrl}/app/w/${b.id}`;
  const oldest = a.oldest_approval ? new Date(a.oldest_approval).getTime() : now;
  return {
    ownManagers: new Set(a.own_managers),
    business: {
      name: b.name,
      link: home,
      failedRuns:
        a.failed_runs > 0
          ? { count: a.failed_runs, link: `${home}/workflows/runs?status=failed&range=1d` }
          : null,
      approvals:
        a.approvals > 0
          ? {
              count: a.approvals,
              oldestMinutes: Math.max(0, Math.floor((now - oldest) / 60_000)),
              link: `${home}/workflows/approvals`,
            }
          : null,
      paused: a.paused.length > 0 ? { names: a.paused, link: `${home}/workflows` } : null,
      updates:
        a.behind.length > 0
          ? { names: a.behind, link: `${ctx.webUrl}/app/org/${organizationId}/businesses` }
          : null,
      suggestions:
        a.suggestions > 0 ? { count: a.suggestions, link: `${home}/knowledge/suggestions` } : null,
    },
  };
}

/** One organization's digest for today, once; then the next 8 AM. */
export const sendDigest: JobHandler = async (ctx) => {
  const organizationId = ctx.scope.organizationId;
  if (!organizationId) throw new Error('the agency digest needs an organization');
  const now = ctx.now;
  const org = await asWorker(ctx.db, { organizationId }, async (tx) => {
    const [o] = await rows<{ name: string; timezone: string }>(
      tx,
      sql`select o.name, z.timezone from app.organizations o
          join private.organization_timezones(${organizationId}::uuid) z on z.organization_id = o.id
          where o.id = ${organizationId}`,
    );
    if (!o) return null;
    const day = localDateOf(now, o.timezone);
    const sent = await rows(
      tx,
      sql`select 1 from app.events
          where entity_type = 'organization' and entity_id = ${organizationId}
            and event_type = 'organization.digest_sent' and payload ->> 'day' = ${day}
          limit 1`,
    );
    const people = await rows<Recipient>(
      tx,
      sql`select u.id, u.email::text as email, u.full_name, u.settings
          from app.organization_memberships om join app.users u on u.id = om.user_id
          where om.organization_id = ${organizationId} and om.role in ('owner', 'admin')
          order by u.email`,
    );
    const businesses = await rows<{ id: string; name: string }>(
      tx,
      sql`select id, name from app.workspaces where organization_id = ${organizationId}
          order by lower(name), id`,
    );
    return {
      ...o,
      day,
      sentToday: sent.length > 0,
      people: people.filter(wantsDigest),
      businesses,
    };
  });
  // The organization is gone (its jobs go with it).
  if (!org) return;
  const next = { rescheduleAt: new Date(nextDigestAt(now, org.timezone)) };
  if (org.sentToday || org.people.length === 0) return next;

  const listed: Listed[] = [];
  for (const b of org.businesses) {
    const found = await lookAt(ctx, organizationId, b, now);
    if (found) listed.push(found);
  }
  if (listed.length === 0) return next;

  const agencyLink = `${ctx.webUrl}/app/org/${organizationId}`;
  const emailed: Recipient[] = [];
  const businesses = new Set<string>();
  let failures = 0;
  for (const person of org.people) {
    // Businesses where they're an owner or admin themselves are left out: they already hear about those.
    const theirs = listed.filter((l) => !l.ownManagers.has(person.id)).map((l) => l.business);
    if (theirs.length === 0) continue;
    try {
      await ctx.mailer.send({
        to: person.email,
        ...agencyDigestEmail({ organization: org.name, businesses: theirs, agencyLink }),
      });
      emailed.push(person);
      for (const b of theirs) businesses.add(b.name);
    } catch (e) {
      failures++;
      ctx.log.warn({ err: errorMessage(e), userId: person.id }, 'could not send an agency digest');
    }
  }
  if (emailed.length === 0) {
    // Nobody could be emailed: the job's retries try again. Nobody had anything to read: done for today.
    if (failures > 0) throw new Error('could not send the agency digest to anyone');
    return next;
  }
  await asWorker(ctx.db, { organizationId }, (tx) =>
    recordSystemEvent(tx, {
      type: 'organization.digest_sent',
      action: 'organization.send_digest',
      organizationId,
      workspaceId: null,
      entityType: 'organization',
      entityId: organizationId,
      payload: { day: org.day, emailed: emailed.length, businesses: businesses.size },
      after: {
        day: org.day,
        emailed: emailed.map((p) => p.full_name || p.email),
        businesses: [...businesses],
      },
      correlationId: randomUUID(),
      causationId: ctx.job.id,
    }),
  );
  return next;
};

/** Job kind → handler, for scheduled.ts's jobs map. */
export const digestJobs: JobMap = {
  [DIGEST_JOBS.plan]: planDigests,
  [DIGEST_JOBS.send]: sendDigest,
};
