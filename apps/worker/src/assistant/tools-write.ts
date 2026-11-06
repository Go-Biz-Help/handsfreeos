import {
  ADDON_CATALOG,
  contactLabelWords,
  conversationOpen,
  formatClock,
  formatPhone,
  HfosError,
  isAddonAiTool,
  isScreenActionTool,
  isScreenReadTool,
  normalizePhone,
  SOCIAL_CHANNEL_NAMES,
  VIDEO_LINK_DAYS,
  VIDEO_CALL_WORDS,
  videoCallAppPath,
  videoLinkCreate,
  type AssistantCard,
  type Catalog,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type {
  CommittedAction,
  OfferedTool,
  PreparedAction,
  ToolContext,
  ToolExecutor,
  ToolOutcome,
} from './runtime';
import {
  capabilityTools,
  commitAddonActionTool,
  commitAddonTool,
  isAddonActionTool,
  prepareAddonActionTool,
  prepareAddonTool,
  runAddonActionTool,
  runAddonTool,
  type AddonActionDeps,
} from './tools-addons';
import { attentionAutoTools, attentionConfirmTools } from './tools-attention';
import { calendarConfirmTools } from './tools-calendar';
import { contactConfirmTools, contactReadTools } from './tools-contacts';
import { moneyConfirmTools, moneyReadTools } from './tools-money';
import { command, money, paths, query, readTools, rehearse, when } from './tools-read';
import { settingsReadTools } from './tools-settings';
import { settingsBusinessConfirmTools } from './tools-settings-business';
import { settingsChannelConfirmTools } from './tools-settings-channels';
import { settingsMeConfirmTools } from './tools-settings-me';
import { settingsMoneyConfirmTools } from './tools-settings-money';
import { settingsCalendarConfirmTools, type SettingsDeps } from './tools-settings-calendar';
import { formAutoTools, formConfirmTools, type FormToolDeps } from './tools-forms';
import { publicOriginFor, withWholeLinks } from './full-links';
import { workflowAutoTools, workflowConfirmTools, type WorkflowToolDeps } from './tools-workflow';
import { billingAutoTools, billingConfirmTools, billingLinkTools } from './tools-billing';
import { contentAutoTools, contentConfirmTools } from './tools-content';
import { extraAutoTools, extraConfirmTools } from './tools-extra';
import { mainOfferAutoTools, mainOfferConfirmTools } from './tools-main-offer';
import { inboxCrmAutoTools, inboxCrmConfirmTools } from './tools-inbox-crm';
import { schedulingAutoTools, schedulingConfirmTools } from './tools-scheduling';
import { commitScreenAction, prepareScreenAction, runScreenAction } from './tools-screen-actions';
import { runScreenRead } from './tools-screen-reads';
import { moreSettingsConfirmTools } from './tools-settings-more';
import { setupAutoTools, setupConfirmTools } from './tools-setup';

/** The rest of what people do on the screens, one file an area: run on their own. */
const moreAutoTools = {
  ...inboxCrmAutoTools,
  ...schedulingAutoTools,
  ...billingAutoTools,
  ...contentAutoTools,
  ...setupAutoTools,
  ...extraAutoTools,
};

/** The same choices as the pipeline's lost-reason dialog (apps/web/src/components/pipeline/lost-reason-dialog.tsx). */
export const LOST_REASONS = [
  'Went with another bidder',
  'Decided not to do the work',
  'No response',
];

/** The runtime puts the tool call's id on a "done" card; this stands in until then. */
const PENDING_ID = '00000000-0000-0000-0000-000000000000';

type Args = Record<string, unknown>;
type Warning = { kind: string; text: string };
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const firstName = (full: string) => full.split(' ')[0] || full;
const defined = (o: Args) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function confirmCard(
  toolCallId: string,
  tool: string,
  card: Omit<ConfirmCard, 'type' | 'toolCallId' | 'tool' | 'personId' | 'conversationId'> &
    Partial<Pick<ConfirmCard, 'personId' | 'conversationId'>>,
): ConfirmCard {
  return { type: 'confirm', toolCallId, tool, personId: null, conversationId: null, ...card };
}

interface Members {
  members: { userId: string; fullName: string; email: string }[];
  organizationAdmins: { userId: string; fullName: string; email: string }[];
}
async function teammate(db: Db, ctx: ToolContext, userId: unknown): Promise<string | null> {
  if (typeof userId !== 'string') return null;
  const team = await query<Members>(db, ctx, 'workspace.members');
  const m = [...team.members, ...team.organizationAdmins].find((x) => x.userId === userId);
  return m ? m.fullName || m.email : null;
}

// ---------- tasks and notes: done at once, with Undo ----------

const FIELD_WORDS: Record<string, string> = {
  title: 'title',
  dueAt: 'due time',
  allDay: 'due time',
  assigneeUserId: 'assignee',
  notes: 'notes',
  leadId: 'lead',
};

const autoWrites: Record<string, (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>> = {
  async create_task(db, ctx, args) {
    const { taskId } = await command<{ taskId: string }>(db, ctx, 'task.create', {
      title: args['title'],
      notes: str(args['notes']) ?? null,
      dueAt: args['dueAt'] ?? null,
      allDay: args['allDay'] ?? false,
      // A task nobody was named for is the asker's own, as when they add one themselves.
      assigneeUserId: args['assigneeUserId'] ?? ctx.actor.userId,
      personId: args['personId'] ?? null,
      companyId: args['companyId'] ?? null,
      leadId: args['leadId'] ?? null,
      customRecordId: args['customRecordId'] ?? null,
    });
    const assignee = args['assigneeUserId'] ?? ctx.actor.userId;
    const who =
      assignee === ctx.actor.userId ? 'You' : ((await teammate(db, ctx, assignee)) ?? 'A teammate');
    const due = args['dueAt'] ? when(String(args['dueAt']), ctx.timezone) : 'No due date';
    const href = paths(ctx.workspaceId).tasks();
    const title = String(args['title']);
    return {
      result: { taskId, added: true, assignee: who, due },
      command: 'task.create',
      card: {
        type: 'done',
        toolCallId: PENDING_ID,
        kind: 'task',
        title,
        detail: `${who} · ${due}`,
        href,
        undoable: true,
      },
      record: { taskId, outcome: `Added “${title}”`, href },
    };
  },

  async update_task(db, ctx, args) {
    const { updated } = await command<{ taskId: string; updated: string[] }>(
      db,
      ctx,
      'task.update',
      defined({
        taskId: args['taskId'],
        title: args['title'],
        dueAt: args['dueAt'],
        allDay: args['allDay'],
        assigneeUserId: args['assigneeUserId'],
        notes: args['notes'],
        leadId: args['leadId'],
      }),
    );
    const changed = [...new Set(updated.map((f) => FIELD_WORDS[f] ?? f))];
    const href = paths(ctx.workspaceId).tasks();
    return {
      result: { taskId: args['taskId'], changed },
      command: 'task.update',
      card: {
        type: 'done',
        toolCallId: PENDING_ID,
        kind: 'task',
        title: str(args['title']) ?? 'Task changed',
        detail: changed.length ? `Changed the ${changed.join(' and ')}` : 'Nothing needed changing',
        href,
        undoable: false,
      },
      record: { taskId: args['taskId'], outcome: 'Changed the task', href, undo: false },
    };
  },

  async complete_task(db, ctx, args) {
    await command(db, ctx, 'task.complete', { taskId: args['taskId'] });
    const href = paths(ctx.workspaceId).tasks();
    return {
      result: { taskId: args['taskId'], done: true },
      command: 'task.complete',
      card: {
        type: 'done',
        toolCallId: PENDING_ID,
        kind: 'task',
        title: 'Task done',
        detail: 'Marked complete',
        href,
        undoable: true,
      },
      record: { taskId: args['taskId'], outcome: 'Marked the task done', href },
    };
  },

  async add_note(db, ctx, args) {
    const p = paths(ctx.workspaceId);
    // Note, Call or Visit, as the Log activity sheet's choice; when it happened, for one logged after the fact.
    const kind = (str(args['kind']) ?? 'note') as 'note' | 'call' | 'visit';
    const target = defined({
      personId: args['personId'],
      leadId: args['leadId'],
      companyId: args['companyId'],
      customRecordId: args['customRecordId'],
    });
    const { activityId } = await command<{ activityId: string }>(
      db,
      ctx,
      'activity.log',
      defined({ kind, body: args['body'], occurredAt: str(args['occurredAt']), ...target }),
    );
    let name = 'the record';
    let href: string | null = null;
    if (typeof args['personId'] === 'string') {
      const { person } = await query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
        personId: args['personId'],
      });
      name = person.fullName;
      href = p.person(args['personId']);
    } else if (typeof args['leadId'] === 'string') {
      name = 'the lead';
      href = p.lead(args['leadId']);
    } else if (typeof args['companyId'] === 'string') {
      name = 'the company';
      href = p.company(args['companyId']);
    } else if (typeof args['customRecordId'] === 'string') {
      const { record } = await query<{ record: { name: string } }>(db, ctx, 'custom_record.get', {
        customRecordId: args['customRecordId'],
      });
      name = record.name;
      href = `/app/w/${ctx.workspaceId}/customers/records/${args['customRecordId']}`;
    }
    const body = String(args['body']);
    const word = { note: 'Note', call: 'Call', visit: 'Visit' }[kind];
    const at = str(args['occurredAt']);
    return {
      result: { activityId, added: true, kind, ...(at ? { when: when(at, ctx.timezone) } : {}) },
      command: 'activity.log',
      card: {
        type: 'done',
        toolCallId: PENDING_ID,
        kind: 'note',
        title: `${word} on ${name}`,
        detail: `${at ? `${when(at, ctx.timezone)} · ` : ''}“${body.length > 120 ? `${body.slice(0, 117)}…` : body}”`,
        href,
        undoable: true,
      },
      record: { activityId, kind, outcome: `Added a ${kind} on ${name}`, href },
    };
  },
};

// ---------- changes that wait for the person's OK ----------

interface ConfirmTool {
  prepare(
    db: Db,
    ctx: ToolContext,
    args: Args,
    toolCallId: string,
    deps?: SettingsDeps,
  ): Promise<PreparedAction>;
  commit(
    db: Db,
    ctx: ToolContext,
    args: Args,
    /** `webUrl` is the web app's address: a link that goes to a customer needs the whole thing, not a path. */
    extra: { lostReason?: string; toolCallId: string; webUrl: string } & SettingsDeps,
  ): Promise<CommittedAction>;
}

const clientId = (toolCallId: string) => `assistant-${toolCallId}`;

interface TextTarget {
  name: string;
  phone: string | null;
  personId: string | null;
  conversationId: string | null;
  blocked: string | null;
  fromNumber: string | null;
  quiet: Quiet | null;
  /** Another of their numbers or emails, as the screen's Text ▾ and Email ▾ pick one; null for the main one. */
  to?: string | null;
}

/** Quiet hours as the business has them now: the local time, and when they end (both "21:30"). */
interface Quiet {
  quiet: boolean;
  localTime: string;
  endsAt: string | null;
}

interface OnFile {
  fullName: string;
  phoneE164: string | null;
  email: string | null;
  otherPhones: { phone: string; phoneE164: string; label: string | null }[];
  otherEmails: { email: string; label: string | null }[];
}

/**
 * Another of the customer's numbers or emails, named in `to`: it has to be one they have on file, as the screen
 * offers only those. Null for none, or for their main one. Its words are the screen's: "(512) 555-0101 · Work".
 */
async function otherOnFile(
  db: Db,
  ctx: ToolContext,
  args: Args,
  channel: 'sms' | 'email',
): Promise<{ value: string; words: string; person: OnFile } | null> {
  const to = str(args['to']);
  if (!to) return null;
  const personId = str(args['personId']);
  if (!personId)
    throw HfosError.validation(
      [],
      'to goes with personId: say whose number or email it is, or leave to out to use the conversation.',
    );
  const { person } = await query<{ person: OnFile }>(db, ctx, 'person.get', { personId });
  const first = firstName(person.fullName);
  if (channel === 'sms') {
    const e164 = normalizePhone(to);
    if (e164 && e164 === person.phoneE164) return null;
    const found = person.otherPhones.find((p) => p.phoneE164 === e164);
    if (!found)
      throw HfosError.validation(
        [],
        `${to} isn’t one of ${first}’s numbers. get_customer lists the ones on file; add it with update_customer first.`,
      );
    return {
      value: found.phoneE164,
      words: `${found.phone} · ${contactLabelWords(found.label, 'phone')}`,
      person,
    };
  }
  const email = to.toLowerCase();
  if (email === person.email?.toLowerCase()) return null;
  const found = person.otherEmails.find((e) => e.email.toLowerCase() === email);
  if (!found)
    throw HfosError.validation(
      [],
      `${to} isn’t one of ${first}’s emails. get_customer lists the ones on file; add it with update_customer first.`,
    );
  return {
    value: found.email,
    words: `${found.email} · ${contactLabelWords(found.label, 'email')}`,
    person,
  };
}

/** Their conversation with that number or address, when there is one already. */
async function laneWith(
  db: Db,
  ctx: ToolContext,
  personId: string,
  channel: 'sms' | 'email',
  counterpart: string,
): Promise<string | null> {
  const { items } = await query<{ items: { id: string; counterpart: string }[] }>(
    db,
    ctx,
    'inbox.list',
    { personId, channel, limit: 50 },
  );
  return items.find((c) => c.counterpart.toLowerCase() === counterpart.toLowerCase())?.id ?? null;
}

/**
 * The conversation another number or address is texted or emailed in, or their main one when `to` is left out: the
 * screen's own way of opening it.
 */
async function openWith(
  db: Db,
  ctx: ToolContext,
  personId: string,
  channel: 'sms' | 'email',
  to?: string,
): Promise<string> {
  const { conversationId } = await command<{ conversationId: string }>(
    db,
    ctx,
    conversationOpen.name,
    { personId, channel, ...(to ? { to } : {}) },
  );
  return conversationId;
}

async function textTarget(db: Db, ctx: ToolContext, args: Args): Promise<TextTarget> {
  const personId = str(args['personId']) ?? null;
  let conversationId = str(args['conversationId']) ?? null;
  const other = await otherOnFile(db, ctx, args, 'sms');
  if (other && personId) {
    const lane = await laneWith(db, ctx, personId, 'sms', other.value);
    const t = lane ? await textTarget(db, ctx, { conversationId: lane }) : null;
    const setup = t
      ? null
      : await query<{
          number: { display: string } | null;
          messagingReady: boolean;
          quiet: Quiet;
        }>(db, ctx, 'phone.setup_status').catch(() => null);
    return {
      name: other.person.fullName,
      phone: other.words,
      personId,
      conversationId: null,
      blocked:
        t?.blocked ??
        (setup && !setup.number
          ? 'no_number'
          : setup && !setup.messagingReady
            ? 'not_ready'
            : null),
      fromNumber: t?.fromNumber ?? setup?.number?.display ?? null,
      quiet: t?.quiet ?? setup?.quiet ?? null,
      to: other.value,
    };
  }
  if (!conversationId && personId) {
    const { items } = await query<{ items: { id: string }[] }>(db, ctx, 'inbox.list', {
      personId,
      channel: 'sms',
      limit: 1,
    });
    conversationId = items[0]?.id ?? null;
  }
  if (conversationId) {
    const c = await query<{
      conversation: {
        channel: string;
        counterpartDisplay: string;
        person: { id: string; fullName: string } | null;
      };
      person: { phone: string | null } | null;
      canText: { ok: boolean; reason: string | null };
      fromNumber: string | null;
      quiet: Quiet;
    }>(db, ctx, 'conversation.get', { conversationId });
    return {
      name: c.conversation.person?.fullName ?? c.conversation.counterpartDisplay,
      // The number this thread is with, which may be another of theirs, not their main one.
      phone:
        c.conversation.channel === 'sms'
          ? c.conversation.counterpartDisplay
          : (c.person?.phone ?? null),
      personId: c.conversation.person?.id ?? personId,
      conversationId,
      blocked: c.canText.ok ? null : c.canText.reason,
      fromNumber: c.fromNumber,
      quiet: c.quiet,
    };
  }
  if (!personId)
    throw HfosError.validation(
      [],
      'Say who the text is for: give their personId (search_customers finds it) or the conversationId.',
    );
  const { person } = await query<{ person: { fullName: string; phone: string | null } }>(
    db,
    ctx,
    'person.get',
    { personId },
  );
  const setup = await query<{
    number: { display: string } | null;
    messagingReady: boolean;
    quiet: Quiet;
  }>(db, ctx, 'phone.setup_status').catch(() => null);
  const blocked = !person.phone
    ? 'no_phone'
    : setup && !setup.number
      ? 'no_number'
      : setup && !setup.messagingReady
        ? 'not_ready'
        : null;
  return {
    name: person.fullName,
    phone: person.phone,
    personId,
    conversationId: null,
    blocked,
    fromNumber: setup?.number?.display ?? null,
    quiet: setup?.quiet ?? null,
  };
}

function cannotText(reason: string, first: string): string {
  switch (reason) {
    case 'opted_out':
      return `${first} replied STOP, so texts to them are off. You can still call or email.`;
    case 'no_phone':
      return `There’s no mobile number for ${first}.`;
    case 'no_number':
      return 'This business has no phone number yet, so texts can’t go out.';
    case 'not_ready':
      return 'The carriers haven’t approved texting for this business yet.';
    case 'email_channel':
      return 'That conversation is email. Send an email instead.';
    case 'chat_channel':
      return 'That conversation is a website chat, so a reply goes in the chat, not by text.';
    case 'portal_channel':
      return `That conversation is in ${first}’s portal, so a reply goes there, not by text.`;
    case 'social_channel':
      return 'That conversation is on Messenger or Instagram, so a reply goes there, not by text.';
    default:
      return 'Texts to them can’t go out right now.';
  }
}

/** The conversations a text never goes in, whose replies reply_in_conversation sends on their own channel. */
const REPLIED_IN_PLACE = new Set(['chat_channel', 'portal_channel', 'social_channel']);

type RichButton = { type?: string; title: string; url?: string; phone?: string };
type RichText =
  | { kind: 'buttons'; buttons: RichButton[] }
  | { kind: 'card'; title: string; buttons: RichButton[] };
/**
 * Reply buttons or a card, as Add buttons or a card makes them, said on the card: where a link button goes and the
 * number a call button rings, since both reach the customer.
 */
function richFields(rich: RichText | undefined): { label: string; value: string }[] {
  if (!rich) return [];
  const buttons = rich.buttons
    .map((b) =>
      b.type === 'link' && b.url
        ? `${b.title} (opens ${b.url})`
        : b.type === 'call' && b.phone
          ? `${b.title} (calls ${formatPhone(b.phone) || b.phone})`
          : b.title,
    )
    .join(' · ');
  return [
    ...(rich.kind === 'card' ? [{ label: 'Card', value: rich.title }] : []),
    ...(buttons ? [{ label: 'Buttons', value: buttons }] : []),
  ];
}

const sendText: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const t = await textTarget(db, ctx, args);
    const first = firstName(t.name);
    // In quiet hours the composer offers both: hold it until they end, or send it now.
    const later = args['whenQuiet'] !== 'send_anyway';
    const quiet = !t.blocked && !!t.quiet?.quiet;
    const ends = t.quiet?.endsAt ? formatClock(t.quiet.endsAt) : null;
    const video = args['askForVideo'] === true;
    const warnings: Warning[] = [];
    if (t.blocked) warnings.push({ kind: 'blocked', text: cannotText(t.blocked, first) });
    else if (quiet && t.quiet)
      warnings.push({
        kind: 'quiet_hours',
        text: later
          ? `It’s ${formatClock(t.quiet.localTime)} for the business, inside quiet hours, so it waits until they end${ends ? `, at ${ends}` : ''}. You can cancel it until then.`
          : `It’s ${formatClock(t.quiet.localTime)} for the business, inside quiet hours. It goes now, as you asked.`,
      });
    if (video && !t.blocked)
      warnings.push({
        kind: 'note',
        text: `A link goes under your words for ${first} to send you a video at full quality. It lasts ${VIDEO_LINK_DAYS} days, and what they send lands in this conversation.`,
      });
    return {
      card: confirmCard(toolCallId, 'send_text', {
        personId: t.personId,
        conversationId: t.conversationId,
        title: `Send this text to ${first}?`,
        fields: [
          { label: 'To', value: [t.name, t.phone].filter(Boolean).join(' · ') },
          {
            label: 'From',
            value: t.fromNumber ? `Your business number · ${t.fromNumber}` : 'Your business number',
          },
          ...(quiet
            ? [
                {
                  label: 'Goes',
                  value: later
                    ? `When quiet hours end${ends ? `, at ${ends}` : ''}`
                    : 'Now, in quiet hours',
                },
              ]
            : []),
          ...(video ? [{ label: 'Adds', value: 'A link for them to send you a video' }] : []),
          ...richFields(args['rich'] as RichText | undefined),
        ],
        body: String(args['body']),
        stageFrom: null,
        stageTo: null,
        warnings,
        reasons: [],
        confirmLabel: t.blocked
          ? ''
          : !quiet
            ? 'Send text'
            : !later
              ? 'Send anyway'
              : ends
                ? `Send at ${ends}`
                : 'Send when quiet hours end',
        editable: !t.blocked,
      }),
      result: {
        to: t.name,
        ...(t.blocked ? { cannotSend: cannotText(t.blocked, first) } : {}),
        ...(t.blocked && REPLIED_IN_PLACE.has(t.blocked)
          ? { next: 'Reply with reply_in_conversation and this conversationId.' }
          : {}),
        ...(quiet ? { quietHours: true, goes: later ? 'when quiet hours end' : 'now' } : {}),
      },
    };
  },
  async commit(db, ctx, args, extra) {
    const t = await textTarget(db, ctx, args);
    // Another of their numbers goes in its own conversation, opened as the screen's Text ▾ opens it.
    let conversationId =
      t.to && t.personId ? await openWith(db, ctx, t.personId, 'sms', t.to) : t.conversationId;
    let body = String(args['body']);
    if (args['askForVideo'] === true) {
      // What they send lands in a conversation, so a first text opens theirs, as the reply box has one open.
      conversationId ??= await openWith(db, ctx, String(t.personId), 'sms');
      const { path } = await command<{ path: string }>(db, ctx, videoLinkCreate.name, {
        conversationId,
      });
      // On a line of its own under the words, on the business's own domain once it works, as the AI teammate's.
      const origin = (await publicOriginFor(db, ctx, extra.webUrl)).replace(/\/+$/, '');
      body = `${body}\n${origin}${path}`;
    }
    const sent = await command<{ conversationId: string; scheduledFor?: string }>(
      db,
      ctx,
      'message.send',
      {
        ...(conversationId ? { conversationId } : { personId: t.personId }),
        channel: 'sms',
        body,
        ...(args['rich'] ? { rich: args['rich'] } : {}),
        // Held until quiet hours end unless the person said to send it now; outside them it goes now either way.
        ...(args['whenQuiet'] === 'send_anyway'
          ? { acknowledgeQuietHours: true }
          : { sendAfterQuietHours: true }),
        clientId: clientId(extra.toolCallId),
      },
    );
    return {
      outcome: sent.scheduledFor
        ? `Held for ${t.name} until quiet hours end: it goes ${when(sent.scheduledFor, ctx.timezone)}, and can be cancelled until then`
        : `Sent to ${t.name}`,
      href: paths(ctx.workspaceId).conversation(sent.conversationId),
      command: 'message.send',
    };
  },
};

interface ComposeOptions {
  to: string | null;
  conversationId: string | null;
  canEmail: { ok: boolean; reason: 'no_email' | 'suppressed' | null };
  suppressed: { reason: string } | null;
  addresses: {
    id: string;
    address: string;
    displayName: string;
    isDefault: boolean;
    usable: boolean;
    mine?: boolean;
  }[];
  fromAddressId: string | null;
  mailboxes: {
    id: string;
    provider: 'microsoft' | 'google';
    accountEmail: string | null;
  }[];
}

const MAILBOX_WORDS = { google: 'Gmail', microsoft: 'Outlook' } as const;

/**
 * Another address an email goes from, as the composer's From picks it: one of the business's addresses that can
 * send, or the person's own connected Gmail or Outlook. Null for the conversation's own or the default.
 */
function fromChoice(
  opts: ComposeOptions,
  asked: string | undefined,
): { emailAddressId?: string; mailboxConnectionId?: string; words: string } | null {
  if (!asked) return null;
  const want = asked.toLowerCase();
  const address = opts.addresses.find((a) => a.address.toLowerCase() === want);
  if (address?.usable)
    return {
      emailAddressId: address.id,
      words: address.mine ? `${address.address} (yours)` : address.address,
    };
  const mailbox = opts.mailboxes.find((m) => m.accountEmail?.toLowerCase() === want);
  if (mailbox)
    return {
      mailboxConnectionId: mailbox.id,
      words: `${mailbox.accountEmail} (your ${MAILBOX_WORDS[mailbox.provider]})`,
    };
  const choices = [
    ...opts.addresses.filter((a) => a.usable).map((a) => a.address),
    ...opts.mailboxes.flatMap((m) => (m.accountEmail ? [m.accountEmail] : [])),
  ];
  throw HfosError.validation(
    [{ path: 'from', message: 'Pick an address this email can go from.' }],
    address
      ? `${asked} can’t send email yet: finish setting it up in Settings → Email first, or pick another.${choices.length ? ` It can go from ${choices.join(', ')}.` : ''}`
      : choices.length
        ? `This email can’t go from ${asked}. It can go from ${choices.join(', ')}.`
        : `This email can’t go from ${asked}. Add the address in Settings → Email, or connect your own mailbox there.`,
  );
}

async function emailTarget(db: Db, ctx: ToolContext, args: Args) {
  const personId = str(args['personId']);
  const other = await otherOnFile(db, ctx, args, 'email');
  // Another of their emails: its own conversation when there is one, else a new one the send opens.
  const lane = other && personId ? await laneWith(db, ctx, personId, 'email', other.value) : null;
  const conversationId = lane ?? (other ? undefined : str(args['conversationId']));
  if (!conversationId && !personId)
    throw HfosError.validation(
      [],
      'Say who the email is for: give their personId (search_customers finds it) or the conversationId.',
    );
  const found = await query<ComposeOptions>(
    db,
    ctx,
    'email.compose_options',
    conversationId ? { conversationId } : { personId },
  );
  // Their main email's state says nothing of another one: a bounce on it is said when it goes.
  const opts: ComposeOptions =
    other && !lane
      ? { ...found, to: other.value, canEmail: { ok: true, reason: null }, suppressed: null }
      : found;
  const from =
    opts.addresses.find((a) => a.id === opts.fromAddressId) ??
    opts.addresses.find((a) => a.isDefault) ??
    null;
  const name = personId
    ? (await query<{ person: { fullName: string } }>(db, ctx, 'person.get', { personId })).person
        .fullName
    : ((
        await query<{
          conversation: { counterpartDisplay: string; person: { fullName: string } | null };
        }>(db, ctx, 'conversation.get', {
          conversationId,
        })
      ).conversation.person?.fullName ??
      opts.to ??
      'them');
  return {
    opts,
    from,
    chosen: fromChoice(opts, str(args['from'])),
    cc: Array.isArray(args['cc']) ? (args['cc'] as string[]) : [],
    name,
    conversationId: other ? null : (conversationId ?? opts.conversationId ?? null),
    personId: personId ?? null,
    to: other?.value ?? null,
    toWords: other?.words ?? null,
  };
}

const sendEmail: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const e = await emailTarget(db, ctx, args);
    const first = firstName(e.name);
    const blocked = e.opts.canEmail.ok
      ? null
      : e.opts.canEmail.reason === 'no_email'
        ? `There’s no email address for ${first}.`
        : `Email to ${e.opts.to} is stopped after a bounce or a complaint.`;
    return {
      card: confirmCard(toolCallId, 'send_email', {
        personId: e.personId,
        conversationId: e.conversationId,
        title: `Email ${first}?`,
        fields: [
          { label: 'To', value: [e.name, e.toWords ?? e.opts.to].filter(Boolean).join(' · ') },
          {
            label: 'From',
            value: e.chosen?.words ?? (e.from ? e.from.address : 'Your business address'),
          },
          ...(e.cc.length ? [{ label: 'Cc', value: e.cc.join(', ') }] : []),
          { label: 'Subject', value: String(args['subject']) },
        ],
        body: String(args['body']),
        stageFrom: null,
        stageTo: null,
        warnings: blocked ? [{ kind: 'blocked', text: blocked }] : [],
        reasons: [],
        confirmLabel: blocked ? '' : 'Send email',
        editable: !blocked,
      }),
      result: { to: e.name, ...(blocked ? { cannotSend: blocked } : {}) },
    };
  },
  async commit(db, ctx, args, extra) {
    const e = await emailTarget(db, ctx, args);
    const conversationId =
      e.to && e.personId ? await openWith(db, ctx, e.personId, 'email', e.to) : e.conversationId;
    const sent = await command<{ conversationId: string }>(db, ctx, 'message.send', {
      ...(conversationId ? { conversationId } : { personId: e.personId }),
      channel: 'email',
      subject: args['subject'],
      body: args['body'],
      ...(e.chosen?.emailAddressId ? { emailAddressId: e.chosen.emailAddressId } : {}),
      ...(e.chosen?.mailboxConnectionId
        ? { mailboxConnectionId: e.chosen.mailboxConnectionId }
        : {}),
      ...(e.cc.length ? { cc: e.cc } : {}),
      clientId: clientId(extra.toolCallId),
    });
    return {
      outcome: `Emailed ${e.name}`,
      href: paths(ctx.workspaceId).conversation(sent.conversationId),
      command: 'message.send',
    };
  },
};

// ---------- a reply where the customer wrote: a website chat, a portal, Messenger or Instagram ----------

/** Where a reply goes, as the card's title says it. */
const REPLY_WHERE: Readonly<Record<string, string>> = {
  chat: 'in the chat',
  portal: 'in their portal',
  messenger: 'on Messenger',
  instagram: 'on Instagram',
};
const THREAD_NAMES: Readonly<Record<string, string>> = {
  chat: 'Website chat',
  portal: 'Client portal',
  ...SOCIAL_CHANNEL_NAMES,
};

interface ReplyPlace {
  conversation: {
    id: string;
    channel: string;
    counterpartDisplay: string;
    person: { id: string; fullName: string } | null;
  };
  chat: { name: string | null } | null;
  social: {
    account: { label: string } | null;
    contact: { name: string };
    window: { open: boolean; peopleOnly: boolean; closesAt: string | null };
  } | null;
}

/** The conversation a reply goes in: never a text or email thread, which send_text and send_email write in. */
async function replyPlace(db: Db, ctx: ToolContext, args: Args) {
  const got = await query<ReplyPlace>(db, ctx, 'conversation.get', {
    conversationId: args['conversationId'],
  });
  const c = got.conversation;
  if (c.channel === 'sms' || c.channel === 'email')
    throw HfosError.validation(
      [{ path: 'conversationId', message: 'Pick a website chat, portal or social conversation.' }],
      `That conversation is ${c.channel === 'sms' ? 'texts' : 'email'}. Write with ${c.channel === 'sms' ? 'send_text' : 'send_email'} and this conversationId instead.`,
    );
  const who =
    c.person?.fullName ?? got.social?.contact.name ?? got.chat?.name ?? c.counterpartDisplay;
  return { got, c, who, where: REPLY_WHERE[c.channel] ?? 'there' };
}

/**
 * A refusal in words the card can show: a check's own message, or, for words that don't fit (an Instagram reply over
 * 1,000 characters), what each field needs, rather than the kernel's general "Some fields need attention".
 */
function refusalWords(e: HfosError): string {
  const fields = e.code === 'validation' && Array.isArray(e.details) ? e.details : [];
  const said = fields.flatMap((f) => {
    const message = (f as { message?: unknown } | null)?.message;
    return typeof message === 'string' && message ? [message] : [];
  });
  return said.length ? said.join(' ') : e.message;
}

const replyInConversation: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { got, c, who, where } = await replyPlace(db, ctx, args);
    const first = firstName(who);
    // The reply box's own refusals, said before anyone agrees: Meta's reply window, a blocked visitor, a closed account.
    let why: string | null = null;
    try {
      await rehearse(db, ctx, 'message.send', {
        conversationId: c.id,
        channel: c.channel,
        body: args['body'],
      });
    } catch (e) {
      if (!(e instanceof HfosError)) throw e;
      why = refusalWords(e);
    }
    const window = got.social?.window;
    const warnings: Warning[] = why
      ? [{ kind: 'blocked', text: why }]
      : [
          { kind: 'caution', text: `It reaches ${first} now.` },
          ...(window?.closesAt
            ? [
                {
                  kind: 'note',
                  text: `${THREAD_NAMES[c.channel]} lets the business answer until ${when(window.closesAt, ctx.timezone)}${window.peopleOnly ? ', and only a person on the team now' : ''}.`,
                },
              ]
            : []),
        ];
    return {
      card: confirmCard(toolCallId, 'reply_in_conversation', {
        personId: c.person?.id ?? null,
        conversationId: c.id,
        title: `Reply to ${first} ${where}?`,
        fields: [
          { label: 'To', value: `${who} · ${THREAD_NAMES[c.channel] ?? c.channel}` },
          ...(got.social?.account ? [{ label: 'Through', value: got.social.account.label }] : []),
        ],
        body: String(args['body']),
        stageFrom: null,
        stageTo: null,
        warnings,
        reasons: [],
        confirmLabel: why ? '' : 'Send reply',
        editable: !why,
      }),
      result: { to: who, channel: c.channel, ...(why ? { cannotSend: why } : {}) },
    };
  },
  async commit(db, ctx, args, extra) {
    const { c, who, where } = await replyPlace(db, ctx, args);
    const sent = await command<{ conversationId: string }>(db, ctx, 'message.send', {
      conversationId: c.id,
      channel: c.channel,
      body: args['body'],
      clientId: clientId(extra.toolCallId),
    });
    return {
      outcome: `Replied to ${who} ${where}`,
      href: paths(ctx.workspaceId).conversation(sent.conversationId),
      command: 'message.send',
    };
  },
};

// ---------- a HandsFreeOS video call with a customer ----------

/** What video_call.start is given, with the business's own address for the customer's link, as its route does. */
async function videoCallInput(db: Db, ctx: ToolContext, args: Args, webUrl: string) {
  const origin = (await publicOriginFor(db, ctx, webUrl)).replace(/\/+$/, '');
  return defined({
    personId: str(args['personId']),
    conversationId: str(args['conversationId']),
    channel: str(args['channel']),
    origin,
  });
}

/** Who the call is with, and how their link goes, as the Video call button says it. */
async function videoCallWith(
  db: Db,
  ctx: ToolContext,
  args: Args,
): Promise<{ name: string; personId: string | null; conversationId: string | null; by: string }> {
  const conversationId = str(args['conversationId']) ?? null;
  if (conversationId) {
    const { conversation: c } = await query<{
      conversation: {
        channel: string;
        counterpartDisplay: string;
        person: { id: string; fullName: string } | null;
      };
    }>(db, ctx, 'conversation.get', { conversationId });
    // A channel asked for that isn't this thread's goes the customer's own way: by text, or to their email.
    const asked = str(args['channel']);
    return {
      name: c.person?.fullName ?? c.counterpartDisplay,
      personId: c.person?.id ?? null,
      conversationId,
      by:
        asked && asked !== c.channel
          ? asked === 'email'
            ? 'By email, to their email address'
            : 'By text, to their phone number'
          : `In this conversation (${(THREAD_NAMES[c.channel] ?? (c.channel === 'sms' ? 'Texts' : 'Email')).toLowerCase()})`,
    };
  }
  const personId = str(args['personId']);
  if (!personId)
    throw HfosError.validation(
      [{ path: 'personId', message: 'Say who the call is with.' }],
      'Say who the call is with: give their personId (search_customers finds it) or the conversationId.',
    );
  const { person } = await query<{
    person: { fullName: string; phone: string | null; email: string | null };
  }>(db, ctx, 'person.get', { personId });
  const channel = str(args['channel']);
  return {
    name: person.fullName,
    personId,
    conversationId: null,
    by:
      channel === 'email' || (!channel && !person.phone && person.email)
        ? `By email${person.email ? ` to ${person.email}` : ''}`
        : channel === 'sms' || person.phone
          ? `By text${person.phone ? ` to ${person.phone}` : ''}${channel ? '' : ', or by email if a text can’t go'}`
          : 'By text or email',
  };
}

const startVideoCall: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId, deps) {
    const who = await videoCallWith(db, ctx, args);
    const first = firstName(who.name);
    const input = await videoCallInput(db, ctx, args, deps?.webUrl ?? '');
    // The command's own refusals, said before anyone agrees; quiet hours ask the person, as the button does.
    let quiet: string | null = null;
    let why: string | null = null;
    const tryIt = async (acknowledgeQuietHours: boolean) => {
      try {
        await rehearse(db, ctx, 'video_call.start', { ...input, acknowledgeQuietHours });
        return null;
      } catch (e) {
        if (!(e instanceof HfosError)) throw e;
        return e;
      }
    };
    const tried = await tryIt(false);
    if (tried?.rule === 'quiet_hours') {
      quiet = tried.message;
      const then = await tryIt(true);
      why = then ? refusalWords(then) : null;
    } else why = tried ? refusalWords(tried) : null;
    return {
      card: confirmCard(toolCallId, 'start_video_call', {
        personId: who.personId,
        conversationId: who.conversationId,
        title: `Start a video call with ${first}?`,
        fields: [
          { label: 'With', value: who.name },
          { label: 'Their link goes', value: who.by },
          { label: 'Then', value: 'The call opens for you from this card' },
        ],
        body: null,
        stageFrom: null,
        stageTo: null,
        warnings: why
          ? [{ kind: 'blocked', text: why }]
          : [
              ...(quiet
                ? [{ kind: 'quiet_hours', text: `${quiet} It goes now if you confirm.` }]
                : []),
              {
                kind: 'caution',
                text: `${first} gets their own link now, from you. Only they get it.`,
              },
            ],
        reasons: [],
        confirmLabel: why ? '' : quiet ? VIDEO_CALL_WORDS.sendAnyway : 'Start the call',
        editable: false,
      }),
      result: {
        with: who.name,
        ...(why ? { cannotStart: why } : {}),
        ...(quiet && !why ? { quietHours: true } : {}),
      },
    };
  },
  async commit(db, ctx, args, extra) {
    const input = await videoCallInput(db, ctx, args, extra.webUrl);
    const out = await command<{
      callId: string;
      conversationId: string | null;
      channel: string;
      name: string;
    }>(db, ctx, 'video_call.start', { ...input, acknowledgeQuietHours: true });
    const by =
      out.channel === 'sms'
        ? 'by text'
        : out.channel === 'email'
          ? 'by email'
          : 'in your conversation';
    return {
      outcome: `${out.name}’s link is on its way ${by}. Open the call from here to join it.`,
      href: videoCallAppPath(ctx.workspaceId, out.callId),
      command: 'video_call.start',
      answer: {
        callId: out.callId,
        conversationId: out.conversationId,
        // The team's own way in: the customer's link went to them alone and is never shown.
        join: `${extra.webUrl}/call/${out.callId}`,
      },
    };
  },
};

interface LeadLite {
  id: string;
  title: string;
  stageId: string;
  stageName: string;
  valueCents: number;
  source: string | null;
  expectedCloseOn: string | null;
  person: { fullName: string } | null;
  company: { name: string } | null;
  assignee: { id: string; fullName: string } | null;
  nextAction: string | null;
  nextActionAt: string | null;
}
const leadGet = (db: Db, ctx: ToolContext, leadId: unknown) =>
  query<{ lead: LeadLite; stages: { id: string; name: string; kind: string }[] }>(
    db,
    ctx,
    'lead.get',
    { leadId },
  );
const leadLine = (l: LeadLite) =>
  `${l.title} · ${l.person?.fullName ?? l.company?.name ?? 'No customer'} · ${money(l.valueCents)}`;

const moveLead: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { lead, stages } = await leadGet(db, ctx, args['leadId']);
    const to = stages.find((s) => s.id === args['stageId']);
    if (!to)
      throw HfosError.validation(
        [],
        'That stage isn’t in this lead’s pipeline. Use one of the stage ids get_lead gives for this lead.',
      );
    if (to.id === lead.stageId)
      throw HfosError.rule(
        'same_stage',
        409,
        `It’s already in ${to.name}, so nothing would change.`,
      );
    const reason = str(args['lostReason']);
    const lost = to.kind === 'lost';
    return {
      card: confirmCard(toolCallId, 'move_lead', {
        title: lost
          ? 'Mark this lead as lost?'
          : to.kind === 'won'
            ? 'Mark this lead as won?'
            : 'Move this lead?',
        fields: [
          { label: 'Lead', value: leadLine(lead) },
          ...(lost && reason ? [{ label: 'Reason', value: reason }] : []),
        ],
        body: null,
        stageFrom: lead.stageName,
        stageTo: to.name,
        warnings: [],
        reasons: lost && !reason ? LOST_REASONS : [],
        confirmLabel: lost ? 'Mark as lost' : 'Move lead',
        editable: false,
      }),
      result: {
        lead: lead.title,
        from: lead.stageName,
        to: to.name,
        ...(lost && !reason ? { needsReason: true } : {}),
      },
    };
  },
  async commit(db, ctx, args, extra) {
    const { stages } = await leadGet(db, ctx, args['leadId']);
    const to = stages.find((s) => s.id === args['stageId']);
    if (!to)
      throw HfosError.validation(
        [],
        'That stage isn’t in this lead’s pipeline anymore. It may have been removed in Settings → Pipelines. Ask again to move it to another stage.',
      );
    const reason = extra.lostReason ?? str(args['lostReason']);
    if (to.kind === 'lost' && !reason)
      throw HfosError.validation(
        [],
        `Moving it to ${to.name} needs a reason it was lost. Pick one under Why was it lost? on the card, then confirm.`,
      );
    await command(
      db,
      ctx,
      'lead.move_stage',
      defined({
        leadId: args['leadId'],
        stageId: to.id,
        lostReason: to.kind === 'lost' ? reason : undefined,
      }),
    );
    return {
      outcome: to.kind === 'lost' ? `Marked as lost: ${reason}` : `Moved to ${to.name}`,
      href: paths(ctx.workspaceId).lead(String(args['leadId'])),
      command: 'lead.move_stage',
    };
  },
};

const fullNameOf = (args: Args) =>
  [str(args['firstName']), str(args['lastName'])].filter(Boolean).join(' ');

const createCustomer: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const name = fullNameOf(args);
    if (!name)
      throw HfosError.validation(
        [],
        'A new customer needs a name. Give a firstName, a lastName or both.',
      );
    const { matches } = await query<{ matches: { name: string; matchedOn: string }[] }>(
      db,
      ctx,
      'crm.find_matches',
      {
        kind: 'person',
        name,
        phone: str(args['phone']) ?? null,
        email: str(args['email']) ?? null,
      },
    );
    return {
      card: confirmCard(toolCallId, 'create_customer', {
        title: `Add ${name} as a new customer?`,
        fields: [
          { label: 'Name', value: name },
          ...(str(args['phone']) ? [{ label: 'Phone', value: String(args['phone']) }] : []),
          ...(str(args['email']) ? [{ label: 'Email', value: String(args['email']) }] : []),
        ],
        body: str(args['notes']) ?? null,
        stageFrom: null,
        stageTo: null,
        warnings: matches.slice(0, 3).map((m) => ({
          kind: 'duplicate',
          text: `${m.name} already has this ${m.matchedOn}. It may be the same person.`,
        })),
        reasons: [],
        confirmLabel: matches.length ? 'Add anyway' : 'Add customer',
        editable: false,
      }),
      result: { name, possibleDuplicates: matches.map((m) => m.name) },
    };
  },
  async commit(db, ctx, args) {
    const { personId } = await command<{ personId: string }>(
      db,
      ctx,
      'person.create',
      defined({
        firstName: str(args['firstName']) ?? '',
        lastName: str(args['lastName']) ?? '',
        phone: str(args['phone']),
        email: str(args['email']),
        notes: str(args['notes']),
        ignoreDuplicates: true,
      }),
    );
    return {
      outcome: `Added ${fullNameOf(args)} to Contacts`,
      href: paths(ctx.workspaceId).person(personId),
      command: 'person.create',
    };
  },
};

/** Who a new lead is for, as the New lead dialog's Who is it for? asks: a person, or a company. */
async function leadFor(db: Db, ctx: ToolContext, args: Args) {
  const personId = str(args['personId']);
  const companyId = str(args['companyId']);
  if (!personId === !companyId)
    throw HfosError.validation(
      [{ path: 'personId', message: 'Pick a person or a company.' }],
      'Say who the lead is for: a person (personId) or a company (companyId), one of the two.',
    );
  if (personId) {
    const { person } = await query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
      personId,
    });
    return { name: person.fullName, first: firstName(person.fullName) };
  }
  const { company } = await query<{ company: { name: string } }>(db, ctx, 'company.get', {
    companyId,
  });
  return { name: company.name, first: company.name };
}

interface PipelineLite {
  id: string;
  name: string;
  isDefault: boolean;
  archivedAt: string | null;
  stages: { id: string; name: string; kind: string }[];
}

/**
 * The stage a new lead starts in, and its pipeline: the stage asked for, in whichever pipeline it is, or the first
 * open stage of the first pipeline, as lead.create picks it.
 */
async function startStage(db: Db, ctx: ToolContext, stageId: unknown) {
  const { pipelines } = await query<{ pipelines: PipelineLite[] }>(db, ctx, 'pipeline.list');
  const live = pipelines.filter((p) => !p.archivedAt);
  if (stageId) {
    const pipeline = live.find((p) => p.stages.some((s) => s.id === stageId));
    if (!pipeline)
      throw HfosError.validation(
        [{ path: 'stageId', message: 'That stage isn’t in a pipeline.' }],
        'That stage isn’t in any of this business’s pipelines. Use a stage id from the pipelines in your context, or leave stageId out for the first stage.',
      );
    return { pipeline, stage: pipeline.stages.find((s) => s.id === stageId)! };
  }
  const pipeline = live[0];
  return {
    pipeline: pipeline ?? null,
    stage: pipeline?.stages.find((s) => s.kind === 'open') ?? null,
  };
}

const createLead: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const [who, { pipeline, stage }, owner] = await Promise.all([
      leadFor(db, ctx, args),
      startStage(db, ctx, args['stageId']),
      teammate(db, ctx, args['assigneeUserId']),
    ]);
    const value = typeof args['value'] === 'number' ? Math.round(args['value'] * 100) : 0;
    const next = str(args['nextAction']);
    const nextAt = str(args['nextActionAt']);
    return {
      card: confirmCard(toolCallId, 'create_lead', {
        title: `Open a lead for ${who.first}?`,
        fields: [
          { label: 'Lead', value: String(args['title']) },
          { label: args['companyId'] ? 'Company' : 'Customer', value: who.name },
          { label: 'Value', value: money(value) },
          ...(stage && pipeline
            ? [{ label: 'Stage', value: `${stage.name} · ${pipeline.name}` }]
            : []),
          ...(owner ? [{ label: 'Assigned', value: owner }] : []),
          ...(next
            ? [
                {
                  label: 'Next',
                  value: `${next}${nextAt ? ` · ${when(nextAt, ctx.timezone)}` : ''}`,
                },
              ]
            : []),
          ...(str(args['expectedCloseOn'])
            ? [{ label: 'Expected close', value: String(args['expectedCloseOn']) }]
            : []),
          ...(str(args['source']) ? [{ label: 'Source', value: String(args['source']) }] : []),
        ],
        body: null,
        stageFrom: null,
        stageTo: null,
        warnings:
          nextAt && !next
            ? [
                {
                  kind: 'note',
                  text: 'A time for the next step needs the step too, so it’s left off.',
                },
              ]
            : [],
        reasons: [],
        confirmLabel: 'Open lead',
        editable: false,
      }),
      result: { title: args['title'], customer: who.name },
    };
  },
  async commit(db, ctx, args) {
    // The stage's own pipeline: without it lead.create looks for the stage in the first pipeline only.
    const { pipeline, stage } = await startStage(db, ctx, args['stageId']);
    const next = str(args['nextAction']);
    const { leadId } = await command<{ leadId: string }>(
      db,
      ctx,
      'lead.create',
      defined({
        title: args['title'],
        personId: str(args['personId']),
        companyId: str(args['companyId']),
        valueCents: typeof args['value'] === 'number' ? Math.round(args['value'] * 100) : undefined,
        pipelineId: pipeline?.id,
        stageId: stage?.id,
        assigneeUserId: args['assigneeUserId'],
        nextAction: next,
        nextActionAt: next ? str(args['nextActionAt']) : undefined,
        expectedCloseOn: str(args['expectedCloseOn']),
        source: str(args['source']),
      }),
    );
    return {
      outcome: `Opened ${String(args['title'])}`,
      href: paths(ctx.workspaceId).lead(leadId),
      command: 'lead.create',
    };
  },
};

/** What a detail of a lead says on a card: "none" when it has none. */
const said = (v: unknown) => (v === null || v === undefined || v === '' ? 'none' : String(v));

const updateLead: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { lead } = await leadGet(db, ctx, args['leadId']);
    const fields: { label: string; value: string }[] = [];
    const title = str(args['title']);
    if (title && title !== lead.title)
      fields.push({ label: 'Title', value: `${lead.title} → ${title}` });
    if (args['assigneeUserId'] !== undefined) {
      const who =
        args['assigneeUserId'] === null
          ? 'Nobody'
          : ((await teammate(db, ctx, args['assigneeUserId'])) ?? 'Someone else');
      fields.push({ label: 'Assigned', value: `${lead.assignee?.fullName ?? 'Nobody'} → ${who}` });
    }
    if (typeof args['value'] === 'number')
      fields.push({
        label: 'Value',
        value: `${money(lead.valueCents)} → ${money(Math.round(args['value'] * 100))}`,
      });
    if (args['expectedCloseOn'] !== undefined && args['expectedCloseOn'] !== lead.expectedCloseOn)
      fields.push({
        label: 'Expected close',
        value: `${said(lead.expectedCloseOn)} → ${said(args['expectedCloseOn'])}`,
      });
    if (args['source'] !== undefined && (str(args['source']) ?? null) !== lead.source)
      fields.push({
        label: 'Source',
        value: `${said(lead.source)} → ${said(str(args['source']))}`,
      });
    const next = nextActionOf(lead, args);
    if (next)
      fields.push({
        label: 'Next',
        value: `${said(lead.nextAction)}${lead.nextActionAt ? ` · ${when(lead.nextActionAt, ctx.timezone)}` : ''} → ${said(next.text)}${next.dueAt ? ` · ${when(next.dueAt, ctx.timezone)}` : ''}`,
      });
    if (!fields.length)
      throw HfosError.validation(
        [],
        'Nothing would change. Give what’s different: title, assigneeUserId, value, expectedCloseOn, source, nextAction or nextActionAt.',
      );
    return {
      card: confirmCard(toolCallId, 'update_lead', {
        title: `Change ${lead.title}?`,
        fields: [{ label: 'Lead', value: leadLine(lead) }, ...fields],
        body: null,
        stageFrom: null,
        stageTo: null,
        warnings: [],
        reasons: [],
        confirmLabel: 'Save changes',
        editable: false,
      }),
      result: { lead: lead.title, changes: fields.map((f) => f.label) },
    };
  },
  async commit(db, ctx, args) {
    const leadId = args['leadId'];
    const details = defined({
      title: str(args['title']),
      assigneeUserId: args['assigneeUserId'],
      valueCents: typeof args['value'] === 'number' ? Math.round(args['value'] * 100) : undefined,
      expectedCloseOn: args['expectedCloseOn'],
      source: args['source'] === undefined ? undefined : (str(args['source']) ?? null),
    });
    if (Object.keys(details).length) await command(db, ctx, 'lead.update', { leadId, ...details });
    const { lead } = await leadGet(db, ctx, leadId);
    const next = nextActionOf(lead, args);
    if (next) await command(db, ctx, 'lead.set_next_action', { leadId, ...next });
    return {
      outcome: 'Saved the changes',
      href: paths(ctx.workspaceId).lead(String(leadId)),
      command: Object.keys(details).length ? 'lead.update' : 'lead.set_next_action',
    };
  },
};

/**
 * The next action to set, as the lead's next action box sets it: the step and when. A time alone moves the step the
 * lead has; a lead with no step can't take a time alone. Null when neither was asked for.
 */
function nextActionOf(
  lead: LeadLite,
  args: Args,
): { text: string | null; dueAt: string | null } | null {
  if (args['nextAction'] === undefined && args['nextActionAt'] === undefined) return null;
  const text =
    args['nextAction'] === undefined ? lead.nextAction : (str(args['nextAction']) ?? null);
  if (!text && args['nextAction'] === undefined)
    throw HfosError.validation(
      [{ path: 'nextActionAt', message: 'Say what the next step is.' }],
      `${lead.title} has no next step, so a time alone has nothing to go on. Give nextAction too.`,
    );
  const dueAt = !text
    ? null
    : args['nextActionAt'] === undefined
      ? lead.nextActionAt
      : ((args['nextActionAt'] as string | null) ?? null);
  return { text, dueAt };
}

const confirmTools: Record<string, ConfirmTool> = {
  send_text: sendText,
  send_email: sendEmail,
  reply_in_conversation: replyInConversation,
  start_video_call: startVideoCall,
  move_lead: moveLead,
  create_customer: createCustomer,
  create_lead: createLead,
  update_lead: updateLead,
  ...calendarConfirmTools,
  ...workflowConfirmTools,
  ...formConfirmTools,
  ...attentionConfirmTools,
  ...moneyConfirmTools,
  ...settingsCalendarConfirmTools,
  ...settingsBusinessConfirmTools,
  ...settingsChannelConfirmTools,
  ...settingsMoneyConfirmTools,
  ...settingsMeConfirmTools,
  // Customers in bulk and any of their details, and the AI's pass over the list (0107).
  ...contactConfirmTools,
  // The rest of what people do on the screens, one file an area.
  ...inboxCrmConfirmTools,
  ...schedulingConfirmTools,
  ...billingConfirmTools,
  ...contentConfirmTools,
  ...setupConfirmTools,
  ...moreSettingsConfirmTools,
  ...extraConfirmTools,
};

/**
 * Every tool of core's the Assistant can call has one of these; worker tests check none is missing. An add-on's tools
 * need none: they all run through the one executor in tools-addons.ts.
 */
export const executorFor = (name: string) =>
  readTools[name] ??
  contactReadTools[name] ??
  settingsReadTools[name] ??
  autoWrites[name] ??
  attentionAutoTools[name] ??
  moneyReadTools[name] ??
  workflowAutoTools[name] ??
  formAutoTools[name] ??
  moreAutoTools[name] ??
  billingLinkTools[name] ??
  capabilityTools[name] ??
  mainOfferAutoTools[name] ??
  mainOfferConfirmTools[name] ??
  confirmTools[name];

/** `workflows`: the model drafting workflows talks to (without it, draft_workflow says the AI isn't set up). */
export function createToolExecutor(
  db: Db,
  workflows: WorkflowToolDeps | null = null,
  forms: FormToolDeps | null = null,
  /** The web app's address, for the links a tool sends to a customer. */
  webUrl = '',
  /** The add-ons find_capabilities knows of: every one HandsFreeOS ships, unless a test says otherwise. */
  addonCatalog: Catalog = ADDON_CATALOG,
  /** The worker's services, for the add-ons' worker actions; without them those tools can't run. */
  addonActions: AddonActionDeps | null = null,
): ToolExecutor {
  // The main offer's score and tries are the builder's own, which ask the model with the worker's AI services.
  const offerDeps = workflows ? { ...workflows, httpDb: db } : null;
  // The map, for a service area so many miles from an address: the worker's own, when it has its services.
  const settingsDeps: SettingsDeps = { geocoder: addonActions?.services.geocoder ?? null, webUrl };
  // A customer's own link is minted with the worker's link key, as Copy link mints it.
  const moneyLinks = addonActions?.services.moneyLinks ?? null;
  // A public page's path in what a tool found goes to the model as a whole link, never a path it must finish.
  const linked = (ctx: ToolContext) => (value: unknown) =>
    withWholeLinks(value, () => publicOriginFor(db, ctx, webUrl));
  const runTool = async (tool: OfferedTool, args: Args, ctx: ToolContext): Promise<ToolOutcome> => {
    // An add-on's tool is its own operation, run through the kernel as the person.
    if (isAddonAiTool(tool)) return runAddonTool(db, tool, args, ctx);
    // Or one of its worker actions, through the door its screens use.
    if (isAddonActionTool(tool)) return runAddonActionTool(addonActions, db, tool, args, ctx);
    // Or a screen's own query, as the person; or one of its commands that runs on its own.
    if (isScreenReadTool(tool)) return runScreenRead(db, tool, args, ctx, webUrl);
    if (isScreenActionTool(tool)) return runScreenAction(db, tool, args, ctx);
    const capabilities = capabilityTools[tool.name];
    if (capabilities) return capabilities(db, ctx, args, addonCatalog);
    const offer = mainOfferAutoTools[tool.name];
    if (offer) return offer(db, ctx, args, offerDeps);
    const link = billingLinkTools[tool.name];
    if (link) return link(db, ctx, args, moneyLinks);
    const run =
      readTools[tool.name] ??
      contactReadTools[tool.name] ??
      settingsReadTools[tool.name] ??
      autoWrites[tool.name] ??
      attentionAutoTools[tool.name] ??
      moneyReadTools[tool.name] ??
      moreAutoTools[tool.name];
    if (run) return run(db, ctx, args);
    const form = formAutoTools[tool.name];
    if (form) return form(db, ctx, args, forms ?? (workflows as FormToolDeps | null));
    const flow = workflowAutoTools[tool.name];
    if (!flow) throw new Error(`No executor for ${tool.name}`);
    return flow(db, ctx, args, workflows);
  };
  const prepareTool = async (
    tool: OfferedTool,
    args: Args,
    ctx: ToolContext,
    toolCallId: string,
  ): Promise<PreparedAction> => {
    if (isAddonAiTool(tool)) return prepareAddonTool(db, tool, args, ctx, toolCallId);
    if (isAddonActionTool(tool)) return prepareAddonActionTool(tool, args, toolCallId);
    if (isScreenActionTool(tool)) return prepareScreenAction(db, tool, args, ctx, toolCallId);
    const offer = mainOfferConfirmTools[tool.name];
    if (offer) return offer.prepare(db, ctx, args, toolCallId);
    const t = confirmTools[tool.name];
    if (!t) throw new Error(`No confirmation for ${tool.name}`);
    return t.prepare(db, ctx, args, toolCallId, settingsDeps);
  };
  const commitTool = async (
    tool: OfferedTool,
    args: Args,
    ctx: ToolContext,
    extra: { readonly lostReason?: string; readonly toolCallId: string },
  ): Promise<CommittedAction> => {
    if (isAddonAiTool(tool)) return commitAddonTool(db, tool, args, ctx);
    if (isAddonActionTool(tool)) return commitAddonActionTool(addonActions, db, tool, args, ctx);
    if (isScreenActionTool(tool)) return commitScreenAction(db, tool, args, ctx, webUrl);
    const offer = mainOfferConfirmTools[tool.name];
    if (offer) return offer.commit(db, ctx, args, offerDeps);
    const t = confirmTools[tool.name];
    if (!t) throw new Error(`No confirmation for ${tool.name}`);
    return t.commit(db, ctx, args, { ...extra, ...settingsDeps, webUrl });
  };
  return {
    async run(tool, args, ctx) {
      const out = await runTool(tool, args, ctx);
      return { ...out, result: await linked(ctx)(out.result) };
    },
    async prepare(tool, args, ctx, toolCallId) {
      // The card is the person's and keeps its links as the screens use them; what the model is told gets them whole.
      const out = await prepareTool(tool, args, ctx, toolCallId);
      return { ...out, result: await linked(ctx)(out.result) };
    },
    async commit(tool, args, ctx, extra) {
      // What the model reads later (the outcome and the answer kept with the call), and the link shown once on the
      // card, all get their public pages whole.
      const done = await commitTool(tool, args, ctx, extra);
      const whole = linked(ctx);
      return {
        ...done,
        outcome: (await whole(done.outcome)) as string,
        ...(done.answer !== undefined ? { answer: await whole(done.answer) } : {}),
        ...(done.shownOnce ? { shownOnce: (await whole(done.shownOnce)) as string } : {}),
      };
    },
    async undo(tool, record, ctx) {
      switch (tool.name) {
        case 'create_task':
          await command(db, ctx, 'task.delete', { taskId: record['taskId'] });
          return 'Undone. The task is gone.';
        case 'complete_task':
          await command(db, ctx, 'task.reopen', { taskId: record['taskId'] });
          return 'Undone. The task is open again.';
        case 'add_note':
          await command(db, ctx, 'activity.delete', { activityId: record['activityId'] });
          return `Undone. The ${typeof record['kind'] === 'string' ? record['kind'] : 'note'} is gone.`;
        default:
          throw HfosError.conflict(
            'This can’t be undone from here. Only a task or note the Assistant added, or a task it completed, can be.',
            'nothing_to_undo',
          );
      }
    },
    reads(tool: OfferedTool) {
      // An add-on's look-ups, and core's tools that only read: never one that writes, whatever its autonomy, nor a
      // worker action (most ask the AI, and some reach a service).
      if (isAddonAiTool(tool)) return tool.op.kind === 'query';
      if (isAddonActionTool(tool)) return false;
      if (isScreenReadTool(tool)) return true;
      if (isScreenActionTool(tool)) return false;
      return (
        tool.name in readTools ||
        tool.name in contactReadTools ||
        tool.name in settingsReadTools ||
        tool.name in moneyReadTools ||
        // A customer's link is read and signed, never written.
        tool.name in billingLinkTools ||
        tool.name in capabilityTools
      );
    },
  };
}
