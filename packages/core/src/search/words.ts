/**
 * What Search everything says, on the web and the phone alike (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Words in
 * core"). Browser-safe. Clients branch on a refusal's `rule`, never on these words, so they can always improve.
 */

/** A kind's group heading, chip and line on the Search page, in the order the chips and groups use. */
export const SEARCH_KIND_LABELS = {
  contacts: 'Contacts',
  companies: 'Companies',
  leads: 'Leads',
  money: 'Money',
  messages: 'Messages',
  calendar: 'Calendar',
  tasks: 'Tasks',
  notes: 'Notes',
  files: 'Files',
  forms: 'Forms',
  knowledge: 'Knowledge',
  /** The business's own kinds together, only when they didn't answer: each answers its own group, with its plural. */
  records: 'Your own kinds of records',
  settings: 'Settings',
  spam: 'Spam',
  archived: 'Archived',
  bin: 'Deleted bin',
  close: 'Close matches',
} as const;

const quoted = (q: string) => `“${q}”`;

/** "100+" once a count was cut at 101 rows, or "20+" for a kind that reads at most 20. */
export const searchCount = (n: number, capped = false): string =>
  capped ? `${Math.min(n, 100)}+` : n > 100 ? '100+' : String(n);

/** "a", "a and b", "a, b and c". */
const listed = (parts: readonly string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

export const SEARCH_WORDS = {
  // ---- The box and its dropdown ----
  box: 'Search everything',
  recent: 'Recent searches',
  clear: 'Clear',
  best: 'Best match',
  seeAll: (n: number, capped = false) => `See all ${searchCount(n, capped)}`,
  seeAllResults: (n: number, capped = false) =>
    `See all ${searchCount(n, capped)} ${n === 1 && !capped ? 'result' : 'results'}`,
  /** "All 26", the first chip. */
  all: (n: number, capped = false) => `All ${searchCount(n, capped)}`,
  alsoFound: 'Also found:',
  exact: 'Exact match',
  alsoHas: (q: string) => `Also has ${q} in it`,
  hints: { move: 'move', open: 'open', close: 'close' },
  /** The best match's buttons, named for screen readers: "Call Dana Smith". */
  call: (name: string) => `Call ${name}`,
  text: (name: string) => `Text ${name}`,

  // ---- The Search page ----
  resultsFor: (n: number, q: string, capped = false) =>
    `${searchCount(n, capped)} ${n === 1 && !capped ? 'result' : 'results'} for ${quoted(q)}`,
  everythingIn: (business: string) => `Everything in ${business} you’re allowed to see.`,
  includeArchived: 'Include archived',
  onlyMine: 'Only mine',
  nothingIn: (labels: readonly string[]) => `Nothing in ${listed(labels)}.`,
  showMore: (n: number, plural: string) => `Show ${n} more ${plural.toLowerCase()}`,
  only: (plural: string) => `Only ${plural.toLowerCase()}`,
  tasksAndNotes: 'Tasks and notes',

  // ---- One kind ----
  named: (n: number, plural: string, q: string) =>
    `${n} ${plural.toLowerCase()} named ${quoted(q)}`,
  kindFor: (n: number, plural: string, q: string) =>
    `${n} ${plural.toLowerCase()} for ${quoted(q)}`,
  narrow: 'Add a last name, a phone number or a street to narrow it.',
  showingAll: (n: number) => `Showing all ${n}`,
  showingOf: (shown: number, total: number) => `Showing ${shown} of ${total}`,
  showMoreOf: (n: number) => `Show ${n} more`,
  sorts: { best: 'Best match', recent: 'Most recent contact', name: 'Name A–Z' },
  /** All 9 · Leads 5 · Clients 4, over one kind's contacts. */
  standing: { label: 'Leads or clients', all: 'All', leads: 'Leads', clients: 'Clients' },
  twoShare: (name: string, phone: string) =>
    `Two ${name}s share the number ${phone}. They may be the same person.`,
  twoSharePhone: (name: string) => `Two ${name}s share a number. Same person?`,
  compareAndMerge: 'Compare and merge',
  compare: 'Compare',
  sameNumber: 'Same number, maybe the same person',
  searchedBack: (plural: string, date: string) =>
    `Searched ${plural.toLowerCase()} back to ${date}.`,
  lookFurther: 'Look further back',
  lookInSpam: 'Look in Spam',

  // ---- Empty and odd states ----
  closeMatches: (q: string) => `Nothing spelled ${quoted(q)}. Showing close matches.`,
  noneActive: (q: string) => `No one active matches ${quoted(q)}.`,
  noMatches: (q: string) => `No matches for ${quoted(q)}`,
  noMatchesHelp: 'Check the spelling, or try a phone number, an email or a street.',
  ask: 'Ask HandsFreeOS',
  addContact: 'Add a contact',
  askDraft: (q: string) => `Find ${quoted(q)} in my business`,

  // ---- A group that didn't answer ----
  tooSlow: (label: string) =>
    `${label} took too long to search. Try again, or pick ${label} on its own.`,
  skipped: (label: string) =>
    `${label} wasn’t searched this time, to keep this quick. Pick ${label} on its own to search it.`,
  /** One of core's own kinds whose details couldn't be read this time. */
  failed: (label: string) => `${label} couldn’t be searched just now. Try again in a minute.`,
  /** The business's own kinds have no one chip to pick, so their lines only say Try again. */
  ownKindsTooSlow: 'Your own kinds of records took too long to search. Try again.',
  ownKindsSkipped:
    'Your own kinds of records weren’t searched this time, to keep this quick. Try again.',
  addonFailed: (name: string) => `${name} couldn’t be searched just now. Try again in a minute.`,
  tryAgain: 'Try again',

  /** A contact or a record saved with no name. */
  noName: 'No name',
  /** A note with no words of its own: a call logged with nothing written. */
  untitledNote: 'Note',

  // ---- The phone ----
  offline:
    'You’re offline, so this searched what’s on this phone. Files, messages and money show once you’re back online.',
  onThisPhone: 'On this phone',
  viewingAsOffline: (name: string) => `Searching needs signal while you’re viewing as ${name}.`,
  /** One kind's page with no signal, for a kind the phone doesn't keep, such as Messages, Money or Files. */
  needsSignal: (label: string) =>
    `Searching ${label} needs signal. It runs once you’re back online.`,
  everythingFor: (q: string) => `Search everything for ${quoted(q)}`,
  /** Leaves the phone's full-screen search. */
  cancel: 'Cancel',

  // ---- Refusals (the API, the web and the phone print the same) ----
  kindGone:
    'That kind of record isn’t in this business anymore. Search everything again, or pick another kind.',
  tookTooLong:
    'That search took too long. Add another word, or pick one kind to look in, and try again.',
  busy: 'Search is busy for a moment. Try again in a few seconds.',
  tooFast:
    'You’re searching faster than HandsFreeOS can keep up. Wait a few seconds and try again.',
} as const;

/** How a found message or thread is named, by its channel. */
const CHANNEL_WORDS: Readonly<
  Record<string, { readonly one: string; readonly thread: string; readonly from?: string }>
> = {
  sms: { one: 'Text', thread: 'Texts with', from: 'Text from' },
  email: { one: 'Email', thread: 'Emails with' },
  chat: { one: 'Chat', thread: 'Chat with' },
  portal: { one: 'Portal message', thread: 'Portal messages with' },
  messenger: { one: 'Messenger', thread: 'Messenger with' },
  instagram: { one: 'Instagram', thread: 'Instagram with' },
};
const channelWords = (channel: string) => CHANNEL_WORDS[channel] ?? CHANNEL_WORDS.chat!;

/** A message found by its words: "Text from Dana Smith", "Text to Jo Smithers", "Email · Kim Le". */
export function messageTitle(
  channel: string,
  direction: 'inbound' | 'outbound',
  who: string,
): string {
  const w = channelWords(channel);
  if (w.from) return `${direction === 'inbound' ? w.from : `${w.one} to`} ${who}`;
  return `${w.one} · ${who}`;
}

/** A thread found by who it's with, or by its number or address: "Texts with Dana Smith". */
export const threadTitle = (channel: string, who: string): string =>
  `${channelWords(channel).thread} ${who}`;

/** A call found by what was said on it: "Call · Marcus Smith". */
export const callTitle = (who: string): string => `Call · ${who}`;

/** Why a hit matched, as its chip says it. */
const WHY: Readonly<Record<string, string>> = {
  phone: 'Phone',
  email: 'Email',
  website: 'Website',
  address: 'Address',
  number: 'Number',
  amount: 'Amount',
  card: 'Card',
  company: 'Company',
  customer: 'Customer',
  message: 'In a message',
  voicemail: 'Voicemail',
  call: 'Call',
  note: 'In a note',
  task_notes: 'Task notes',
  file_name: 'File name',
  file_text: 'In the file',
  answer: 'Form answer',
  mls: 'MLS number',
  close: 'Close match',
};

/**
 * The chip beside a hit: "Phone", "In the file", a custom field's own name, or an add-on's own chip. None for a plain
 * name or title match, nor for a note or a form answer found by who it's on: the marked name says it.
 */
export function whyLabel(
  why: { readonly field: string; readonly label?: string | null },
  kind?: string,
): string | null {
  if (why.label) return why.label;
  if (why.field === 'customer' && (kind === 'notes' || kind === 'forms')) return null;
  return WHY[why.field] ?? null;
}

/**
 * A badge beside a hit's title, as both apps draw it: "Lead", "Client", "Archived", "Other mail". Null for a badge
 * said another way: an invoice's late, due and paid are its line ("6 days overdue", "Paid Sep 30"), and an anonymous
 * answer's is "Answered by someone who didn’t say who".
 */
const BADGES: Readonly<Record<string, string>> = {
  lead: 'Lead',
  client: 'Client',
  archived: 'Archived',
  done: 'Done',
  won: 'Won',
  lost: 'Lost',
  cancelled: 'Cancelled',
  void: 'Void',
  draft: 'Draft',
  other_mail: 'Other mail',
  spam: 'Spam',
  my_mail: 'My mail',
  voicemail: 'Voicemail',
  automated: 'Automated',
};
export const badgeLabel = (badge: string): string | null => BADGES[badge] ?? null;
