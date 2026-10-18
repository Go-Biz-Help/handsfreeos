/**
 * Deleting for good, through the Deleted bin (20261027000400 and 20261027000800; the owner's decisions of 2026-10-08
 * are in docs/deleting.md): what the delete box, its toasts and Settings → Deleted bin say, so the web and the phone
 * say the same thing. Browser-safe; `commands/bin.ts` does the work.
 */
import { fmtAt, fmtMonthDay, localDayOf } from './calendar/when';
import type { BinContents, BinKind } from './schemas/bin';

/** Days something waits in the bin. The database sets the date (`purge_after`); this only says it. */
export const BIN_DAYS = 30;

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "a", "a and b", "a, b and c". */
function listed(parts: readonly string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The counts a delete box names, in the order people look for them. */
const COUNTED = [
  ['conversations', 'conversation'],
  ['messages', 'message'],
  ['calls', 'call'],
  ['notes', 'note'],
  ['tasks', 'task'],
  ['leads', 'lead'],
  ['bookings', 'booking'],
  ['files', 'file'],
  ['forms', 'form response'],
  ['relationships', 'relationship'],
] as const;

/** What goes with it: "3 conversations, 12 messages and 2 bookings", or null when nothing does. */
export function binContentsWords(c: BinContents): string | null {
  const parts = COUNTED.flatMap(([key, one]) => {
    const n = c[key];
    return n ? [count(n, one)] : [];
  });
  return parts.length > 0 ? listed(parts) : null;
}

/** Several things' counts added up, for a box that deletes them at once; one thing's, all it says. */
export function binContentsTotal(list: readonly BinContents[]): BinContents {
  if (list.length === 1) return list[0]!;
  const total: Partial<
    Record<(typeof COUNTED)[number][0] | 'upcoming' | 'bills' | 'people' | 'partners', number>
  > = {};
  for (const c of list)
    for (const key of [
      ...COUNTED.map(([k]) => k),
      'upcoming',
      'bills',
      'people',
      'partners',
    ] as const) {
      const n = c[key];
      if (n) total[key] = (total[key] ?? 0) + n;
    }
  return total;
}

/** A conversation's channel, as the bin lists it. */
const CHANNELS: Readonly<Record<string, string>> = {
  sms: 'Text',
  email: 'Email',
  chat: 'Website chat',
  portal: 'Client portal',
  messenger: 'Messenger',
  instagram: 'Instagram',
};

/** What the delete box, the bin and the toasts say. */
export const BIN_WORDS = {
  /** The menu item beside Archive. */
  menu: 'Delete for good…',
  submit: 'Delete for good',
  keep: (several: boolean) => (several ? 'Keep them' : 'Keep it'),
  /** Settings → Deleted bin. */
  title: 'Deleted bin',
  about: `Customers, conversations, bookings, leads, companies and records deleted for good wait here ${BIN_DAYS} days. Bring one back before then, or delete it now.`,
  emptyTitle: 'The bin is empty',
  emptyBody: `What’s deleted for good waits here ${BIN_DAYS} days, so it can be brought back.`,
  restore: 'Bring back',
  deleteNow: 'Delete now',
  emptyAll: 'Empty the bin',
  emptying: 'Being deleted now',
  deleteNowTitle: (name: string) => `Delete ${name} now?`,
  deleteNowBody: (when: string) =>
    `It’s deleted for good now rather than on ${when}, and can’t be brought back.`,
  emptyAllTitle: 'Empty the Deleted bin?',
  emptyAllBody: 'Everything in it is deleted for good now, and none of it can be brought back.',
  emptyStarted: (n: number) =>
    n === 0 ? 'Nothing left to delete.' : `Deleting ${count(n, 'thing')} for good now.`,
  kinds: {
    person: 'Customer',
    conversation: 'Conversation',
    appointment: 'Booking',
    lead: 'Lead',
    company: 'Company',
    custom_record: 'Record',
  },
  /** The box's line over what can't go yet, when it was asked to delete several. */
  blocked: (n: number) => (n === 1 ? 'This one can’t go yet:' : 'These can’t go yet:'),
  /** Deleting the rest of several when some can't go. */
  submitRest: (n: number) => (n === 1 ? 'Delete the other one' : `Delete the other ${n}`),
  /** Ticked by default on a booking still to come, as Cancel is. */
  tellCancelled: 'Tell them that it’s cancelled',
  /** The phone's buttons for a booking still to come, as its Cancel sheet asks. */
  deleteAndTell: (first: string | null) =>
    first ? `Delete and tell ${first}` : 'Delete and tell them',
  deleteQuietly: 'Delete without telling them',
  /** While the box asks what goes with them. */
  checking: (several: boolean) => `Checking what goes with ${several ? 'them' : 'it'}…`,
  /** The toast once a booking still to come is cancelled, with the customer told, and deleted. */
  cancelledTold: `Cancelled and deleted. The customer is being told. Bring it back from Settings → Deleted bin within ${BIN_DAYS} days.`,
  /** On the phone, which deletes only with a connection. */
  offline: 'Deleting needs a connection. Try again when you’re back online.',
  /** A deleted customer's page: the API says where they went, and whoever may bring them back gets a way there. */
  goneTitle: 'This customer was deleted',
  openBin: 'Open the Deleted bin',
} as const satisfies Record<string, unknown> & { kinds: Record<BinKind, string> };

/** The delete box: its title, and a line each for what goes, what stays and when it's gone. */
export interface BinDeleteBox {
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * What the delete box says before anything goes. `names` is one per thing (the customer's name for a
 * conversation); `contents` is their counts added up (`binContentsTotal`).
 */
export function binDeleteBox(
  kind: BinKind,
  names: readonly string[],
  contents: BinContents,
): BinDeleteBox {
  const n = names.length;
  const several = n > 1;
  const name = names[0] ?? 'this';
  const words = binContentsWords(contents);
  const lines: string[] = [];
  let title: string;
  if (kind === 'person') {
    title = several ? `Delete ${n} customers for good?` : `Delete ${name} for good?`;
    if (words) lines.push(`This also deletes everything only about them: ${words}.`);
    const up = contents.upcoming ?? 0;
    if (up > 0)
      lines.push(
        up === 1
          ? 'Their booking still to come is cancelled first, without telling them. To tell them, cancel it on the calendar first.'
          : `Their ${up} bookings still to come are cancelled first, without telling them. To tell them, cancel them on the calendar first.`,
      );
    const bills = contents.bills ?? 0;
    if (bills > 0)
      lines.push(
        bills === 1
          ? `Their bill stays, with just ${several ? 'the' : 'their'} name on it.`
          : `Their ${bills} bills stay, with just ${several ? 'the names' : 'their name'} on them.`,
      );
    // A partner's record goes with their contact: what they earned, and which clients were theirs.
    const partners = contents.partners ?? 0;
    if (partners > 0)
      lines.push(
        !several
          ? 'They’re one of your partners. Their partner record goes too: what they’ve earned, and which clients they sent you.'
          : partners === 1
            ? 'One of them is your partner. Their partner record goes too: what they’ve earned, and which clients they sent you.'
            : `${partners} of them are your partners. Their partner records go too: what they’ve earned, and which clients they sent you.`,
      );
  } else if (kind === 'conversation') {
    const people = new Set(names);
    title = !several
      ? `Delete the conversation with ${name} for good?`
      : people.size === 1
        ? `Delete the ${n} conversations with ${name} for good?`
        : `Delete ${n} conversations for good?`;
    if (words) lines.push(`This also deletes ${words}.`);
    lines.push(
      several
        ? 'They don’t delete anyone from Contacts.'
        : 'It doesn’t delete anyone from Contacts.',
    );
  } else if (kind === 'appointment') {
    title = 'Delete this booking for good?';
    if (words) lines.push(`This also deletes ${words}.`);
    if ((contents.upcoming ?? 0) > 0) lines.push('It’s still to come, so it’s cancelled first.');
  } else if (kind === 'lead') {
    title = several ? `Delete ${n} leads for good?` : 'Delete this lead for good?';
    if (words) lines.push(`This also deletes ${words}.`);
    const who = (contents.who ?? []).find((w): w is string => !!w);
    lines.push(
      several
        ? 'They don’t delete anyone from Contacts.'
        : who
          ? `It doesn’t delete ${who} from Contacts.`
          : 'It doesn’t delete anyone from Contacts.',
    );
  } else {
    title = several
      ? `Delete ${n} ${kind === 'company' ? 'companies' : 'records'} for good?`
      : `Delete ${name} for good?`;
    if (words)
      lines.push(`This also deletes everything only about ${several ? 'them' : 'it'}: ${words}.`);
    const people = contents.people ?? 0;
    if (kind === 'company' && people > 0)
      lines.push(
        people === 1
          ? 'The person who works there stays in Contacts.'
          : `The ${people} people who work there stay in Contacts.`,
      );
    if (kind === 'custom_record')
      lines.push(
        several
          ? 'They don’t delete anyone from Contacts.'
          : 'It doesn’t delete anyone from Contacts.',
      );
  }
  lines.push(
    kind === 'person' || several
      ? `They wait ${BIN_DAYS} days in Settings → Deleted bin, where you can bring them back. Then they’re gone for good.`
      : `It waits ${BIN_DAYS} days in Settings → Deleted bin, where you can bring it back. Then it’s gone for good.`,
  );
  return { title, lines };
}

/** The toast once they're in the bin. */
export function binDeletedWords(kind: BinKind, names: readonly string[]): string {
  const n = names.length;
  const back = `from Settings → Deleted bin within ${BIN_DAYS} days.`;
  if (kind === 'person')
    return `${n === 1 ? names[0] : `${n} customers`} deleted. Bring them back ${back}`;
  if (kind === 'conversation')
    return n === 1
      ? `Conversation deleted. Bring it back ${back}`
      : `${n} conversations deleted. Bring them back ${back}`;
  if (kind === 'lead')
    return n === 1
      ? `Lead deleted. Bring it back ${back}`
      : `${n} leads deleted. Bring them back ${back}`;
  if (kind === 'company' || kind === 'custom_record')
    return n === 1
      ? `${names[0]} deleted. Bring it back ${back}`
      : `${n} ${kind === 'company' ? 'companies' : 'records'} deleted. Bring them back ${back}`;
  return `Booking deleted. Bring it back ${back}`;
}

/** The toast once something's back: where to find it. */
export function binRestoredWords(r: {
  readonly kind: BinKind;
  readonly name: string;
  readonly joined: number;
}): string {
  if (r.kind === 'person') return `${r.name} is back in Contacts.`;
  if (r.kind === 'conversation')
    return `The conversation with ${r.name} is back in the Inbox.${
      r.joined > 0 ? ' It joined their newer conversation on the same line.' : ''
    }`;
  if (r.kind === 'lead') return `${r.name} is back in the Pipeline.`;
  if (r.kind === 'company' || r.kind === 'custom_record') return `${r.name} is back in Contacts.`;
  return `${r.name} is back on the calendar.`;
}

/** An item in the bin, as `bin.list` answers it. */
export interface BinItemLike {
  readonly kind: BinKind;
  readonly contents: BinContents;
  readonly deletedBy: { readonly name: string } | null;
  readonly deletedAt: string;
  readonly purgeAfter: string;
  readonly emptying: boolean;
}

/** What an item in the bin is: "Customer", "Lead", or a record's own kind ("Pet"). */
export function binKindLabel(item: Pick<BinItemLike, 'kind' | 'contents'>): string {
  return item.kind === 'custom_record' && item.contents.type
    ? item.contents.type
    : BIN_WORDS.kinds[item.kind];
}

/**
 * The line under an item's name: what went with a customer, a company or a record ("3 conversations and 12
 * messages"), a conversation's channel and messages ("Text · 12 messages"), a booking's time and who was on it
 * ("Thu, Oct 8 at 9:00 AM · Dana Lopez"), or whose a lead was and what went with it ("Dana Lopez · 1 task"). Null
 * when there's nothing to say.
 */
export function binItemDetail(item: BinItemLike, timeZone: string): string | null {
  const c = item.contents;
  const who = (c.who ?? []).filter((w): w is string => !!w).join(', ') || null;
  const parts =
    item.kind === 'conversation'
      ? [c.channel ? (CHANNELS[c.channel] ?? null) : null, binContentsWords(c)]
      : item.kind === 'appointment'
        ? [c.startsAt ? fmtAt(c.startsAt, timeZone) : null, who]
        : item.kind === 'lead'
          ? [who, binContentsWords(c)]
          : [binContentsWords(c)];
  const line = parts.filter((p): p is string => !!p).join(' · ');
  return line || null;
}

/** "Oct 8", with the year when it isn't this one, where the business is. */
export function binDay(at: string, timeZone: string, now = Date.now()): string {
  return fmtMonthDay(localDayOf(at, timeZone), Number(localDayOf(now, timeZone).slice(0, 4)));
}

/** "Deleted by Dale Owner on Oct 8 · Gone for good on Nov 7", or "· Being deleted now". */
export function binItemWhen(item: BinItemLike, timeZone: string, now = Date.now()): string {
  const deleted = `Deleted${item.deletedBy ? ` by ${item.deletedBy.name}` : ''} on ${binDay(item.deletedAt, timeZone, now)}`;
  return `${deleted} · ${
    item.emptying
      ? BIN_WORDS.emptying
      : `Gone for good on ${binDay(item.purgeAfter, timeZone, now)}`
  }`;
}
