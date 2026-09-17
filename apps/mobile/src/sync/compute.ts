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

/** A customer's `search_text`: first and last name, email, `phone_e164` (not the display number), city, first line. */
export function personSearchText(
  person: Pick<
    PeopleRow,
    'first_name' | 'last_name' | 'email' | 'phone_e164' | 'city' | 'address_line1'
  >,
): string {
  return searchJoin([
    person.first_name,
    person.last_name,
    person.email,
    person.phone_e164,
    person.city,
    person.address_line1,
  ]);
}

/** A company's `search_text`: name, email, `phone_e164`, city, first line. */
export function companySearchText(
  company: Pick<CompaniesRow, 'name' | 'email' | 'phone_e164' | 'city' | 'address_line1'>,
): string {
  return searchJoin([
    company.name,
    company.email,
    company.phone_e164,
    company.city,
    company.address_line1,
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
