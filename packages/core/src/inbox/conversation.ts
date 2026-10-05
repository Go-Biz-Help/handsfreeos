/**
 * What one conversation's screen says, the same on the web and the phone (M10): the line under the customer's name,
 * the banners (not a customer yet, snoozed, closed), who it's assigned to, the actions and what each did. Browser-safe.
 */
import type { WordPart } from './composer';
import { firstName } from './list';
import { zonedWhen } from './time';

type UserRef = { readonly id: string; readonly fullName: string };

/** "Mike", the chat visitor's name, or null for a number nobody has linked. */
export function customerFirstName(
  person: { readonly fullName: string } | null,
  chatName?: string | null,
): string | null {
  if (person) return firstName(person.fullName);
  return chatName ? firstName(chatName) : null;
}

/** "Mike", "this visitor" or "this number": who a sentence about the customer names. */
export function whoOf(first: string | null, channel: 'sms' | 'email' | 'chat' | 'portal'): string {
  return (
    first ??
    (channel === 'chat' ? 'this visitor' : channel === 'portal' ? 'this client' : 'this number')
  );
}

/** A website chat's line: "Website chat · on /pricing", "Website chat · lonestarhvac.com". */
export function chatLine(
  chat: {
    readonly pagePath: string | null;
    readonly onSiteNow: boolean;
    readonly site: string | null;
  } | null,
): string {
  return `Website chat${chat?.pagePath ? ` · ${chat.onSiteNow ? 'on' : 'was on'} ${chat.pagePath}` : chat?.site ? ` · ${chat.site}` : ''}`;
}

/**
 * The line under the customer's name: "(713) 555-0142 · Texts", "mike@example.com · Email", "Texts · not in
 * Contacts yet". `short` leaves out "not in Contacts yet" where the banner already says it (the web at phone width).
 * `compact` is the phone app's header, where a portal thread is "Portal · Smith purchase" (board 92).
 */
export function threadChannelLine(
  c: {
    readonly channel: 'sms' | 'email' | 'chat' | 'portal';
    readonly counterpart: string;
    readonly counterpartDisplay: string;
    /** A portal thread's record ("12 Main St purchase"). */
    readonly record?: { readonly name: string } | null;
  },
  person: { readonly phone: string | null } | null,
  opts: {
    readonly chat?: Parameters<typeof chatLine>[0];
    readonly short?: boolean;
    readonly compact?: boolean;
  } = {},
): string {
  if (c.channel === 'chat') return chatLine(opts.chat ?? null);
  if (c.channel === 'portal') {
    const word = opts.compact ? 'Portal' : 'Client portal';
    return c.record ? `${word} · ${c.record.name}` : word;
  }
  if (c.channel === 'email') return `${c.counterpart} · Email`;
  if (person) return `${person.phone ?? c.counterpartDisplay} · Texts`;
  return opts.short ? 'Texts' : 'Texts · not in Contacts yet';
}

/**
 * "All lines" (0089): every lane of the customer woven into one timeline, each item saying which of the business's
 * lines it was on. It reads and never writes: a reply has to leave from a line, and "all" is not one, so the box
 * gives way to `note` and the switcher above is where somebody picks.
 */
export const ALL_LINES_WORDS = {
  label: 'All lines',
  note: 'Reading every line at once. Pick a line above to reply.',
  /** Above each item: "To Front desk · (713) 555-0100" for what came in, "From info@…" for what went out. */
  line: (direction: 'inbound' | 'outbound', lineDisplay: string): string =>
    `${direction === 'inbound' ? 'To' : 'From'} ${lineDisplay}`,
} as const;

/** "(713) 555-0142 isn’t a customer yet. Add them, or link the number to someone you already have." */
export function notCustomerBanner(
  counterpartDisplay: string,
  channel: 'sms' | 'email' | 'chat' | 'portal',
): { readonly parts: readonly WordPart[]; readonly short: string; readonly action: string } {
  return {
    parts: [
      { strong: `${counterpartDisplay} isn’t a customer yet.` },
      ` Add them, or link the ${channel === 'chat' ? 'chat' : 'number'} to someone you already have.`,
    ],
    short: 'Not in Contacts yet.',
    action: 'Add person',
  };
}

/** "Snoozed until 3:10 PM. It comes back sooner if Mike writes again." */
export function snoozedBanner(
  snoozedUntil: string,
  who: string,
  timeZone: string,
  now = new Date(),
): { readonly parts: readonly WordPart[]; readonly action: string } {
  return {
    parts: [
      'Snoozed until ',
      { strong: zonedWhen(new Date(snoozedUntil), timeZone, now) },
      `. It comes back sooner if ${who} writes again.`,
    ],
    action: 'Unsnooze',
  };
}

/** "Closed. A new message from Mike opens it again." */
export const closedBanner = (who: string): { readonly text: string; readonly action: string } => ({
  text: `Closed. A new message from ${who} opens it again.`,
  action: 'Reopen',
});

/** Who a conversation is assigned to, on its Assign button: "You", "Marco", or null. */
export function assigneeShort(assignee: UserRef | null, myUserId: string): string | null {
  return assignee ? (assignee.id === myUserId ? 'You' : firstName(assignee.fullName)) : null;
}

/** "Marco Diaz (you)" in the Assign to list. */
export const memberLabel = (member: UserRef, myUserId: string): string =>
  member.id === myUserId ? `${member.fullName} (you)` : member.fullName;

/** What each change to a conversation says once it's done. */
export const CONVERSATION_DONE = {
  assigned: (userId: string | null, myUserId: string, fullName?: string) =>
    userId === null
      ? 'Unassigned'
      : userId === myUserId
        ? 'Assigned to you'
        : `Assigned to ${firstName(fullName ?? '')}`,
  closed: (who: string) => `Closed. A new message from ${who} opens it again.`,
  closedShort: 'Closed. A new message opens it again.',
  /** conversation.close_all: one line whether it closed four lanes or none (0089). */
  closedAll: (n: number) =>
    n === 0
      ? 'Nothing left to close.'
      : n === 1
        ? 'Closed. A new message opens it again.'
        : `Closed all ${n} conversations. A new message opens one again.`,
  reopened: 'Back in the inbox',
  snoozed: (when: string) => `Snoozed until ${when}`,
  snoozedTomorrow: (time: string) => `Snoozed until tomorrow ${time}`,
  markedUnread: 'Marked as unread',
  archived: 'Archived. It is out of the inbox.',
  restored: 'Back in the inbox.',
  retrying: 'Sending it again',
  heldCancelled: 'Cancelled. That text won’t go.',
  /** A failed text sent again in quiet hours, cancelled: it goes back as it was. */
  retryCancelled: 'Cancelled. It stays as not delivered, and you can send it again later.',
  linked: 'Added to Contacts and linked',
  /** conversation.move (M19): where it went, and whether the sender's next mail follows. */
  moved: (folder: 'inbox' | 'other' | 'spam', remembered: boolean) =>
    `${folder === 'inbox' ? 'Moved to the Inbox' : folder === 'other' ? 'Moved to Other mail' : 'Moved to Spam'}.${
      remembered
        ? folder === 'inbox'
          ? ' Their next email lands in the Inbox too.'
          : folder === 'other'
            ? ' Their next email lands in Other mail too.'
            : ' Their next email lands in Spam too.'
        : ''
    }`,
  /** Nothing moved: it was there already. */
  alreadyThere: 'It’s already there.',
  /** conversation.share (M19): out of the person's own mail and into the team's Inbox. */
  shared: 'Shared with the team. It’s in the team’s Inbox now.',
} as const;

/** The actions on a conversation, as its menus and the phone's sheet name them. */
export const CONVERSATION_ACTIONS = {
  call: 'Call',
  openCustomer: 'Open customer',
  addPerson: 'Add as a new person',
  assign: 'Assign',
  assignTo: 'Assign to',
  nobody: 'Nobody',
  handTo: (name: string) => `Hand to ${name}`,
  snooze: 'Snooze',
  close: 'Close',
  closeConversation: 'Close conversation',
  /** Every line this customer writes on, at once (0089). */
  closeAll: 'Close every line',
  reopen: 'Reopen',
  markUnread: 'Mark as unread',
  archive: 'Archive this conversation',
  restore: 'Bring it back',
  copyPhone: 'Copy phone number',
  copyEmail: 'Copy email address',
  details: 'Details and actions',
  customerDetails: 'Customer details',
  back: 'Back to the inbox',
  takeOver: 'Take over',
  takeIt: 'Take it',
  handBack: 'Hand back',
  handBackTo: (name: string) => `Hand back to ${name}`,
  keepIt: 'Keep it',
  /** Email threads between the Inbox, Other mail and Spam (M19). */
  moveToInbox: 'Move to Inbox',
  moveToOther: 'Move to Other mail',
  moveToSpam: 'Move to Spam',
  notSpam: 'Not spam',
  /** Remembered for the sender, so their next new thread goes to the same place. */
  moveSenderToInbox: 'Always put their mail in the Inbox',
  moveSenderToOther: 'Always put their mail in Other mail',
  moveSenderToSpam: 'Always put their mail in Spam',
  /** Someone's own mail (M19): only they see it until they share it. */
  share: 'Share with the team',
} as const;

/** What a thread in someone's own mail says about itself (M19). */
export const PRIVATE_THREAD_WORDS = {
  badge: 'Only you',
  banner: 'Only you can see this. Share it with the team to hand it to them.',
  /** Beside My mail in the inbox. */
  onlyYou: 'only you see it',
  back: 'Team inbox',
  /** Where a customer's details would be. */
  panel:
    'Mail to your own address stays out of Contacts while it’s yours. Share it with the team to add them as a customer.',
} as const;

/** The details sheet's line under the name: "(713) 555-0142 · Customer since 2021", or "Not in Contacts yet". */
export function customerSinceLine(
  person: { readonly phone: string | null; readonly customerSince: string } | null,
  c: {
    readonly channel: 'sms' | 'email' | 'chat' | 'portal';
    readonly counterpart: string;
    readonly counterpartDisplay: string;
  },
): string {
  if (!person) return 'Not in Contacts yet';
  const contact =
    c.channel === 'email'
      ? c.counterpart
      : c.channel === 'portal'
        ? (person.phone ?? 'Client portal')
        : (person.phone ?? c.counterpartDisplay);
  return `${contact} · Customer since ${new Date(person.customerSince).getFullYear()}`;
}

/** A business with no number yet: texting starts once it has one. */
export const NO_NUMBER_WORDS = {
  title: 'Text customers from HandsFreeOS',
  body: 'Get a business number first. It takes about two minutes, and calls work right away.',
  setUp: 'Set up texting',
  askAdmin: 'Ask an owner or admin to set up texting.',
} as const;

/** One way to move an email thread from where it is (M19), as `mailMoves` lists them. */
export interface MailMove {
  readonly folder: 'inbox' | 'other' | 'spam';
  /** Remembered for the sender, so their next new thread goes to the same place. */
  readonly remember: boolean;
  readonly label: string;
}

/**
 * Where an email thread can go from the folder it's in (M19), as a thread's menu and the phone's sheet list them: the
 * other two folders once, then, for the team's threads only, the same with the sender remembered. Out of Spam, "Not
 * spam" puts it in Other mail, and Move to Inbox goes a step further. Someone's own mail moves one thread at a time,
 * since where a sender's mail goes is the team's to say.
 */
export function mailMoves(folder: 'inbox' | 'other' | 'spam', ownMail: boolean): MailMove[] {
  const to =
    folder === 'inbox'
      ? (['other', 'spam'] as const)
      : folder === 'other'
        ? (['inbox', 'spam'] as const)
        : (['other', 'inbox'] as const);
  const once = to.map((f) => ({
    folder: f,
    remember: false,
    label:
      f === 'inbox'
        ? CONVERSATION_ACTIONS.moveToInbox
        : f === 'other'
          ? folder === 'spam'
            ? CONVERSATION_ACTIONS.notSpam
            : CONVERSATION_ACTIONS.moveToOther
          : CONVERSATION_ACTIONS.moveToSpam,
  }));
  if (ownMail) return once;
  const always = to.map((f) => ({
    folder: f,
    remember: true,
    label:
      f === 'inbox'
        ? CONVERSATION_ACTIONS.moveSenderToInbox
        : f === 'other'
          ? CONVERSATION_ACTIONS.moveSenderToOther
          : CONVERSATION_ACTIONS.moveSenderToSpam,
  }));
  return [...once, ...always];
}
