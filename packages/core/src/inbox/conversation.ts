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
export function whoOf(first: string | null, channel: 'sms' | 'email' | 'chat'): string {
  return first ?? (channel === 'chat' ? 'this visitor' : 'this number');
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
 * Customers yet". `short` leaves out "not in Customers yet" where the banner already says it (the web at phone width).
 */
export function threadChannelLine(
  c: {
    readonly channel: 'sms' | 'email' | 'chat';
    readonly counterpart: string;
    readonly counterpartDisplay: string;
  },
  person: { readonly phone: string | null } | null,
  opts: { readonly chat?: Parameters<typeof chatLine>[0]; readonly short?: boolean } = {},
): string {
  if (c.channel === 'chat') return chatLine(opts.chat ?? null);
  if (c.channel === 'email') return `${c.counterpart} · Email`;
  if (person) return `${person.phone ?? c.counterpartDisplay} · Texts`;
  return opts.short ? 'Texts' : 'Texts · not in Customers yet';
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
  channel: 'sms' | 'email' | 'chat',
): { readonly parts: readonly WordPart[]; readonly short: string; readonly action: string } {
  return {
    parts: [
      { strong: `${counterpartDisplay} isn’t a customer yet.` },
      ` Add them, or link the ${channel === 'chat' ? 'chat' : 'number'} to someone you already have.`,
    ],
    short: 'Not in Customers yet.',
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
  linked: 'Added to Customers and linked',
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
} as const;

/** The details sheet's line under the name: "(713) 555-0142 · Customer since 2021", or "Not in Customers yet". */
export function customerSinceLine(
  person: { readonly phone: string | null; readonly customerSince: string } | null,
  c: {
    readonly channel: 'sms' | 'email' | 'chat';
    readonly counterpart: string;
    readonly counterpartDisplay: string;
  },
): string {
  if (!person) return 'Not in Customers yet';
  const contact = c.channel === 'email' ? c.counterpart : (person.phone ?? c.counterpartDisplay);
  return `${contact} · Customer since ${new Date(person.customerSince).getFullYear()}`;
}

/** A business with no number yet: texting starts once it has one. */
export const NO_NUMBER_WORDS = {
  title: 'Text customers from HandsFreeOS',
  body: 'Get a business number first. It takes about two minutes, and calls work right away.',
  setUp: 'Set up texting',
  askAdmin: 'Ask an owner or admin to set up texting.',
} as const;
