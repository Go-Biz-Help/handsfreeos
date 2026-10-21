/**
 * Why a row matched, and at which tier (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How it works, 4), worked out once
 * for the server's searchers and the phone's own search (`search/copy.ts`), so a contact found by its street on the
 * phone says "Address" as it does with signal. Browser-safe: each takes a row's fields, however it was read.
 */
import { otherAddressesOf } from '../crm/contact-points';
import type { SearchHit } from '../schemas/search';
import type { SearchProbes } from './probes';
import { tierOf } from './rank';
import { digitsIn, fieldHolding, fieldSnippet, holdsAll, listedValues, wordsLeft } from './hit';

type Cell = string | null | undefined;

/** Tier, whether it was an exact identifier, and why. */
export type Explained = Pick<SearchHit, 'tier' | 'exact' | 'why'>;

const why = (field: string, snippet: SearchHit['why']['snippet'] = null): SearchHit['why'] => ({
  field,
  label: null,
  snippet,
  page: null,
});

/** "Dana Smith": first and last name, either of which may be missing. */
export const fullNameOf = (first: Cell, last: Cell): string =>
  `${first ?? ''} ${last ?? ''}`.trim();

/** A one-line address from its parts. */
const addressOf = (r: AddressFields): string =>
  [r.address_line1, r.address_line2, r.city, r.state, r.postal_code].filter(Boolean).join(', ');

/** Every other address, each on one line, together. */
const otherAddressesText = (raw: unknown): string =>
  otherAddressesOf(raw)
    .map((a) => [a.line1, a.line2, a.city, a.state, a.postalCode].filter(Boolean).join(', '))
    .join(' ');

interface AddressFields {
  readonly address_line1: Cell;
  readonly address_line2: Cell;
  readonly city: Cell;
  readonly state: Cell;
  readonly postal_code: Cell;
}

/** A customer, or a company, as its explaining reads it. Other phones, emails and addresses are parsed lists. */
interface ReachFields extends AddressFields {
  readonly email: Cell;
  readonly phone_e164: Cell;
  readonly other_phones: unknown;
  readonly other_emails: unknown;
  readonly other_addresses: unknown;
  /** The business's own fields' values together, where they're read (the server); null on the phone. */
  readonly custom_text: Cell;
}

export interface ContactFields extends ReachFields {
  readonly first_name: Cell;
  readonly last_name: Cell;
  readonly phone_alt: Cell;
  readonly company_name: Cell;
}

export interface CompanyFields extends ReachFields {
  readonly name: string;
  readonly website: Cell;
}

function phonesAndEmails(r: ReachFields): { phones: Cell[]; emails: (string | null)[] } {
  return {
    phones: [r.phone_e164, ...listedValues(r.other_phones, 'phone')],
    emails: [
      r.email?.toLowerCase() ?? null,
      ...listedValues(r.other_emails, 'email').map((e) => e.toLowerCase()),
    ],
  };
}

/**
 * A contact: a phone or an email exactly, the name, the email's domain, phone digits, then the field holding the rest.
 */
export function explainContact(r: ContactFields, p: SearchProbes): Explained {
  const { phones, emails } = phonesAndEmails(r);
  if (p.phoneE164 && phones.includes(p.phoneE164))
    return { tier: 0, exact: true, why: why('phone') };
  if (p.email && emails.includes(p.email)) return { tier: 0, exact: true, why: why('email') };
  const name = fullNameOf(r.first_name, r.last_name);
  const t = tierOf(name, p);
  if (t === 1) return { tier: 1, exact: false, why: why('name') };
  if (p.domain && emails.some((e) => e?.endsWith(`@${p.domain}`)))
    return { tier: 1, exact: false, why: why('email', fieldSnippet(r.email, p)) };
  if (t === 2) return { tier: 2, exact: false, why: why('name') };
  if (p.digits && [...phones, r.phone_alt].some((x) => digitsIn(x).includes(p.digits!)))
    return { tier: 3, exact: false, why: why('phone') };
  // Tier 3: the field holding the words the name doesn't.
  const address = addressOf(r);
  const field = fieldHolding(wordsLeft([name], p), [
    { field: 'address', text: address },
    { field: 'address', text: otherAddressesText(r.other_addresses) },
    { field: 'company', text: r.company_name },
    { field: 'email', text: emails.filter(Boolean).join(' ') },
    { field: 'field', text: r.custom_text },
    { field: 'phone', text: [...phones, r.phone_alt].filter(Boolean).join(' ') },
  ]);
  if (field === 'address')
    return { tier: 3, exact: false, why: why('address', fieldSnippet(address, p)) };
  if (field === 'company')
    return { tier: 3, exact: false, why: why('company', fieldSnippet(r.company_name, p)) };
  if (field === 'email')
    return { tier: 3, exact: false, why: why('email', fieldSnippet(r.email, p)) };
  return { tier: 3, exact: false, why: why(field ?? 'name') };
}

/** A company: as a contact, with its website as tier 1 for a domain and a field of its own. */
export function explainCompany(r: CompanyFields, p: SearchProbes): Explained {
  const { phones, emails } = phonesAndEmails(r);
  if (p.phoneE164 && phones.includes(p.phoneE164))
    return { tier: 0, exact: true, why: why('phone') };
  if (p.email && emails.includes(p.email)) return { tier: 0, exact: true, why: why('email') };
  const t = tierOf(r.name, p);
  if (t === 1) return { tier: 1, exact: false, why: why('name') };
  if (p.domain && (r.website ?? '').toLowerCase().includes(p.domain))
    return { tier: 1, exact: false, why: why('website', fieldSnippet(r.website, p)) };
  if (p.domain && emails.some((e) => e?.endsWith(`@${p.domain}`)))
    return { tier: 1, exact: false, why: why('email', fieldSnippet(r.email, p)) };
  if (t === 2) return { tier: 2, exact: false, why: why('name') };
  if (p.digits && phones.some((x) => digitsIn(x).includes(p.digits!)))
    return { tier: 3, exact: false, why: why('phone') };
  // Tier 3: the field holding the words the name doesn't.
  const address = addressOf(r);
  const field = fieldHolding(wordsLeft([r.name], p), [
    { field: 'address', text: address },
    { field: 'address', text: otherAddressesText(r.other_addresses) },
    { field: 'website', text: r.website },
    { field: 'email', text: emails.filter(Boolean).join(' ') },
    { field: 'field', text: r.custom_text },
    { field: 'phone', text: phones.filter(Boolean).join(' ') },
  ]);
  if (field === 'address')
    return { tier: 3, exact: false, why: why('address', fieldSnippet(address, p)) };
  if (field === 'website')
    return { tier: 3, exact: false, why: why('website', fieldSnippet(r.website, p)) };
  if (field === 'email')
    return { tier: 3, exact: false, why: why('email', fieldSnippet(r.email, p)) };
  return { tier: 3, exact: false, why: why(field ?? 'name') };
}

/** A lead: its title, else the name of who it's for, the company's when only the company holds the words. */
export function explainLead(
  r: { readonly title: string; readonly person_name: Cell; readonly company_name: Cell },
  p: SearchProbes,
): Explained {
  const t = tierOf(r.title, p);
  if (t) return { tier: t, exact: false, why: why('title') };
  const onCompany = !holdsAll([r.person_name], p) && holdsAll([r.company_name], p);
  const who = onCompany
    ? r.company_name
    : [r.person_name, r.company_name].filter(Boolean).join(' · ');
  return {
    tier: 3,
    exact: false,
    why: why(onCompany ? 'company' : 'customer', fieldSnippet(who, p)),
  };
}

/** A task: its title, else its notes, which are words in content. */
export function explainTask(
  r: { readonly title: string; readonly notes: Cell },
  p: SearchProbes,
): Explained {
  const t = tierOf(r.title, p);
  return t
    ? { tier: t, exact: false, why: why('title') }
    : { tier: 4, exact: false, why: why('task_notes', fieldSnippet(r.notes, p)) };
}

/** An appointment: an attendee exactly, the title, the place or who's coming, then the notes. */
export function explainAppointment(
  r: {
    readonly title: string;
    readonly address: Cell;
    readonly notes: Cell;
    /** Who's coming: their names, phones and emails together. */
    readonly attendees: Cell;
    /** Who's coming, by name: "Dana Smith, Jo Smithers". */
    readonly who: Cell;
    readonly exact_phone: boolean;
    readonly exact_email: boolean;
  },
  p: SearchProbes,
): Explained {
  if (r.exact_phone) return { tier: 0, exact: true, why: why('phone') };
  if (r.exact_email) return { tier: 0, exact: true, why: why('email') };
  const t = tierOf(r.title, p);
  if (t) return { tier: t, exact: false, why: why('title') };
  const field = fieldHolding(wordsLeft([r.title], p), [
    { field: 'address', text: r.address },
    { field: 'customer', text: r.attendees },
    { field: 'note', text: r.notes },
  ]);
  if (field === 'address')
    return { tier: 3, exact: false, why: why('address', fieldSnippet(r.address, p)) };
  if (field === 'customer')
    return { tier: 3, exact: false, why: why('customer', fieldSnippet(r.who, p)) };
  // A visit's notes are words in content (How it works, 4).
  return { tier: 4, exact: false, why: why('note', fieldSnippet(r.notes, p)) };
}
