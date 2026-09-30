/**
 * The morning summary (M8): at 7 AM where the business is, everyone who works there gets one email about what
 * needs them, urgent first — and only when they have something. It reuses the agency digest's shape: the hourly
 * plan keeps one `attention_digest.send` job waiting per business, and the job re-arms itself for the next 7 AM,
 * worked out again each time so it follows daylight saving.
 *
 * Each person sees their own list, the way Home does: a member gets their items plus the ones nobody has taken,
 * an owner or admin gets everything, and approval items only reach the people who can decide them. It goes out
 * once a day per business (`workspace.attention_digest_sent` carries the day and who got it), and someone who
 * turned Morning summary off gets none. A business that turned "Morning brief" off in Settings → Automations sends
 * nobody one; the job keeps its place for the next morning, so turning it back on needs nothing else.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  affectedCents,
  ATTENTION_KIND_LABELS,
  automationOn,
  chipsOf,
  chipText,
  clockLabel,
  decidableApprovals,
  FOLLOW_UP_OVERDUE,
  isUrgent,
  localDateOf,
  localInstant,
  rankItems,
  scorableOf,
  scheduleJob,
  sortChips,
  uuidArray,
  type AttentionItemRow,
  type AttentionKind,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { attentionItems } from '@hfos/db/schema';
import {
  dayWindow,
  followUpsDueToday,
  todaysJobs,
  type FollowUpDue,
  type TodaysJob,
} from '../automations/briefings';
import { attentionMorningEmail, type MorningItem, type MorningJob } from '../emails/templates';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { tenantOf } from '../services';
import { recordSystemEvent } from '../system-event';
import { ATTENTION_JOBS, DIGEST_SEND_AT, digestJobKey } from './constants';
import type { BusinessPlanner } from './jobs';

/** Items listed below the urgent ones; the rest are a "and more" on Home. */
const TOP = 8;
/** Businesses per statement (four parameters each, well under Postgres's limit). */
const PLAN_CHUNK = 2000;

/** The next 7 AM where the business is, after `now`. */
export function nextAttentionDigestAt(now: number, timeZone: string): number {
  const today = localDateOf(now, timeZone);
  const at = localInstant(today, DIGEST_SEND_AT, timeZone);
  return at > now ? at : localInstant(addDays(today, 1), DIGEST_SEND_AT, timeZone);
}

/** Every business has its morning summary waiting, at its own next 7 AM; one already waiting stays as it is. */
export const ensureDigests: BusinessPlanner = async (tx, businesses, now) => {
  for (let i = 0; i < businesses.length; i += PLAN_CHUNK) {
    const chunk = businesses.slice(i, i + PLAN_CHUNK);
    const keys = chunk.map((b) => sql`${digestJobKey(b.workspaceId)}`);
    const times = chunk.map(
      (b) => sql`${new Date(nextAttentionDigestAt(now, b.timeZone)).toISOString()}`,
    );
    await tx.execute(
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          select b.org, b.ws, ${ATTENTION_JOBS.digest}, b.key, b.at::timestamptz, '{}'::jsonb
          from unnest(${uuidArray(chunk.map((b) => b.workspaceId))},
            ${uuidArray(chunk.map((b) => b.organizationId))},
            array[${sql.join(keys, sql`, `)}]::text[],
            array[${sql.join(times, sql`, `)}]::text[]) as b(ws, org, key, at)
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
    );
  }
};

export interface Member extends Record<string, unknown> {
  id: string;
  email: string;
  full_name: string | null;
  settings: Record<string, unknown>;
  role: 'owner' | 'admin' | 'member' | null;
  /** What the business lets them do (0106), as the database keeps it. */
  permissions: string[] | null;
}

/** On unless the person turned it off. */
const wantsDigest = (u: Member) =>
  (u.settings as { notifications?: { attentionDigest?: boolean } }).notifications
    ?.attentionDigest !== false;

/** Everyone who works in the business, with the role their list follows (a member sees their own plus unassigned). */
export async function membersOf(
  tx: Tx,
  workspaceId: string,
  organizationId: string,
): Promise<Member[]> {
  return rows<Member>(
    tx,
    sql`select u.id, u.email::text as email, u.full_name, u.settings,
          coalesce(wm.role::text,
            case when om.role::text in ('owner', 'admin') then om.role::text end) as role,
          (select wa.permissions from app.workspace_access wa
           where wa.user_id = u.id and wa.workspace_id = ${workspaceId}) as permissions
        from app.users u
        left join app.workspace_memberships wm
          on wm.user_id = u.id and wm.workspace_id = ${workspaceId}
        left join app.organization_memberships om
          on om.user_id = u.id and om.organization_id = ${organizationId}
        where wm.user_id is not null or om.role::text in ('owner', 'admin')
        order by u.email`,
  );
}

const firstNameOf = (full: string | null): string => (full ?? '').trim().split(/\s+/)[0] ?? '';

/** The morning's "who to call": items that are a call to make today. */
function isCall(r: AttentionItemRow, endOfTomorrow: number): boolean {
  switch (r.kind as AttentionKind) {
    case 'hot_lead':
    case 'estimate_waiting':
      return true;
    case 'unconfirmed_appointment':
      return !r.dueAt || r.dueAt.getTime() < endOfTomorrow;
    case 'missing_next_action':
      return chipsOf(r).some((c) => c.code === FOLLOW_UP_OVERDUE);
    default:
      return false;
  }
}

/** What the morning adds to the Action Center's items: today's jobs and follow-ups due later today. */
export interface MorningExtras {
  readonly jobs: readonly TodaysJob[];
  readonly followUps: readonly FollowUpDue[];
  readonly timeZone: string;
  readonly endOfTomorrow: number;
}

/** One person's morning summary, or null when nothing needs them. */
function summaryFor(
  person: Member,
  items: readonly AttentionItemRow[],
  decidable: ReadonlySet<string>,
  now: number,
  links: { business: string; home: string },
  extras: MorningExtras,
): ReturnType<typeof attentionMorningEmail> | null {
  const everyone = person.role === 'owner' || person.role === 'admin';
  const theirs = items.filter(
    (i) =>
      (everyone || i.assigneeUserId === null || i.assigneeUserId === person.id) &&
      (i.kind !== 'ai_approval' || decidable.has(i.subjectId)) &&
      // Texting turned down is for the owners and admins, who set texting up.
      (i.kind !== 'texting_rejected' || everyone),
  );
  const jobs: MorningJob[] = extras.jobs
    .filter((j) => everyone || j.userIds.includes(person.id))
    .map((j) => ({
      time: clockLabel(j.startsAt, extras.timeZone),
      customers: j.customers,
      title: j.title,
      unconfirmed: !j.confirmed,
      link: `${links.home}/calendar?appt=${j.id}`,
    }));
  const dueLater: MorningItem[] = extras.followUps
    .filter((f) => everyone || f.assigneeUserId === null || f.assigneeUserId === person.id)
    .map((f) => ({
      kind: 'Follow-up due',
      title: `${f.name} · ${f.title}`,
      chips: [f.nextAction, clockLabel(f.dueAt, extras.timeZone)].filter((c): c is string => !!c),
      link: `${links.home}/leads/${f.leadId}`,
    }));
  if (theirs.length === 0 && jobs.length === 0 && dueLater.length === 0) return null;
  const ranked = rankItems(
    theirs.map((r) => ({ ...scorableOf(r), row: r })),
    now,
  ).map((x) => x.row);
  const listed = (r: AttentionItemRow): MorningItem => ({
    kind: ATTENTION_KIND_LABELS[r.kind as AttentionKind],
    title: r.title,
    chips: sortChips(chipsOf(r))
      .slice(0, 3)
      .map((c) => chipText(c, now)),
    link: `${links.home}?item=${r.id}`,
  });
  const calls = ranked.filter((r) => isCall(r, extras.endOfTomorrow));
  const others = ranked.filter((r) => !calls.includes(r));
  const urgent = others.filter((r) => isUrgent(scorableOf(r), now));
  const rest = others.filter((r) => !urgent.includes(r)).slice(0, TOP);
  return attentionMorningEmail({
    business: links.business,
    firstName: firstNameOf(person.full_name),
    affectedCents: affectedCents(
      ranked.map((r) => ({
        value: Number(r.valueCents ?? 0),
        valueIsEstimate: r.valueIsEstimate,
        moneyKey: r.moneyKey,
        leadId: r.leadId,
      })),
    ),
    jobs,
    call: [...calls.map(listed), ...dueLater],
    urgent: urgent.map(listed),
    rest: rest.map(listed),
    total: ranked.length,
    homeLink: links.home,
    everyone,
  });
}

/** `attention_digest.send`: one business's morning summary, once for the day, then the next 7 AM. */
export const sendAttentionDigest: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const now = ctx.now;
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [w] = await rows<{
      name: string;
      timezone: string;
      settings: Record<string, unknown> | null;
    }>(
      tx,
      sql`select name, timezone, settings from app.workspaces where id = ${scope.workspaceId}`,
    );
    if (!w) return null;
    const ws = { name: w.name, timezone: w.timezone };
    const timeZone = ws.timezone || 'UTC';
    const day = localDateOf(now, timeZone);
    const sent = await rows(
      tx,
      sql`select 1 from app.events
          where entity_type = 'workspace' and entity_id = ${scope.workspaceId}
            and event_type = 'workspace.attention_digest_sent' and payload ->> 'day' = ${day}
          limit 1`,
    );
    const nobody = {
      ...ws,
      timeZone,
      day,
      people: [] as Member[],
      items: [] as AttentionItemRow[],
      decidable: new Map<string, ReadonlySet<string>>(),
      extras: {
        jobs: [],
        followUps: [],
        timeZone,
        endOfTomorrow: now,
      } as MorningExtras,
    };
    if (sent.length > 0 || !automationOn(w.settings, 'morningBrief'))
      return { ...nobody, done: true };
    const items = await tx
      .select()
      .from(attentionItems)
      .where(
        sql`${attentionItems.workspaceId} = ${scope.workspaceId} and ${attentionItems.state} = 'open'`,
      );
    const people = (await membersOf(tx, scope.workspaceId, scope.organizationId)).filter(
      wantsDigest,
    );
    const approvals = items.filter((i) => i.kind === 'ai_approval').map((i) => i.subjectId);
    const decidable = new Map<string, ReadonlySet<string>>();
    for (const p of people)
      decidable.set(
        p.id,
        approvals.length
          ? await decidableApprovals(
              tx,
              scope.workspaceId,
              { role: p.role, permissions: p.permissions },
              p.id,
              approvals,
            )
          : new Set<string>(),
      );
    const window = dayWindow(now, timeZone);
    const extras: MorningExtras = {
      jobs: await todaysJobs(tx, scope.workspaceId, window),
      followUps: await followUpsDueToday(tx, scope.workspaceId, now, window),
      timeZone,
      endOfTomorrow: localInstant(addDays(window.day, 2), '00:00', timeZone),
    };
    return { ...nobody, done: false, people, items, decidable, extras };
  });
  // The business is gone (its jobs go with it).
  if (!found) return;
  const next = { rescheduleAt: new Date(nextAttentionDigestAt(now, found.timeZone)) };
  if (
    found.done ||
    found.people.length === 0 ||
    (found.items.length === 0 &&
      found.extras.jobs.length === 0 &&
      found.extras.followUps.length === 0)
  )
    return next;

  const links = {
    business: found.name,
    home: `${ctx.webUrl}/app/w/${scope.workspaceId}`,
  };
  const emailed: Member[] = [];
  let failures = 0;
  for (const person of found.people) {
    const mail = summaryFor(
      person,
      found.items,
      found.decidable?.get(person.id) ?? new Set<string>(),
      now,
      links,
      found.extras,
    );
    if (!mail) continue;
    try {
      await ctx.mailer.send({ to: person.email, ...mail });
      emailed.push(person);
    } catch (e) {
      failures++;
      ctx.log.warn({ err: errorMessage(e), userId: person.id }, 'could not send a morning summary');
    }
  }
  if (emailed.length === 0) {
    // Nobody could be emailed: the job's retries try again. Nobody had anything: done for today.
    if (failures > 0) throw new Error('could not send the morning summary to anyone');
    return next;
  }
  await asWorker(ctx.db, scope, (tx) =>
    recordSystemEvent(tx, {
      type: 'workspace.attention_digest_sent',
      action: 'attention.send_digest',
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'workspace',
      entityId: scope.workspaceId,
      payload: {
        day: found.day,
        userIds: emailed.map((p) => p.id),
        items: found.items.length,
        _broadcast: false,
      },
      after: { day: found.day, emailed: emailed.map((p) => p.full_name || p.email) },
      correlationId: randomUUID(),
      causationId: ctx.job.id,
    }),
  );
  return next;
};

/** The business's morning summary, armed for now (the test route and the seed). */
export async function armDigestNow(
  tx: Tx,
  business: { workspaceId: string; organizationId: string },
  at: number,
): Promise<void> {
  await scheduleJob(
    tx,
    {
      kind: ATTENTION_JOBS.digest,
      dedupeKey: digestJobKey(business.workspaceId),
      runAt: new Date(at),
      payload: {},
      workspaceId: business.workspaceId,
      organizationId: business.organizationId,
    },
    { pullEarlier: true },
  );
}
