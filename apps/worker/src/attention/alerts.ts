/**
 * The one urgent email (M8). It goes out when something can't wait: a hot lead after 10 minutes, a new lead
 * nobody answered after 15 open-hours minutes, or a customer waiting past the business's reply threshold. Each
 * item's `urgent_from` decides the moment; the worker notices it in settle.ts and queues `attention.urgent_alert`.
 *
 * - **Once per item:** at most one email for a set of facts (`alert_fingerprint`). New facts can alert again.
 * - **Never two for one wait:** a waiting conversation folds into its customer's lead card, and the card turns
 *   urgent on the same wait, so anything tied to a conversation dedupes on `conversation.unanswered_alerted` with
 *   that wait's time, exactly as `conversation.unanswered_check` does. That check keeps its own timing and calls
 *   this sender, so today's unanswered-message email and the Action Center's are the same email.
 * - **Lead kinds alert only in open hours:** outside them the job waits for the business to open.
 * - **Who hears:** the assignee, otherwise every owner and admin, each as their "Urgent items" setting allows.
 * - **On their phones too (M10):** the same people get the push, each as their push switch for it allows (urgent
 *   for a lead, customer waiting for a conversation), queued with the marks below so it goes once (push/urgent.ts).
 * - **Never about old clocks:** settle.ts's first-sweep guard marks data from before the Action Center as already
 *   alerted, so nothing here ever fires for it.
 */
import { eq } from 'drizzle-orm';
import {
  addOpenTime,
  chipsOf,
  chipText,
  isLeadKind,
  openHoursOf,
  scheduleJob,
  sortChips,
  workspaceMessaging,
  type AttentionItemRow,
  type AttentionKind,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { attentionItems, conversations } from '@hfos/db/schema';
import { conversationContact } from '../chat/store';
import { attentionUrgentEmail, type AttentionUrgentInput } from '../emails/templates';
import { managers } from '../handlers/telephony';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { queueUrgentPush, urgentPushListeners } from '../push/urgent';
import { tenantOf, type TenantScope, type WorkerServices } from '../services';
import { recordSystemEvent } from '../system-event';
import { ATTENTION_JOBS, alertJobKey } from './constants';
import type { SettleOutcome } from './settle';
import { isUuid } from './subjects';

type Conversation = typeof conversations.$inferSelect;

/** The kinds an urgent email goes out for, and how it reads. */
const ALERT_KINDS: Readonly<Record<string, AttentionUrgentInput['kind']>> = {
  hot_lead: 'hot_lead',
  unanswered_lead: 'unanswered_lead',
  customer_waiting: 'customer_waiting',
};

const alertKindOf = (kind: string): AttentionUrgentInput['kind'] | null =>
  ALERT_KINDS[kind] ?? null;

const localClock = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    new Date(at),
  );

/** The wait a conversation is in: the customer's unanswered message, or a hand-off nobody has taken. */
export function waitOf(c: Conversation): { waitingSince: Date | null; guardSince: Date | null } {
  const handedOff = c.handledBy === 'person' && c.needsPersonSince !== null && !c.takenOverBy;
  const waitingSince = c.awaitingReplySince ?? (handedOff ? c.needsPersonSince : null);
  return { waitingSince, guardSince: handedOff ? c.needsPersonSince : waitingSince };
}

/** Today's unanswered alert already went out for this wait. */
async function alreadyAlerted(tx: Tx, conversationId: string, since: Date): Promise<boolean> {
  const found = await rows(
    tx,
    sql`select 1 from app.events
        where entity_type = 'conversation' and entity_id = ${conversationId}
          and event_type = 'conversation.unanswered_alerted'
          and payload ->> 'awaitingSince' = ${since.toISOString()}
        limit 1`,
  );
  return found.length > 0;
}

interface Recipient extends Record<string, unknown> {
  id: string;
  email: string;
  full_name: string | null;
  settings: Record<string, unknown>;
}

/** "Urgent items" (the old unansweredEmail key, relabelled): on unless the person turned it off. */
const wantsUrgent = (u: Recipient) =>
  (u.settings as { notifications?: { unansweredEmail?: boolean } }).notifications
    ?.unansweredEmail !== false;

async function userById(tx: Tx, id: string): Promise<Recipient[]> {
  return rows<Recipient>(
    tx,
    sql`select id, email::text as email, full_name, settings from app.users where id = ${id}`,
  );
}

export interface AlertAbout {
  /** The attention item it's about, when there is one. */
  readonly itemId?: string | null;
  /** The waiting conversation (today's unanswered check passes only this). */
  readonly conversationId?: string | null;
}

export type AlertResult =
  | { readonly status: 'sent'; readonly recipients: number }
  | { readonly status: 'skipped'; readonly reason: string }
  /** The business is shut: the job waits until it opens. */
  | { readonly status: 'wait'; readonly at: number };

/** Marks the item as alerted for these facts, so nothing sends a second email about them. */
async function markAlerted(tx: Tx, item: AttentionItemRow, now: number): Promise<void> {
  await tx
    .update(attentionItems)
    .set({ alertFingerprint: item.fingerprint, alertedAt: new Date(now) })
    .where(eq(attentionItems.id, item.id));
}

/**
 * One urgent email about an item, a waiting conversation, or both. The only sender: the Action Center's job and
 * `conversation.unanswered_check` both come through here, so nobody ever gets two emails for one wait.
 */
export async function alertUrgent(
  s: WorkerServices,
  scope: TenantScope,
  about: AlertAbout,
  o: { readonly now: number; readonly causationId: string; readonly correlationId?: string | null },
): Promise<AlertResult> {
  return asWorker(s.db, scope, async (tx): Promise<AlertResult> => {
    const skip = (reason: string): AlertResult => ({ status: 'skipped', reason });
    let item: AttentionItemRow | null = null;
    if (about.itemId) {
      const [row] = await tx
        .select()
        .from(attentionItems)
        .where(eq(attentionItems.id, about.itemId));
      if (!row || row.workspaceId !== scope.workspaceId) return skip('gone');
      item = row;
      if (item.state !== 'open') return skip('not_open');
      if (item.alertFingerprint === item.fingerprint) return skip('already_alerted');
      if (!alertKindOf(item.kind)) return skip('not_alertable');
    }
    const conversationId = about.conversationId ?? item?.conversationId ?? null;
    const [conv] = conversationId
      ? await tx.select().from(conversations).where(eq(conversations.id, conversationId))
      : [];
    const wait = conv ? waitOf(conv) : null;
    // One email per wait, however many items fold onto it.
    if (conv && wait?.guardSince && (await alreadyAlerted(tx, conv.id, wait.guardSince))) {
      if (item) await markAlerted(tx, item, o.now);
      return skip('already_alerted');
    }
    const m = await workspaceMessaging(tx, scope.workspaceId);
    const tz = m.timezone || 'UTC';
    // A lead's alert waits for the business to open; a waiting customer's follows the reply threshold.
    if (item && isLeadKind(item.kind as AttentionKind)) {
      const opensAt = addOpenTime(openHoursOf(m.rawSettings), tz, o.now, 0);
      if (opensAt > o.now) return { status: 'wait', at: opensAt };
    }

    const assigneeId = item?.assigneeUserId ?? conv?.assigneeUserId ?? null;
    const candidates = assigneeId
      ? await userById(tx, assigneeId)
      : ((await managers(tx, scope.workspaceId)) as Recipient[]);
    const recipients = candidates.filter(wantsUrgent);
    const kind = item ? alertKindOf(item.kind)! : 'customer_waiting';
    // Phones follow each person's push switch, not their email one.
    const listeners = await urgentPushListeners(
      tx,
      kind,
      candidates.map((c) => c.id),
    );
    if (recipients.length === 0 && listeners === 0) return skip('nobody_to_email');

    const personId = item?.personId ?? conv?.personId ?? null;
    const [person] = personId
      ? await rows<{ first_name: string | null; last_name: string | null }>(
          tx,
          sql`select first_name, last_name from app.people where id = ${personId}`,
        )
      : [];
    const contact = conv ? await conversationContact(tx, conv) : null;
    const name = `${person?.first_name ?? ''} ${person?.last_name ?? ''}`.trim();
    const customer = name || contact || item?.title || 'A customer';
    const firstName = person?.first_name?.trim() || customer;
    const waitingSince = wait?.waitingSince ?? item?.sinceAt ?? null;
    const [latest] = conv
      ? await rows<{ photos: number }>(
          tx,
          sql`select coalesce(jsonb_array_length(media), 0)::int as photos from app.messages
              where conversation_id = ${conv.id} and direction = 'inbound'
              order by occurred_at desc limit 1`,
        )
      : [];
    const value =
      item && !item.valueIsEstimate && Number(item.valueCents ?? 0) > 0
        ? Number(item.valueCents)
        : null;
    const link =
      conv && conv.status !== 'closed'
        ? `${s.webUrl}/app/w/${scope.workspaceId}/inbox/${conv.id}`
        : `${s.webUrl}/app/w/${scope.workspaceId}${item ? `?item=${item.id}` : ''}`;
    const mail = attentionUrgentEmail({
      kind,
      customer,
      firstName,
      business: m.name,
      minutesWaiting: Math.max(
        1,
        Math.round((o.now - (waitingSince?.getTime() ?? o.now)) / 60_000),
      ),
      valueCents: value,
      chips: item
        ? sortChips(chipsOf(item))
            .filter((c) => c.code !== 'value')
            .slice(0, 3)
            .map((c) => chipText(c, o.now))
        : [],
      preview: conv?.lastPreview ?? item?.detail ?? '',
      receivedAt: localClock(waitingSince?.getTime() ?? o.now, tz),
      contact: contact ?? '',
      link,
      action: conv && conv.status !== 'closed' ? `Reply to ${firstName}` : 'Open in HandsFreeOS',
      assignedToYou: !!assigneeId,
      photos: latest?.photos ?? 0,
      channel: conv?.channel,
    });
    let failures = 0;
    const emailed: Recipient[] = [];
    for (const r of recipients)
      try {
        await s.mailer.send({ to: r.email, ...mail });
        emailed.push(r);
      } catch (e) {
        failures++;
        s.log.warn({ err: errorMessage(e), userId: r.id }, 'could not send an urgent email');
      }
    // Nobody could be reached: the job's retries try again rather than marking it alerted.
    if (emailed.length === 0 && failures > 0) throw new Error('could not send the urgent email');

    // The push commits with the marks below: a retry that finds them never pushes again.
    const pushed =
      listeners > 0
        ? await queueUrgentPush(tx, scope, {
            kind,
            item,
            conversation: conv ?? null,
            waitSince: wait?.guardSince ?? null,
            userIds: candidates.map((c) => c.id),
            customer,
            preview: conv?.lastPreview ?? item?.detail ?? '',
            valueCents: value,
            photos: latest?.photos ?? 0,
          })
        : 0;
    if (item) await markAlerted(tx, item, o.now);
    if (conv && wait?.guardSince)
      await recordSystemEvent(tx, {
        type: 'conversation.unanswered_alerted',
        action: 'conversation.unanswered_check',
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        entityType: 'conversation',
        entityId: conv.id,
        payload: {
          awaitingSince: wait.guardSince.toISOString(),
          recipients: emailed.length,
          pushed,
          itemId: item?.id ?? null,
          _broadcast: false,
        },
        after: { with: customer, emailed: emailed.map((r) => r.full_name || r.email) },
        correlationId: o.correlationId ?? o.causationId,
        causationId: o.causationId,
      });
    return { status: 'sent', recipients: emailed.length };
  });
}

/** After a reconcile: one urgent-alert job per item that turned urgent (follow-ups.ts). */
export async function planUrgentAlerts(tx: Tx, outcome: SettleOutcome): Promise<void> {
  for (const u of outcome.becameUrgent) {
    if (!alertKindOf(u.kind)) continue;
    await scheduleJob(
      tx,
      {
        kind: ATTENTION_JOBS.urgentAlert,
        dedupeKey: alertJobKey(u.itemId),
        runAt: outcome.now,
        payload: { itemId: u.itemId, fingerprint: u.fingerprint },
        workspaceId: outcome.scope.workspaceId,
        organizationId: outcome.scope.organizationId,
      },
      { pullEarlier: true },
    );
  }
}

/** `attention.urgent_alert`: the email for one item, or a wait until the business opens. */
export const urgentAlertJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const itemId = ctx.job.payload['itemId'];
  if (!isUuid(itemId)) return;
  const result = await alertUrgent(
    ctx,
    scope,
    { itemId },
    { now: Math.max(ctx.now, ctx.job.runAt.getTime()), causationId: ctx.job.id },
  );
  if (result.status === 'wait') return { rescheduleAt: new Date(result.at) };
};
