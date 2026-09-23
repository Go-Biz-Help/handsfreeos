/**
 * Automations' "Hand-off nobody picked up": the AI teammate handed a conversation to a person and, besides the
 * push, text and email it sends at once and the 15-minute alert, nobody has picked it up.
 * - At 1 hour of open time: another push to whoever it was handed to (its assignee, else the hand-off list).
 * - At 4 hours: the same push to the owners and admins too, and an email to them; the conversation's card on
 *   Home says the owner has been told (`conversation.handoff_escalated`).
 *
 * Each round reads the conversation again and stops if someone took it over, it went back to the AI, it closed
 * or snoozed, or a newer hand-off started its own rounds.
 */
import { randomUUID } from 'node:crypto';
import {
  automationSettingsOf,
  isWorkspaceUser,
  loadTeammate,
  openHoursOf,
  scheduleJob,
  workspaceMessaging,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { runtimeConfigOf } from '../ai-team/config';
import { handoffList } from '../ai-team/escalation';
import { afterOpenTime } from '../ai-team/hours';
import { handoffWaitingEmail } from '../emails/templates';
import { managers } from '../handlers/telephony';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { queuePush } from '../push/queue';
import { CHANNEL_WORD, conversationCollapseId } from '../push/urgent';
import { tenantOf } from '../services';
import { recordSystemEvent } from '../system-event';

export const HANDOFF_NUDGE_JOB = 'automations.handoff_nudge';
export const handoffNudgeKey = (conversationId: string, round: 1 | 2): string =>
  `handoff-nudge:${conversationId}:${round}`;
/** Open time after the hand-off: the second push, then the owners. */
export const HANDOFF_NUDGE_AFTER_MS = { 1: 60 * 60_000, 2: 4 * 60 * 60_000 } as const;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** conversation.handed_off: both rounds, timed from the hand-off in the business's open hours. */
export const onHandoffNudge: EventHandler = async (ctx) => {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const conversationId = str(p['conversationId']) ?? ctx.event.entityId;
  if (!conversationId) return;
  const scope = tenantOf(ctx.scope);
  const [conv] = await rows<{ needs_person_since: Date | null; taken_over_by: string | null }>(
    ctx.tx,
    sql`select needs_person_since, taken_over_by from app.conversations
        where id = ${conversationId} and workspace_id = ${scope.workspaceId} and handled_by = 'person'`,
  );
  if (!conv?.needs_person_since || conv.taken_over_by) return;
  const m = await workspaceMessaging(ctx.tx, scope.workspaceId);
  if (!automationSettingsOf(m.rawSettings).switches.handoffFollowUp) return;
  const since = new Date(conv.needs_person_since).getTime();
  const hours = openHoursOf(m.rawSettings);
  for (const round of [1, 2] as const)
    await scheduleJob(ctx.tx, {
      kind: HANDOFF_NUDGE_JOB,
      dedupeKey: handoffNudgeKey(conversationId, round),
      runAt: new Date(
        afterOpenTime(hours, m.timezone || 'UTC', since, HANDOFF_NUDGE_AFTER_MS[round]),
      ),
      payload: { conversationId, round, since: new Date(since).toISOString() },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    });
};

interface Waiting extends Record<string, unknown> {
  status: string;
  handled_by: string;
  needs_person_since: Date | null;
  taken_over_by: string | null;
  assignee_user_id: string | null;
  ai_teammate_id: string | null;
  channel: string;
  person_id: string | null;
  customer: string | null;
  assignee_name: string | null;
}

export const handoffNudgeJob: JobHandler = async (ctx) => {
  const p = (ctx.job.payload ?? {}) as Record<string, unknown>;
  const conversationId = str(p['conversationId']);
  const since = str(p['since']);
  const round = p['round'] === 2 ? 2 : 1;
  if (!conversationId || !since) return;
  const scope = tenantOf(ctx.scope);
  await asWorker(ctx.db, scope, async (tx) => {
    const [c] = await rows<Waiting>(
      tx,
      sql`select c.status::text as status, c.handled_by::text as handled_by, c.needs_person_since,
            c.taken_over_by, c.assignee_user_id, c.ai_teammate_id, c.channel::text as channel, c.person_id,
            nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') as customer,
            u.full_name as assignee_name
          from app.conversations c
          left join app.people p on p.id = c.person_id
          left join app.users u on u.id = c.assignee_user_id
          where c.id = ${conversationId} and c.workspace_id = ${scope.workspaceId}`,
    );
    // Picked up, back with the AI, closed or snoozed, or a newer hand-off with rounds of its own.
    if (
      !c ||
      c.status !== 'open' ||
      c.handled_by !== 'person' ||
      c.taken_over_by ||
      !c.needs_person_since ||
      new Date(c.needs_person_since).toISOString() !== new Date(since).toISOString()
    )
      return;
    const m = await workspaceMessaging(tx, scope.workspaceId);
    if (!automationSettingsOf(m.rawSettings).switches.handoffFollowUp) return;
    const assignee =
      c.assignee_user_id && (await isWorkspaceUser(tx, scope.workspaceId, c.assignee_user_id))
        ? c.assignee_user_id
        : null;
    const teammate = c.ai_teammate_id
      ? await loadTeammate(tx, scope.workspaceId, { teammateId: c.ai_teammate_id })
      : null;
    const handedTo = assignee
      ? [assignee]
      : (
          await handoffList(
            tx,
            scope.workspaceId,
            teammate ? runtimeConfigOf(teammate.config) : null,
          )
        ).map((u) => u.id);
    const heads = round === 2 ? await managers(tx, scope.workspaceId) : [];
    const customer = c.customer ?? 'A customer';
    const waited = round === 1 ? '1 hour' : '4 hours';
    await queuePush(tx, scope, {
      key: `${handoffNudgeKey(conversationId, round)}:${since}`,
      category: 'customer_waiting_no_ai',
      userIds: [...new Set([...handedTo, ...heads.map((u) => u.id)])],
      title: `Still waiting for a person · ${customer}`,
      about: CHANNEL_WORD[c.channel] ?? null,
      body: `Handed over ${waited} ago, and nobody has picked it up.`,
      path: `/app/w/${scope.workspaceId}/inbox/${conversationId}`,
      refs: {
        conversationId,
        ...(c.channel === 'sms' || c.channel === 'email' || c.channel === 'chat'
          ? { channel: c.channel }
          : {}),
        ...(c.person_id ? { personId: c.person_id } : {}),
      },
      collapseId: conversationCollapseId(conversationId),
    });
    if (round !== 2) return;
    const mail = handoffWaitingEmail({
      customer,
      waiting: waited,
      handedTo: c.assignee_name,
      link: `${ctx.webUrl}/app/w/${scope.workspaceId}/inbox/${conversationId}`,
    });
    for (const u of heads) {
      const wants =
        (u.settings as { notifications?: { unansweredEmail?: boolean } }).notifications
          ?.unansweredEmail !== false;
      if (wants && u.email) await ctx.mailer.send({ to: u.email, ...mail });
    }
    await recordSystemEvent(tx, {
      type: 'conversation.handoff_escalated',
      action: 'automations.handoff_nudge',
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'conversation',
      entityId: conversationId,
      payload: { personId: c.person_id, needsPersonSince: since, _broadcast: false },
      after: { told: heads.length },
      correlationId: randomUUID(),
      causationId: ctx.job.id,
    });
  });
};
