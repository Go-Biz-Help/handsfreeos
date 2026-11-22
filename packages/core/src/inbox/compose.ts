/**
 * New message, from the Inbox (the owner, 2026-11-22: "a compose option to send a text or email" to someone who hasn't
 * written first): pick anyone, then text or email them. Their conversation opens, started if they have none, and the
 * message is written there. The web's dialog and the phone's sheet share these words, and the rule for which of the
 * two can reach someone.
 *
 * Only a text and an email can start a conversation (`conversation.open`). A website chat, Messenger and Instagram
 * begin with the customer, so they aren't offered here.
 */

/** What New message can start: a text or an email. */
export type ComposeChannel = 'sms' | 'email';
export const COMPOSE_CHANNELS: readonly ComposeChannel[] = ['sms', 'email'];

/** How to reach someone, as their record has it. */
export interface ComposeContact {
  readonly phoneE164: string | null;
  readonly email: string | null;
}

/**
 * Where each of the two would go, or null when their record has nothing for it: the number or address their
 * conversation is kept under (`conversation.open` uses the same: the main number, the main email in lower case).
 */
export function composeTargets(person: ComposeContact): Record<ComposeChannel, string | null> {
  return {
    sms: person.phoneE164?.trim() || null,
    email: person.email?.trim().toLowerCase() || null,
  };
}

/** The one New message starts on: a text when they have a number, else an email, else a text (which says why not). */
export function composeDefault(person: ComposeContact): ComposeChannel {
  const to = composeTargets(person);
  return to.sms || !to.email ? 'sms' : 'email';
}

const named = (name: string) => {
  const who = name.trim() || 'this customer';
  return who.charAt(0).toUpperCase() + who.slice(1);
};

/** Why a text or an email can't reach them, and where to fix it: the words `conversation.open` refuses with. */
export function composeMissing(channel: ComposeChannel, name: string): string {
  return channel === 'sms'
    ? `${named(name)} has no mobile number yet. Add one to their details to text them.`
    : `${named(name)} has no email address yet. Add one to their details to email them.`;
}

export const COMPOSE_WORDS = {
  /** The Inbox's button, and the title of what it opens. */
  button: 'New message',
  title: 'New message',
  description: 'Pick who it’s to, then text or email them.',
  to: 'To',
  search: 'Search by name, number or email',
  how: 'How',
  channel: { sms: 'Text', email: 'Email' } as Record<ComposeChannel, string>,
  /** The phone's two buttons, once someone is picked. */
  textThem: 'Text',
  emailThem: 'Email',
  someoneElse: 'Choose someone else',
  /** The web's button: their conversation opens with the box ready. */
  open: 'Open conversation',
  /** A company was picked on the web, where the search finds both. */
  personOnly: 'Pick a person: a text or an email goes to one customer.',
  missing: composeMissing,
  /** The phone, starting a conversation that isn't on it yet with no signal. */
  needsSignal: (name: string) =>
    `You’re offline, and ${name.trim() || 'this customer'} has no conversation on this phone yet. Try again when you have signal.`,
  /** The phone asked HandsFreeOS and got no answer. */
  notReached:
    'HandsFreeOS couldn’t be reached, so the conversation didn’t open. Try again in a minute.',
  /** HandsFreeOS has it, but it hasn't reached this phone's copy yet: pressing again opens it once it has. */
  notHereYet: 'The conversation hasn’t reached this phone yet. Try again in a moment.',
} as const;
