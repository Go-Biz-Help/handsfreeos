/**
 * What follows a hand-off to a person (plan M7, "Handing to a person"), on `conversation.handed_off`. Every
 * hand-off sends it, with `ai_teammate.handed_off` (for workflows) beside it, so this listens to the one. The
 * customer's line went out with the hand-off itself (handoff.ts).
 * - The team's email, from the design: to the assignee, else the teammate's hand-off list (its owners and admins
 *   unless it names people), each as their aiHandoff setting allows (on unless turned off).
 * - An emergency: an urgent email to the assignee and every owner and admin, whatever their settings, with what
 *   the customer wrote and the safety text they got, word for word.
 * - M3's unanswered alert is pending for 15 minutes of open hours after the hand-off (scheduled.ts sends it).
 * - A budget hand-off: the owners hear once a day that the teammate reached its share of the AI limit.
 * A marker event per hand-off keeps a retry from emailing twice (it commits on its own, like the booking email).
 */
import { eq } from 'drizzle-orm';
import {
  emergencyKind,
  formatPhone,
  isWorkspaceUser,
  loadTeammate,
  localDateOf,
  openHoursOf,
  scheduleJob,
  workspaceMessaging,
  type EmergencyKind,
  type TeammateConfig,
  type TeammateRow,
  type WeeklyHours,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { handoffEmail, teammateLimitEmail, urgentHandoffEmail } from '../emails/templates';
import { managers, workspaceManagers } from '../handlers/telephony';
import type { EventHandler, HandlerContext } from '../handlers/types';
import type { TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import { runtimeConfigOf } from './config';
import { HANDOFF_UNANSWERED_MS } from './constants';
import { afterOpenTime } from './hours';

type Conversation = typeof conversations.$inferSelect;

interface Recipient {
  readonly id: string;
  readonly email: string;
  readonly full_name: string | null;
  readonly settings: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Intl's clock uses a narrow no-break space before AM/PM; mail reads better with a plain one. */
const ODD_SPACES = new RegExp(`[${String.fromCodePoint(0x202f, 0x00a0)}]`, 'g');
const plain = (s: string) => s.replace(ODD_SPACES, ' ');
const clock = (at: number, timeZone: string) =>
  plain(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(at),
  );
const weekday = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(at);

const EMERGENCY_ABOUT: Readonly<Record<EmergencyKind, string>> = {
  gas: 'a possible gas smell',
  carbon_monoxide: 'a carbon monoxide alarm',
  fire: 'fire or smoke',
  flooding: 'flooding',
  injury: 'someone being hurt',
};
const EMERGENCY_SUBJECT: Readonly<Record<EmergencyKind, string>> = {
  gas: 'may smell gas',
  carbon_monoxide: 'has a carbon monoxide alarm going off',
  fire: 'reports fire or smoke',
  flooding: 'reports flooding',
  injury: 'says someone is hurt',
};
const WROTE: Readonly<Record<string, string>> = {
  sms: 'texted',
  email: 'emailed',
  chat: 'wrote in the website chat',
};

/**
 * When a hand-off sets off M3's unanswered alert: this much open time after it (15 minutes; the worker's
 * reminder override in tests and local demos).
 */
export function handoffAlertDue(
  needsPersonSince: Date,
  openHours: WeeklyHours,
  timeZone: string,
  overrideMs: number | null,
): number {
  return afterOpenTime(
    openHours,
    timeZone,
    needsPersonSince.getTime(),
    overrideMs ?? HANDOFF_UNANSWERED_MS,
  );
}

const wantsHandoffs = (u: Recipient) =>
  (u.settings as { notifications?: { aiHandoff?: boolean } }).notifications?.aiHandoff !== false;

async function usersNamed(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
): Promise<Recipient[]> {
  const out: Recipient[] = [];
  for (const id of new Set(ids)) {
    if (!(await isWorkspaceUser(tx, workspaceId, id))) continue;
    const [u] = await rows<Recipient & Record<string, unknown>>(
      tx,
      sql`select id, email::text as email, full_name, settings from app.users where id = ${id}`,
    );
    if (u) out.push(u);
  }
  return out;
}

/** Who hears about a hand-off nobody is assigned: the teammate's list (its owners and admins unless it names people). */
async function handoffList(
  tx: Tx,
  workspaceId: string,
  config: TeammateConfig | null,
): Promise<Recipient[]> {
  const who = config?.handOff.notify;
  if (who?.kind === 'users') {
    const named = await usersNamed(
      tx,
      workspaceId,
      who.userIds.filter((v): v is string => typeof v === 'string'),
    );
    if (named.length) return named;
  }
  return workspaceManagers(tx, workspaceId);
}

/** The owners (the organization's when the business has none of its own). */
async function ownersOf(tx: Tx, workspaceId: string): Promise<Recipient[]> {
  return rows<Recipient & Record<string, unknown>>(
    tx,
    sql`with own as (
          select wm.user_id from app.workspace_memberships wm
          where wm.workspace_id = ${workspaceId} and wm.role = 'owner')
        select u.id, u.email::text as email, u.full_name, u.settings from app.users u
        where u.id in (select user_id from own)
           or (not exists (select 1 from own) and u.id in (
                select om.user_id from app.organization_memberships om
                join app.workspaces w on w.organization_id = om.organization_id
                where w.id = ${workspaceId} and om.role = 'owner'))
        order by u.email`,
  );
}

/** How the email names the customer: their name, a chat visitor's typed name, or how they wrote in. */
async function customerOf(tx: Tx, conv: Conversation): Promise<{ name: string; first: string }> {
  if (conv.personId) {
    const [p] = await rows<{ first_name: string | null; last_name: string | null }>(
      tx,
      sql`select first_name, last_name from app.people where id = ${conv.personId}`,
    );
    const name = `${p?.first_name ?? ''} ${p?.last_name ?? ''}`.trim();
    if (name) return { name, first: p?.first_name?.trim() || name };
  }
  if (conv.channel === 'chat') {
    const [v] = await rows<{ name: string | null }>(
      tx,
      sql`select name from app.chat_visitors where id::text = ${conv.counterpart.replace(/^chat:/, '')}`,
    );
    const name = v?.name?.trim() || 'A website visitor';
    return { name, first: v?.name?.trim().split(/\s+/)[0] || 'the visitor' };
  }
  const contact = conv.channel === 'sms' ? formatPhone(conv.counterpart) : conv.counterpart;
  return { name: contact, first: contact };
}

interface Hand {
  readonly scope: TenantScope;
  readonly conv: Conversation;
  readonly teammate: TeammateRow | null;
  readonly reason: string;
  readonly note: string | null;
  readonly timeZone: string;
}

/** The team's email for one hand-off (or the urgent one for an emergency), once. */
async function tellTeam(ctx: HandlerContext, h: Hand): Promise<void> {
  const [done] = await rows(
    ctx.tx,
    sql`select 1 from app.events
        where causation_id = ${ctx.event.id} and event_type = 'ai_teammate.handoff_emailed' limit 1`,
  );
  if (done) return;
  const ws = h.scope.workspaceId;
  const tz = h.timeZone;
  const config = h.teammate ? runtimeConfigOf(h.teammate.config) : null;
  const [assignee] = h.conv.assigneeUserId
    ? await usersNamed(ctx.tx, ws, [h.conv.assigneeUserId])
    : [];
  const who = await customerOf(ctx.tx, h.conv);
  const link = `${ctx.webUrl}/app/w/${ws}/inbox/${h.conv.id}`;
  const [last] = await rows<{
    body_text: string | null;
    subject: string | null;
    occurred_at: Date | string;
  }>(
    ctx.tx,
    sql`select body_text, subject, occurred_at from app.messages
        where conversation_id = ${h.conv.id} and direction = 'inbound'
        order by occurred_at desc, created_at desc limit 1`,
  );
  const lastText = last ? (last.body_text || last.subject || '').trim().slice(0, 600) : '';
  const lastAt = last ? new Date(last.occurred_at).getTime() : Date.now();
  const urgent = h.reason === 'emergency';
  let recipients: Recipient[];
  if (urgent) {
    const everyone = [...(assignee ? [assignee] : []), ...(await managers(ctx.tx, ws))];
    recipients = [...new Map(everyone.map((u) => [u.id, u])).values()];
    const [line] = await rows<{ body_text: string | null }>(
      ctx.tx,
      sql`select body_text from app.messages
          where conversation_id = ${h.conv.id} and client_id like ${`handoff:${h.conv.id}:%`}
          order by created_at desc limit 1`,
    );
    const kind = emergencyKind(lastText);
    const mail = urgentHandoffEmail({
      teammate: h.teammate?.name ?? null,
      customer: who.name,
      firstName: who.first,
      opening: `${who.name} ${WROTE[h.conv.channel] ?? 'wrote'} at ${clock(lastAt, tz)} on ${weekday(lastAt, tz)} about ${kind ? EMERGENCY_ABOUT[kind] : 'an emergency'}.`,
      subjectAbout: kind ? EMERGENCY_SUBJECT[kind] : 'may have an emergency',
      wrote: lastText || null,
      sent: line?.body_text ?? null,
      link,
    });
    for (const r of recipients) await ctx.mailer.send({ to: r.email, ...mail, priority: 'high' });
  } else {
    const list = assignee ? [assignee] : await handoffList(ctx.tx, ws, config);
    recipients = list.filter(wantsHandoffs);
    if (!recipients.length) return;
    const mail = handoffEmail({
      teammate: h.teammate?.name ?? null,
      channel: h.conv.channel,
      customer: who.name,
      firstName: who.first,
      at: clock(h.conv.needsPersonSince!.getTime(), tz),
      note: h.note,
      lastMessage: last && lastText ? { text: lastText, at: clock(lastAt, tz) } : null,
      link,
      assignedToYou: !!assignee,
    });
    for (const r of recipients) await ctx.mailer.send({ to: r.email, ...mail });
  }
  await asWorker(ctx.db, h.scope, (tx) =>
    recordSystemEvent(tx, {
      type: 'ai_teammate.handoff_emailed',
      action: 'ai_teammate.handoff_email',
      organizationId: h.scope.organizationId,
      workspaceId: ws,
      entityType: 'conversation',
      entityId: h.conv.id,
      payload: { reason: h.reason, urgent, recipients: recipients.length, _broadcast: false },
      after: { emailed: recipients.map((r) => r.full_name || r.email), urgent },
      correlationId: ctx.event.correlationId,
      causationId: ctx.event.id,
    }),
  );
}

/** The teammate used its share of today's AI limit: its owners hear once a day. */
async function limitNotice(
  ctx: HandlerContext,
  scope: TenantScope,
  teammate: TeammateRow,
  business: string,
  timeZone: string,
): Promise<void> {
  const day = localDateOf(Date.now(), timeZone);
  // Two hand-offs at once still make one email: the second waits here, then finds the marker.
  await ctx.tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`ai-limit:${scope.workspaceId}:${day}`}))`,
  );
  const [done] = await rows(
    ctx.tx,
    sql`select 1 from app.events
        where workspace_id = ${scope.workspaceId} and event_type = 'ai_teammate.budget_reached'
          and payload ->> 'day' = ${day}
        limit 1`,
  );
  if (done) return;
  const owners = await ownersOf(ctx.tx, scope.workspaceId);
  const mail = teammateLimitEmail({
    teammate: teammate.name,
    business,
    sharePercent: runtimeConfigOf(teammate.config).limits.dailySharePercent,
    link: `${ctx.webUrl}/app/w/${scope.workspaceId}/ai-team`,
  });
  for (const o of owners) await ctx.mailer.send({ to: o.email, ...mail });
  await asWorker(ctx.db, scope, (tx) =>
    recordSystemEvent(tx, {
      type: 'ai_teammate.budget_reached',
      action: 'ai_teammate.budget_notice',
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'ai_teammate',
      entityId: teammate.id,
      payload: { day, teammateId: teammate.id, emailed: owners.length },
      after: { teammate: teammate.name, emailed: owners.map((o) => o.full_name || o.email) },
      correlationId: ctx.event.correlationId,
      causationId: ctx.event.id,
    }),
  );
}

/** `conversation.handed_off`: the alert clock, the team's email, and for a budget hand-off, the owners. */
export const onHandedOff: EventHandler = async (ctx) => {
  const e = ctx.event;
  if (!e.workspaceId || !e.organizationId) return;
  const scope: TenantScope = { workspaceId: e.workspaceId, organizationId: e.organizationId };
  const p = isRecord(e.payload) ? e.payload : {};
  const conversationId = str(p['conversationId']) ?? e.entityId;
  if (!conversationId) return;
  const [conv] = await ctx.tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  // Someone has it already, or it went back to the teammate: nobody needs telling.
  if (!conv || conv.handledBy !== 'person' || !conv.needsPersonSince || conv.takenOverBy) return;
  const m = await workspaceMessaging(ctx.tx, scope.workspaceId);
  const timeZone = m.timezone || 'UTC';
  await scheduleJob(
    ctx.tx,
    {
      kind: 'conversation.unanswered_check',
      dedupeKey: `unanswered:${conv.id}`,
      runAt: new Date(
        handoffAlertDue(
          conv.needsPersonSince,
          openHoursOf(m.rawSettings),
          timeZone,
          ctx.reminderOverrideMs,
        ),
      ),
      payload: { conversationId: conv.id },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
  const teammateId = str(p['teammateId']) ?? conv.aiTeammateId;
  const teammate = teammateId
    ? await loadTeammate(ctx.tx, scope.workspaceId, { teammateId })
    : null;
  const reason = str(p['reason']) ?? 'other';
  await tellTeam(ctx, { scope, conv, teammate, reason, note: str(p['note']), timeZone });
  if (reason === 'budget' && teammate) await limitNotice(ctx, scope, teammate, m.name, timeZone);
};
