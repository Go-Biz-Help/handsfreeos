/**
 * The search text a phone works out for itself. `search_text` is a generated column, and Postgres 17 doesn't
 * replicate generated columns, so it never reaches a phone: these give the same text from the columns that do. The
 * phone's pickers (customers, the calendar's, the AI teammate's test console) and its offline search
 * (`search/copy.ts`) read it; `apps/mobile/src/sync/compute.ts` re-exports it. Browser-safe.
 */

/** A synced column: text, or nothing yet. */
type Cell = string | null | undefined;

/** The other emails, numbers and addresses as they sync: JSON text holding a list, or nothing yet. */
export interface OtherContactCells {
  readonly other_emails?: Cell;
  readonly other_phones?: Cell;
  readonly other_addresses?: Cell;
}

/** The migrations' lower-cased join: each part, missing ones as empty, with single spaces between. */
const searchJoin = (parts: readonly Cell[]) =>
  parts
    .map((part) => part ?? '')
    .join(' ')
    .toLowerCase();

/** A synced JSON list's entries that are objects; anything unreadable reads as none. */
function entries(json: Cell): Record<string, unknown>[] {
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
 * `private.other_contacts_text` (0103): the other emails, then the other numbers, then each other address's city
 * and first line — the same spaces the database leaves, so a search finds the same customers on the phone.
 */
function otherContactsText(row: OtherContactCells): string {
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
  person: {
    readonly first_name: Cell;
    readonly last_name: Cell;
    readonly email: Cell;
    readonly phone_e164: Cell;
    readonly city: Cell;
    readonly address_line1: Cell;
  } & OtherContactCells,
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
  company: {
    readonly name: Cell;
    readonly email: Cell;
    readonly phone_e164: Cell;
    readonly city: Cell;
    readonly address_line1: Cell;
  } & OtherContactCells,
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
export function leadSearchText(lead: { readonly title: Cell }): string {
  return searchJoin([lead.title]);
}

/** The web's search: the words typed, lower-cased, anywhere in the search text. */
export function matchesSearch(searchText: string, typed: string): boolean {
  return searchText.includes(typed.toLowerCase());
}
