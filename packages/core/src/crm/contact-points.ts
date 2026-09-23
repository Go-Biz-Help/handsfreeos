/**
 * A customer's other emails, numbers and addresses (0100): the ones besides the main email, phone and address.
 * They live as JSON on the person or company, beside the columns for the main ones, and every text, email,
 * reminder and receipt still goes to the main ones. These are what else is on file: a customer who writes in
 * from their other address, or calls from their office line, is still recognised as themselves, and the team can
 * pick one of them when they want to reach the customer somewhere else.
 *
 * The `tidy…` functions do exactly what `private.tidy_other_contacts` does in the database — trim, lowercase an
 * email, drop an empty label, and drop an entry that is empty, repeats an earlier one or repeats the main one —
 * so a command can tell "already so" from what the database would store, and so the phone's copy reads the same.
 *
 * Browser-safe: the web's editor and the phone use the same functions.
 */
import type { OtherAddressOut, OtherEmailOut, OtherPhoneOut } from '../schemas/crm';
import { formatPhone } from './phone';

/** Another email on file, lowercased. */
export interface OtherEmail {
  readonly email: string;
  readonly label?: string;
}

/** Another number on file, in E.164. */
export interface OtherPhone {
  readonly phone: string;
  readonly label?: string;
}

/** Another address on file. Empty parts are left out; the country is always there. */
export interface OtherAddress {
  readonly label?: string;
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly state?: string;
  readonly postalCode?: string;
  readonly country: string;
}

/** The most of each a record keeps (the database's checks say the same). */
export const MAX_OTHER_CONTACTS = 20;

/** Labels the editors offer; anything else may be typed. */
export const CONTACT_LABELS = {
  email: ['Work', 'Personal', 'Billing', 'Other'],
  phone: ['Mobile', 'Work', 'Home', 'Office', 'Other'],
  address: ['Home', 'Work', 'Billing', 'Job site', 'Rental', 'Other'],
} as const;

/** What an entry looks like before it is tidied: from an input, a phone's copy or a row. */
type Loose = Readonly<Record<string, unknown>>;
const loose = (e: object): Loose => e as Loose;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const labelOf = (v: unknown): { readonly label?: string } => {
  const s = str(v);
  return s ? { label: s } : {};
};

/** A main address as the columns hold it, for telling whether another one repeats it. */
export interface MainAddress {
  readonly line1?: string | null;
  readonly line2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
}

/**
 * Two addresses are the same when street, second line, town, state and ZIP read the same, ignoring case: the
 * key the database builds with concat_ws, which leaves out a part that is missing altogether.
 */
export function addressKey(a: MainAddress): string {
  return [a.line1, a.line2, a.city, a.state, a.postalCode]
    .filter((v): v is string => v !== null && v !== undefined)
    .map((v) => v.trim())
    .join('|')
    .toLowerCase();
}

/** The other emails as they are stored: lowercased, each once, never the main one. */
export function tidyOtherEmails(
  list: readonly object[],
  main: string | null | undefined,
): OtherEmail[] {
  const seen = new Set<string>([str(main).toLowerCase()]);
  const out: OtherEmail[] = [];
  for (const e of list.map(loose)) {
    const email = str(e.email).toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, ...labelOf(e.label) });
  }
  return out;
}

/** The other numbers as they are stored: E.164 (the input already made them so), each once, never the main one. */
export function tidyOtherPhones(
  list: readonly object[],
  main: string | null | undefined,
): OtherPhone[] {
  const seen = new Set<string>([str(main)]);
  const out: OtherPhone[] = [];
  for (const p of list.map(loose)) {
    const phone = str(p.phone);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.push({ phone, ...labelOf(p.label) });
  }
  return out;
}

/** The other addresses as they are stored: parts trimmed, empty ones left out, each once, never the main one. */
export function tidyOtherAddresses(
  list: readonly object[],
  main: MainAddress | null | undefined,
): OtherAddress[] {
  const seen = new Set<string>(main ? [addressKey(main)] : []);
  const out: OtherAddress[] = [];
  for (const a of list.map(loose)) {
    const part = (k: string): { readonly [key: string]: string } => {
      const s = str(a[k]);
      return s ? { [k]: s } : {};
    };
    const address: OtherAddress = {
      ...labelOf(a.label),
      ...part('line1'),
      ...part('line2'),
      ...part('city'),
      ...part('state'),
      ...part('postalCode'),
      country: str(a.country).toUpperCase() || 'US',
    };
    if (!address.line1 && !address.city && !address.postalCode) continue;
    const key = addressKey(address);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

/** What makes one entry the same entry across two copies of a list: its email, its number, its address. */
export const emailKey = (e: OtherEmail): string => e.email.toLowerCase();
export const phoneKey = (p: OtherPhone): string => p.phone;

/**
 * An edited list rebased on the list as it is now (0100), entry by entry: what the editor took off comes off, what
 * they changed takes their change, what they added is added — and what somebody else added or changed since the
 * editor opened it stays, so two people adding a number at the same moment both keep theirs. When nothing changed
 * since (`base` reads the same as `now`), the edit is the list as they left it, order and all.
 */
export function rebaseList<T>(
  edited: readonly T[],
  base: readonly T[],
  now: readonly T[],
  keyOf: (entry: T) => string,
): T[] {
  const same = (a: readonly T[], b: readonly T[]) =>
    a.length === b.length && a.every((e, i) => JSON.stringify(e) === JSON.stringify(b[i]));
  if (same(base, now)) return [...edited];
  const saw = new Map(base.map((e) => [keyOf(e), e]));
  const wants = new Map(edited.map((e) => [keyOf(e), e]));
  const out: T[] = [];
  const kept = new Set<string>();
  for (const e of now) {
    const key = keyOf(e);
    // Taken off by the editor: gone, whatever became of it since.
    if (saw.has(key) && !wants.has(key)) continue;
    const mine = wants.get(key);
    const changedByEditor =
      mine !== undefined && JSON.stringify(mine) !== JSON.stringify(saw.get(key));
    out.push(changedByEditor || !saw.has(key) ? (mine ?? e) : e);
    kept.add(key);
  }
  for (const [key, e] of wants) {
    if (kept.has(key)) continue;
    // New in the edit; or changed in it after somebody else took it off, which brings it back with the change.
    const theirs = saw.get(key);
    if (theirs === undefined || JSON.stringify(theirs) !== JSON.stringify(e)) out.push(e);
  }
  return out;
}

/**
 * One list's edit, ready for mergeFields: rebased on the row when the editor said what it saw, and then counted as
 * seen as it is now — the rebase already kept whatever changed since. Without what it saw (the API, the Assistant,
 * an import), the edit is the whole list.
 */
export function listEdit<T>(
  wanted: T[] | undefined,
  saw: T[] | undefined,
  now: T[],
  keyOf: (entry: T) => string,
  tidy: (list: T[]) => T[],
): { value: T[] | undefined; base: T[] | undefined } {
  if (wanted === undefined || saw === undefined) return { value: wanted, base: saw };
  return { value: tidy(rebaseList(wanted, saw, now, keyOf)), base: now };
}

/** A list read from a row or a phone's copy (JSON, or JSON text): whatever is there, never a throw. */
function listOf(json: unknown): Loose[] {
  let v: unknown = json;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v)
    ? v.filter((e): e is Loose => !!e && typeof e === 'object' && !Array.isArray(e))
    : [];
}

export const otherEmailsOf = (json: unknown): OtherEmail[] => tidyOtherEmails(listOf(json), null);
export const otherPhonesOf = (json: unknown): OtherPhone[] => tidyOtherPhones(listOf(json), null);
export const otherAddressesOf = (json: unknown): OtherAddress[] =>
  tidyOtherAddresses(listOf(json), null);

/** How the API answers with them (the shapes are schemas/crm's OtherEmailOut, OtherPhoneOut, OtherAddressOut). */
export const otherEmailsOut = (json: unknown): OtherEmailOut[] =>
  otherEmailsOf(json).map((e) => ({ email: e.email, label: e.label ?? null }));

export const otherPhonesOut = (json: unknown): OtherPhoneOut[] =>
  otherPhonesOf(json).map((p) => ({
    phone: formatPhone(p.phone) || p.phone,
    phoneE164: p.phone,
    label: p.label ?? null,
  }));

export const otherAddressesOut = (json: unknown): OtherAddressOut[] =>
  otherAddressesOf(json).map((a) => ({
    label: a.label ?? null,
    line1: a.line1 ?? null,
    line2: a.line2 ?? null,
    city: a.city ?? null,
    state: a.state ?? null,
    postalCode: a.postalCode ?? null,
    country: a.country,
  }));

/** The answer's shapes back into what is stored: what an editor sends as the list it saw. */
export const otherEmailsStored = (list: readonly OtherEmailOut[]): OtherEmail[] =>
  tidyOtherEmails(list, null);
export const otherPhonesStored = (list: readonly OtherPhoneOut[]): OtherPhone[] =>
  tidyOtherPhones(
    list.map((p) => ({ phone: p.phoneE164, label: p.label })),
    null,
  );
export const otherAddressesStored = (list: readonly OtherAddressOut[]): OtherAddress[] =>
  tidyOtherAddresses(list, null);

/**
 * What a label reads as beside a value ("Work"), or a plain word when there is none. `kind` picks the word: an
 * unlabelled other number is "Other number".
 */
export function contactLabelWords(
  label: string | null | undefined,
  kind: 'email' | 'phone' | 'address',
): string {
  if (label?.trim()) return label.trim();
  return kind === 'email' ? 'Other email' : kind === 'phone' ? 'Other number' : 'Other address';
}
