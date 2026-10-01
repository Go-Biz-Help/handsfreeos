/**
 * What Let HandsFreeOS Handle would do for one item (M8), worked out on the server so the preview and the worker
 * agree:
 * - on its own (a confirmation request, a follow-up nudge): whom it reaches and how, the words exactly, when it
 *   goes (after the cancel window, and after quiet hours for a text), the checks it ran ("Nathan said texts are
 *   OK", "Outside quiet hours (8 PM to 8 AM)"…), or why it can't go;
 * - asks first: the choices (hand to the AI teammate, reply, set a next action), each with why it isn't
 *   available when it isn't.
 * The reach and reply rules here are pure and shared with the list's per-item hint (hints.ts). The worker (step 6)
 * runs planAutoAction again, under the item's lock, right before it sends. Server-only.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { loadTeammate, teammateConfigOf } from '../ai-team/load';
import { addDays, localDateOf, localInstant } from '../calendar/engine/zoned';
import { userNames } from '../calendar/load';
import { formatPhone } from '../crm/phone';
import { activeSuppression, workspaceAddresses } from '../messaging/email';
import { quietHoursState, type QuietHoursWindow } from '../messaging/quiet-hours';
import { isOptedOut, defaultNumber, loadRegistrations, readiness } from '../messaging/store';
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
import {
  lastReminderNote,
  moneyDraftEmail,
  moneyDraftText,
  tooSoonAfterReminder,
  type LastReminder,
  type MoneyDraftInput,
} from './money-draft';
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

import {
  MONEY_KINDS,
  nudgeContact,
  reachChannel,
  reachRule,
  replyChannelRule,
  REPLY_KINDS,
  type Reach,
  type ReachBusiness,
  type ReachContact,
} from './reach';

export {
  MONEY_KINDS,
  nudgeContact,
  reachChannel,
  reachRule,
  replyChannelRule,
  REPLY_KINDS,
  type Reach,
  type ReachBusiness,
  type ReachContact,
} from './reach';

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

/** "8 PM", "8:30 PM", "12 AM": a quiet-hours clock as the Let HandsFreeOS Handle sheet says it. */
export function shortClock(value: string): string {
  const [h = 0, m = 0] = value.split(':').map(Number);
  const hour = h % 24;
  return `${hour % 12 === 0 ? 12 : hour % 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${hour < 12 ? 'AM' : 'PM'}`;
}

export async function reachBusinessOf(tx: Tx, workspaceId: string): Promise<ReachBusiness> {
  const number = await defaultNumber(tx, workspaceId);
  const textingReady =
    !!number &&
    number.status === 'active' &&
    readiness(number, await loadRegistrations(tx, workspaceId)).messagingReady;
  return {
    textingReady,
    canEmail: (await workspaceAddresses(tx, workspaceId)).some((a) => a.usable),
  };
}

/** The reach rule for one customer, looked up on the spot. */
export async function reachFor(tx: Tx, workspaceId: string, c: ReachContact): Promise<Reach> {
  const optedOut = c.phone ? await isOptedOut(tx, workspaceId, c.phone) : false;
  const emailStopped = c.email
    ? !!(await activeSuppression(tx, workspaceId, c.email.toLowerCase()))
    : false;
  const { text, email } = reachRule(
    c,
    { optedOut, emailStopped },
    await reachBusinessOf(tx, workspaceId),
  );
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

/** The texts check, in the sheet's words ("Nathan said texts are OK"). */
function textsLabel(reason: string | null, who: string, whom: string): string {
  switch (reason) {
    case null:
      return `${who} said texts are OK`;
    case 'no_consent':
      return `${who} hasn’t said texts are OK`;
    case 'opted_out':
      return `${who} texted STOP`;
    case 'no_phone':
      return `There’s no mobile number for ${whom}`;
    default:
      return 'Texting isn’t set up yet';
  }
}

/** The email check, when a text can't go. */
function emailLabel(reason: string | null, address: string | null, whom: string): string {
  switch (reason) {
    case null:
      return `It can go by email to ${address?.toLowerCase() ?? whom}`;
    case 'no_email':
      return `There’s no email address for ${whom}`;
    case 'email_stopped':
      return `Email to ${whom} is stopped`;
    default:
      return 'The business has no address to send email from';
  }
}

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
    contact: nudgeContact({ phone: l.phone, email: l.email, consent: l.consent }),
    appointment: null,
    lead: { title: l.title, assigneeUserId: l.assignee_user_id },
  };
}

type Check = AttentionAutoPlanOut['checks'][number];

/**
 * The automatic action for an item, exactly as HandsFreeOS would carry it out now, with the checks it ran, or null
 * when the item's kind doesn't have one. A person asking (Let HandsFreeOS Handle) doesn't need the automatic switch
 * on, but a nudge never goes before an owner has read the message once.
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
  const checks: Check[] = [];
  const check = (code: string, ok: boolean, label: string) => checks.push({ code, label, ok });
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
    checks,
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
  const who = target.firstName ?? 'The customer';
  const whom = target.firstName ?? 'them';

  // How it reaches them.
  const reach = await reachFor(tx, ctx.workspaceId, target.contact);
  const channel = reachChannel(reach);
  check('texts', reach.text === null, textsLabel(reach.text, who, whom));
  if (reach.text !== null)
    check('email', reach.email === null, emailLabel(reach.email, target.contact.email, whom));
  if (channel === 'email' && reach.text && byEmail[reach.text]) notes.push(byEmail[reach.text]!);
  const to = !channel
    ? null
    : channel === 'sms'
      ? formatPhone(target.contact.phone!)
      : target.contact.email!.toLowerCase();

  // When it goes: after the cancel window, and a text after quiet hours.
  const scheduledFor = item.autoState === 'scheduled' ? item.autoScheduledFor : null;
  let sendAt = scheduledFor ? scheduledFor.getTime() : at + AUTO_CANCEL_WINDOW_MINUTES * MIN;
  if (channel === 'sms') {
    const q = ctx.quietHours;
    const range = `${shortClock(q.start)} to ${shortClock(q.end)}`;
    const end = q.enabled ? quietEndAfter(q, tz, sendAt) : null;
    if (!q.enabled) check('quiet_hours', true, 'Quiet hours are off');
    else if (end === null) check('quiet_hours', true, `Outside quiet hours (${range})`);
    else {
      if (!scheduledFor) sendAt = end;
      check(
        'quiet_hours',
        false,
        `Quiet hours (${range}): the text goes at ${clockLabel(end, tz)}`,
      );
      notes.push(`It’s quiet hours then, so the text goes at ${clockLabel(end, tz)}.`);
    }
  }

  // Whether anyone else is on it. Every check runs; the first failure (in the guard's order) blocks it.
  let stop: { code: string; message: string } | null = null;
  const block = (code: string, message: string) => {
    stop ??= { code, message };
  };
  if (target.personId) {
    const b = await blockersFor(tx, ctx, item, target.personId, at);
    const teammate = await loadTeammate(tx, ctx.workspaceId);
    const ai = teammate?.name ?? 'The AI teammate';
    const talking = b.aiTalking
      ? `${ai} is talking with ${whom}`
      : b.personTalking
        ? `Someone on your team is talking with ${whom}`
        : b.waiting
          ? `${who} is waiting on a reply`
          : b.personMessageAt
            ? `Someone on your team messaged ${whom} ${agoLabel(at - b.personMessageAt.getTime())}`
            : null;
    check(
      'talking',
      talking === null,
      talking ??
        (teammate
          ? `Nobody on your team, and not ${teammate.name}, is talking with ${whom}`
          : `Nobody on your team is talking with ${whom}`),
    );
    const busy = b.workflow
      ? `The “${b.workflow}” workflow is working with ${whom}`
      : b.draft
        ? `${ai} has a reply for ${whom} waiting for approval`
        : null;
    check('busy', busy === null, busy ?? 'No workflow running and no draft waiting');
    const days = ctx.settings.nudge.cooldownDays;
    const nextAuto = b.lastAutoAt ? b.lastAutoAt.getTime() + days * DAY : null;
    if (action === 'nudge')
      check(
        'cooldown',
        !b.lastAutoAt,
        b.lastAutoAt
          ? `HandsFreeOS followed up ${dayLabel(b.lastAutoAt.getTime(), tz)}; the next one can go ${dayLabel(nextAuto!, tz)}`
          : `No other automatic message in the last ${days} days`,
      );

    if (b.aiTalking) block('someone_talking', `${ai} is talking with them.`);
    else if (b.personTalking) block('someone_talking', 'Someone on the team is talking with them.');
    else if (b.waiting)
      block('customer_waiting', 'They’re waiting on a reply. Answer them instead.');
    else if (b.draft) block('draft_pending', `${ai} has a reply waiting for approval.`);
    else if (b.workflow)
      block('workflow_running', `The “${b.workflow}” workflow is working with them.`);
    else if (b.personMessageAt)
      block(
        'recent_person_contact',
        `Someone on the team messaged them ${agoLabel(at - b.personMessageAt.getTime())}, so HandsFreeOS leaves it to them.`,
      );
    else if (action === 'nudge' && b.lastAutoAt)
      block(
        'cooldown',
        `HandsFreeOS followed up with them ${dayLabel(b.lastAutoAt.getTime(), tz)}. The next one can go ${dayLabel(nextAuto!, tz)}.`,
      );
  }
  if (!channel)
    block(
      'no_way_to_reach',
      `HandsFreeOS can’t reach them: ${TEXT_WHY[reach.text ?? ''] ?? 'no text'}, and ${EMAIL_WHY[reach.email ?? ''] ?? 'no email'}.`,
    );
  if (stop) return plan({ channel, to, blocked: stop });

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
    const number = await defaultNumber(tx, ctx.workspaceId);
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
  readonly channel: 'sms' | 'email' | 'chat' | 'portal';
  readonly handledBy: 'none' | 'ai' | 'person';
  /** The number, address or chat visitor it's with. */
  readonly counterpart: string;
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
    sql`select id, channel::text as channel, handled_by::text as "handledBy", counterpart from app.conversations
        where workspace_id = ${workspaceId}
          and ${item.conversationId ? sql`id = ${item.conversationId}` : sql`person_id = ${item.personId}`}
        order by last_message_at desc nulls last limit 1`,
  );
  return c ?? null;
}

/**
 * The last thing the business's own ladder actually sent about an invoice (`invoices.reminder_state`): a rung of
 * reminders, or the `sent` rung, which is the invoice itself going out. Both count — writing to someone an hour
 * after their invoice landed is the same mistake as two reminders an hour apart.
 */
export function lastSentReminder(state: unknown): LastReminder | null {
  const rungs = (state as { reminders?: Record<string, unknown> } | null)?.reminders;
  if (!rungs || typeof rungs !== 'object') return null;
  let best: LastReminder | null = null;
  for (const [key, entry] of Object.entries(rungs)) {
    const r = entry as { status?: unknown; channel?: unknown; at?: unknown };
    if (r?.status !== 'sent' || typeof r.at !== 'string') continue;
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) continue;
    if (!best || at > Date.parse(best.at))
      best = {
        at: r.at,
        channel: r.channel === 'sms' || r.channel === 'email' ? r.channel : null,
        kind: key === 'sent' ? 'document' : 'reminder',
      };
  }
  return best;
}

interface MoneyDocumentRow extends Record<string, unknown> {
  number: string | null;
  title: string | null;
  amount: number;
  day: string | null;
  reminder_state: unknown;
  first_name: string | null;
  phone: string | null;
  email: string | null;
  consent: 'unknown' | 'opted_in' | 'opted_out';
}

/**
 * The one choice a money card offers: the follow-up, already written from the document's own figures, for a
 * person to read and send. Never the AI teammate — an AI that talks to a customer about a bill is a different
 * conversation, and one Chris hasn't had.
 *
 * The business's own reminder ladder is already writing to this customer about this invoice on the schedule
 * they agreed, so the option carries when the last one went out, and refuses to offer a second within the day.
 */
async function moneyAskOptions(
  tx: Tx,
  ctx: AttentionContext,
  item: AttentionItemRow,
  now: Date,
  sender: string | null,
): Promise<AttentionAskOptionOut[]> {
  const ws = ctx.workspaceId;
  const invoice = item.kind === 'invoice_overdue';
  const [doc] = await rows<MoneyDocumentRow>(
    tx,
    invoice
      ? sql`select i.number, i.title, i.balance_cents::float8 as amount, i.due_on::text as day,
              i.reminder_state, p.first_name, p.phone_e164 as phone, p.email::text as email,
              p.sms_consent::text as consent
            from app.invoices i join app.people p on p.id = i.person_id
            where i.workspace_id = ${ws} and i.id = ${item.subjectId}`
      : sql`select e.number, e.title, e.total_cents::float8 as amount, e.expires_on::text as day,
              null::jsonb as reminder_state, p.first_name, p.phone_e164 as phone, p.email::text as email,
              p.sms_consent::text as consent
            from app.estimates e join app.people p on p.id = e.person_id
            where e.workspace_id = ${ws} and e.id = ${item.subjectId}`,
  );
  if (!doc) return [];
  const conv = await conversationForItem(tx, ws, item);
  // Never a website chat about money: a visitor's chat is gone by the time a bill is late.
  const conversationChannel = conv && conv.channel !== 'chat' ? conv.channel : null;
  const textNumber = conversationChannel === 'sms' ? conv!.counterpart : doc.phone;
  const textStopped =
    doc.consent === 'opted_out' || (textNumber ? await isOptedOut(tx, ws, textNumber) : false);
  const channel = replyChannelRule({
    conversationChannel,
    phone: doc.phone,
    email: doc.email,
    textStopped,
  });
  const draftInput: MoneyDraftInput = {
    kind: invoice ? 'invoice_overdue' : 'estimate_waiting',
    firstName: doc.first_name,
    businessName: ctx.name,
    senderFirstName: sender,
    title: doc.title,
    number: doc.number,
    amountCents: Math.max(0, Math.round(Number(doc.amount))),
    day: doc.day,
    timeZone: ctx.timeZone,
    now: now.getTime(),
    // A number we have never texted carries the STOP wording, as every other first text does.
    firstText: channel === 'sms' && !conversationChannel,
  };
  const mail = moneyDraftEmail(draftInput);
  const last = invoice ? lastSentReminder(doc.reminder_state) : null;
  const tooSoon = tooSoonAfterReminder(last, now.getTime(), ctx.timeZone);
  const cannot = textStopped
    ? 'They texted STOP, and there’s no email address for them.'
    : 'There’s no number or email for them.';
  return [
    {
      action: 'reply',
      label: channel === 'email' ? 'Email them' : 'Text them',
      available: channel !== null && !tooSoon,
      reason: tooSoon ?? (channel === null ? cannot : null),
      channel,
      conversationId: conv && conv.channel === channel ? conv.id : null,
      suggestion: null,
      draft:
        channel === null
          ? null
          : channel === 'email'
            ? { body: mail.body, subject: mail.subject }
            : { body: moneyDraftText(draftInput), subject: null },
      note: tooSoon ? null : lastReminderNote(last, now.getTime(), ctx.timeZone),
    },
  ];
}

/** The ask-first choices for an item, each as the person would run it. */
export async function askOptions(
  tx: Tx,
  ctx: AttentionContext,
  item: AttentionItemRow,
  now: Date,
  /** Who is asking, by first name: the follow-up is signed as them ("it's Dale at Lone Star"). */
  sender: string | null = null,
): Promise<AttentionAskOptionOut[]> {
  const kind = item.kind as AttentionKind;
  if (MONEY_KINDS.has(kind)) return moneyAskOptions(tx, ctx, item, now, sender);
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
        draft: null,
        note: null,
      },
    ];
  }
  if (!REPLY_KINDS.has(kind)) return [];
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
        : // A client's portal is for their people: the AI teammate never answers it.
          conv.channel === 'portal'
          ? `${teammate.name} doesn’t answer messages in a client’s portal. Reply yourself.`
          : !teammateConfigOf(teammate).channels[conv.channel]
            ? `${teammate.name} doesn’t answer ${channelWords[conv.channel]}.`
            : conv.handledBy === 'ai'
              ? `${teammate.name} is already answering them.`
              : null;
  const [person] = item.personId
    ? await rows<{
        phone: string | null;
        email: string | null;
        consent: 'unknown' | 'opted_in' | 'opted_out';
      }>(
        tx,
        sql`select phone_e164 as phone, email::text as email, sms_consent::text as consent
            from app.people where id = ${item.personId}`,
      )
    : [];
  const textNumber = conv?.channel === 'sms' ? conv.counterpart : (person?.phone ?? null);
  const textStopped =
    person?.consent === 'opted_out' ||
    (textNumber ? await isOptedOut(tx, ctx.workspaceId, textNumber) : false);
  const channel = replyChannelRule({
    conversationChannel: conv?.channel ?? null,
    phone: person?.phone ?? null,
    email: person?.email ?? null,
    textStopped,
  });
  const replyWhy = channel
    ? null
    : textStopped
      ? 'They texted STOP. They can text START to get texts again.'
      : 'There’s no number or email for them.';
  return [
    {
      action: 'hand_to_ai',
      label: handTo,
      available: aiWhy === null,
      reason: aiWhy,
      channel: conv?.channel ?? null,
      conversationId: conv?.id ?? null,
      suggestion: null,
      draft: null,
      note: null,
    },
    {
      action: 'reply',
      label:
        channel === 'email'
          ? 'Email them'
          : channel === 'chat'
            ? 'Reply in chat'
            : channel === 'portal'
              ? 'Reply in their portal'
              : 'Text them',
      available: replyWhy === null,
      reason: replyWhy === null ? null : capital(replyWhy),
      channel,
      // A reply that falls back to email starts from the customer, not the text conversation.
      conversationId: conv && conv.channel === channel ? conv.id : null,
      suggestion: null,
      draft: null,
      note: null,
    },
  ];
}
