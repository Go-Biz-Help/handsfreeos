/**
 * Push notifications (M10): the words the worker and the phone app share. Browser-safe, so the app registers its
 * notification categories from the same lists the worker names them from (apps/worker/src/push/README.md is the
 * contract in prose).
 *
 * - **Switches:** `users.settings.push`, one per moment, a key of its own beside the email switches (0058). Each is
 *   on unless the person turned it off, except `payment`, which is off until they turn it on. `pushSwitchOn` reads
 *   one exactly as `private.push_on` does. A save sends them all: `user.update_profile` replaces a top-level key
 *   whole. `customerWaiting` is a new message nobody has answered yet, as it arrives; `missedCall` is a call nobody
 *   took, and the voicemail if one was left; `urgent` is what can't wait, a customer left waiting past the reply
 *   threshold among it. `supportTickets` is for HandsFreeOS's own support people alone: a new support ticket.
 *   `qualifying` is the AI teammate's: a lead qualifies, or a customer sends a file a question asked for.
 * - **Categories and buttons:** what each kind of push offers. The buttons that reach a customer or approve
 *   something (Reply, Let AI handle, Let HandsFreeOS handle, Approve) need the phone unlocked first; Snooze 1 hour
 *   doesn't; Call, Review and Open open the app.
 * - **What every push carries** (`PushData`, version 1): the business, where it opens, the ids its buttons act on,
 *   and a command id for each button that runs a command, so a button pressed twice, or on two phones, does it once.
 * - **Pushes about no business** (`STAFF_PUSH_CATEGORIES`): HandsFreeOS's support desk tells its own people about a
 *   new ticket. Such a push has no workspace and opens the desk (`/admin/…`); every other push has a business and
 *   opens under `/app/w/<business>/`.
 */
import { z } from 'zod';
import { clipLine } from './attention/wording';

// ---------- the switches ----------

export const PUSH_SWITCHES = [
  'customerWaiting',
  'missedCall',
  'urgent',
  'approval',
  'booking',
  'assigned',
  'payment',
  /** The usage wallet (M16): the balance ran out, or the card on it stopped working. */
  'wallet',
  /** Automations' "Did the job happen?": a visit you were on is over; mark it done from the push. */
  'jobs',
  /** Automations' "Connection broke": payments, a calendar, email, reviews or a phone number stopped working. */
  'connections',
  /** What an add-on the business uses needs this person to see (Real Estate step 5): a duty late, a deal at risk. */
  'addons',
  /** HandsFreeOS's support desk: someone wrote to support. Only its own support people ever get these. */
  'supportTickets',
  /**
   * The AI teammate's qualifying (20261018000400): a lead qualifies, or a customer sends the file a question asks
   * for. Only to the people the teammate's settings name ("Tell").
   */
  'qualifying',
] as const;
export type PushSwitch = (typeof PUSH_SWITCHES)[number];
/** The kinds nobody turns off (a check-in's): not a switch in Settings, and always on (`private.push_on`). */
export const ALWAYS_ON = 'safety' as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One of a person's push switches, from their settings: the stored choice, else on (payments: off). */
export function pushSwitchOn(settings: unknown, key: PushSwitch): boolean {
  const push = isRecord(settings) ? settings['push'] : undefined;
  const chosen = isRecord(push) ? push[key] : undefined;
  return typeof chosen === 'boolean' ? chosen : key !== 'payment';
}

/** Every switch, as a save sends them (`settings: { push: … }`). */
export const PushSwitches = z.object({
  customerWaiting: z.boolean(),
  missedCall: z.boolean(),
  urgent: z.boolean(),
  approval: z.boolean(),
  booking: z.boolean(),
  assigned: z.boolean(),
  payment: z.boolean(),
  wallet: z.boolean(),
  jobs: z.boolean(),
  connections: z.boolean(),
  addons: z.boolean(),
  supportTickets: z.boolean(),
  qualifying: z.boolean(),
});
export type PushSwitches = z.infer<typeof PushSwitches>;

/** A person's switches with their defaults filled in, ready to show or to save back whole. */
export function pushSwitchesOf(settings: unknown): PushSwitches {
  return Object.fromEntries(
    PUSH_SWITCHES.map((k) => [k, pushSwitchOn(settings, k)]),
  ) as PushSwitches;
}

// ---------- buttons and categories ----------

export interface PushButtonDef {
  /** The words on the button. */
  readonly title: string;
  /** The commands it runs, with the command id the push carries for it; none for a button that opens the app. */
  readonly commands: readonly string[];
  /** The phone must be unlocked (Face ID, fingerprint or its code) before it runs. */
  readonly unlock: boolean;
  /** It opens the app instead of acting from the notification. */
  readonly opensApp: boolean;
  /** Typed on the lock screen. */
  readonly textInput?: { readonly placeholder: string; readonly submit: string };
}

export const PUSH_BUTTONS = {
  reply: {
    title: 'Reply',
    commands: ['message.send'],
    unlock: true,
    opensApp: false,
    textInput: { placeholder: 'Write a reply', submit: 'Send' },
  },
  call: { title: 'Call', commands: [], unlock: false, opensApp: true },
  let_ai_handle: {
    title: 'Let AI handle',
    commands: ['conversation.hand_to_ai'],
    unlock: true,
    opensApp: false,
  },
  let_handle: {
    title: 'Let HandsFreeOS handle',
    commands: ['attention.let_handle'],
    unlock: true,
    opensApp: false,
  },
  snooze: {
    title: 'Snooze 1 hour',
    commands: ['attention.snooze'],
    unlock: false,
    opensApp: false,
  },
  approve: {
    title: 'Approve',
    commands: ['workflow.decide_approval', 'ai_teammate.decide_draft'],
    unlock: true,
    opensApp: false,
  },
  review: { title: 'Review', commands: [], unlock: false, opensApp: true },
  // "How did it go?" after a visit: marking it done or missed, or saying it's still going (ask again in an hour).
  done: { title: 'Done', commands: ['appointment.set_status'], unlock: true, opensApp: false },
  no_show: {
    title: 'Didn’t happen',
    commands: ['appointment.set_status'],
    unlock: true,
    opensApp: false,
  },
  still_there: {
    title: 'Still there',
    commands: ['appointment.still_going'],
    unlock: false,
    opensApp: false,
  },
  open: { title: 'Open', commands: [], unlock: false, opensApp: true },
  // A check-in's "Still there?" (round six): answered from the lock screen, never needing an unlock.
  im_ok: { title: 'I’m OK', commands: ['safety.check_out'], unlock: false, opensApp: false },
  add_15: { title: '+15 min', commands: ['safety.extend'], unlock: false, opensApp: false },
} as const satisfies Record<string, PushButtonDef>;
export type PushButton = keyof typeof PUSH_BUTTONS;
export const PUSH_BUTTON_IDS = Object.keys(PUSH_BUTTONS) as [PushButton, ...PushButton[]];

/** How long Snooze 1 hour snoozes for, from when it was pressed. */
export const PUSH_SNOOZE_MS = 60 * 60_000;

/**
 * Each kind of push: the switch that decides whether a person gets it, and its buttons in order.
 * - `customer_message`: a customer's new message, as it arrives. `customer_waiting`: the same conversation, still
 *   unanswered past the business's reply threshold (an urgent item). Both replace the conversation's earlier
 *   notification (`collapseId`) rather than adding another.
 * - Both buttons that hand over (Let AI handle; Let HandsFreeOS handle, whose only choice that needs no typing is
 *   handing the conversation to the AI teammate) are offered only where the business's AI teammate is on, answers
 *   that conversation's channel and isn't answering it already; the `_no_ai` kinds are the same push without them.
 */
export const PUSH_CATEGORIES = {
  customer_message: { switch: 'customerWaiting', buttons: ['reply', 'call', 'let_ai_handle'] },
  customer_message_no_ai: { switch: 'customerWaiting', buttons: ['reply', 'call'] },
  customer_waiting: { switch: 'urgent', buttons: ['reply', 'call', 'let_ai_handle'] },
  customer_waiting_no_ai: { switch: 'urgent', buttons: ['reply', 'call'] },
  urgent_lead: { switch: 'urgent', buttons: ['call', 'let_handle', 'snooze'] },
  urgent_lead_no_ai: { switch: 'urgent', buttons: ['call', 'snooze'] },
  missed_call: { switch: 'missedCall', buttons: ['call', 'reply'] },
  voicemail: { switch: 'missedCall', buttons: ['call', 'reply'] },
  approval: { switch: 'approval', buttons: ['approve', 'review'] },
  booking: { switch: 'booking', buttons: ['open'] },
  assigned: { switch: 'assigned', buttons: ['open'] },
  payment: { switch: 'payment', buttons: ['open'] },
  /**
   * The balance. On by default, unlike `payment`: a failed payment is a thing to look at when you next look,
   * and a wallet that has run out means nothing the business sends is going anywhere.
   */
  wallet: { switch: 'wallet', buttons: ['open'] },
  /** A visit you were on is over and nobody has said how it went (Automations' "Did the job happen?"). */
  job_check: { switch: 'jobs', buttons: ['done', 'no_show', 'still_there'] },
  /** Something the business connected stopped working (Automations' "Connection broke"): Open goes to fix it. */
  connection: { switch: 'connections', buttons: ['open'] },
  /**
   * An add-on's alert (app.addon_alerts): Open goes to the add-on's page. The phone opens its own screen for it when
   * this build has one (the add-on's `ui.phone`), and the web until then.
   */
  addon_alert: { switch: 'addons', buttons: ['open'] },
  /**
   * The AI teammate's qualifying (20261018000400), to whoever its settings name: a customer sent the file a question
   * asks for, like a photo of their electric bill; or a lead qualified. Open goes to the lead.
   */
  customer_file: { switch: 'qualifying', buttons: ['open'] },
  lead_qualified: { switch: 'qualifying', buttons: ['open'] },
  /**
   * Someone wrote to HandsFreeOS support, in the app or by email: a new ticket, to the support people. It belongs to
   * no business; Open goes to the ticket on the support desk.
   */
  support_ticket: { switch: 'supportTickets', buttons: ['open'] },
  /**
   * Check-ins (round six): "Still at 12 Oak St?" to the person at their planned end, with I’m OK and +15 min; and
   * to a teammate they asked to be told, that they haven't checked out (Open shows where). Never switched off:
   * a missed one is a false alarm, or nobody told.
   */
  safety_check: { switch: 'safety', buttons: ['im_ok', 'add_15'] },
  safety_alert: { switch: 'safety', buttons: ['open'] },
} as const satisfies Record<
  string,
  { readonly switch: PushSwitch | typeof ALWAYS_ON; readonly buttons: readonly PushButton[] }
>;
export type PushCategory = keyof typeof PUSH_CATEGORIES;
export const PUSH_CATEGORY_IDS = Object.keys(PUSH_CATEGORIES) as [PushCategory, ...PushCategory[]];

/**
 * The kinds sent to HandsFreeOS's own support people rather than to a business's: they carry no workspace, open the
 * support desk (`/admin/…`), and go to active support staff with the kind's switch on.
 */
export const STAFF_PUSH_CATEGORIES: readonly PushCategory[] = ['support_ticket'];
export const isStaffPush = (category: PushCategory): boolean =>
  STAFF_PUSH_CATEGORIES.includes(category);

/** The buttons of a category that run a command: the ones a push carries a command id for. */
export const commandButtonsOf = (category: PushCategory): PushButton[] =>
  PUSH_CATEGORIES[category].buttons.filter((b) => PUSH_BUTTONS[b].commands.length > 0);

// ---------- what a push carries ----------

export const PUSH_DATA_VERSION = 1;

/** The records a push is about: what its buttons act on and what the app opens. */
export const PushRefs = z.object({
  conversationId: z.uuid().optional(),
  /** The conversation's channel: Reply sends on it. */
  channel: z.enum(['sms', 'email', 'chat', 'messenger', 'instagram']).optional(),
  /** The customer's message a push about a new message is for. */
  messageId: z.uuid().optional(),
  personId: z.uuid().optional(),
  leadId: z.uuid().optional(),
  /** The Action Center item (Let HandsFreeOS handle, Snooze 1 hour). */
  itemId: z.uuid().optional(),
  /** A workflow's approval step (Approve runs workflow.decide_approval). */
  approvalId: z.uuid().optional(),
  /** An AI teammate draft (Approve runs ai_teammate.decide_draft). */
  draftId: z.uuid().optional(),
  appointmentId: z.uuid().optional(),
  taskId: z.uuid().optional(),
  invoiceId: z.uuid().optional(),
  /** An add-on's alert (app.addon_alerts). */
  alertId: z.uuid().optional(),
  /** The record an add-on's alert is about (a deal): its screen on the phone finds its notifications by it. */
  recordId: z.uuid().optional(),
  /** A support ticket (`support_ticket`). */
  ticketId: z.uuid().optional(),
  /** A check-in (`safety_check`, `safety_alert`): I’m OK and +15 min act on it. */
  checkInId: z.uuid().optional(),
});
export type PushRefs = z.infer<typeof PushRefs>;

/**
 * A push's `data`. iPhones show the title, subtitle and body from the notification itself; Android pushes are
 * data-only and the app draws them, so theirs carry the words too.
 *
 * A push about a business names it and opens under `/app/w/<business>/`. One of the staff kinds (`support_ticket`)
 * belongs to no business: `workspaceId` is null, `business` is empty, and it opens the support desk (`/admin/…`).
 * Anything else is refused, so a business push can never open the desk, nor a desk push a business.
 */
export const PushData = z
  .object({
    v: z.literal(PUSH_DATA_VERSION),
    /** One per moment, the same on every phone it reaches. */
    notificationId: z.uuid(),
    category: z.enum(PUSH_CATEGORY_IDS),
    /** The business; null only for a push to HandsFreeOS's support people. */
    workspaceId: z.uuid().nullable(),
    /** The business's name, for people who work in more than one; empty when it is about no business. */
    business: z.string(),
    /** Where it opens: a web path under /app/w/<business>/, as the emails link, or the support desk's /admin/…. */
    path: z.string().regex(/^\/(app\/w|admin)\//),
    sentAt: z.iso.datetime(),
    refs: PushRefs,
    /** The command id each button that runs a command uses (`x-hfos-command-id`). */
    commandIds: z.partialRecord(z.enum(PUSH_BUTTON_IDS), z.uuid()),
    /**
     * The notification this one replaces, where one about the same thing may already be showing (a conversation's:
     * `conversation-<id>`). iPhones get it as the collapse and thread id; Android's app replaces its own.
     */
    collapseId: z.string().max(64).optional(),
    /** An update to a notification already showing (a burst of messages): replace it without a sound or a buzz. */
    quiet: z.boolean().optional(),
    title: z.string().optional(),
    subtitle: z.string().nullable().optional(),
    body: z.string().optional(),
  })
  .refine(
    (d) =>
      isStaffPush(d.category)
        ? d.workspaceId === null && d.path.startsWith('/admin/')
        : d.workspaceId !== null && d.path.startsWith('/app/w/'),
    {
      error: 'A push opens its own business, or the support desk for a push to support people.',
      path: ['path'],
    },
  );
export type PushData = z.infer<typeof PushData>;

// ---------- the words of a staff push ----------

/** What a lock screen shows before it cuts off: the worker clips every push to these (push/payload.ts). */
export const PUSH_TEXT_MAX = { title: 64, subtitle: 64, body: 180 } as const;

/**
 * A new support ticket's notification, for HandsFreeOS's support people: "New support ticket #1042", who wrote and
 * about which business ("Dana Reed · Reed Plumbing"), and the subject with the start of what they wrote. The same
 * words wherever a new ticket is announced.
 */
export function supportTicketPushWords(ticket: {
  readonly number: number;
  readonly subject: string;
  /** What they wrote first; nothing when there is nothing yet. */
  readonly preview?: string | null;
  /** Their name, else their email address. */
  readonly requester: string;
  /** The business the ticket is about, when it is known. */
  readonly business?: string | null;
}): { title: string; about: string; body: string } {
  const subject = clipLine(ticket.subject, 80) || 'No subject';
  // The closing quote survives the phone's cut: the preview is shortened to what fits after the subject, which
  // leaves it at least 96 characters.
  const room = PUSH_TEXT_MAX.body - subject.length - 4;
  const preview = clipLine(ticket.preview ?? '', room);
  const body = preview ? `${subject}: “${preview}”` : subject;
  return {
    title: `New support ticket #${ticket.number}`,
    about: [ticket.requester, ticket.business]
      .map((p) => p?.trim())
      .filter((p): p is string => !!p)
      .join(' · '),
    body,
  };
}
