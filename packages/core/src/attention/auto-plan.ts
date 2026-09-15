/**
 * What Let HandsFreeOS Handle would do for one item (M8), worked out on the server so the preview and the worker
 * agree:
 * - on its own (a confirmation request, a follow-up nudge): whom it reaches and how, the words exactly, when it
 *   goes (after the cancel window, and after quiet hours for a text), or why it can't go;
 * - asks first: the choices (hand to the AI teammate, reply, set a next action), each with why it isn't
 *   available when it isn't.
 * The worker (step 6) runs planAutoAction again, under the item's lock, right before it sends. Server-only.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { loadTeammate, teammateConfigOf } from '../ai-team/load';
import { addDays, localDateOf, localInstant } from '../calendar/engine/zoned';
import { userNames } from '../calendar/load';
import { formatPhone } from '../crm/phone';
import { activeSuppression, workspaceAddresses } from '../messaging/email';
import { quietHoursState, type QuietHoursWindow } from '../messaging/quiet-hours';
import { isOptedOut, liveNumber, loadRegistrations, readiness } from '../messaging/store';
import type { AttentionAskOptionOut, AttentionAutoPlanOut } from '../schemas/attention';
import { LIVE_RUN_STATUSES } from '../schemas/workflow';
import { chipsOf } from './items';
import {
  AUTO_CANCEL_WINDOW_MINUTES,
  AUTO_RECENT_PERSON_HOURS,
  autoActionOf,
  type AttentionKind,
} from './kinds';
import type { AttentionContext, AttentionItemRow } from './load';
import { renderNudge } from './nudge';
import {
  clockLabel,
  confirmRequestEmail,
  confirmRequestText,
  dayLabel,
  nudgeEmailSubject,
  STOP_WORDING,
  suggestedNextAction,
  whenLabel,
} from './wording';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** When quiet hours end after `t`, or null when it isn't quiet then. */
export function quietEndAfter(
  window: QuietHoursWindow,
  timeZone: string,
  t: number,
): number | null {
  const q = quietHoursState(window, timeZone, new Date(t));
  if (!q.quiet || !q.endsAt) return null;
  const today = localDateOf(t, timeZone);
  const end = localInstant(today, q.endsAt, timeZone);
  return end > t ? end : localInstant(addDays(today, 1), q.endsAt, timeZone);
}

export interface ReachContact {
  readonly phone: string | null;
  readonly email: string | null;
  /** The booking's own consent (the ticked box, a staff booking for a number that never said STOP). */
  readonly smsOk: boolean;
  readonly personConsent: 'unknown' | 'opted_in' | 'opted_out';
}

export interface Reach {
  /** Why a text can't go, or null when it can (quiet hours aside). */
  readonly text: string | null;
  /** Why an email can't go, or null when it can. */
  readonly email: string | null;
  /** A text now would be the first to this number: it carries the STOP wording. */
  readonly firstText: boolean;
}

/**
 * How HandsFreeOS can reach a customer on its own (the booking reminders' rules): texts need their agreement and
 * texting set up, and never override a STOP; email needs an address that isn't stopped, and one to send from.
 */
export async function reachFor(tx: Tx, workspaceId: string, c: ReachContact): Promise<Reach> {
  let text: string | null = null;
  if (!c.phone) text = 'no_phone';
  else if (c.personConsent === 'opted_out' || (await isOptedOut(tx, workspaceId, c.phone)))
    text = 'opted_out';
  else if (!c.smsOk && c.personConsent !== 'opted_in') text = 'no_consent';
  else {
    const number = await liveNumber(tx, workspaceId);
    const ready =
      !!number &&
      number.status === 'active' &&
      readiness(number, await loadRegistrations(tx, workspaceId)).messagingReady;
    if (!ready) text = 'texting_not_ready';
  }
  let email: string | null = null;
  if (!c.email) email = 'no_email';
  else if (await activeSuppression(tx, workspaceId, c.email.toLowerCase())) email = 'email_stopped';
  else if (!(await workspaceAddresses(tx, workspaceId)).some((a) => a.usable))
    email = 'no_email_address';
  let firstText = false;
  if (text === null && c.phone) {
    const found = await rows(
      tx,
      sql`select 1 from app.messages m join app.conversations c on c.id = m.conversation_id
          where c.workspace_id = ${workspaceId} and c.channel = 'sms' and c.counterpart = ${c.phone}
            and m.direction = 'outbound' and m.status not in ('failed', 'undelivered')
          limit 1`,
    );
    firstText = found.length === 0;
  }
  return { text, email, firstText };
}

const TEXT_WHY: Readonly<Record<string, string>> = {
  no_phone: 'there’s no mobile number',
  opted_out: 'they texted STOP',
  no_consent: 'they haven’t agreed to texts',
  texting_not_ready: 'texting isn’t set up yet',
};
const EMAIL_WHY: Readonly<Record<string, string>> = {
  no_email: 'there’s no email address',
  email_stopped: 'email to them is stopped',
  no_email_address: 'the business has no address to send from',
};
const byEmail: Readonly<Record<string, string>> = {
  no_phone: 'There’s no mobile number, so this goes by email.',
  opted_out: 'They texted STOP, so this goes by email.',
  no_consent: 'They haven’t agreed to texts, so this goes by email.',
  texting_not_ready: 'Texting isn’t set up yet, so this goes by email.',
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const agoLabel = (ms: number) =>
  ms < HOUR
    ? `${Math.max(1, Math.floor(ms / MIN))} min ago`
    : ms < DAY
      ? `${Math.floor(ms / HOUR)} h ago`
      : `${Math.floor(ms / DAY)} days ago`;

interface Blockers {
  readonly aiTalking: boolean;
  readonly personTalking: boolean;
  readonly waiting: boolean;
  readonly draft: boolean;
  readonly workflow: string | null;
  readonly personMessageAt: Date | null;
  readonly lastAutoAt: Date | null;
}

/** What keeps an automatic message from going to this customer right now (the nudge guard's checks). */
async function blockersFor(
  tx: Tx,
  ctx: AttentionContext,
  item: AttentionItemRow,
  personId: string,
  now: number,
): Promise<Blockers> {
  const ws = ctx.workspaceId;
  const since = new Date(now - AUTO_RECENT_PERSON_HOURS * HOUR).toISOString();
  const cooldownFrom = new Date(now - ctx.settings.nudge.cooldownDays * DAY).toISOString();
  const [r] = await rows<{
    ai_talking: boolean;
    person_talking: boolean;
    waiting: boolean;
    draft: boolean;
    workflow: string | null;
    person_message_at: Date | null;
    last_auto_at: Date | null;
  }>(
    tx,
    sql`select
          exists (select 1 from app.conversations c where c.workspace_id = ${ws} and c.person_id = ${personId}
            and c.handled_by = 'ai') as ai_talking,
          exists (select 1 from app.conversations c where c.workspace_id = ${ws} and c.person_id = ${personId}
            and c.handled_by = 'person' and c.status <> 'closed') as person_talking,
          exists (select 1 from app.conversations c where c.workspace_id = ${ws} and c.person_id = ${personId}
            and c.status = 'open' and c.awaiting_reply_since is not null) as waiting,
          exists (select 1 from app.ai_teammate_drafts d where d.workspace_id = ${ws} and d.person_id = ${personId}
            and d.status = 'pending') as draft,
          (select w.name from app.workflow_runs r join app.workflows w on w.id = r.workflow_id
            where r.workspace_id = ${ws} and r.person_id = ${personId} and not r.is_test
              and r.status::text in (${sql.join(
                LIVE_RUN_STATUSES.map((s) => sql`${s}`),
                sql`, `,
              )})
            order by r.started_at desc limit 1) as workflow,
          (select max(m.occurred_at) from app.messages m join app.conversations c on c.id = m.conversation_id
            where c.workspace_id = ${ws} and c.person_id = ${personId} and m.direction = 'outbound'
              and m.sent_by is not null and m.occurred_at > ${since}::timestamptz) as person_message_at,
          ${
            item.leadId
              ? sql`(select max(i.auto_done_at) from app.attention_items i
                  where i.workspace_id = ${ws} and i.lead_id = ${item.leadId} and i.id <> ${item.id}
                    and i.auto_state = 'sent' and i.auto_done_at > ${cooldownFrom}::timestamptz)`
              : sql`null::timestamptz`
          } as last_auto_at`,
  );
  return {
    aiTalking: !!r?.ai_talking,
    personTalking: !!r?.person_talking,
    waiting: !!r?.waiting,
    draft: !!r?.draft,
    workflow: r?.workflow ?? null,
    personMessageAt: r?.person_message_at ? new Date(r.person_message_at) : null,
    lastAutoAt: r?.last_auto_at ? new Date(r.last_auto_at) : null,
  };
}

interface Target {
  readonly personId: string | null;
  readonly firstName: string | null;
  readonly contact: ReachContact;
  /** The appointment it confirms. */
  readonly appointment: { readonly title: string; readonly startsAt: number } | null;
  /** The lead a nudge follows up. */
  readonly lead: { readonly title: string; readonly assigneeUserId: string | null } | null;
}

async function targetOf(
  tx: Tx,
  ctx: AttentionContext,
  item: AttentionItemRow,
  action: 'confirm_request' | 'nudge',
): Promise<Target | null> {
  if (action === 'confirm_request') {
    const [a] = await rows<{
      person_id: string;
      first_name: string | null;
      phone: string | null;
      email: string | null;
      sms_ok: boolean;
      consent: 'unknown' | 'opted_in' | 'opted_out';
      title: string;
      starts_at: Date;
    }>(
      tx,
      sql`select t.person_id, p.first_name, t.contact_phone_e164 as phone, t.contact_email as email, t.sms_ok,
            p.sms_consent::text as consent, a.title, a.starts_at
          from app.appointment_attendees t
          join app.appointments a on a.id = t.appointment_id
          join app.people p on p.id = t.person_id
          where t.workspace_id = ${ctx.workspaceId} and t.id = ${item.subjectId}`,
    );
    if (!a) return null;
    return {
      personId: a.person_id,
      firstName: a.first_name?.trim() || null,
      contact: { phone: a.phone, email: a.email, smsOk: a.sms_ok, personConsent: a.consent },
      appointment: { title: a.title, startsAt: new Date(a.starts_at).getTime() },
      lead: null,
    };
  }
  const [l] = await rows<{
    person_id: string | null;
    first_name: string | null;
    phone: string | null;
    email: string | null;
    consent: 'unknown' | 'opted_in' | 'opted_out' | null;
    title: string;
    assignee_user_id: string | null;
  }>(
    tx,
    sql`select l.person_id, p.first_name, p.phone_e164 as phone, p.email::text as email,
          p.sms_consent::text as consent, l.title, l.assignee_user_id
        from app.leads l left join app.people p on p.id = l.person_id
        where l.workspace_id = ${ctx.workspaceId} and l.id = ${item.subjectId}`,
  );
  if (!l) return null;
  return {
    personId: l.person_id,
    firstName: l.first_name?.trim() || null,
    // A follow-up nudge texts only someone who agreed to texts; a web-form lead who didn't gets an email.
    contact: {
      phone: l.phone,
      email: l.email,
      smsOk: false,
      personConsent: l.consent ?? 'unknown',
    },
    appointment: null,
    lead: { title: l.title, assigneeUserId: l.assignee_user_id },
  };
}

/**
 * The automatic action for an item, exactly as HandsFreeOS would carry it out now, or null when the item's kind
 * doesn't have one. A person asking (Let HandsFreeOS Handle) doesn't need the automatic switch on, but a nudge
 * never goes before an owner has read the message once.
 */
export async function planAutoAction(
  tx: Tx,
  ctx: AttentionContext,
  item: AttentionItemRow,
  now: Date,
): Promise<AttentionAutoPlanOut | null> {
  const kind = item.kind as AttentionKind;
  const action = autoActionOf(kind, chipsOf(item));
  if (!action) return null;
  const at = now.getTime();
  const tz = ctx.timeZone;
  const notes: string[] = [];
  const plan = (over: Partial<AttentionAutoPlanOut>): AttentionAutoPlanOut => ({
    action,
    channel: null,
    to: null,
    subject: null,
    text: null,
    sendAt: null,
    scheduledFor: null,
    blocked: null,
    notes,
    ...over,
  });
  const blocked = (code: string, message: string, over: Partial<AttentionAutoPlanOut> = {}) =>
    plan({ ...over, blocked: { code, message } });

  if (item.autoState === 'sent' && item.autoDoneAt)
    return blocked(
      'already_sent',
      `HandsFreeOS already sent this ${dayLabel(item.autoDoneAt.getTime(), tz)} at ${clockLabel(item.autoDoneAt.getTime(), tz)}.`,
    );
  if (item.state !== 'open' && item.state !== 'snoozed')
    return blocked('not_open', 'This isn’t waiting on anyone anymore.');
  if (action === 'nudge' && !ctx.settings.auto.nudgeReviewedAt)
    return blocked(
      'nudge_not_reviewed',
      'An owner or admin needs to read the follow-up message in Settings and turn it on first.',
    );
  const target = await targetOf(tx, ctx, item, action);
  if (!target) return blocked('subject_gone', 'This was deleted.');

  // Whether anyone else is on it.
  if (target.personId) {
    const b = await blockersFor(tx, ctx, item, target.personId, at);
    const teammate = b.aiTalking || b.draft ? await loadTeammate(tx, ctx.workspaceId) : null;
    const ai = teammate?.name ?? 'The AI teammate';
    if (b.aiTalking) return blocked('someone_talking', `${ai} is talking with them.`);
    if (b.personTalking)
      return blocked('someone_talking', 'Someone on the team is talking with them.');
    if (b.waiting)
      return blocked('customer_waiting', 'They’re waiting on a reply. Answer them instead.');
    if (b.draft) return blocked('draft_pending', `${ai} has a reply waiting for approval.`);
    if (b.workflow)
      return blocked('workflow_running', `The “${b.workflow}” workflow is working with them.`);
    if (b.personMessageAt)
      return blocked(
        'recent_person_contact',
        `Someone on the team messaged them ${agoLabel(at - b.personMessageAt.getTime())}, so HandsFreeOS leaves it to them.`,
      );
    if (action === 'nudge' && b.lastAutoAt) {
      const next = b.lastAutoAt.getTime() + ctx.settings.nudge.cooldownDays * DAY;
      return blocked(
        'cooldown',
        `HandsFreeOS followed up with them ${dayLabel(b.lastAutoAt.getTime(), tz)}. The next one can go ${dayLabel(next, tz)}.`,
      );
    }
  }

  // How it reaches them.
  const reach = await reachFor(tx, ctx.workspaceId, target.contact);
  const channel: 'sms' | 'email' | null =
    reach.text === null ? 'sms' : reach.email === null ? 'email' : null;
  if (!channel)
    return blocked(
      'no_way_to_reach',
      `HandsFreeOS can’t reach them: ${TEXT_WHY[reach.text ?? ''] ?? 'no text'}, and ${EMAIL_WHY[reach.email ?? ''] ?? 'no email'}.`,
    );
  if (channel === 'email' && reach.text && byEmail[reach.text]) notes.push(byEmail[reach.text]!);
  const to =
    channel === 'sms' ? formatPhone(target.contact.phone!) : target.contact.email!.toLowerCase();

  // When it goes: after the cancel window, and a text after quiet hours.
  const scheduledFor = item.autoState === 'scheduled' ? item.autoScheduledFor : null;
  let sendAt = scheduledFor ? scheduledFor.getTime() : at + AUTO_CANCEL_WINDOW_MINUTES * MIN;
  if (channel === 'sms' && !scheduledFor) {
    const end = quietEndAfter(ctx.quietHours, tz, sendAt);
    if (end !== null) {
      sendAt = end;
      notes.push(`It’s quiet hours then, so the text goes at ${clockLabel(end, tz)}.`);
    }
  }

  // The words.
  let text: string;
  let subject: string | null = null;
  if (action === 'confirm_request') {
    const appt = target.appointment!;
    const input = {
      firstName: target.firstName,
      businessName: ctx.name,
      title: appt.title,
      startsAt: appt.startsAt,
      timeZone: tz,
      now: sendAt,
      replyToConfirm: ctx.settings.replyToConfirm,
      manageUrl: null,
      firstText: reach.firstText,
    };
    if (channel === 'sms') text = confirmRequestText(input);
    else ({ subject, body: text } = confirmRequestEmail(input));
    if (appt.startsAt <= sendAt)
      return blocked('too_late', `The appointment starts ${whenLabel(appt.startsAt, tz)}.`, {
        channel,
        to,
      });
  } else {
    const number = await liveNumber(tx, ctx.workspaceId);
    const sender = target.lead?.assigneeUserId
      ? (await userNames(tx, [target.lead.assigneeUserId])).get(target.lead.assigneeUserId)
      : null;
    const rendered = renderNudge(ctx.settings.nudge.template, {
      firstName: target.firstName,
      businessName: ctx.name,
      leadTitle: target.lead?.title ?? null,
      senderName: sender?.split(/\s+/)[0] ?? null,
      businessPhone: number ? formatPhone(number.e164) : null,
    });
    if (rendered.missing.length)
      return blocked(
        'nudge_incomplete',
        rendered.missing.includes('businessPhone')
          ? 'The follow-up message gives the business’s number, and the business has no number yet.'
          : 'The follow-up message needs the business’s name.',
        { channel, to },
      );
    text =
      channel === 'sms' && reach.firstText && !/\bSTOP\b/.test(rendered.text)
        ? `${rendered.text} ${STOP_WORDING}`
        : rendered.text;
    if (channel === 'email') subject = nudgeEmailSubject(ctx.name);
  }
  return plan({
    channel,
    to,
    subject,
    text,
    sendAt: new Date(sendAt).toISOString(),
    scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
  });
}

export type HandleConversation = {
  readonly id: string;
  readonly channel: 'sms' | 'email' | 'chat';
  readonly handledBy: 'none' | 'ai' | 'person';
};

/** The conversation an item's reply or hand-off goes to: its own, else the customer's latest. */
export async function conversationForItem(
  tx: Tx,
  workspaceId: string,
  item: Pick<AttentionItemRow, 'conversationId' | 'personId'>,
): Promise<HandleConversation | null> {
  if (!item.conversationId && !item.personId) return null;
  const [c] = await rows<HandleConversation>(
    tx,
    sql`select id, channel::text as channel, handled_by::text as "handledBy" from app.conversations
        where workspace_id = ${workspaceId}
          and ${item.conversationId ? sql`id = ${item.conversationId}` : sql`person_id = ${item.personId}`}
        order by last_message_at desc nulls last limit 1`,
  );
  return c ?? null;
}

/** The ask-first choices for an item, each as the person would run it. */
export async function askOptions(
  tx: Tx,
  ctx: AttentionContext,
  item: AttentionItemRow,
  now: Date,
): Promise<AttentionAskOptionOut[]> {
  const kind = item.kind as AttentionKind;
  if (kind === 'missing_next_action') {
    const [p] = item.personId
      ? await rows<{ first_name: string | null }>(
          tx,
          sql`select first_name from app.people where id = ${item.personId}`,
        )
      : [];
    return [
      {
        action: 'set_next_action',
        label: 'Set the next action',
        available: !!item.leadId,
        reason: item.leadId ? null : 'There’s no lead to set it on.',
        channel: null,
        conversationId: null,
        suggestion: suggestedNextAction(
          p?.first_name ?? null,
          ctx.business.openHours,
          ctx.timeZone,
          now.getTime(),
        ),
      },
    ];
  }
  if (kind !== 'hot_lead' && kind !== 'unanswered_lead' && kind !== 'customer_waiting') return [];
  const conv = await conversationForItem(tx, ctx.workspaceId, item);
  const teammate = await loadTeammate(tx, ctx.workspaceId);
  const handTo = teammate ? `Hand to ${teammate.name}` : 'Hand to the AI teammate';
  const channelWords: Readonly<Record<string, string>> = {
    sms: 'texts',
    email: 'email',
    chat: 'website chat',
  };
  const aiWhy = !teammate
    ? 'Set up your AI teammate first.'
    : teammate.status === 'off'
      ? `Turn ${teammate.name} on first.`
      : !conv
        ? 'There’s no conversation with them yet. Reply to start one.'
        : !teammateConfigOf(teammate).channels[conv.channel]
          ? `${teammate.name} doesn’t answer ${channelWords[conv.channel]}.`
          : conv.handledBy === 'ai'
            ? `${teammate.name} is already answering them.`
            : null;
  const [person] = item.personId
    ? await rows<{ phone: string | null; email: string | null }>(
        tx,
        sql`select phone_e164 as phone, email::text as email from app.people where id = ${item.personId}`,
      )
    : [];
  const channel: 'sms' | 'email' | 'chat' | null =
    conv?.channel ?? (person?.phone ? 'sms' : person?.email ? 'email' : null);
  const stopped =
    channel === 'sms' && person?.phone
      ? await isOptedOut(tx, ctx.workspaceId, person.phone)
      : false;
  const replyWhy = !channel
    ? 'There’s no number or email for them.'
    : stopped
      ? 'They texted STOP. They can text START to get texts again.'
      : null;
  return [
    {
      action: 'hand_to_ai',
      label: handTo,
      available: aiWhy === null,
      reason: aiWhy,
      channel: conv?.channel ?? null,
      conversationId: conv?.id ?? null,
      suggestion: null,
    },
    {
      action: 'reply',
      label:
        channel === 'email' ? 'Email them' : channel === 'chat' ? 'Reply in chat' : 'Text them',
      available: replyWhy === null,
      reason: replyWhy === null ? null : capital(replyWhy),
      channel,
      conversationId: conv?.id ?? null,
      suggestion: null,
    },
  ];
}
