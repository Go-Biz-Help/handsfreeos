import { balanceCents } from '@hfos/core';

import type { CompaniesRow, InvoicesRow, LeadsRow, PeopleRow } from './schema';

/**
 * What the phone works out for itself (the plan's "What the phone works out", pitfall 9). `search_text` and
 * `balance_cents` are generated columns, and Postgres 17 doesn't replicate generated columns, so they never reach the
 * phone: these give the same answers from the columns that do.
 */

/** The migrations' lower-cased join: each part, missing ones as empty, with single spaces between. */
const searchJoin = (parts: readonly (string | null | undefined)[]) =>
  parts
    .map((part) => part ?? '')
    .join(' ')
    .toLowerCase();

/** The other emails, numbers and addresses as they sync: JSON text holding a list, or nothing yet. */
type OtherContacts = Partial<Pick<PeopleRow, 'other_emails' | 'other_phones' | 'other_addresses'>>;

/** A synced JSON list's entries that are objects; anything unreadable reads as none. */
function entries(json: string | null | undefined): Record<string, unknown>[] {
  if (!json) return [];
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list)
      ? list.filter(
          (e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e),
        )
      : [];
  } catch {
    return [];
  }
}

/** Postgres's `->>`: a string as itself, any other JSON value as its JSON text, a missing one as null. */
const field = (e: Record<string, unknown>, key: string): string | null => {
  const v = e[key];
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
};

/** Postgres's `string_agg(…, ' ')`: nulls skipped, and null when nothing is left. */
const agg = (values: readonly (string | null)[]): string | null => {
  const kept = values.filter((v): v is string => v !== null);
  return kept.length ? kept.join(' ') : null;
};

/**
 * `private.other_contacts_text` (0102): the other emails, then the other numbers, then each other address's city
 * and first line — the same spaces the database leaves, so a search finds the same customers on the phone.
 */
function otherContactsText(row: OtherContacts): string {
  return [
    agg(entries(row.other_emails).map((e) => field(e, 'email'))),
    agg(entries(row.other_phones).map((e) => field(e, 'phone'))),
    agg(
      entries(row.other_addresses).map((e) =>
        [field(e, 'city'), field(e, 'line1')].filter((v) => v !== null).join(' '),
      ),
    ),
  ]
    .filter((v) => v !== null)
    .join(' ');
}

/**
 * A customer's `search_text`: first and last name, email, `phone_e164` (not the display number), city, first line,
 * then their other emails, numbers and addresses.
 */
export function personSearchText(
  person: Pick<
    PeopleRow,
    'first_name' | 'last_name' | 'email' | 'phone_e164' | 'city' | 'address_line1'
  > &
    OtherContacts,
): string {
  return searchJoin([
    person.first_name,
    person.last_name,
    person.email,
    person.phone_e164,
    person.city,
    person.address_line1,
    otherContactsText(person),
  ]);
}

/** A company's `search_text`: name, email, `phone_e164`, city, first line, then its other ways to reach it. */
export function companySearchText(
  company: Pick<CompaniesRow, 'name' | 'email' | 'phone_e164' | 'city' | 'address_line1'> &
    OtherContacts,
): string {
  return searchJoin([
    company.name,
    company.email,
    company.phone_e164,
    company.city,
    company.address_line1,
    otherContactsText(company),
  ]);
}

/** A lead's `search_text`: its title. */
export function leadSearchText(lead: Pick<LeadsRow, 'title'>): string {
  return searchJoin([lead.title]);
}

/** The web's search: the words typed, lower-cased, anywhere in the search text. */
export function matchesSearch(searchText: string, typed: string): boolean {
  return searchText.includes(typed.toLowerCase());
}

/**
 * What's still owed on an invoice, with core's own sum (the same as `invoices.balance_cents`): total less paid, and a
 * refund only ever uses up an overpayment.
 */
export function invoiceBalanceCents(
  invoice: Pick<InvoicesRow, 'total_cents' | 'amount_paid_cents' | 'amount_refunded_cents'>,
): number {
  return balanceCents(
    invoice.total_cents ?? 0,
    invoice.amount_paid_cents ?? 0,
    invoice.amount_refunded_cents ?? 0,
  );
}
