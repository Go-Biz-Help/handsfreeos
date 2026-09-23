/**
 * Automations' "End-of-day email": at 6 PM where the business is (its own time, in Settings → Automations), the
 * owners and admins get the day in numbers — leads and who reached them, jobs booked, done and missed, money in,
 * what the AI teammate did — then today's jobs nobody marked done and what's still open on Home.
 *
 * One job per business, re-armed for the next evening each time, like the morning summary. It goes once a day
 * (`workspace.evening_brief_sent` carries the day and who got it); someone who turned End-of-day email off in
 * Notifications gets none, and a business that turned the row off sends nobody one.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  ATTENTION_KIND_LABELS,
  automationSettingsOf,
  chipsOf,
  chipText,
  clockLabel,
  isUrgent,
  localDateOf,
  localInstant,
  rankItems,
  scorableOf,
  sortChips,
  uuidArray,
  type AttentionKind,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { attentionItems } from '@hfos/db/schema';
import type { BusinessPlanner } from '../attention/jobs';
import { membersOf, type Member } from '../attention/digest';
import { eveningBriefEmail, type MorningItem } from '../emails/templates';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { tenantOf } from '../services';
import { recordSystemEvent } from '../system-event';
import { dayNumbers, dayWindow, hasTeammate, todaysJobs } from './briefings';

export const EVENING_JOB = 'automations.evening_brief';
export const eveningJobKey = (workspaceId: string): string => `evening-brief:${workspaceId}`;
/** The default time; each business may move it (`settings.automations.briefings.eveningAt`). */
export const EVENING_AT = '18:00';
/** Open items the email lists; the rest are "and more" on Home. */
const TOP = 8;
const PLAN_CHUNK = 2000;

/** The next evening email where the business is, after `now`. */
export function nextEveningAt(now: number, timeZone: string, at = EVENING_AT): number {
  const today = localDateOf(now, timeZone);
  const t = localInstant(today, at, timeZone);
  return t > now ? t : localInstant(addDays(today, 1), at, timeZone);
}

/** Every business has its evening email waiting (at 6 PM; the job moves itself to the business's own time). */
export const ensureEvening: BusinessPlanner = async (tx, businesses, now) => {
  for (let i = 0; i < businesses.length; i += PLAN_CHUNK) {
    const chunk = businesses.slice(i, i + PLAN_CHUNK);
    const keys = chunk.map((b) => sql`${eveningJobKey(b.workspaceId)}`);
    const times = chunk.map((b) => sql`${new Date(nextEveningAt(now, b.timeZone)).toISOString()}`);
    await tx.execute(
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          select b.org, b.ws, ${EVENING_JOB}, b.key, b.at::timestamptz, '{}'::jsonb
          from unnest(${uuidArray(chunk.map((b) => b.workspaceId))},
            ${uuidArray(chunk.map((b) => b.organizationId))},
            array[${sql.join(keys, sql`, `)}]::text[],
            array[${sql.join(times, sql`, `)}]::text[]) as b(ws, org, key, at)
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
    );
  }
};

/** On unless the person turned it off. */
const wantsEvening = (u: Member) =>
  (u.settings as { notifications?: { eveningSummary?: boolean } }).notifications?.eveningSummary !==
  false;

const firstNameOf = (full: string | null): string => (full ?? '').trim().split(/\s+/)[0] ?? '';

/** `automations.evening_brief`: one business's end-of-day email, once for the day, then the next evening. */
export const eveningBriefJob: JobHandler = async (ctx) => {
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
    const timeZone = w.timezone || 'UTC';
    const s = automationSettingsOf(w.settings);
    const at = s.briefings.eveningAt;
    const window = dayWindow(now, timeZone);
    const base = { name: w.name, timeZone, at, day: window.day };
    if (!s.switches.eveningBrief) return { ...base, wait: null, send: null };
    // Armed for 6 PM but the business chose later: wait for its own time today.
    const todayAt = localInstant(window.day, at, timeZone);
    if (now < todayAt - 60_000) return { ...base, wait: new Date(todayAt), send: null };
    const [sent] = await rows(
      tx,
      sql`select 1 from app.events
          where entity_type = 'workspace' and entity_id = ${scope.workspaceId}
            and event_type = 'workspace.evening_brief_sent' and payload ->> 'day' = ${window.day}
          limit 1`,
    );
    if (sent) return { ...base, wait: null, send: null };
    const people = (await membersOf(tx, scope.workspaceId, scope.organizationId)).filter(
      (p) => (p.role === 'owner' || p.role === 'admin') && wantsEvening(p),
    );
    const items = await tx
      .select()
      .from(attentionItems)
      .where(
        sql`${attentionItems.workspaceId} = ${scope.workspaceId} and ${attentionItems.state} = 'open'`,
      );
    const jobs = await todaysJobs(tx, scope.workspaceId, window);
    const numbers = await dayNumbers(tx, scope.workspaceId, window);
    const ai = await hasTeammate(tx, scope.workspaceId);
    return { ...base, wait: null, send: { people, items, jobs, numbers, ai } };
  });
  if (!found) return;
  if (found.wait) return { rescheduleAt: found.wait };
  const next = { rescheduleAt: new Date(nextEveningAt(now, found.timeZone, found.at)) };
  if (!found.send || !found.send.people.length) return next;

  const { people, items, jobs, numbers, ai } = found.send;
  const home = `${ctx.webUrl}/app/w/${scope.workspaceId}`;
  const ranked = rankItems(
    items.map((r) => ({ ...scorableOf(r), row: r })),
    now,
  ).map((x) => x.row);
  const open: MorningItem[] = ranked.slice(0, TOP).map((r) => ({
    kind: ATTENTION_KIND_LABELS[r.kind as AttentionKind],
    title: r.title,
    chips: sortChips(chipsOf(r))
      .slice(0, 3)
      .map((c) => chipText(c, now)),
    link: `${home}?item=${r.id}`,
  }));
  const notMarked = jobs
    .filter((j) => j.status === 'scheduled' && j.endsAt <= now)
    .map((j) => ({
      time: clockLabel(j.startsAt, found.timeZone),
      customers: j.customers,
      title: j.title,
      unconfirmed: false,
      link: `${home}/calendar?appt=${j.id}`,
    }));
  const urgent = ranked.filter((r) => isUrgent(scorableOf(r), now)).length;
  const emailed: Member[] = [];
  let failures = 0;
  for (const person of people) {
    const mail = eveningBriefEmail({
      business: found.name,
      firstName: firstNameOf(person.full_name),
      numbers: {
        newLeads: numbers.newLeads,
        leadsReached: numbers.leadsReached,
        jobsBooked: numbers.jobsBooked,
        jobsDone: numbers.jobsDone,
        noShows: numbers.noShows,
        paidCents: numbers.paidCents,
        payments: numbers.payments,
        invoicesSent: numbers.invoicesSent,
        estimatesSent: numbers.estimatesSent,
        ai: ai ? { answered: numbers.aiAnswered, draftsWaiting: numbers.aiDraftsWaiting } : null,
      },
      notMarked,
      open,
      openTotal: ranked.length,
      urgent,
      homeLink: home,
    });
    try {
      await ctx.mailer.send({ to: person.email, ...mail });
      emailed.push(person);
    } catch (e) {
      failures++;
      ctx.log.warn({ err: errorMessage(e), userId: person.id }, 'could not send an evening email');
    }
  }
  if (emailed.length === 0) {
    if (failures > 0) throw new Error('could not send the evening email to anyone');
    return next;
  }
  await asWorker(ctx.db, scope, (tx) =>
    recordSystemEvent(tx, {
      type: 'workspace.evening_brief_sent',
      action: 'automations.evening_brief',
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'workspace',
      entityId: scope.workspaceId,
      payload: { day: found.day, userIds: emailed.map((p) => p.id), _broadcast: false },
      after: { day: found.day, emailed: emailed.map((p) => p.full_name || p.email) },
      correlationId: randomUUID(),
      causationId: ctx.job.id,
    }),
  );
  return next;
};
