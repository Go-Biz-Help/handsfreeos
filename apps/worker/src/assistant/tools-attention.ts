/**
 * The Assistant's Action Center tools (M8). "What needs my attention?" reads attention.list, the query Home reads,
 * so the two always show the same items in the same order, with each item's ids and the tool its own button is. Handling
 * an item (what Let HandsFreeOS Handle does on Home) and assigning one wait for the person's OK on a card, and so do
 * snoozing and dismissing one when that stops a message HandsFreeOS is about to send; Confirm then runs the Action
 * Center's own command as the person, marked as done through the Assistant, so its rules, events and audit apply.
 * Snoozing and dismissing otherwise happen at once, as on Home (risk 0, and do_attention_restore puts one back).
 */
import {
  addonAlertAcknowledge,
  ATTENTION_KIND_LABELS,
  attentionTargetOf,
  handledByHandsFree,
  handledLineOf,
  HfosError,
  isDraftItem,
  leadCatchUp,
  lessonKnowsOtherwise,
  referralCreateLead,
  screenActionName,
  teammateLessonApply,
  walletTopUp,
  type AssistantCard,
  type AttentionKind,
  type AttentionListOutput,
  type AttentionPreviewHandleOutput,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { z } from 'zod';
import { atLabel, clockLabel, firstName } from './calendar-format';
import type { CommittedAction, PreparedAction, ToolContext, ToolOutcome } from './runtime';
import { command, money, paths, query, quoted } from './tools-read';

type Args = Record<string, unknown>;
type Item = AttentionListOutput['items'][number];
type Preview = z.infer<typeof AttentionPreviewHandleOutput>;
type AutoPlan = NonNullable<Preview['auto']>;
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
type CardItem = Extract<AssistantCard, { type: 'attention' }>['items'][number];
type Warning = { kind: string; text: string };

/** The most items the answer's card shows (and the model reads). */
const TOP = 8;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const SNOOZE_MAX_DAYS = 30;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Home, and one item on it. */
const home = (ws: string) => ({
  page: () => `/app/w/${ws}`,
  item: (id: string) => `/app/w/${ws}?item=${id}`,
});

/** A row's kind in Home's words ("Gone quiet", "Not confirmed"). */
const KIND_WORD: Readonly<Record<AttentionKind, string>> = {
  hot_lead: 'Hot lead',
  unanswered_lead: 'Unanswered lead',
  stale_opportunity: 'Gone quiet',
  missing_next_action: 'No next action',
  unconfirmed_appointment: 'Not confirmed',
  ai_approval: 'Approval',
  customer_waiting: 'Customer waiting',
  overdue_task: 'Overdue task',
  estimate_waiting: 'Estimate waiting',
  invoice_overdue: 'Invoice overdue',
  wallet_low: 'Balance running low',
  wallet_empty: 'Balance empty',
  wallet_card_declined: 'Card declined',
  job_not_thanked: 'Say thanks',
  referral_mentioned: 'Referral',
  maintenance_due: 'Maintenance due',
  pipeline_mismatch: 'Wrong stage',
  quiet_after_price: 'Quiet after a price',
  job_unconfirmed: 'Did it happen?',
  job_never_completed: 'Never marked done',
  job_no_address: 'No address',
  client_quiet: 'Gone quiet',
  promise_due: 'Promise due',
  revenue_moved: 'Money in changed',
  channel_quiet: 'Channel quiet',
  connection_error: 'Connection broken',
  connection_silent: 'Connection silent',
  ai_unreviewed: 'AI not reviewed',
  ai_corrections: 'Something to teach the AI',
  website_changed: 'Website changed',
  faq_suggestions: 'Question to answer',
  offer_lapsing: 'Promotion ending',
  texting_rejected: 'Texting turned down',
  addon_alert: 'Add-on alert',
  webinar_hot: 'Hot after a webinar',
};

/** Chips that tell time: a row shows the first one on its right. */
const TIME_CHIPS: ReadonlySet<string> = new Set([
  'waiting',
  'not_contacted',
  'last_contact',
  'no_contact',
  'follow_up_overdue',
  'overdue',
  'starts_in',
  'expires_in',
  'due_in',
  'job_done',
]);

/** Kinds whose detail is someone else's words (the customer's message, an AI draft): read as data. */
const QUOTED_DETAIL: ReadonlySet<AttentionKind> = new Set([
  'hot_lead',
  'customer_waiting',
  'ai_approval',
  // The carriers' own reason for turning texting down.
  'texting_rejected',
  // An add-on's own words.
  'addon_alert',
]);

const CHANNEL_WORD = {
  sms: 'Texts',
  email: 'Email',
  chat: 'Website chat',
  portal: 'Client portal',
  messenger: 'Messenger',
  instagram: 'Instagram',
} as const;

/** "Maria Lopez" from "Maria Lopez · AC install" (a task's title is its own). */
const headOf = (item: Pick<Item, 'title'>) => item.title.split(' · ')[0] ?? item.title;

const toneOf = (i: Item): CardItem['tone'] =>
  i.urgent || i.kind === 'hot_lead'
    ? 'danger'
    : i.kind === 'unanswered_lead' ||
        i.kind === 'unconfirmed_appointment' ||
        i.kind === 'ai_approval'
      ? 'accent'
      : 'warning';

/** One row of the card: the title, "Hot lead · $18,500 · ready to book", and up to three chips. */
function cardItem(ws: string, i: Item): CardItem {
  const time = i.reasons.find((r) => TIME_CHIPS.has(r.code));
  const value = !i.valueIsEstimate && i.valueCents > 0;
  const signs = i.reasons
    .filter((r) => r.code !== 'value' && !TIME_CHIPS.has(r.code))
    .filter((r) => !(i.kind === 'missing_next_action' && r.code === 'no_next_action'))
    .map((r) => r.text);
  const chips = [...(time ? [time] : []), ...i.reasons.filter((r) => r !== time)].slice(0, 3);
  return {
    title: i.title,
    detail: [KIND_WORD[i.kind], ...(value ? [money(i.valueCents)] : []), ...signs.slice(0, 2)].join(
      ' · ',
    ),
    tone: toneOf(i),
    waitingSince: i.reasons.find((r) => r.code === 'waiting')?.since ?? null,
    href: home(ws).item(i.id),
    itemId: i.id,
    kind: i.kind,
    chips: chips.map((c) => ({ code: c.code, text: c.text })),
    ...(value ? { valueCents: i.valueCents } : {}),
  };
}

/**
 * The tool that does what an item's own button on Home does (Create lead, Move deal, Add to its instructions, Mark
 * done, Approve, Top up…), with the ids it takes from the item, when it isn't handle_attention_item (Let HandsFreeOS
 * Handle). Screen commands go by their command's name, as their tools are named. Null when the button opens a
 * conversation or a page, or calls.
 */
export function buttonToolOf(i: Item): ({ readonly tool: string } & Args) | null {
  // A card carrying a customer's wait answers it first, whatever its kind (handleButtonOf words it Reply).
  if (i.conversationId && i.reasons.some((r) => r.code === 'waiting')) return null;
  const id = i.subject.id;
  switch (i.kind) {
    case 'referral_mentioned':
      return { tool: screenActionName(referralCreateLead.name), referralId: id };
    case 'pipeline_mismatch':
      return { tool: screenActionName(leadCatchUp.name), leadId: id };
    case 'ai_corrections':
      // "Use the new one" when what the AI knows says otherwise: the new words take the old ones' place.
      return {
        tool: screenActionName(teammateLessonApply.name),
        lessonId: id,
        ...(lessonKnowsOtherwise(i) ? { replace: true } : {}),
      };
    case 'job_unconfirmed':
    case 'job_never_completed':
      return { tool: 'update_appointment', appointmentId: id, outcome: 'done' };
    case 'job_no_address':
      return i.personId ? { tool: 'update_customer', personId: i.personId } : null;
    case 'ai_approval':
      return isDraftItem(i)
        ? { tool: 'decide_teammate_draft', draftId: id, decision: 'approve' }
        : { tool: 'answer_workflow_approval', approvalId: id, decision: 'approve' };
    case 'wallet_low':
    case 'wallet_empty':
      return { tool: screenActionName(walletTopUp.name) };
    case 'addon_alert':
      return i.addonAlert?.needsAck && !i.addonAlert.acknowledgedAt
        ? { tool: screenActionName(addonAlertAcknowledge.name), alertId: i.addonAlert.alertId }
        : null;
    default:
      return null;
  }
}

/** The page an item opens, as its ⋯ menu's Open does: a whole link once the web app's address is known. */
const opensOf = (i: Item, ws: string, webUrl: string) => {
  const t = attentionTargetOf(i, ws);
  return { label: t.label, link: `${webUrl}${t.href}` };
};

/** One item as the model reads it, with what it is about and the ids its buttons take. */
const itemResult = (i: Item, rank: number, ctx: ToolContext, webUrl: string) => {
  const press = buttonToolOf(i);
  return {
    rank,
    id: i.id,
    kind: i.kind,
    what: ATTENTION_KIND_LABELS[i.kind],
    title: i.title,
    chips: i.reasons.map((r) => r.text),
    value: i.valueIsEstimate ? null : money(i.valueCents),
    urgent: i.urgent,
    ...(i.detail
      ? {
          detail: QUOTED_DETAIL.has(i.kind)
            ? i.kind === 'ai_approval'
              ? { draft: i.detail }
              : quoted(i.detail)
            : i.detail,
        }
      : {}),
    subject: { type: i.subject.type, id: i.subject.id },
    ...(i.personId ? { personId: i.personId } : {}),
    ...(i.leadId ? { leadId: i.leadId } : {}),
    ...(i.conversationId ? { conversationId: i.conversationId } : {}),
    ...(i.appointmentId ? { appointmentId: i.appointmentId } : {}),
    ...(i.addonAlert
      ? {
          addonAlert: {
            alertId: i.addonAlert.alertId,
            addon: i.addonAlert.addonName,
            severity: i.addonAlert.severity,
            waitsForSomeoneToSeeIt: i.addonAlert.needsAck && !i.addonAlert.acknowledgedAt,
          },
        }
      : {}),
    assignee: i.assignee?.fullName ?? null,
    button: i.handleLabel,
    ...(press ? { buttonTool: press } : {}),
    opens: opensOf(i, ctx.workspaceId, webUrl),
    canHandle: i.actions.letHandle,
    ...(i.auto.state === 'scheduled' && i.auto.scheduledFor
      ? { handsFreeOsSendsAt: atLabel(Date.parse(i.auto.scheduledFor), ctx.timezone) }
      : {}),
  };
};

/** "Asked Maria Lopez to confirm the AC install", from core's words with the customer in bold. */
const handledWords = (i: Item, myUserId: string) => {
  const { text, sub } = handledLineOf(i, myUserId);
  return {
    what: text.map((p) => (typeof p === 'string' ? p : p.strong)).join(''),
    ...(sub ? { how: sub } : {}),
  };
};

/** The list as Home reads it: attention.list, as the person, in the scope they asked for (or their usual one). */
const listFor = (db: Db, ctx: ToolContext, input: Record<string, unknown>) =>
  query<AttentionListOutput>(db, ctx, 'attention.list', input);

/** A whole number from the model, kept between `min` and `max`; `fallback` when it isn't one. */
const whole = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(max, Math.max(min, n));
};

/** The most of today's handled list read at once (Home shows 6, then Show more). */
const HANDLED_MOST = 20;

// ---------- what needs attention (on its own) ----------

export const attentionAutoTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args, webUrl?: string) => Promise<ToolOutcome>
> = {
  async what_needs_attention(db, ctx, args, webUrl = '') {
    const list = await listFor(db, ctx, {
      ...(str(args['scope']) ? { scope: args['scope'] } : {}),
      ...(str(args['kind']) ? { kinds: [args['kind']] } : {}),
      includeHandled: true,
    });
    const offset = whole(args['offset'], 0, 0, list.items.length);
    const limit = whole(args['limit'], TOP, 1, 50);
    const page = list.items.slice(offset, offset + limit);
    const shown = page.slice(0, TOP);
    const after = list.items.length - offset - page.length;
    // Newest first: Home's Handled by HandsFreeOS is the ones HandsFreeOS did; with nothing open, all of them show.
    const done = list.handled;
    return {
      result: {
        scope: list.scope,
        affected: money(list.affectedCents),
        affectedCents: list.affectedCents,
        counts: list.counts,
        handledToday: list.handledToday,
        items: page.map((i, n) => itemResult(i, offset + n + 1, ctx, webUrl)),
        ...(after > 0 ? { more: after, nextOffset: offset + page.length } : {}),
        // Home's other two parts, read once, with the first page.
        ...(offset === 0
          ? {
              handled: done.slice(0, HANDLED_MOST).map((i) => ({
                title: i.title,
                ...handledWords(i, ctx.actor.userId),
                ...(handledByHandsFree(i) ? { byHandsFree: true } : {}),
                ...(i.handled ? { at: atLabel(Date.parse(i.handled.at), ctx.timezone) } : {}),
                opens: opensOf(i, ctx.workspaceId, webUrl),
              })),
              ...(done.length > HANDLED_MOST
                ? { handledNotListed: done.length - HANDLED_MOST }
                : {}),
              comingUp: list.scheduled.map((s) => ({
                itemId: s.itemId,
                title: s.title,
                sends: s.action === 'confirm_request' ? 'confirmation request' : 'follow-up',
                goesAt: atLabel(Date.parse(s.scheduledFor), ctx.timezone),
              })),
            }
          : {}),
      },
      card: shown.length
        ? {
            type: 'attention',
            affected: {
              cents: list.affectedCents,
              total: list.counts.total,
              urgent: list.counts.urgent,
              scope: list.scope,
            },
            items: shown.map((i) => cardItem(ctx.workspaceId, i)),
          }
        : null,
    };
  },

  /**
   * Home's Snooze and Dismiss…, at once (risk 0, as they are on Home, where Undo takes them back). One that would stop
   * a message HandsFreeOS is about to send asks first instead, through update_attention_item.
   */
  async set_aside_attention_item(db, ctx, args) {
    const item = await openItem(db, ctx, String(args['itemId']));
    const action = args['action'] === 'dismiss' ? 'dismiss' : 'snooze';
    if (!item.actions[action])
      throw HfosError.forbidden(
        `Your role can’t ${action} this one. An owner or admin can.`,
        'attention_not_yours',
      );
    if (item.auto.state === 'scheduled' && item.auto.scheduledFor)
      throw HfosError.rule(
        'attention_stops_auto',
        409,
        `HandsFreeOS is sending its ${item.auto.action === 'confirm_request' ? 'confirmation request' : 'follow-up'} for this one ${atLabel(Date.parse(item.auto.scheduledFor), ctx.timezone)}, and this would stop it. Use update_attention_item, which shows the person a card first.`,
      );
    const ws = ctx.workspaceId;
    if (action === 'snooze') {
      const until = snoozeUntil(args);
      const out = await command<{ changed: boolean }>(db, ctx, 'attention.snooze', {
        itemId: item.id,
        until: new Date(until).toISOString(),
      });
      const when = atLabel(until, ctx.timezone);
      return {
        result: out.changed
          ? { item: item.title, snoozedUntil: when, putBackWith: 'do_attention_restore' }
          : { item: item.title, unchanged: 'It was already set aside like that.' },
        command: 'attention.snooze',
        record: { itemId: item.id, outcome: `Snoozed until ${when}`, href: home(ws).page() },
      };
    }
    const reason = str(args['reason']) ?? null;
    const out = await command<{ changed: boolean }>(db, ctx, 'attention.dismiss', {
      itemId: item.id,
      reason,
    });
    return {
      result: out.changed
        ? {
            item: item.title,
            dismissed: 'It comes back only if something changes.',
            ...(reason ? { reason } : {}),
            putBackWith: 'do_attention_restore',
          }
        : { item: item.title, unchanged: 'It was already dismissed.' },
      command: 'attention.dismiss',
      record: { itemId: item.id, outcome: 'Dismissed', href: home(ws).page() },
    };
  },
};

// ---------- handling, snoozing, dismissing and assigning (on Confirm) ----------

/** The item as this person sees it on Home now, or why it isn't there. */
async function openItem(db: Db, ctx: ToolContext, itemId: string): Promise<Item> {
  const list = await listFor(db, ctx, { scope: 'everyone', includeHandled: true });
  const item = list.items.find((i) => i.id === itemId);
  if (item) return item;
  if (list.handled.some((i) => i.id === itemId))
    throw HfosError.rule('attention_not_open', 409, 'That one was already handled today.');
  throw HfosError.notFound(
    'That isn’t on the Action Center list anymore. It may be snoozed, dismissed or done.',
  );
}

function confirmCard(
  toolCallId: string,
  tool: string,
  item: Item,
  card: Pick<ConfirmCard, 'title' | 'fields' | 'body' | 'warnings' | 'confirmLabel'>,
): ConfirmCard {
  return {
    type: 'confirm',
    toolCallId,
    tool,
    personId: item.personId,
    conversationId: item.conversationId,
    stageFrom: null,
    stageTo: null,
    reasons: [],
    editable: false,
    ...card,
  };
}

/** Where a reply to an item goes. */
type Reach = 'sms' | 'email' | 'chat' | 'portal' | 'messenger' | 'instagram';

/** What handling this item would do right now, worked out from attention.preview_handle. */
type HandlePlan =
  | { readonly kind: 'blocked'; readonly why: string; readonly warning: string }
  | { readonly kind: 'auto'; readonly plan: AutoPlan }
  | {
      readonly kind: 'hand_to_ai';
      readonly teammate: string;
      readonly label: string;
      readonly channel: Reach | null;
      readonly conversationId: string | null;
    }
  | {
      readonly kind: 'reply';
      readonly channel: Reach;
      readonly body: string;
      readonly subject: string | null;
      readonly to: string | null;
      readonly quiet: string | null;
    }
  | { readonly kind: 'set_next_action'; readonly text: string; readonly dueAt: string | null };

const blockedPlan = (why: string, warning = 'blocked'): HandlePlan => ({
  kind: 'blocked',
  why,
  warning,
});

async function handlePlan(
  db: Db,
  ctx: ToolContext,
  item: Item,
  preview: Preview,
  args: Args,
): Promise<HandlePlan> {
  if (preview.mode === 'none')
    return blockedPlan(
      item.kind === 'ai_approval'
        ? 'Approvals always wait for a person to decide. I can approve or reject it for you instead.'
        : item.kind === 'overdue_task'
          ? // Its button opens the task; ticking it off on Home's Today card is complete_task.
            'HandsFreeOS can’t do your tasks. I can mark this one done for you instead.'
          : // Its own button does it (Top up, Create lead, Mark done…), and so can the Assistant, on the person's word.
            buttonToolOf(item)
            ? `HandsFreeOS doesn’t take care of this kind on its own. I can do what its ${item.handleLabel} button on Home does instead.`
            : (preview.reason ??
              'HandsFreeOS can’t take care of this kind of item for you. Open it on Home to deal with it yourself.'),
    );
  if (!item.actions.letHandle)
    return blockedPlan('Your role can’t hand this one off. An owner or admin can.');

  if (preview.mode === 'auto') {
    if (str(args['action']) || str(args['body']) || str(args['nextAction']))
      throw HfosError.validation(
        [],
        'HandsFreeOS sends its own message for this one. Leave out action, body and nextAction, or write your own text with send_text.',
      );
    if (item.auto.state === 'scheduled' && item.auto.scheduledFor)
      return blockedPlan(
        `HandsFreeOS is already sending it ${atLabel(Date.parse(item.auto.scheduledFor), ctx.timezone)}. You can cancel it on Home.`,
        'scheduled',
      );
    const plan = preview.auto;
    if (!plan)
      return blockedPlan(
        'HandsFreeOS can’t take care of this kind of item for you. Open it on Home to deal with it yourself.',
      );
    if (plan.blocked) return blockedPlan(plan.blocked.message);
    return { kind: 'auto', plan };
  }

  const option = (a: string) => preview.options.find((o) => o.action === a);
  const asked =
    str(args['action']) ??
    (str(args['body']) ? 'reply' : str(args['nextAction']) ? 'set_next_action' : undefined);
  const action =
    asked ??
    (option('set_next_action')
      ? 'set_next_action'
      : option('hand_to_ai')?.available
        ? 'hand_to_ai'
        : 'reply');
  const chosen = option(action);
  if (!chosen)
    throw HfosError.validation(
      [{ path: 'action', message: 'That isn’t one of the ways to handle this one.' }],
      `This one can’t be handled with ${action}. Use one of these for action instead: ${preview.options.map((o) => o.action).join(', ')}.`,
    );
  if (!chosen.available)
    return blockedPlan(
      chosen.reason ??
        'That way of handling it isn’t open for this one right now. Try another way, or open it on Home.',
    );

  switch (chosen.action) {
    case 'hand_to_ai':
      return {
        kind: 'hand_to_ai',
        teammate: chosen.label.replace(/^Hand to /, ''),
        label: chosen.label,
        channel: chosen.channel,
        conversationId: chosen.conversationId,
      };
    case 'reply': {
      // A money card comes with its follow-up already written from the document's own figures, so the
      // Assistant offers that unless the person dictates their own words.
      const body = str(args['body']) ?? chosen.draft?.body ?? null;
      const handWhy = option('hand_to_ai')?.reason;
      if (!body)
        throw HfosError.validation(
          [{ path: 'body', message: 'Write the reply in body.' }],
          `${handWhy ? `${handWhy} ` : ''}Write the reply in body; the card shows it before it goes.`,
        );
      const channel = chosen.channel ?? 'sms';
      const subject = str(args['subject']) ?? chosen.draft?.subject ?? null;
      if (channel === 'email' && !subject)
        throw HfosError.validation(
          [{ path: 'subject', message: 'Give the email a subject.' }],
          'This reply goes by email, so it needs a subject. Put one in subject.',
        );
      const [person, setup] = await Promise.all([
        item.personId
          ? query<{ person: { phone: string | null; email: string | null } }>(
              db,
              ctx,
              'person.get',
              { personId: item.personId },
            ).catch(() => null)
          : Promise.resolve(null),
        channel === 'sms'
          ? query<{ quiet: { quiet: boolean; localTime: string } }>(
              db,
              ctx,
              'phone.setup_status',
            ).catch(() => null)
          : Promise.resolve(null),
      ]);
      return {
        kind: 'reply',
        channel,
        body,
        subject,
        // Messenger and Instagram answer in the thread they wrote in; there's no address to show.
        to:
          channel === 'sms'
            ? (person?.person.phone ?? null)
            : channel === 'email'
              ? (person?.person.email ?? null)
              : null,
        quiet: setup?.quiet.quiet ? setup.quiet.localTime : null,
      };
    }
    case 'set_next_action': {
      const text = str(args['nextAction']) ?? chosen.suggestion?.text;
      if (!text)
        throw HfosError.validation(
          [{ path: 'nextAction', message: 'Say what to do next.' }],
          'There’s no suggested next action for this one. Say what to do next in nextAction.',
        );
      const dueAt =
        str(args['dueAt']) ?? (str(args['nextAction']) ? null : (chosen.suggestion?.dueAt ?? null));
      return { kind: 'set_next_action', text, dueAt };
    }
  }
}

async function planFor(db: Db, ctx: ToolContext, args: Args) {
  const itemId = String(args['itemId']);
  const item = await openItem(db, ctx, itemId);
  const preview = await query<Preview>(db, ctx, 'attention.preview_handle', { itemId });
  return { item, plan: await handlePlan(db, ctx, item, preview, args) };
}

const autoWords = (plan: AutoPlan) =>
  plan.action === 'confirm_request' ? 'confirmation request' : 'follow-up';

interface AttentionConfirmTool {
  prepare(db: Db, ctx: ToolContext, args: Args, toolCallId: string): Promise<PreparedAction>;
  commit(
    db: Db,
    ctx: ToolContext,
    args: Args,
    extra: { readonly toolCallId: string },
  ): Promise<CommittedAction>;
}

const handleItem: AttentionConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { item, plan } = await planFor(db, ctx, args);
    const name = headOf(item);
    const first = firstName(name);
    const card = (
      c: Pick<ConfirmCard, 'title' | 'fields' | 'body' | 'warnings' | 'confirmLabel'>,
    ) => confirmCard(toolCallId, 'handle_attention_item', item, c);
    switch (plan.kind) {
      case 'blocked':
        return {
          card: card({
            title: `${ATTENTION_KIND_LABELS[item.kind]}: ${item.title}`,
            fields: [],
            body: null,
            warnings: [{ kind: plan.warning, text: plan.why }],
            confirmLabel: '',
          }),
          result: {
            item: item.title,
            cannotHandle: plan.why,
            // What its own button does, for the model to offer instead.
            ...(buttonToolOf(item)
              ? { button: item.handleLabel, buttonTool: buttonToolOf(item) }
              : item.kind === 'overdue_task'
                ? { doneWith: { tool: 'complete_task', taskId: item.subject.id } }
                : {}),
          },
        };
      case 'auto': {
        const p = plan.plan;
        const sendAt = p.sendAt ? Date.parse(p.sendAt) : Date.now();
        const warnings: Warning[] = p.notes.map((n) => ({
          kind: /quiet hours/i.test(n) ? 'quiet_hours' : 'note',
          text: n,
        }));
        return {
          card: card({
            title:
              p.action === 'confirm_request'
                ? `Ask ${first} to confirm?`
                : `Follow up with ${first}?`,
            fields: [
              { label: 'To', value: [name, p.to].filter(Boolean).join(' · ') },
              { label: 'By', value: p.channel === 'email' ? 'Email' : 'Text' },
              ...(p.subject ? [{ label: 'Subject', value: p.subject }] : []),
              {
                label: 'Goes',
                value: `${atLabel(sendAt, ctx.timezone)}, unless you cancel it on Home first`,
              },
            ],
            body: p.text,
            warnings: warnings.slice(0, 3),
            confirmLabel: `Send at ${clockLabel(sendAt, ctx.timezone)}`,
          }),
          result: {
            item: item.title,
            sends: autoWords(p),
            channel: p.channel,
            to: name,
            goesAt: atLabel(sendAt, ctx.timezone),
          },
        };
      }
      case 'hand_to_ai':
        return {
          card: card({
            title: `Hand ${name} to ${plan.teammate}?`,
            fields: [
              ...(plan.channel
                ? [{ label: 'Chat', value: `${CHANNEL_WORD[plan.channel]} with ${name}` }]
                : []),
              {
                label: 'Then',
                value: `${plan.teammate} answers ${first} from now on, and hands them back to the team if they need a person`,
              },
            ],
            body: null,
            warnings: [],
            confirmLabel: plan.label,
          }),
          result: { item: item.title, handTo: plan.teammate },
        };
      case 'reply':
        return {
          card: card({
            title:
              plan.channel === 'email'
                ? `Email ${first}?`
                : plan.channel === 'chat'
                  ? `Reply to ${first} in the chat?`
                  : plan.channel === 'portal'
                    ? `Reply to ${first} in their portal?`
                    : plan.channel === 'messenger' || plan.channel === 'instagram'
                      ? `Reply to ${first} on ${CHANNEL_WORD[plan.channel]}?`
                      : `Send this text to ${first}?`,
            fields: [
              { label: 'To', value: [name, plan.to].filter(Boolean).join(' · ') },
              ...(plan.subject ? [{ label: 'Subject', value: plan.subject }] : []),
            ],
            body: plan.body,
            warnings: plan.quiet
              ? [
                  {
                    kind: 'quiet_hours',
                    text: `It’s ${plan.quiet} for the business, inside quiet hours. Sending now is up to you.`,
                  },
                ]
              : [],
            confirmLabel:
              plan.channel === 'email'
                ? 'Send email'
                : plan.channel !== 'sms'
                  ? 'Send reply'
                  : plan.quiet
                    ? 'Send anyway'
                    : 'Send text',
          }),
          result: {
            item: item.title,
            to: name,
            channel: plan.channel,
            ...(plan.quiet ? { quietHours: true } : {}),
          },
        };
      case 'set_next_action': {
        const due = plan.dueAt ? atLabel(Date.parse(plan.dueAt), ctx.timezone) : 'No due date';
        return {
          card: card({
            title: `Set a next action for ${name}?`,
            fields: [
              { label: 'Lead', value: item.title },
              { label: 'Next', value: plan.text },
              { label: 'Due', value: due },
            ],
            body: null,
            warnings: [],
            confirmLabel: 'Set next action',
          }),
          result: { item: item.title, nextAction: plan.text, due },
        };
      }
    }
  },

  async commit(db, ctx, args) {
    const { item, plan } = await planFor(db, ctx, args);
    const name = headOf(item);
    const ws = ctx.workspaceId;
    const letHandle = (input: Record<string, unknown>) =>
      command<{
        status: 'requested' | 'already_scheduled' | 'done';
        scheduledFor: string | null;
        conversationId: string | null;
      }>(db, ctx, 'attention.let_handle', { itemId: item.id, ...input });
    switch (plan.kind) {
      case 'blocked':
        throw HfosError.rule('attention_cannot_handle', 409, plan.why);
      case 'auto': {
        const out = await letHandle({});
        const at = out.scheduledFor ?? plan.plan.sendAt;
        const clock = at ? clockLabel(Date.parse(at), ctx.timezone) : null;
        const what =
          plan.plan.action === 'confirm_request'
            ? `HandsFreeOS asks ${firstName(name)} to confirm`
            : `HandsFreeOS follows up with ${firstName(name)}`;
        return {
          outcome:
            out.status === 'already_scheduled'
              ? `It was already set to go${clock ? ` at ${clock}` : ''}.`
              : `${what}${clock ? ` at ${clock}` : ''}. You can cancel it on Home until then.`,
          href: home(ws).item(item.id),
          command: 'attention.let_handle',
        };
      }
      case 'hand_to_ai': {
        const out = await letHandle({ action: 'hand_to_ai' });
        const conversationId = out.conversationId ?? plan.conversationId;
        return {
          outcome: `Handed ${name} to ${plan.teammate}.`,
          href: conversationId ? paths(ws).conversation(conversationId) : home(ws).page(),
          command: 'attention.let_handle',
        };
      }
      case 'reply': {
        const out = await letHandle({
          action: 'reply',
          body: plan.body,
          channel: plan.channel,
          ...(plan.subject ? { subject: plan.subject } : {}),
          acknowledgeQuietHours: true,
        });
        return {
          outcome: `Sent to ${name}`,
          href: out.conversationId ? paths(ws).conversation(out.conversationId) : home(ws).page(),
          command: 'attention.let_handle',
        };
      }
      case 'set_next_action': {
        await letHandle({ action: 'set_next_action', text: plan.text, dueAt: plan.dueAt });
        const due = plan.dueAt ? `, ${atLabel(Date.parse(plan.dueAt), ctx.timezone)}` : '';
        return {
          outcome: `Next action set: ${plan.text}${due}.`,
          href: item.leadId ? paths(ws).lead(item.leadId) : home(ws).page(),
          command: 'attention.let_handle',
        };
      }
    }
  },
};

interface Members {
  members: { userId: string; fullName: string; email: string }[];
  organizationAdmins: { userId: string; fullName: string; email: string }[];
}
async function teammateName(db: Db, ctx: ToolContext, userId: string): Promise<string | null> {
  const team = await query<Members>(db, ctx, 'workspace.members');
  const m = [...team.members, ...team.organizationAdmins].find((x) => x.userId === userId);
  return m ? m.fullName || m.email : null;
}

/** What assigning an item changes besides the item. */
const ASSIGN_CHANGES: Readonly<Record<AttentionKind, string>> = {
  hot_lead: 'Who owns the lead, too',
  unanswered_lead: 'Who owns the lead, too',
  stale_opportunity: 'Who owns the lead, too',
  missing_next_action: 'Who owns the lead, too',
  customer_waiting: 'Who has the conversation, too',
  overdue_task: 'Who the task is for, too',
  unconfirmed_appointment: 'Only who follows up on it. The appointment stays as it is.',
  ai_approval: 'Only who follows up on it. Who may decide it stays the same.',
  estimate_waiting: 'Only who follows up on it. The estimate stays as it is.',
  invoice_overdue: 'Only who follows up on it. The invoice stays as it is.',
  // Never assignable, so this never shows; the shape asks for a line all the same.
  wallet_low: 'A balance belongs to the business, not to a person.',
  wallet_empty: 'A balance belongs to the business, not to a person.',
  wallet_card_declined: 'A card belongs to the business, not to a person.',
  job_not_thanked: 'Only who thanks them. The job stays as it is.',
  referral_mentioned: 'Only who reaches out. Nothing else changes.',
  maintenance_due: 'Only who calls them. Nothing else changes.',
  pipeline_mismatch: 'Only who moves it. The deal stays as it is.',
  quiet_after_price: 'Who owns the lead, too',
  job_unconfirmed: 'Only who follows up on it. The appointment stays as it is.',
  job_never_completed: 'Only who follows up on it. The appointment stays as it is.',
  job_no_address: 'Only who follows up on it. The appointment stays as it is.',
  client_quiet: 'Only who checks in with them. Nothing else changes.',
  promise_due: 'Only who follows through. Nothing else changes.',
  revenue_moved: 'A week of money belongs to the business, not to a person.',
  channel_quiet: 'A channel belongs to the business, not to a person.',
  connection_error: 'A connection is fixed by whoever it belongs to.',
  connection_silent: 'A connection is fixed by whoever it belongs to.',
  ai_unreviewed: 'Only who reviews the AI’s work. Nothing else changes.',
  ai_corrections: 'What the AI learns belongs to the business, not to a person.',
  website_changed: 'Only who reviews the updates. Nothing else changes.',
  faq_suggestions: 'Only who answers the question. Nothing else changes.',
  offer_lapsing: 'Only who looks after the promotion. Nothing else changes.',
  texting_rejected: 'The business’s texting is set up by its owners and admins.',
  addon_alert: 'The add-on that raised it decides who it’s for.',
  webinar_hot: 'Only who reaches out. Nothing else changes.',
};

type UpdateAction = 'snooze' | 'dismiss' | 'assign';
const actionOf = (v: unknown): UpdateAction => (v === 'dismiss' || v === 'assign' ? v : 'snooze');

/** When a snooze ends, checked the way attention.snooze checks it. */
function snoozeUntil(args: Args): number {
  const until = str(args['until']);
  if (!until)
    throw HfosError.validation(
      [{ path: 'until', message: 'Say until when.' }],
      'Say when it should come back: give until, a date and time.',
    );
  const at = Date.parse(until);
  if (!Number.isFinite(at) || at < Date.now() + MIN)
    throw HfosError.validation(
      [{ path: 'until', message: 'Pick a time in the future.' }],
      'That snooze time has already passed. Pick a later time.',
    );
  if (at > Date.now() + SNOOZE_MAX_DAYS * DAY)
    throw HfosError.validation(
      [{ path: 'until', message: `Snooze for ${SNOOZE_MAX_DAYS} days at most.` }],
      `That’s more than ${SNOOZE_MAX_DAYS} days away. Snooze it for ${SNOOZE_MAX_DAYS} days at most, or dismiss it instead.`,
    );
  return at;
}

const updateItem: AttentionConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const item = await openItem(db, ctx, String(args['itemId']));
    const action = actionOf(args['action']);
    const name = headOf(item);
    const what = { label: 'Item', value: `${KIND_WORD[item.kind]} · ${item.title}` };
    const warnings: Warning[] = [];
    if (!item.actions[action])
      warnings.push({
        kind: 'blocked',
        text:
          action === 'assign'
            ? 'Your role can’t assign this one. An owner or admin can.'
            : `Your role can’t ${action} this one. An owner or admin can.`,
      });
    else if (action !== 'assign' && item.auto.state === 'scheduled' && item.auto.scheduledFor)
      warnings.push({
        kind: 'stops_auto',
        text: `It also stops the ${item.auto.action === 'confirm_request' ? 'confirmation request' : 'follow-up'} HandsFreeOS was sending ${atLabel(Date.parse(item.auto.scheduledFor), ctx.timezone)}.`,
      });
    const blocked = warnings.some((w) => w.kind === 'blocked');
    const card = (c: Pick<ConfirmCard, 'title' | 'fields' | 'confirmLabel'>) =>
      confirmCard(toolCallId, 'update_attention_item', item, {
        ...c,
        body: null,
        warnings,
        confirmLabel: blocked ? '' : c.confirmLabel,
      });
    const cannot = blocked ? { cannot: warnings[0]!.text } : {};

    switch (action) {
      case 'snooze': {
        const until = atLabel(snoozeUntil(args), ctx.timezone);
        return {
          card: card({
            title: `Snooze ${name} until ${until}?`,
            fields: [
              what,
              { label: 'Comes back', value: `${until}, or sooner if something changes` },
            ],
            confirmLabel: 'Snooze',
          }),
          result: { item: item.title, snoozeUntil: until, ...cannot },
        };
      }
      case 'dismiss': {
        const reason = str(args['reason']);
        return {
          card: card({
            title: `Dismiss ${name}?`,
            fields: [
              what,
              { label: 'Reason', value: reason ?? 'None given' },
              { label: 'Comes back', value: 'Only if something changes' },
            ],
            confirmLabel: 'Dismiss',
          }),
          result: { item: item.title, dismiss: true, ...(reason ? { reason } : {}), ...cannot },
        };
      }
      case 'assign': {
        const to = args['assigneeUserId'];
        if (to === undefined)
          throw HfosError.validation(
            [{ path: 'assigneeUserId', message: 'Say who to assign it to.' }],
            'Say who to assign it to: a user id from list_team, or null to leave it for anyone.',
          );
        const who = typeof to === 'string' ? await teammateName(db, ctx, to) : null;
        if (typeof to === 'string' && !who)
          throw HfosError.validation(
            [{ path: 'assigneeUserId', message: 'Pick someone in this workspace.' }],
            'Nobody on this business’s team has that user id. Look them up with list_team and use the id it gives.',
          );
        const now = item.assignee?.fullName ?? 'Nobody';
        const same = (item.assignee?.id ?? null) === (typeof to === 'string' ? to : null);
        if (same && !blocked)
          warnings.push({
            kind: 'blocked',
            text: who ? `It’s already ${firstName(who)}’s.` : 'Nobody has it yet.',
          });
        return {
          card: confirmCard(toolCallId, 'update_attention_item', item, {
            title: who ? `Assign ${name} to ${firstName(who)}?` : `Leave ${name} for anyone?`,
            fields: [
              what,
              { label: 'Assigned', value: `${now} → ${who ?? 'Nobody'}` },
              { label: 'Changes', value: ASSIGN_CHANGES[item.kind] },
            ],
            body: null,
            warnings,
            confirmLabel: blocked || same ? '' : who ? 'Assign' : 'Unassign',
          }),
          result: {
            item: item.title,
            assignTo: who ?? 'nobody',
            ...(blocked || same ? { cannot: warnings.at(-1)!.text } : {}),
          },
        };
      }
    }
  },

  async commit(db, ctx, args) {
    const itemId = String(args['itemId']);
    const ws = ctx.workspaceId;
    switch (actionOf(args['action'])) {
      case 'snooze': {
        const until = snoozeUntil(args);
        await command(db, ctx, 'attention.snooze', {
          itemId,
          until: new Date(until).toISOString(),
        });
        return {
          outcome: `Snoozed until ${atLabel(until, ctx.timezone)}.`,
          href: home(ws).page(),
          command: 'attention.snooze',
        };
      }
      case 'dismiss':
        await command(db, ctx, 'attention.dismiss', {
          itemId,
          reason: str(args['reason']) ?? null,
        });
        return {
          outcome: 'Dismissed. It comes back only if something changes.',
          href: home(ws).page(),
          command: 'attention.dismiss',
        };
      case 'assign': {
        const to = typeof args['assigneeUserId'] === 'string' ? args['assigneeUserId'] : null;
        await command(db, ctx, 'attention.assign', { itemId, assigneeUserId: to });
        const who = to ? await teammateName(db, ctx, to) : null;
        return {
          outcome: who ? `Assigned to ${who}.` : 'Left for anyone.',
          href: home(ws).item(itemId),
          command: 'attention.assign',
        };
      }
    }
  },
};

export const attentionConfirmTools: Record<string, AttentionConfirmTool> = {
  handle_attention_item: handleItem,
  update_attention_item: updateItem,
};
