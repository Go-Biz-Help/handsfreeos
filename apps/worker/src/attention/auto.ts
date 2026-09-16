/**
 * What HandsFreeOS does on its own for one attention item (M8): one confirmation request for an unconfirmed
 * appointment, and one follow-up nudge for a stale lead or an overdue follow-up. Nothing else is ever automatic.
 *
 * **Arming** (never sending): when an item of an automatic kind opens, comes back with new facts or wakes from a
 * snooze with its switch on, and whenever a person presses Let HandsFreeOS Handle (`attention.handle_requested`,
 * which needs no switch, though a nudge still waits for an owner to have read the message once). It records the
 * action as scheduled for the end of the 60-minute cancel window ("Will follow up at 10:40 · Cancel"), later when
 * quiet hours push a text out, and queues `attention.auto_handle` for then. The hourly sweep also picks up items
 * whose switch was turned on after they opened: those have no transition of their own.
 *
 * **Sending:** the job reads the item again under its lock and goes ahead only while everything still holds — it
 * wasn't cancelled, its switch is still on, its facts haven't changed, nothing went out for them already, the lead
 * is still open, and core's `planAutoAction` (consent and how to reach them, quiet hours, whether Ava or a person
 * is talking with them, a pending draft, a running workflow, a person's own message in the last 72 hours, and the
 * 14-day cooldown for nudges) still lets it go. Every skip records why, in one of SKIP_REASONS or the plan's own
 * codes. It sends through booking/deliver.ts as the system actor tagged as the Action Center, with a fixed
 * clientId, so a retry sends once and the timeline reads "HandsFreeOS".
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  attentionRecordAuto,
  AUTO_CANCEL_WINDOW_MINUTES,
  AUTO_KINDS,
  autoActionOf,
  BOOKING_LINK_PLACEHOLDER,
  chipsOf,
  executeCommand,
  executeCommandIn,
  loadAttentionContext,
  nudgesOn,
  planAutoAction,
  scheduleJob,
  type AttentionContext,
  type AttentionItemRow,
  type AttentionKind,
  type AttentionSettings,
  type AutoAction,
  type RequestMeta,
  type SystemActor,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { attentionItems } from '@hfos/db/schema';
import { clientIdFor, quietEndAt, sendEmail, sendText, wasSent } from '../booking/deliver';
import { manageUrlFor } from '../booking/links';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { tenantOf, workerMeta, type TenantScope, type WorkerServices } from '../services';
import { ATTENTION_JOBS, autoJobKey, CONFIRM_HANDLED_UNTIL_MS, QUIET_JITTER_MS } from './constants';
import type { SettleOutcome } from './settle';
import { isUuid } from './subjects';

const MIN = 60_000;
/** Many texts held for the same quiet hours don't all go at the same instant. */
const jitter = (max: number): number => Math.floor(Math.random() * max);
const iso = (ms: number): string => new Date(ms).toISOString();
/** Items an hourly sweep arms at most, so one business can never hold up the others. */
const SWEEP_ARM_LIMIT = 200;

/**
 * Why an automatic action didn't go out, recorded on the item (`auto_skip_reason`) and turned into plain words by
 * the audit log. The rest of the codes come from core's `planAutoAction` (`someone_talking`, `customer_waiting`,
 * `draft_pending`, `workflow_running`, `recent_person_contact`, `cooldown`, `no_way_to_reach`, `too_late`,
 * `nudge_not_reviewed`, `nudge_incomplete`, `subject_gone`, `already_sent`, `not_open`), from reconcile
 * (`resolved`), or from the carrier or mail service refusing it (`opted_out`, `quiet_hours`, `recipient_suppressed`…).
 */
export const SKIP_REASONS = {
  /** The business turned this kind of automatic message off after it was queued. */
  turnedOff: 'turned_off',
  /** The lead was archived, won or lost. */
  leadClosed: 'lead_closed',
  /** The booking has no change-or-cancel link to send them to. */
  noBookingLink: 'no_booking_link',
  /** The item isn't waiting on anyone any more. */
  notOpen: 'not_open',
  /** Whoever it was for is gone. */
  subjectGone: 'subject_gone',
  /** Nothing can reach them. */
  noWayToReach: 'no_way_to_reach',
} as const;

/** The system actor, tagged as the Action Center working on one item: "HandsFreeOS" in the timeline and audit log. */
export const actionCenterActor = (
  scope: TenantScope,
  item: Pick<AttentionItemRow, 'id' | 'kind'>,
  onBehalfOf: string | null = null,
): SystemActor => ({
  type: 'system',
  workspaceId: scope.workspaceId,
  organizationId: scope.organizationId,
  onBehalfOf,
  via: { kind: 'action_center', itemId: item.id, itemKind: item.kind },
});

/** Whether the business lets this action go out on its own (a nudge also needs its message reviewed once). */
export const autoSwitchOn = (settings: AttentionSettings, action: AutoAction): boolean =>
  action === 'nudge' ? nudgesOn(settings) : settings.auto.confirmRequests;

/** What `attention.record_auto` is told, beside the item. */
interface AutoRecord {
  readonly action: AutoAction;
  readonly outcome: 'scheduled' | 'sent' | 'skipped';
  readonly fingerprint?: string;
  readonly scheduledFor?: string;
  readonly reason?: string;
  readonly channel?: 'sms' | 'email' | null;
  readonly messageId?: string | null;
  readonly requestedBy?: string | null;
  readonly handledUntil?: string | null;
}

/** Records an outcome inside the caller's transaction (arming, from a settle or an event). */
const recordIn = (
  tx: Tx,
  scope: TenantScope,
  item: AttentionItemRow,
  input: AutoRecord,
  meta: RequestMeta,
  requestedBy: string | null,
) =>
  executeCommandIn(
    tx,
    attentionRecordAuto,
    { workspaceId: scope.workspaceId, itemId: item.id, ...input },
    actionCenterActor(scope, item, requestedBy),
    meta,
  );

/** Records an outcome in its own transaction (the job, once the item's lock is gone). */
const recordAuto = (
  s: WorkerServices,
  scope: TenantScope,
  item: AttentionItemRow,
  input: AutoRecord,
  meta: RequestMeta,
  requestedBy: string | null,
) =>
  executeCommand(
    s.db,
    attentionRecordAuto,
    { workspaceId: scope.workspaceId, itemId: item.id, ...input },
    actionCenterActor(scope, item, requestedBy),
    meta,
  );

export interface ArmOptions {
  readonly now: Date;
  /** The person whose Let HandsFreeOS Handle asked for it; null when the Action Center armed it itself. */
  readonly requestedBy: string | null;
  readonly meta: RequestMeta;
}

/**
 * Queues one item's automatic action for the end of its cancel window, or records why it can't go. It only
 * schedules; the job sends. Runs inside the caller's transaction, under reconcile's lock.
 */
export async function armAutoAction(
  tx: Tx,
  scope: TenantScope,
  ctx: AttentionContext,
  item: AttentionItemRow,
  o: ArmOptions,
): Promise<'scheduled' | 'skipped' | 'left'> {
  const action = autoActionOf(item.kind as AttentionKind, chipsOf(item));
  if (!action || item.state !== 'open') return 'left';
  // Once per set of facts: reconcile clears auto_state when they change, which is its next chance.
  if (item.autoState === 'scheduled' || item.autoState === 'sent') return 'left';
  // Skipped or cancelled stays that way unless a person asks again.
  if (item.autoState && !o.requestedBy) return 'left';
  // A person asking doesn't need the switch on; the Action Center acting on its own does.
  if (!o.requestedBy && !autoSwitchOn(ctx.settings, action)) return 'left';
  const plan = await planAutoAction(tx, ctx, item, o.now);
  if (!plan) return 'left';
  if (plan.blocked) {
    await recordIn(
      tx,
      scope,
      item,
      { action, outcome: 'skipped', reason: plan.blocked.code },
      o.meta,
      o.requestedBy,
    );
    return 'skipped';
  }
  const sendAt = plan.sendAt
    ? Date.parse(plan.sendAt)
    : o.now.getTime() + AUTO_CANCEL_WINDOW_MINUTES * MIN;
  await recordIn(
    tx,
    scope,
    item,
    {
      action,
      outcome: 'scheduled',
      fingerprint: item.fingerprint,
      scheduledFor: iso(sendAt),
      requestedBy: o.requestedBy,
    },
    o.meta,
    o.requestedBy,
  );
  await scheduleJob(
    tx,
    {
      kind: ATTENTION_JOBS.autoHandle,
      dedupeKey: autoJobKey(item.id),
      runAt: new Date(sendAt),
      payload: { itemId: item.id, fingerprint: item.fingerprint, requestedBy: o.requestedBy },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
  return 'scheduled';
}

/** Open items of an automatic kind with nothing recorded yet: their switch may have been turned on since. */
async function armableIds(tx: Tx, workspaceId: string): Promise<string[]> {
  const kinds = Object.keys(AUTO_KINDS);
  const list = await rows<{ id: string }>(
    tx,
    sql`select id from app.attention_items
        where workspace_id = ${workspaceId} and state = 'open' and auto_state is null
          and kind in (${sql.join(
            kinds.map((k) => sql`${k}`),
            sql`, `,
          )})
        order by opened_at
        limit ${SWEEP_ARM_LIMIT}`,
  );
  return list.map((r) => r.id);
}

/** After a reconcile: everything whose automatic action should now be waiting to go out (follow-ups.ts). */
export async function planAutoActions(tx: Tx, outcome: SettleOutcome): Promise<void> {
  const scope = outcome.scope;
  const ids = new Set(outcome.autoCandidates.map((c) => c.transition.itemId));
  if (outcome.all) for (const id of await armableIds(tx, scope.workspaceId)) ids.add(id);
  if (ids.size === 0) return;
  const ctx = await loadAttentionContext(tx, scope.workspaceId, outcome.now);
  const items = await tx
    .select()
    .from(attentionItems)
    .where(
      and(eq(attentionItems.workspaceId, scope.workspaceId), inArray(attentionItems.id, [...ids])),
    );
  const meta = workerMeta(outcome.cause.correlationId, outcome.cause.causationId);
  for (const item of items)
    await armAutoAction(tx, scope, ctx, item, { now: outcome.now, requestedBy: null, meta });
}

/** A person pressed Let HandsFreeOS Handle on a safe item: the worker alone schedules and sends it. */
export const onHandleRequested: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const itemId = isUuid(p['itemId']) ? p['itemId'] : ctx.event.entityId;
  if (!workspaceId || !organizationId || !isUuid(itemId)) return;
  const scope = { workspaceId, organizationId };
  const [item] = await ctx.tx
    .select()
    .from(attentionItems)
    .where(and(eq(attentionItems.id, itemId), eq(attentionItems.workspaceId, workspaceId)))
    .for('update');
  if (!item) return;
  const now = new Date();
  await armAutoAction(ctx.tx, scope, await loadAttentionContext(ctx.tx, workspaceId, now), item, {
    now,
    requestedBy: isUuid(p['requestedBy']) ? p['requestedBy'] : null,
    meta: workerMeta(ctx.event.correlationId, ctx.event.id),
  });
};

// ---- Sending ----

interface Target {
  readonly phone: string | null;
  readonly email: string | null;
  /** A confirmation request's appointment start. */
  readonly startsAt: number | null;
}

/** Where the message goes: the booking's own contact details, or the lead's customer. */
async function targetOf(
  tx: Tx,
  workspaceId: string,
  item: AttentionItemRow,
  action: AutoAction,
): Promise<Target | null> {
  if (action === 'confirm_request') {
    const [a] = await rows<{ phone: string | null; email: string | null; starts_at: Date }>(
      tx,
      sql`select t.contact_phone_e164 as phone, t.contact_email as email, p.starts_at
          from app.appointment_attendees t join app.appointments p on p.id = t.appointment_id
          where t.workspace_id = ${workspaceId} and t.id = ${item.subjectId}`,
    );
    return a ? { phone: a.phone, email: a.email, startsAt: new Date(a.starts_at).getTime() } : null;
  }
  const [l] = await rows<{ phone: string | null; email: string | null }>(
    tx,
    sql`select p.phone_e164 as phone, p.email::text as email
        from app.leads l left join app.people p on p.id = l.person_id
        where l.workspace_id = ${workspaceId} and l.id = ${item.subjectId}`,
  );
  return l ? { phone: l.phone, email: l.email, startsAt: null } : null;
}

type Decision =
  | { readonly kind: 'stop' }
  | { readonly kind: 'wait'; readonly at: number }
  | {
      readonly kind: 'skip';
      readonly item: AttentionItemRow;
      readonly action: AutoAction;
      readonly reason: string;
    }
  | {
      readonly kind: 'send';
      readonly item: AttentionItemRow;
      readonly action: AutoAction;
      readonly channel: 'sms' | 'email';
      readonly to: string;
      readonly subject: string | null;
      readonly text: string;
      readonly clientId: string;
      readonly handledUntil: string | null;
    };

/** The item read again under its lock: everything is checked once more, as of the moment it would go out. */
async function decide(
  tx: Tx,
  s: WorkerServices,
  scope: TenantScope,
  itemId: string,
  now: number,
  requestedBy: string | null,
): Promise<Decision> {
  const [item] = await tx
    .select()
    .from(attentionItems)
    .where(and(eq(attentionItems.id, itemId), eq(attentionItems.workspaceId, scope.workspaceId)))
    .for('update');
  // Cancelled by a person, already sent, already skipped, or its facts changed (reconcile cleared it).
  if (!item || item.autoState !== 'scheduled') return { kind: 'stop' };
  const action = autoActionOf(item.kind as AttentionKind, chipsOf(item));
  if (!action) return { kind: 'stop' };
  const skip = (reason: string): Decision => ({ kind: 'skip', item, action, reason });
  if (item.state !== 'open') return skip(SKIP_REASONS.notOpen);
  const ctx = await loadAttentionContext(tx, scope.workspaceId, new Date(now));
  if (!requestedBy && !autoSwitchOn(ctx.settings, action)) return skip(SKIP_REASONS.turnedOff);
  if (item.leadId) {
    const [lead] = await rows<{ open: boolean }>(
      tx,
      sql`select (status = 'open' and archived_at is null) as open from app.leads
          where workspace_id = ${scope.workspaceId} and id = ${item.leadId}`,
    );
    if (lead && !lead.open) return skip(SKIP_REASONS.leadClosed);
  }
  const plan = await planAutoAction(tx, ctx, item, new Date(now));
  if (!plan) return { kind: 'stop' };
  if (plan.blocked) return skip(plan.blocked.code);
  if (!plan.channel || !plan.text) return skip(SKIP_REASONS.noWayToReach);
  // Quiet hours may have come round again since it was queued: the text waits for the end of them.
  if (plan.channel === 'sms') {
    const end = quietEndAt(ctx.quietHours, ctx.timeZone, now);
    if (end !== null) return { kind: 'wait', at: end + jitter(QUIET_JITTER_MS) };
  }
  const target = await targetOf(tx, scope.workspaceId, item, action);
  if (!target) return skip(SKIP_REASONS.subjectGone);
  const to = plan.channel === 'sms' ? target.phone : target.email;
  if (!to) return skip(SKIP_REASONS.noWayToReach);
  let text = plan.text;
  let subject = plan.subject;
  let handledUntil: string | null = null;
  if (action === 'confirm_request') {
    // The preview shows a placeholder; the customer gets their own change-or-cancel link.
    const manageUrl = await manageUrlFor(tx, s.bookingLinks, item.subjectId);
    if (manageUrl) {
      text = text.split(BOOKING_LINK_PLACEHOLDER).join(manageUrl);
      subject = subject?.split(BOOKING_LINK_PLACEHOLDER).join(manageUrl) ?? null;
    }
    if (text.includes(BOOKING_LINK_PLACEHOLDER)) return skip(SKIP_REASONS.noBookingLink);
    // It stays handled until 12 hours before the start, then comes back if it still isn't confirmed.
    const until = (target.startsAt ?? 0) - CONFIRM_HANDLED_UNTIL_MS;
    handledUntil = target.startsAt !== null && until > now ? iso(until) : null;
  }
  return {
    kind: 'send',
    item,
    action,
    channel: plan.channel,
    to,
    subject,
    text,
    clientId: clientIdFor('attn', item.id, item.fingerprint),
    handledUntil,
  };
}

/** `attention.auto_handle`: the confirmation request or follow-up nudge goes out, or records why it didn't. */
export const autoHandleJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const itemId = ctx.job.payload['itemId'];
  if (!isUuid(itemId)) return;
  const requestedBy = isUuid(ctx.job.payload['requestedBy'])
    ? (ctx.job.payload['requestedBy'] as string)
    : null;
  const now = Math.max(ctx.now, ctx.job.runAt.getTime());
  const meta = workerMeta(null, ctx.job.id);
  const d = await asWorker(ctx.db, scope, (tx) => decide(tx, ctx, scope, itemId, now, requestedBy));
  if (d.kind === 'stop') return;
  if (d.kind === 'wait') return { rescheduleAt: new Date(d.at) };
  if (d.kind === 'skip') {
    await recordAuto(
      ctx,
      scope,
      d.item,
      { action: d.action, outcome: 'skipped', reason: d.reason },
      meta,
      requestedBy,
    );
    return;
  }
  const actor = actionCenterActor(scope, d.item, requestedBy);
  const sent =
    d.channel === 'sms'
      ? await sendText(ctx, scope, d.to, d.text, d.clientId, meta, actor)
      : await sendEmail(
          ctx,
          scope,
          d.to,
          { subject: d.subject ?? '', body: d.text },
          d.clientId,
          meta,
          actor,
        );
  if (!wasSent(sent)) {
    await recordAuto(
      ctx,
      scope,
      d.item,
      { action: d.action, outcome: 'skipped', reason: sent.refused },
      meta,
      requestedBy,
    );
    return;
  }
  // The request opens the ask, so a reply of C (or YES) confirms it: message.receive looks for exactly this.
  // The day-before reminder records its ask through attendee.record_reminder, which has no slot of its own for
  // this one; the column is the worker's to set, and attention.auto_sent is the record that it asked.
  if (d.action === 'confirm_request')
    await asWorker(ctx.db, scope, (tx) =>
      tx.execute(
        sql`update app.appointment_attendees set confirm_asked_at = now()
            where workspace_id = ${scope.workspaceId} and id = ${d.item.subjectId}
              and confirm_asked_at is null and confirmed_at is null`,
      ),
    );
  await recordAuto(
    ctx,
    scope,
    d.item,
    {
      action: d.action,
      outcome: 'sent',
      channel: d.channel,
      messageId: sent.messageId,
      requestedBy,
      handledUntil: d.handledUntil,
    },
    meta,
    requestedBy,
  );
};
