/**
 * The moments that send a push from an event (M10); the urgent alert's is urgent.ts. Each handler queues one push in
 * the event's own transaction, so the outbox's once-per-event is the push's too, for the people the moment's email
 * picks (or, where no email covers it, the people it is about):
 * - **Approvals waiting** (`approval`): a workflow's approval step, to the people it names who still work in the
 *   business, else its owners and admins, as its email; an AI teammate's draft, to whoever may decide it (a reply:
 *   the conversation's assignee, else the teammate's hand-off list; an action to approve: the owners and admins).
 * - **Your appointments** (`booking`): booked, moved or cancelled, to the people working it (a calendar nobody works:
 *   its owner, else the owners and admins, as the booking email); put on your calendar, to whoever it was given to.
 *   Never a time held for a deposit that nobody paid, which nobody was told was booked.
 * - **Assigned to you** (`assigned`): a lead, a conversation, a task, or a Home item assigned on its own (an item
 *   whose lead, conversation or task changed hands says so through that record's own event).
 * - **A customer pays** (`payment`, off unless turned on): an invoice paid in full, to the people its email goes to.
 * - **A call nobody took** (`missedCall`): an inbound call that went unanswered, and the voicemail if one was left,
 *   to the conversation's assignee, else the owners and admins.
 * - **A customer's new message** (`customerWaiting`): arrival.ts.
 *
 * Whoever did it gets nothing about it. A push is a second channel: a handler runs in a savepoint, and a failure is
 * logged without holding up anything else the event does.
 */
import {
  ATTENTION_KIND_LABELS,
  dayLabel,
  formatPhone,
  loadCustomerSaid,
  money,
  PAYMENT_METHOD_WORDS,
  TeammateDraftPreview,
  whenLabel,
  type AttentionKind,
  type PaymentMethod,
  type PushRefs,
  uuidArray,
  walletSpeaks,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { runtimeConfigOf } from '../ai-team/config';
import { standIns } from '../booking/team-email';
import { conversationContact } from '../chat/store';
import { handlersFor, type EventHandler, type HandlerMap } from '../handlers/types';
import type { TenantScope } from '../services';
import { onCustomerMessagePush } from './arrival';
import {
  isRecord,
  managerIds,
  payloadOf,
  personActor,
  personName,
  pushMoment,
  quoted,
  stillHere,
  str,
  strings,
  userName,
} from './moment';
import { pushAudience, queuePush, type PushMoment } from './queue';
import { CHANNEL_WORD, conversationCollapseId } from './urgent';

// ---------- approvals ----------

/**
 * The push for a workflow approval step still waiting, to the people named on it (else the owners and admins);
 * null once it's decided. Also what "Approvals about to expire" sends (automations/expiring.ts).
 */
export async function approvalPushOf(
  tx: Tx,
  scope: TenantScope,
  approvalId: string,
): Promise<PushMoment | null> {
  const [a] = await rows<{ approvers: string[] | null; preview: unknown; status: string }>(
    tx,
    sql`select approvers, preview, status::text as status from app.workflow_approvals
        where id = ${approvalId} and workspace_id = ${scope.workspaceId}`,
  );
  if (!a || a.status !== 'pending') return null;
  const named = await stillHere(tx, scope.workspaceId, a.approvers ?? []);
  const preview = isRecord(a.preview) ? a.preview : {};
  const workflow = str(preview['workflow']) ?? 'A workflow';
  const customer = str(preview['customer']);
  const fields = isRecord(preview['fields']) ? Object.values(preview['fields']) : [];
  const written = fields.find((v): v is string => typeof v === 'string' && !!v.trim());
  const personId = str(preview['personId']);
  return {
    key: `approval:${approvalId}`,
    category: 'approval',
    userIds: named.length ? named : await managerIds(tx, scope.workspaceId),
    title: `Approval · ${customer ?? workflow}`,
    body: `${workflow}: ${written ? quoted(written) : (str(preview['message']) ?? 'waiting for your OK')}`,
    path: `/app/w/${scope.workspaceId}/workflows/approvals`,
    refs: { approvalId, ...(personId ? { personId } : {}) },
  };
}

/** workflow.approval_requested: an approval step is waiting for someone's yes. */
export const onApprovalPush = pushMoment('approval', async (ctx, scope) => {
  const approvalId = str(payloadOf(ctx)['approvalId']) ?? ctx.event.entityId;
  if (!approvalId) return;
  const moment = await approvalPushOf(ctx.tx, scope, approvalId);
  if (moment) await queuePush(ctx.tx, scope, moment);
});

/**
 * The wallet ran out, or the card on it stopped working (M16). Owners and admins, because they are the ones who
 * can do something about it — a member with `inbox.use` cannot put a card on a wallet and would only be told
 * about a problem they cannot fix.
 *
 * `wallet.low` is deliberately not here. A low balance with a working card fixes itself in seconds, and a push
 * about something that resolves before somebody reaches their phone teaches them to ignore the next one.
 *
 * **Nothing goes out before the business is on the wallet**, and what it says depends on how far along it is.
 * At `off` there is no push at all: during a shadow week every balance goes negative and telling somebody
 * their texts had stopped would be false. At `warn` it says what is about to happen; only at `enforce` does it
 * say what has.
 */
export const onWalletPush = pushMoment('wallet', async (ctx, scope) => {
  const ws = scope.workspaceId;
  const [w] = await rows<{
    balance_cents: number | string;
    suspended_reason: string | null;
    stage: string;
  }>(
    ctx.tx,
    sql`select balance_cents, suspended_reason, stage::text as stage
        from app.usage_wallets where workspace_id = ${ws}`,
  );
  if (!w || !walletSpeaks(w.stage)) return;
  const stopping = w.stage === 'enforce';
  const declined = ctx.event.eventType === 'wallet.suspended';
  const balance = Number(w.balance_cents);
  await queuePush(ctx.tx, scope, {
    // One key per kind of trouble, so a card declining and then the balance emptying are not two identical
    // notifications — and so the same trouble reported twice is one.
    key: declined ? `wallet-card:${ws}` : `wallet-empty:${ws}`,
    category: 'wallet',
    userIds: await managerIds(ctx.tx, ws),
    title: declined ? 'Your card was declined' : 'Your balance has run out',
    body: declined
      ? (w.suspended_reason ??
        (stopping
          ? 'Texts and calls have stopped until a card is added.'
          : 'Add a card so texts and calls keep working.'))
      : stopping
        ? `${money(balance)} left. Texts and calls have stopped until it is topped up.`
        : `${money(balance)} left. Top up before texts and calls stop.`,
    path: `/app/w/${ws}/settings/usage`,
    refs: {},
  });
});

/** Who hears about a reply draft nobody is assigned: the teammate's hand-off list, else the owners and admins. */
async function handOffList(tx: Tx, workspaceId: string, config: unknown): Promise<string[]> {
  const who = runtimeConfigOf(config).handOff.notify;
  if (who?.kind === 'users') {
    const named = await stillHere(
      tx,
      workspaceId,
      who.userIds.filter((v): v is string => typeof v === 'string'),
    );
    if (named.length) return named;
  }
  return managerIds(tx, workspaceId);
}

/**
 * Of these people, the ones who may see a draft with this list: whoever sees the whole inbox, and anybody else only
 * when the list names them — the draft's two SELECT arms, read off what 0083 stores for them.
 */
async function seesDraft(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  viewers: readonly string[],
): Promise<string[]> {
  if (!ids.length) return [];
  const narrowed = await rows<{ user_id: string }>(
    tx,
    sql`select wa.user_id from app.workspace_access wa
        where wa.workspace_id = ${workspaceId} and not wa.sees_whole_inbox
          and wa.user_id = any(${uuidArray([...ids])})`,
  );
  const hidden = new Set(narrowed.map((r) => r.user_id).filter((id) => !viewers.includes(id)));
  return ids.filter((id) => !hidden.has(id));
}

/**
 * The push for an AI teammate draft still waiting: an action to approve goes to the owners and admins, a reply to
 * the conversation's assignee (else the teammate's hand-off list); null once it's decided. Also what "Approvals
 * about to expire" sends (automations/expiring.ts).
 */
export async function draftPushOf(
  tx: Tx,
  scope: TenantScope,
  draftId: string,
): Promise<PushMoment | null> {
  const ws = scope.workspaceId;
  const [d] = await rows<{
    kind: string;
    status: string;
    preview: unknown;
    conversation_id: string | null;
    person_id: string | null;
    member_viewer_ids: string[];
    name: string;
    config: unknown;
  }>(
    tx,
    sql`select d.kind::text as kind, d.status::text as status, d.preview, d.conversation_id, d.person_id,
          d.member_viewer_ids, t.name, t.config
        from app.ai_teammate_drafts d join app.ai_teammates t on t.id = d.teammate_id
        where d.id = ${draftId} and d.workspace_id = ${ws}`,
  );
  if (!d || d.status !== 'pending') return null;
  const [conv] = d.conversation_id
    ? await rows<{ assignee_user_id: string | null; channel: 'sms' | 'email' | 'chat' }>(
        tx,
        sql`select assignee_user_id, channel::text as channel from app.conversations
            where id = ${d.conversation_id}`,
      )
    : [];
  // Only owners and admins decide what the teammate asks approval for; anyone in the inbox decides a reply.
  const assignee = conv?.assignee_user_id ? await stillHere(tx, ws, [conv.assignee_user_id]) : [];
  const picked =
    d.kind === 'approval'
      ? await managerIds(tx, ws)
      : assignee.length
        ? assignee
        : await handOffList(tx, ws, d.config);
  // The push quotes the draft, so it goes only to people who may open it (20261012020100): a member the business
  // narrowed to their own threads hears about drafts on theirs and no others. Nobody left: the owners and admins.
  const seeing = await seesDraft(tx, ws, picked, d.member_viewer_ids);
  const userIds = seeing.length ? seeing : await managerIds(tx, ws);
  const preview = TeammateDraftPreview.safeParse(d.preview);
  const message = preview.success ? (preview.data.message?.body ?? null) : null;
  const discount = preview.success ? preview.data.discount : null;
  const customer = await personName(tx, d.person_id);
  const call = preview.success ? preview.data.call : null;
  const body = call
    ? `${d.name} wants to call ${customer ?? 'them'} ${CALL_WHY[call.purpose] ?? ''}`.trim() + '.'
    : discount
      ? `${d.name} wants to take ${discount.percent}% off${message ? `: ${quoted(message)}` : '.'}`
      : message
        ? `${d.name} wrote: ${quoted(message)}`
        : `${d.name} is waiting for your OK.`;
  return {
    key: `draft:${draftId}`,
    category: 'approval',
    userIds,
    title: `Approval · ${customer ?? d.name}`,
    body,
    path: `/app/w/${ws}/workflows/approvals?filter=ai`,
    refs: {
      draftId,
      ...(d.conversation_id && conv
        ? { conversationId: d.conversation_id, channel: conv.channel }
        : {}),
      ...(d.person_id ? { personId: d.person_id } : {}),
    },
  };
}

/** Why an AI call waiting for approval would be made, for the team's push. */
const CALL_WHY: Readonly<Record<string, string>> = {
  confirm_visit: 'to confirm their visit',
  missed_call: 'back about a missed call',
  quote: 'about their quote',
  campaign: 'for a campaign',
};

/** ai_teammate.drafted: the AI teammate wrote something that waits for a person's OK. */
export const onDraftPush = pushMoment('approval', async (ctx, scope) => {
  const draftId = str(payloadOf(ctx)['draftId']) ?? ctx.event.entityId;
  if (!draftId) return;
  const moment = await draftPushOf(ctx.tx, scope, draftId);
  if (moment) await queuePush(ctx.tx, scope, moment);
});

// ---------- your appointments ----------

type Change = 'booked' | 'moved' | 'cancelled' | 'given';

const APPOINTMENT_CHANGES: Readonly<Record<string, Change>> = {
  'appointment.booked': 'booked',
  'attendee.added': 'booked',
  'appointment.rescheduled': 'moved',
  'attendee.rescheduled': 'moved',
  'appointment.cancelled': 'cancelled',
  'attendee.cancelled': 'cancelled',
  'attendee.removed': 'cancelled',
  'appointment.reassigned': 'given',
};

const CHANGE_TITLE: Readonly<Record<Change, string>> = {
  booked: 'New booking',
  moved: 'Moved',
  cancelled: 'Cancelled',
  given: 'On your calendar',
};

const startOf = (v: unknown): number | null => {
  const at = isRecord(v) ? Date.parse(String(v['startsAt'] ?? '')) : NaN;
  return Number.isFinite(at) ? at : null;
};

/** Booked, moved, cancelled or given to someone: the people working the appointment hear. */
export const onAppointmentPush = pushMoment('booking', async (ctx, scope) => {
  const change = APPOINTMENT_CHANGES[ctx.event.eventType];
  const appointmentId = ctx.event.entityId;
  if (!change || !appointmentId) return;
  const ws = scope.workspaceId;
  const p = payloadOf(ctx);
  if (change === 'cancelled') {
    // A held time given back unpaid: the booking was never announced, so neither is this.
    const [audit] = await rows<{ action: string }>(
      ctx.tx,
      sql`select action from app.audit_logs where event_id = ${ctx.event.id} limit 1`,
    );
    if (audit?.action === 'booking.release_hold') return;
  }
  const [appt] = await rows<{
    title: string;
    starts_at: Date | string;
    owner_user_id: string | null;
    tz: string;
  }>(
    ctx.tx,
    sql`select a.title, a.starts_at, c.owner_user_id, coalesce(c.timezone, w.timezone) as tz
        from app.appointments a
        join app.calendars c on c.id = a.calendar_id
        join app.workspaces w on w.id = a.workspace_id
        where a.id = ${appointmentId} and a.workspace_id = ${ws}`,
  );
  if (!appt) return;
  let userIds: string[];
  if (change === 'given') {
    const before = new Set(strings(p['fromUserIds']));
    userIds = strings(p['toUserIds']).filter((id) => !before.has(id));
  } else {
    const staff = await rows<{ user_id: string }>(
      ctx.tx,
      sql`select user_id from app.appointment_staff where appointment_id = ${appointmentId}
          order by created_at, user_id`,
    );
    userIds = staff.length
      ? staff.map((s) => s.user_id)
      : await standIns(ctx.tx, scope, appt.owner_user_id);
  }
  // The customer: the booking the event is about, else the first one on it.
  const [who] = await rows<{ person_id: string }>(
    ctx.tx,
    sql`select person_id from app.appointment_attendees
        where appointment_id = ${appointmentId}
        order by (id = ${str(p['attendeeId'])}::uuid) desc nulls last,
          (person_id = ${str(p['personId'])}::uuid) desc nulls last, created_at, id
        limit 1`,
  );
  const personId = str(p['personId']) ?? who?.person_id ?? null;
  const customer = await personName(ctx.tx, personId);
  const tz = appt.tz || 'UTC';
  const from = startOf(p['from']);
  const at =
    (change === 'moved' ? startOf(p['to']) : null) ??
    (change === 'cancelled' ? startOf(p) : null) ??
    new Date(appt.starts_at).getTime();
  const title = CHANGE_TITLE[change];
  await queuePush(ctx.tx, scope, {
    key: `booking:${ctx.event.id}`,
    category: 'booking',
    userIds,
    exceptUserId: personActor(ctx),
    title: customer ? `${title} · ${customer}` : title,
    body: `${appt.title} · ${whenLabel(at, tz)}${change === 'moved' && from !== null ? ` (was ${whenLabel(from, tz)})` : ''}`,
    path: `/app/w/${ws}/calendar?appt=${appointmentId}`,
    refs: { appointmentId, ...(personId ? { personId } : {}) },
  });
});

// ---------- assigned to you ----------

/** A lead, a conversation, a task or a Home item given to someone: they hear, unless they took it themselves. */
export const onAssignedPush = pushMoment('assigned', async (ctx, scope) => {
  const ws = scope.workspaceId;
  const p = payloadOf(ctx);
  const actor = personActor(ctx);
  const byName = await userName(ctx.tx, actor);
  const by = byName ? ` · from ${byName}` : '';
  const id = ctx.event.entityId;
  if (!id) return;
  const base = {
    key: `assigned:${ctx.event.id}`,
    category: 'assigned',
    exceptUserId: actor,
  } as const;

  switch (ctx.event.eventType) {
    case 'lead.assigned': {
      const assignee = str(p['assigneeUserId']);
      const [lead] = await rows<{
        title: string;
        person_id: string | null;
        company: string | null;
      }>(
        ctx.tx,
        sql`select l.title, l.person_id, c.name as company from app.leads l
            left join app.companies c on c.id = l.company_id
            where l.id = ${id} and l.workspace_id = ${ws}`,
      );
      if (!assignee || !lead) return;
      const customer = (await personName(ctx.tx, lead.person_id)) ?? lead.company;
      await queuePush(ctx.tx, scope, {
        ...base,
        userIds: [assignee],
        title: customer ? `Assigned to you · ${customer}` : 'Lead assigned to you',
        body: `Lead: ${lead.title}${by}`,
        path: `/app/w/${ws}/leads/${id}`,
        refs: { leadId: id, ...(lead.person_id ? { personId: lead.person_id } : {}) },
      });
      return;
    }
    case 'conversation.assigned': {
      const assignee = str(p['assigneeUserId']);
      const [conv] = await rows<{
        channel: 'sms' | 'email' | 'chat';
        counterpart: string;
        person_id: string | null;
      }>(
        ctx.tx,
        sql`select channel::text as channel, counterpart, person_id from app.conversations
            where id = ${id} and workspace_id = ${ws}`,
      );
      if (!assignee || !conv) return;
      const customer =
        (await personName(ctx.tx, conv.person_id)) ?? (await conversationContact(ctx.tx, conv));
      // What the customer said last, never the business's own words however recent.
      const said = (await loadCustomerSaid(ctx.tx, [id])).get(id);
      await queuePush(ctx.tx, scope, {
        ...base,
        userIds: [assignee],
        title: `Assigned to you · ${customer}`,
        about: CHANNEL_WORD[conv.channel] ?? null,
        body: `${said ? quoted(said.words) : 'A conversation'}${by}`,
        path: `/app/w/${ws}/inbox/${id}`,
        refs: {
          conversationId: id,
          channel: conv.channel,
          ...(conv.person_id ? { personId: conv.person_id } : {}),
        },
      });
      return;
    }
    case 'task.created':
    case 'task.updated': {
      if (
        ctx.event.eventType === 'task.updated' &&
        !strings(p['fields']).includes('assigneeUserId')
      )
        return;
      const [task] = await rows<{
        title: string;
        assignee_user_id: string | null;
        due_at: Date | string | null;
        all_day: boolean;
        person_id: string | null;
        lead_id: string | null;
        done_at: Date | string | null;
        tz: string;
      }>(
        ctx.tx,
        sql`select t.title, t.assignee_user_id, t.due_at, t.all_day, t.person_id, t.lead_id, t.done_at,
              w.timezone as tz
            from app.tasks t join app.workspaces w on w.id = t.workspace_id
            where t.id = ${id} and t.workspace_id = ${ws}`,
      );
      if (!task?.assignee_user_id || task.done_at) return;
      const due = task.due_at ? new Date(task.due_at).getTime() : null;
      const when =
        due === null
          ? ''
          : ` · due ${task.all_day ? dayLabel(due, task.tz) : whenLabel(due, task.tz)}`;
      const refs: PushRefs = {
        taskId: id,
        ...(task.person_id ? { personId: task.person_id } : {}),
        ...(task.lead_id ? { leadId: task.lead_id } : {}),
      };
      await queuePush(ctx.tx, scope, {
        ...base,
        userIds: [task.assignee_user_id],
        title: 'Task assigned to you',
        body: `${task.title}${when}${by}`,
        path: `/app/w/${ws}/tasks`,
        refs,
      });
      return;
    }
    case 'attention.assigned': {
      // A lead's, conversation's or task's item passed the record itself on, and that record's event says so.
      if (p['passedTo']) return;
      const assignee = str(p['assigneeUserId']);
      const [item] = await rows<{ kind: string; title: string; person_id: string | null }>(
        ctx.tx,
        sql`select kind, title, person_id from app.attention_items
            where id = ${id} and workspace_id = ${ws}`,
      );
      if (!assignee || !item) return;
      await queuePush(ctx.tx, scope, {
        ...base,
        userIds: [assignee],
        title: `Assigned to you · ${ATTENTION_KIND_LABELS[item.kind as AttentionKind] ?? 'Home'}`,
        body: `${item.title}${by}`,
        path: `/app/w/${ws}?item=${id}`,
        refs: { itemId: id, ...(item.person_id ? { personId: item.person_id } : {}) },
      });
      return;
    }
  }
});

// ---------- a customer pays ----------

/** invoice.paid: the owners and admins, and whoever the invoice is on, as the "you've been paid" email. */
export const onPaidPush = pushMoment('payment', async (ctx, scope) => {
  const invoiceId = ctx.event.entityId;
  if (!invoiceId) return;
  const ws = scope.workspaceId;
  const [invoice] = await rows<{
    number: string | null;
    total_cents: number;
    assignee_user_id: string | null;
    person_id: string;
    customer: string;
    method: string | null;
  }>(
    ctx.tx,
    sql`select i.number, i.total_cents::float8 as total_cents, i.assignee_user_id, i.person_id,
          trim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')) as customer,
          (select p.method::text from app.payments p
            where p.invoice_id = i.id and p.status = 'succeeded'
            order by p.received_at desc nulls last, p.created_at desc limit 1) as method
        from app.invoices i join app.people pe on pe.id = i.person_id
        where i.workspace_id = ${ws} and i.id = ${invoiceId}`,
  );
  if (!invoice) return;
  const people = await rows<{ id: string }>(
    ctx.tx,
    // As the paid email: whoever manages money here (0106), and the invoice's own person.
    sql`select wm.user_id as id from app.workspace_memberships wm
        join app.workspace_access wa on wa.user_id = wm.user_id and wa.workspace_id = wm.workspace_id
        where wm.workspace_id = ${ws}
          and (wa.manages_money or wm.user_id = ${invoice.assignee_user_id}::uuid)`,
  );
  const how = invoice.method
    ? ` by ${PAYMENT_METHOD_WORDS[invoice.method as PaymentMethod] ?? invoice.method}`
    : '';
  await queuePush(ctx.tx, scope, {
    key: `payment:${ctx.event.id}`,
    category: 'payment',
    userIds: people.map((u) => u.id),
    exceptUserId: personActor(ctx),
    title: `Paid · ${invoice.customer || 'A customer'}`,
    body: `${invoice.number ?? 'An invoice'} · ${money(Number(invoice.total_cents))}${how}`,
    path: `/app/w/${ws}/money/invoices/${invoiceId}`,
    refs: { invoiceId, personId: invoice.person_id },
  });
});

// ---------- a call nobody took ----------

/** "0:14", the same shape the conversation list uses for a call's length. */
const callClock = (seconds: number | null | undefined): string => {
  const s = Math.max(0, seconds ?? 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * `call.missed` and `call.voicemail_left`: an inbound call nobody answered, and the voicemail if one followed.
 *
 * Both collapse onto the conversation, so a call that goes to voicemail replaces its own missed-call notification
 * instead of buzzing twice. The two events come from different webhooks and may arrive in either order, which is
 * why the collapse does the work rather than the ordering: whichever lands second is the one left on the phone,
 * and the voicemail's words are a superset of the missed call's either way.
 *
 * An outbound call that didn't connect is nobody's news — whoever placed it watched it fail — and a bridge the
 * person cancelled themselves is theirs, so the actor never hears about it.
 */
export const onMissedCallPush = pushMoment('missedCall', async (ctx, scope) => {
  const callId = ctx.event.entityId;
  if (!callId) return;
  const ws = scope.workspaceId;
  const [call] = await rows<{
    direction: string;
    from_e164: string;
    conversation_id: string | null;
    person_id: string | null;
    is_voicemail: boolean;
    transcript: string | null;
    recording_seconds: number | null;
  }>(
    ctx.tx,
    sql`select direction::text as direction, from_e164, conversation_id, person_id,
          is_voicemail, transcript, recording_seconds
        from app.calls where id = ${callId} and workspace_id = ${ws}`,
  );
  if (!call || call.direction !== 'inbound' || !call.conversation_id) return;
  // The voicemail says everything the missed call would, so the missed call stands down once one is known.
  if (ctx.event.eventType === 'call.missed' && call.is_voicemail) return;

  const [conv] = await rows<{ id: string; channel: string; assignee_user_id: string | null }>(
    ctx.tx,
    sql`select id, channel::text as channel, assignee_user_id from app.conversations
        where id = ${call.conversation_id} and workspace_id = ${ws}`,
  );
  if (!conv) return;
  const assignee = conv.assignee_user_id
    ? await stillHere(ctx.tx, ws, [conv.assignee_user_id])
    : [];
  const userIds = assignee.length ? assignee : await managerIds(ctx.tx, ws);
  const actor = personActor(ctx);
  if ((await pushAudience(ctx.tx, 'missed_call', userIds, actor)).length === 0) return;

  const voicemail = call.is_voicemail;
  const customer = (await personName(ctx.tx, call.person_id)) ?? formatPhone(call.from_e164);
  await queuePush(ctx.tx, scope, {
    key: `${voicemail ? 'voicemail' : 'missed-call'}:${ctx.event.id}`,
    category: voicemail ? 'voicemail' : 'missed_call',
    userIds,
    exceptUserId: actor,
    title: customer,
    about: voicemail ? 'Voicemail' : 'Missed call',
    body: voicemail
      ? call.transcript
        ? quoted(call.transcript)
        : `Left a voicemail · ${callClock(call.recording_seconds)}`
      : 'Called, and nobody picked up.',
    path: `/app/w/${ws}/inbox/${conv.id}`,
    refs: {
      conversationId: conv.id,
      channel: conv.channel as PushRefs['channel'],
      ...(call.person_id ? { personId: call.person_id } : {}),
    },
    collapseId: conversationCollapseId(conv.id),
  });
});

// ---------- wiring ----------

/** Event type → the push it may bring. */
const PUSH_HANDLERS: Readonly<Record<string, EventHandler>> = {
  'message.received': onCustomerMessagePush,
  'call.missed': onMissedCallPush,
  'call.voicemail_left': onMissedCallPush,
  'workflow.approval_requested': onApprovalPush,
  'ai_teammate.drafted': onDraftPush,
  'appointment.booked': onAppointmentPush,
  'attendee.added': onAppointmentPush,
  'appointment.rescheduled': onAppointmentPush,
  'attendee.rescheduled': onAppointmentPush,
  'appointment.cancelled': onAppointmentPush,
  'attendee.cancelled': onAppointmentPush,
  'attendee.removed': onAppointmentPush,
  'appointment.reassigned': onAppointmentPush,
  'lead.assigned': onAssignedPush,
  'conversation.assigned': onAssignedPush,
  'task.created': onAssignedPush,
  'task.updated': onAssignedPush,
  'attention.assigned': onAssignedPush,
  'invoice.paid': onPaidPush,
  'wallet.empty': onWalletPush,
  'wallet.suspended': onWalletPush,
};

/** Appends each event's push after everything else it does (handlers/index.ts). */
export function withPush(handlers: HandlerMap): HandlerMap {
  const out: Record<string, EventHandler | readonly EventHandler[]> = { ...handlers };
  for (const [type, handler] of Object.entries(PUSH_HANDLERS))
    out[type] = [...handlersFor(handlers, type), handler];
  return out;
}
