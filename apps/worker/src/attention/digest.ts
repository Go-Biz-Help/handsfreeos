/**
 * The morning summary (M8): at 7 AM where the business is, everyone who works there gets one email about what
 * needs them, urgent first — and only when they have something. It reuses the agency digest's shape: the hourly
 * plan keeps one `attention_digest.send` job waiting per business, and the job re-arms itself for the next 7 AM,
 * worked out again each time so it follows daylight saving.
 *
 * Each person sees their own list, the way Home does: a member gets their items plus the ones nobody has taken,
 * an owner or admin gets everything, and approval items only reach the people who can decide them. It goes out
 * once a day per business (`workspace.attention_digest_sent` carries the day and who got it), and someone who
 * turned Morning summary off gets none.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  affectedCents,
  ATTENTION_KIND_LABELS,
  chipsOf,
  chipText,
  decidableApprovals,
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
import { attentionMorningEmail, type MorningItem } from '../emails/templates';
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

interface Member extends Record<string, unknown> {
  id: string;
  email: string;
  full_name: string | null;
  settings: Record<string, unknown>;
  role: 'owner' | 'admin' | 'member' | null;
}

/** On unless the person turned it off. */
const wantsDigest = (u: Member) =>
  (u.settings as { notifications?: { attentionDigest?: boolean } }).notifications
    ?.attentionDigest !== false;

/** Everyone who works in the business, with the role their list follows (a member sees their own plus unassigned). */
async function membersOf(tx: Tx, workspaceId: string, organizationId: string): Promise<Member[]> {
  return rows<Member>(
    tx,
    sql`select u.id, u.email::text as email, u.full_name, u.settings,
          coalesce(wm.role::text,
            case when om.role::text in ('owner', 'admin') then om.role::text end) as role
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

/** One person's morning summary, or null when nothing needs them. */
function summaryFor(
  person: Member,
  items: readonly AttentionItemRow[],
  decidable: ReadonlySet<string>,
  now: number,
  links: { business: string; home: string },
): ReturnType<typeof attentionMorningEmail> | null {
  const everyone = person.role === 'owner' || person.role === 'admin';
  const theirs = items.filter(
    (i) =>
      (everyone || i.assigneeUserId === null || i.assigneeUserId === person.id) &&
      (i.kind !== 'ai_approval' || decidable.has(i.subjectId)),
  );
  if (theirs.length === 0) return null;
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
  const urgent = ranked.filter((r) => isUrgent(scorableOf(r), now));
  const rest = ranked.filter((r) => !urgent.includes(r)).slice(0, TOP);
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
    const [ws] = await rows<{ name: string; timezone: string }>(
      tx,
      sql`select name, timezone from app.workspaces where id = ${scope.workspaceId}`,
    );
    if (!ws) return null;
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
    };
    if (sent.length > 0) return { ...nobody, done: true };
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
          ? await decidableApprovals(tx, scope.workspaceId, p.role, p.id, approvals)
          : new Set<string>(),
      );
    return { ...nobody, done: false, people, items, decidable };
  });
  // The business is gone (its jobs go with it).
  if (!found) return;
  const next = { rescheduleAt: new Date(nextAttentionDigestAt(now, found.timeZone)) };
  if (found.done || found.people.length === 0 || found.items.length === 0) return next;

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
