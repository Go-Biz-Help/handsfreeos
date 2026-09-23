/**
 * Browser-safe helpers for the CSV import: the fields a file can map to, header guesses, and turning
 * a row into command input. The worker and the wizard preview use the same code.
 */
export const PERSON_FIELDS = [
  'first_name',
  'last_name',
  'full_name',
  'email',
  'email_alt',
  'phone',
  'phone_alt',
  'company',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'postal_code',
  'tags',
  'notes',
  'source',
] as const;
export const COMPANY_FIELDS = [
  'name',
  'email',
  'email_alt',
  'phone',
  'phone_alt',
  'website',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'postal_code',
  'tags',
  'notes',
  'source',
] as const;
export type PersonField = (typeof PERSON_FIELDS)[number];
export type CompanyField = (typeof COMPANY_FIELDS)[number];
export const SKIP = 'skip';
/**
 * Fields several columns may map to at once: every "Home phone", "Work phone" and "Phone 2" joins the other numbers
 * (0103), and every extra email column the other emails.
 */
export const REPEATABLE_FIELDS: readonly string[] = ['phone_alt', 'email_alt'];

const GUESSES: Record<string, string[]> = {
  first_name: ['first name', 'firstname', 'first', 'given name'],
  last_name: ['last name', 'lastname', 'last', 'surname', 'family name'],
  full_name: ['name', 'full name', 'contact', 'contact name', 'customer', 'customer name'],
  email: ['email', 'e-mail', 'email address'],
  email_alt: [
    'email 2',
    'alt email',
    'other email',
    'secondary email',
    'work email',
    'personal email',
    'additional email',
  ],
  phone: ['phone', 'phone number', 'mobile', 'cell', 'telephone', 'primary phone'],
  phone_alt: [
    'phone 2',
    'alt phone',
    'other phone',
    'secondary phone',
    'home phone',
    'work phone',
    'office phone',
    'additional phone',
  ],
  company: ['company', 'business', 'organization', 'account'],
  name: ['company', 'company name', 'business', 'business name', 'name', 'account'],
  website: ['website', 'web', 'url', 'site'],
  address_line1: ['address', 'street', 'address 1', 'address line 1', 'street address'],
  address_line2: ['address 2', 'address line 2', 'unit', 'suite', 'apt'],
  city: ['city', 'town'],
  state: ['state', 'province', 'region'],
  postal_code: ['zip', 'zip code', 'postal code', 'postcode'],
  tags: ['tags', 'labels', 'groups', 'type'],
  notes: ['notes', 'note', 'comments', 'description', 'referred by'],
  source: ['source', 'lead source', 'how did you hear'],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

/** Suggests field keys for CSV headers; unknown headers map to "skip". */
export function guessMapping(
  headers: string[],
  kind: 'people' | 'companies',
): Record<string, string> {
  const fields: readonly string[] = kind === 'people' ? PERSON_FIELDS : COMPANY_FIELDS;
  const taken = new Set<string>();
  const out: Record<string, string> = {};
  for (const header of headers) {
    const h = norm(header);
    let best = SKIP;
    for (const field of fields) {
      if (taken.has(field)) continue;
      const candidates = GUESSES[field] ?? [];
      if (candidates.includes(h) || h === norm(field)) {
        best = field;
        break;
      }
    }
    if (best !== SKIP && !REPEATABLE_FIELDS.includes(best)) taken.add(best);
    out[header] = best;
  }
  return out;
}

export interface MappedPerson {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  /** Every column mapped to "Other email" and "Other phone", in column order (validated by the command). */
  otherEmails: string[];
  otherPhones: string[];
  company: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };
  tags: string[];
  notes: string | null;
  source: string | null;
}
export interface MappedCompany {
  name: string;
  email: string | null;
  phone: string | null;
  otherEmails: string[];
  otherPhones: string[];
  website: string | null;
  address: MappedPerson['address'];
  tags: string[];
  notes: string | null;
  source: string | null;
}

const cell = (
  row: Record<string, string>,
  mapping: Record<string, string>,
  field: string,
): string | null => {
  for (const [column, f] of Object.entries(mapping)) {
    if (f === field) {
      const v = row[column]?.trim();
      if (v) return v;
    }
  }
  return null;
};
/** Every value mapped to a field, in column order, each once (a repeatable field can have several columns). */
const cells = (
  row: Record<string, string>,
  mapping: Record<string, string>,
  field: string,
): string[] => {
  const out: string[] = [];
  for (const [column, f] of Object.entries(mapping)) {
    const v = f === field ? row[column]?.trim() : '';
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
};
const splitName = (full: string): [string, string] => {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return [parts[0]!, ''];
  return [parts.slice(0, -1).join(' '), parts[parts.length - 1]!];
};
const splitTags = (v: string | null): string[] =>
  v
    ? [
        ...new Set(
          v
            .split(/[;,|]/)
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ].slice(0, 20)
    : [];

/** Maps one CSV row to the shape person.create wants (phones and emails are validated by the command). */
export function mapPersonRow(
  row: Record<string, string>,
  mapping: Record<string, string>,
): MappedPerson {
  let firstName = cell(row, mapping, 'first_name') ?? '';
  let lastName = cell(row, mapping, 'last_name') ?? '';
  const full = cell(row, mapping, 'full_name');
  if (!firstName && !lastName && full) [firstName, lastName] = splitName(full);
  return {
    firstName,
    lastName,
    email: cell(row, mapping, 'email'),
    phone: cell(row, mapping, 'phone'),
    otherEmails: cells(row, mapping, 'email_alt'),
    otherPhones: cells(row, mapping, 'phone_alt'),
    company: cell(row, mapping, 'company'),
    address: {
      line1: cell(row, mapping, 'address_line1'),
      line2: cell(row, mapping, 'address_line2'),
      city: cell(row, mapping, 'city'),
      state: cell(row, mapping, 'state'),
      postalCode: cell(row, mapping, 'postal_code'),
    },
    tags: splitTags(cell(row, mapping, 'tags')),
    notes: cell(row, mapping, 'notes'),
    source: cell(row, mapping, 'source'),
  };
}

export function mapCompanyRow(
  row: Record<string, string>,
  mapping: Record<string, string>,
): MappedCompany {
  return {
    name: cell(row, mapping, 'name') ?? '',
    email: cell(row, mapping, 'email'),
    phone: cell(row, mapping, 'phone'),
    otherEmails: cells(row, mapping, 'email_alt'),
    otherPhones: cells(row, mapping, 'phone_alt'),
    website: cell(row, mapping, 'website'),
    address: {
      line1: cell(row, mapping, 'address_line1'),
      line2: cell(row, mapping, 'address_line2'),
      city: cell(row, mapping, 'city'),
      state: cell(row, mapping, 'state'),
      postalCode: cell(row, mapping, 'postal_code'),
    },
    tags: splitTags(cell(row, mapping, 'tags')),
    notes: cell(row, mapping, 'notes'),
    source: cell(row, mapping, 'source'),
  };
}
