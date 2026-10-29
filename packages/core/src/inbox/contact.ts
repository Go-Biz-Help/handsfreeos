/**
 * Changing the customer without leaving their conversation (M10 step 15, continued).
 *
 * The notes half of this landed first — a note goes in the thread because in a truck "gate code 4821" belongs where
 * the texts are, not on another screen. The same argument covers the rest of the customer: the name you finally
 * learned halfway through a text thread, the number that turned out to be a mobile, the tag that says they pay late.
 * Making somebody open another screen to write any of it down is how it stops being written down.
 *
 * So both apps put the edits in the conversation, and the words for them live here so the two screens say the same
 * thing. Browser-safe: words and small pure helpers only.
 */

/** A first and last name as the person commands take them. */
export interface NameParts {
  readonly firstName: string;
  readonly lastName: string;
}

/**
 * A display name split back into first and last: everything up to the first space is the first name, the rest is the
 * last. "Mike" gives a first name and no last, which `person.create` accepts — it asks for one or the other, not both.
 *
 * Editing one line rather than two fields is what makes this worth doing: in the inbox the name is read as one line
 * ("Mike Alvarez"), so it is edited as one line, and split on the way to the command.
 */
export function splitName(full: string): NameParts {
  const trimmed = full.trim().replace(/\s+/g, ' ');
  if (!trimmed) return { firstName: '', lastName: '' };
  const cut = trimmed.indexOf(' ');
  return cut === -1
    ? { firstName: trimmed, lastName: '' }
    : { firstName: trimmed.slice(0, cut), lastName: trimmed.slice(cut + 1) };
}

const SENDER_QUOTES = new Set(['"', "'", '“', '”', '‘', '’']);

/**
 * The name an email's From line gave, as a new contact's name, or nothing: what's between quotes is kept, and a "name"
 * that is only the address again, or has no letter in it, is no name.
 */
export function nameFromSender(raw: string | null | undefined): string | null {
  // Quotes are peeled off one at a time: a regex anchored at the end slows down on a long run of them.
  const quoted = (raw ?? '').trim();
  let start = 0;
  let end = quoted.length;
  while (start < end && SENDER_QUOTES.has(quoted[start]!)) start++;
  while (end > start && SENDER_QUOTES.has(quoted[end - 1]!)) end--;
  const name = quoted.slice(start, end).trim().replace(/\s+/g, ' ');
  if (!name || name.includes('@') || !/\p{L}/u.test(name)) return null;
  return name.slice(0, 160);
}

/** The two halves back into one line, for showing what was saved. */
export const joinName = (name: NameParts): string =>
  `${name.firstName} ${name.lastName}`.trim().replace(/\s+/g, ' ');

/**
 * Why a name can't be saved, or nothing. Checked before the command so a blanked-out name in the panel says so at
 * once instead of coming back as a field error on a screen that has already moved on.
 */
export function nameProblem(full: string): string | null {
  return splitName(full).firstName ? null : CONTACT_EDIT_WORDS.nameEmpty;
}

/** Why a note can't be saved, or nothing. */
export function noteProblem(body: string): string | null {
  return body.trim() ? null : CONTACT_EDIT_WORDS.noteEmpty;
}

/**
 * What the conversation's customer panel says, on both apps.
 *
 * `edit*` name the pencil targets for a screen reader — the field itself shows the value, so the only label it can
 * carry is what editing it would do.
 */
export const CONTACT_EDIT_WORDS = {
  /** The inline fields. */
  editName: 'Edit name',
  editPhone: 'Edit phone',
  editEmail: 'Edit email',
  namePlaceholder: 'Their name',
  phonePlaceholder: 'Their number',
  emailPlaceholder: 'Their email',
  /** Shown in place of a value nobody has filled in, and tapping it starts the edit. */
  noPhone: 'Add a number',
  noEmail: 'Add an email',
  nameEmpty: 'Enter a name.',
  /** After any inline save. Short: it fires often and sits over a conversation. */
  saved: 'Saved.',
  /** Escape hatch to the whole form, for address, company, owner and source. */
  editAll: 'Edit all details',
  /** While the form's details are still coming down. */
  loading: 'Opening…',

  /** The note box in the panel. */
  noteEmpty: 'Write something.',
  notePlaceholder: 'Something the team should know…',
  noteSave: 'Add note',
  noteAdded: 'Note added.',

  /** Tags. */
  tags: 'Tags',

  /** The open lead's card. */
  stage: 'Stage',
  moved: (stage: string) => `Moved to ${stage}.`,
  nextAction: 'Set next action',
  nextActionPlaceholder: 'Call Monday with the price',
  nextActionSave: 'Set it',

  /** Money, which opens the real editor with this customer already in it. */
  newEstimate: 'New estimate',
  newInvoice: 'New invoice',

  /** An unknown number, named in the panel instead of through a dialog. */
  addTitle: 'Add them as a customer',
  addSave: 'Add customer',
  added: (name: string) => `${name} added.`,
  linkInstead: 'Or link to an existing customer',
  /** A number that already belongs to somebody: what they wanted was link, not add. */
  duplicate: 'Somebody already has this number. Link the conversation to them instead.',
  /** Out to the full form, for the times you have the address and the company too. */
  moreDetails: 'Add more details instead',
} as const;

/**
 * Adding or linking whoever wrote, from their conversation (the owner, 2026-10-29: "quickly create a new contact from
 * it or assign that email to an existing contact"), on both apps.
 */
export const SENDER_WORDS = {
  add: 'Add to Contacts',
  link: 'Link to a contact',
  linkTo: (name: string) => `Link to ${name}`,
  /** Somebody already has the address: linking them is what's wanted, not adding a second one. */
  known: (name: string) => `${name} already has this email address.`,
  linkSomeoneElse: 'Link to someone else',
  /** The phone's sheet for picking who it is. */
  linkTitle: 'Link to a contact',
  linkDescription: (counterpart: string) => `${counterpart} joins their record and timeline.`,
  search: 'Search by name, number or email',
  nobody: (typed: string) => `No one matches “${typed}”.`,
  /** Done. */
  linked: (name: string) => `Linked to ${name}.`,
} as const;
