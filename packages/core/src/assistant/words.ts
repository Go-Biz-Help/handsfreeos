/**
 * The Assistant's words and its small pieces of working out, in one browser-safe place (M10 step 17): the consent
 * step, the notice cards, the composer, the chats list, and everything a confirmation says once it is answered.
 * The web's panel (`apps/web/src/components/assistant`) and the phone's Ask HandsFreeOS screen both read them, so
 * neither copies the other's wording by hand.
 *
 * Icons are named, not drawn: each app maps a name to its own icon set (lucide-react on the web,
 * lucide-react-native on the phone).
 */
import type { z } from 'zod';
import type { AssistantCard, AssistantPageRecord } from '../schemas/assistant';

/** The record a question is asked from (`AssistantPageRecord`'s own shape). */
export type PageRecord = z.infer<typeof AssistantPageRecord>;

export type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;

/** Why an answer stopped short; each has its own card (design/m4/States.dc.html). */
export type AssistantNoticeCode =
  | 'budget_reached'
  | 'busy'
  | 'already_running'
  | 'failed'
  | 'stopped'
  | 'unreachable'
  | 'dropped'
  | 'forbidden';

export type AssistantNoticeIcon = 'limit' | 'offline' | 'waiting' | 'locked' | 'alert';

export interface AssistantNoticeWords {
  readonly icon: AssistantNoticeIcon;
  readonly tone: 'warning' | 'danger' | 'neutral';
  readonly title: string;
  /** The line under the title. */
  readonly sub: string;
  readonly action: 'retry' | 'reload' | null;
}

interface NoticeCopy {
  readonly icon: AssistantNoticeIcon;
  readonly tone: 'warning' | 'danger' | 'neutral';
  readonly title: (workspaceName: string) => string;
  /** The line under the title; the worker's own words when null. */
  readonly sub: string | null;
  readonly action: 'retry' | 'reload' | null;
}

const NOTICES: Record<Exclude<AssistantNoticeCode, 'stopped'>, NoticeCopy> = {
  budget_reached: {
    icon: 'limit',
    tone: 'warning',
    title: (ws) => `That’s today’s Assistant limit for ${ws}`,
    sub: 'It resets at midnight. Everything else in HandsFreeOS still works.',
    action: null,
  },
  busy: {
    icon: 'offline',
    tone: 'neutral',
    title: () => 'The Assistant is busy right now',
    sub: 'Nothing was changed. Try again in a minute.',
    action: 'retry',
  },
  unreachable: {
    icon: 'offline',
    tone: 'neutral',
    title: () => 'The Assistant isn’t reachable right now',
    sub: 'Nothing was changed. Check your connection, then try again.',
    action: 'retry',
  },
  already_running: {
    icon: 'waiting',
    tone: 'neutral',
    title: () => 'Still answering your last question',
    sub: 'It may be in another tab. Wait for it to finish, then try again.',
    action: 'retry',
  },
  dropped: {
    icon: 'offline',
    tone: 'neutral',
    title: () => 'The connection dropped',
    sub: 'The answer is saved in this chat when it finishes.',
    action: 'reload',
  },
  forbidden: {
    icon: 'locked',
    tone: 'neutral',
    title: () => 'You can’t use the Assistant here',
    sub: null,
    action: null,
  },
  failed: {
    icon: 'alert',
    tone: 'danger',
    title: () => 'Something went wrong',
    sub: 'Try again in a minute.',
    action: 'retry',
  },
};

/**
 * What a notice card says. `stopped` has no card (Stop says its own line in the chat), so it answers null.
 * `message` is what the worker said, shown where the card has no words of its own.
 */
export function assistantNotice(
  code: AssistantNoticeCode,
  { workspaceName, message }: { workspaceName: string; message: string },
): AssistantNoticeWords | null {
  if (code === 'stopped') return null;
  const copy = NOTICES[code];
  return {
    icon: copy.icon,
    tone: copy.tone,
    title: copy.title(workspaceName),
    sub: copy.sub ?? message,
    action: copy.action,
  };
}

/** The label on a notice's button, or null when the card has none. */
export function assistantNoticeAction(notice: AssistantNoticeWords): string | null {
  return notice.action === 'retry'
    ? 'Try again'
    : notice.action === 'reload'
      ? 'Reload the chat'
      : null;
}

export type ConsentPointIcon = 'chat' | 'shield' | 'check';

export interface ConsentWords {
  readonly title: string;
  readonly lead: string;
  readonly points: readonly { readonly icon: ConsentPointIcon; readonly text: string }[];
  readonly ok: string;
  readonly notNow: string;
}

/**
 * The consent step before the first question (design/m10/Assistant.dc.html, "The first time"): what is sent, that
 * nothing reaches a customer without an OK, and that the OK is kept with the account. Only the last point changes
 * with where it is read.
 */
export function assistantConsentWords(place: 'web' | 'phone'): ConsentWords {
  return {
    title: 'How the Assistant answers you',
    lead: 'What you ask about is sent to an AI service to answer you.',
    points: [
      {
        icon: 'chat',
        text: 'Your question, and the customers, messages, appointments or money it looks up to answer it.',
      },
      {
        icon: 'shield',
        text: 'Nothing goes to a customer, and nothing is booked or changed, until you say OK.',
      },
      {
        icon: 'check',
        text:
          place === 'phone'
            ? 'Your OK is kept with your account, so you won’t be asked again on your phone or on the web.'
            : 'Your OK is kept with your account, so you won’t be asked again here or on your phone.',
      },
    ],
    ok: 'OK, continue',
    notNow: 'Not now',
  };
}

/** The panel and the screen, beyond the cards themselves. */
export const ASSISTANT_WORDS = {
  title: 'Ask HandsFreeOS',
  /**
   * The composer's placeholder. The full one is what the boards draw, on the web's panel and on the phone app's own
   * screen (design/m10/Assistant.dc.html); the short one is for the web's panel at phone width, where the box has a
   * send button beside it and no room for the rest.
   */
  placeholder: { full: 'Ask anything, or tell me what to do…', compact: 'Ask HandsFreeOS…' },
  hint: 'Asks before it contacts customers or changes records',
  send: 'Send',
  stop: 'Stop',
  stopped: 'Stopped. Anything that needs your OK did not happen.',
  newChat: 'New chat',
  /** The chats list. */
  history: {
    title: 'Your chats',
    back: 'Back to the chat',
    loading: 'Loading your chats…',
    empty: 'No chats yet. Ask something and it’s saved here.',
    privacy:
      'Only you can see your chats. Anything the Assistant changes shows in the audit log as done by you, through the Assistant.',
    rename: 'Rename',
    renameTitle: 'Rename chat',
    archive: 'Archive',
    archived: 'Chat archived',
  },
  /** Today's budget is spent: the box says so rather than taking a question. */
  paused: { text: 'The Assistant is paused for today', hint: 'Back at midnight' },
  /** No model on the worker at all. */
  notAvailable: {
    title: 'The Assistant isn’t available yet',
    body: 'It hasn’t been set up for HandsFreeOS yet. Everything else works as usual.',
    hint: 'Shows until the Assistant is set up',
  },
  /**
   * The phone app built without the worker's address (`EXPO_PUBLIC_WORKER_URL`): the Assistant may well be running
   * fine, this copy of the app just can't reach it. Said apart from `notAvailable` because the fix is a new build,
   * not setting the Assistant up — and telling someone "not available yet" when it works on the web sends them
   * looking in the wrong place.
   */
  notInThisBuild: {
    title: 'The Assistant can’t be reached from this app',
    body: 'This build of the app wasn’t given the address it needs. Updating to the latest version usually fixes it — if it doesn’t, tell us from Get help.',
    hint: 'Shows until the app is built with it',
  },
  /**
   * The phone with no signal (design/m10/Assistant.dc.html, "No signal"). The Assistant is one of the few things
   * that needs it: the question stays in the chat and nothing is queued.
   */
  offline: {
    title: 'The Assistant needs signal',
    body: 'Your question is saved — ask again when you’re back online.',
    again: 'Ask again',
    works:
      'Customers, notes, photos, tasks, the calendar and most of Money keep working with no signal.',
    composer: 'The Assistant needs signal',
    hint: 'Ask again when you’re back online',
  },
  /** The first thing the screen says, before anything is asked. */
  emptyTitle: 'Ask HandsFreeOS anything',
  emptyBody: 'Ask about a customer, your day or the money you’re owed, or say what to do next.',
} as const;

/** What a confirmation card says while it waits, and once it is answered. */
export const ASSISTANT_CONFIRM_WORDS = {
  needsOk: 'Needs your OK',
  edit: 'Edit',
  cancel: 'Cancel',
  /** Cancelling an appointment: the way out keeps it. */
  keepIt: 'Keep it',
  /** A rule stops it, so there is nothing to confirm. */
  close: 'Close',
  done: 'Done.',
  failed: 'That didn’t work. Nothing was changed.',
  expired: 'Expired. You asked something else first, so nothing happened.',
  whyLost: 'Why was it lost?',
  chooseReason: 'Choose a reason',
  /**
   * Edit on a phone opens the conversation with the words in the box, and the card is cancelled there and then, so
   * the same message can't also go from the card.
   */
  editedInstead: 'You’re writing your own version instead.',
} as const;

/** How a warning on a confirmation reads: a caution, something to know, or a refusal. */
export function assistantWarningTone(kind: string): 'warning' | 'accent' | 'danger' {
  if (kind === 'blocked') return 'danger';
  if (kind === 'duplicate' || kind === 'note' || kind === 'scheduled') return 'accent';
  return 'warning';
}

const lostMove = (card: ConfirmCard) =>
  card.reasons.length > 0 || card.confirmLabel === 'Mark as lost' || /lost\?$/.test(card.title);

/** Won and Lost read green and red, like the pipeline; every other stage is open. */
export function assistantStageKind(name: string): 'open' | 'won' | 'lost' {
  return /^won$/i.test(name) ? 'won' : /^lost$/i.test(name) ? 'lost' : 'open';
}

/** Where a lead's move ends up, for the badge's colour. */
export function assistantMoveKind(card: ConfirmCard): 'open' | 'won' | 'lost' {
  return lostMove(card) ? 'lost' : /won\?$/.test(card.title) ? 'won' : 'open';
}

/** "Mike" from the To line ("Mike Johnson · (713) 555-0142"). */
function firstOfTo(card: ConfirmCard): string | null {
  return (
    card.fields
      .find((f) => f.label === 'To')
      ?.value.split(' · ')[0]
      ?.trim()
      .split(/\s+/)[0] ?? null
  );
}

/** What a cancelled card says: what did not happen, in the words of the thing it would have done. */
export function assistantCancelledText(card: ConfirmCard): string {
  const first = firstOfTo(card);
  switch (card.tool) {
    case 'send_text':
    case 'send_email':
      return first ? `Not sent. Nothing went to ${first}.` : 'Not sent.';
    case 'move_lead':
      return lostMove(card)
        ? `Not changed. It stays in ${card.stageFrom}.`
        : `Not moved. It stays in ${card.stageFrom}.`;
    case 'create_customer':
      return 'Nothing added.';
    case 'create_lead':
      return 'No lead opened.';
    case 'book_appointment':
      return 'Not booked. Nothing was added to the calendar.';
    case 'reschedule_appointment': {
      const was = card.fields.find((f) => f.label === 'Was')?.value;
      return was ? `Not moved. It stays ${was}.` : 'Not moved.';
    }
    case 'cancel_appointment':
      return 'Kept. The appointment is still on.';
    case 'start_workflow':
      return 'Not started. Nothing was sent.';
    case 'pause_workflow':
      return 'Not paused. It’s still on.';
    case 'resume_workflow':
      return 'Still paused.';
    case 'remove_contact_from_workflow':
      return 'Left in. Nothing stopped.';
    case 'answer_workflow_approval':
      return 'Not answered. It’s still waiting for a decision.';
    case 'add_knowledge_item':
      return 'Nothing added.';
    case 'handle_attention_item':
      return 'Not handled. It’s still on Home.';
    case 'update_attention_item':
      return card.confirmLabel === 'Snooze'
        ? 'Not snoozed. It’s still on Home.'
        : card.confirmLabel === 'Dismiss'
          ? 'Not dismissed. It’s still on Home.'
          : 'Not changed.';
    default:
      return 'Not changed.';
  }
}

const OPEN_LABELS: Record<string, string> = {
  start_workflow: 'See runs',
  remove_contact_from_workflow: 'See runs',
  pause_workflow: 'Open workflow',
  resume_workflow: 'Open workflow',
  answer_workflow_approval: 'See the run',
  add_knowledge_item: 'Open item',
};

/** An Action Center card opens where its result landed: the conversation, the lead, or Home. */
const attentionOpenLabel = (href: string) =>
  /\/inbox\//.test(href) ? 'Open conversation' : /\/leads\//.test(href) ? 'Open lead' : 'Open Home';

/** The link under a card that did something: where it went. */
export function assistantOpenLabel(tool: string, href: string): string {
  if (tool === 'handle_attention_item' || tool === 'update_attention_item')
    return attentionOpenLabel(href);
  return (
    OPEN_LABELS[tool] ??
    (tool === 'send_text' || tool === 'send_email'
      ? 'Open conversation'
      : tool === 'create_customer' || tool === 'update_customer'
        ? 'Open customer'
        : tool.endsWith('_lead')
          ? 'Open lead'
          : 'Open')
  );
}

/** The link under a money card: what its list is called (design/m10 "A money card": "Open invoices"). */
export function assistantMoneyOpenLabel(href: string): string {
  if (/\/money\/estimates(\?|$)/.test(href)) return 'Open estimates';
  if (/\/money\/payments(\?|$)/.test(href)) return 'Open payments';
  if (/\/money\/plans(\?|$)/.test(href)) return 'Open plans';
  if (/\/money(\?|$)/.test(href)) return 'Open invoices';
  return 'Open';
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RECORD_ROUTES: readonly (readonly [PageRecord['type'], string])[] = [
  ['person', 'customers/people'],
  ['company', 'customers/companies'],
  ['lead', 'leads'],
  ['conversation', 'inbox'],
  ['workflow_run', 'workflows/runs'],
  ['workflow', 'workflows'],
];

/**
 * The record on screen when the question is asked, so "text him" means the customer whose page is open. The phone's
 * screens sit at the web's own addresses, so both read it the same way: `/app/w/<ws>/customers/people/<id>` is a
 * person, `customers/companies/<id>` a company, `leads/<id>` a lead, `inbox/<id>` a conversation, `workflows/<id>` a
 * workflow, `workflows/runs/<id>` a run of one, and `/calendar?appt=<id>` the appointment that's open. Every other
 * page has no record.
 */
export function assistantPageRecord(
  pathname: string,
  workspaceId: string,
  appt: string | null = null,
): PageRecord | null {
  const base = `/app/w/${workspaceId}/`;
  if (!pathname.startsWith(base)) return null;
  const rest = pathname.slice(base.length);
  if (/^calendar\/?$/.test(rest))
    return appt && new RegExp(`^${UUID}$`, 'i').test(appt)
      ? { type: 'appointment', id: appt.toLowerCase() }
      : null;
  for (const [type, prefix] of RECORD_ROUTES) {
    const m = new RegExp(`^${prefix}/(${UUID})(?:/|$)`, 'i').exec(rest);
    if (m) return { type, id: m[1]!.toLowerCase() };
  }
  return null;
}

const clock = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/**
 * When a chat or an answer happened: "Today, 2:16 PM", then "Yesterday" and "Sep 10" (with the time too
 * when `time` is set).
 */
export function assistantChatWhen(
  iso: string,
  opts: { time?: boolean } = {},
  now = new Date(),
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === now.toDateString()) return `Today, ${clock(d)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day =
    d.toDateString() === yesterday.toDateString()
      ? 'Yesterday'
      : d.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
        });
  return opts.time ? `${day}, ${clock(d)}` : day;
}
