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
 *   threshold among it.
 * - **Categories and buttons:** what each kind of push offers. The buttons that reach a customer or approve
 *   something (Reply, Let AI handle, Let HandsFreeOS handle, Approve) need the phone unlocked first; Snooze 1 hour
 *   doesn't; Call, Review and Open open the app.
 * - **What every push carries** (`PushData`, version 1): the business, where it opens, the ids its buttons act on,
 *   and a command id for each button that runs a command, so a button pressed twice, or on two phones, does it once.
 */
import { z } from 'zod';

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
] as const;
export type PushSwitch = (typeof PUSH_SWITCHES)[number];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One of a person's push switches, from their settings: the stored choice, else on (payments: off). */
export function pushSwitchOn(settings: unknown, key: PushSwitch): boolean {
  const push = isRecord(settings) ? settings['push'] : undefined;
  const chosen = isRecord(push) ? push[key] : undefined;
  return typeof chosen === 'boolean' ? chosen : key !== 'payment';
}

/** All nine switches, as a save sends them (`settings: { push: … }`). */
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
});
export type PushSwitches = z.infer<typeof PushSwitches>;

/** A person's nine switches with their defaults filled in, ready to show or to save back whole. */
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
} as const satisfies Record<
  string,
  { readonly switch: PushSwitch; readonly buttons: readonly PushButton[] }
>;
export type PushCategory = keyof typeof PUSH_CATEGORIES;
export const PUSH_CATEGORY_IDS = Object.keys(PUSH_CATEGORIES) as [PushCategory, ...PushCategory[]];

/** The buttons of a category that run a command: the ones a push carries a command id for. */
export const commandButtonsOf = (category: PushCategory): PushButton[] =>
  PUSH_CATEGORIES[category].buttons.filter((b) => PUSH_BUTTONS[b].commands.length > 0);

// ---------- what a push carries ----------

export const PUSH_DATA_VERSION = 1;

/** The records a push is about: what its buttons act on and what the app opens. */
export const PushRefs = z.object({
  conversationId: z.uuid().optional(),
  /** The conversation's channel: Reply sends on it. */
  channel: z.enum(['sms', 'email', 'chat']).optional(),
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
});
export type PushRefs = z.infer<typeof PushRefs>;

/**
 * A push's `data`. iPhones show the title, subtitle and body from the notification itself; Android pushes are
 * data-only and the app draws them, so theirs carry the words too.
 */
export const PushData = z.object({
  v: z.literal(PUSH_DATA_VERSION),
  /** One per moment, the same on every phone it reaches. */
  notificationId: z.uuid(),
  category: z.enum(PUSH_CATEGORY_IDS),
  workspaceId: z.uuid(),
  /** The business's name, for people who work in more than one. */
  business: z.string(),
  /** Where it opens: a web path under /app/w/<business>/, as the emails link. */
  path: z.string().startsWith('/app/w/'),
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
});
export type PushData = z.infer<typeof PushData>;
