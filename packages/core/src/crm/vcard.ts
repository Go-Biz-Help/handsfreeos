/**
 * Contacts from a vCard file (.vcf), as phones and mail apps export them: an iPhone's or a Mac's Contacts, Google
 * Contacts, Outlook and Android, in vCard 2.1, 3.0 or 4.0. Browser-safe.
 *
 * Read for the Assistant's contacts import (docs/business-cards.md, "Many contacts at once, from the Assistant"):
 * what a person has a box for (name, phones, emails, company, address) goes in it, and what they don't (job title,
 * website, birthday) leads their note, as a scanned business card's does. Photos, groups and the rest are left out.
 */
import { BUSINESS_CARD_WORDS } from './business-card';
import { MAX_OTHER_CONTACTS } from './contact-points';

/** One contact as a vCard has it. */
export interface VcardContact {
  readonly firstName: string;
  readonly lastName: string;
  /** Its FN line: the name as the app shows it, used when it has no N line. */
  readonly fullName: string;
  /** The preferred one first. */
  readonly emails: readonly string[];
  /** The preferred one first, else a mobile number. */
  readonly phones: readonly string[];
  readonly company: string | null;
  readonly jobTitle: string | null;
  readonly website: string | null;
  readonly address: {
    readonly line1: string | null;
    readonly line2: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
  } | null;
  /** As the card says it: 1985-04-12, or --04-12 with no year. */
  readonly birthday: string | null;
  readonly note: string | null;
}

/** A line of a vCard, unfolded: `item1.TEL;TYPE=CELL:+1 555…` as name, its parameters and its raw value. */
interface Line {
  readonly name: string;
  readonly params: ReadonlyMap<string, readonly string[]>;
  /** Bare parameters, as vCard 2.1 writes types: `TEL;CELL;PREF:…`. */
  readonly bare: readonly string[];
  readonly value: string;
}

const isQuotedPrintable = (head: string) => /;\s*(encoding=)?quoted-printable\b/i.test(head);

/** The lines of a file, each folded line joined back to the one it continues. */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const last = out.length - 1;
    const prev = out[last];
    const head = prev === undefined ? '' : prev.slice(0, prev.indexOf(':') + 1 || prev.length);
    const qp = prev !== undefined && isQuotedPrintable(head);
    if (prev !== undefined && (raw.startsWith(' ') || raw.startsWith('\t'))) {
      // A folded line: its first space is the fold's. A quoted-printable soft break before it goes too.
      out[last] = (qp && prev.endsWith('=') ? prev.slice(0, -1) : prev) + raw.slice(1);
    } else if (prev !== undefined && qp && prev.endsWith('=')) {
      // vCard 2.1's quoted-printable soft break: "=" at the end, the value going on at the start of the next line.
      out[last] = prev.slice(0, -1) + raw;
    } else out.push(raw);
  }
  return out;
}

function lineOf(raw: string): Line | null {
  const colon = raw.indexOf(':');
  if (colon <= 0) return null;
  const [rawName = '', ...rawParams] = raw.slice(0, colon).split(';');
  // A group goes before a dot ("item1.EMAIL"), and only the name after it matters.
  const name = rawName
    .slice(rawName.lastIndexOf('.') + 1)
    .trim()
    .toUpperCase();
  if (!name) return null;
  const params = new Map<string, string[]>();
  const bare: string[] = [];
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq < 0) {
      if (p.trim()) bare.push(p.trim().toUpperCase());
      continue;
    }
    const key = p.slice(0, eq).trim().toUpperCase();
    const values = p
      .slice(eq + 1)
      .split(',')
      .map((v) => v.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    params.set(key, [...(params.get(key) ?? []), ...values]);
  }
  return { name, params, bare, value: raw.slice(colon + 1) };
}

/** Quoted-printable bytes as text, in the line's charset (UTF-8 unless it says otherwise). */
function fromQuotedPrintable(value: string, charset: string | undefined): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    const hex = value.slice(i + 1, i + 3);
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      const code = c.charCodeAt(0);
      if (code < 0x80) bytes.push(code);
      else bytes.push(...new TextEncoder().encode(c));
    }
  }
  const label = /^(iso-8859-1|latin1|windows-1252)$/i.test(charset ?? '')
    ? 'windows-1252'
    : 'utf-8';
  return new TextDecoder(label).decode(new Uint8Array(bytes));
}

const types = (line: Line): string[] => [
  ...(line.params.get('TYPE') ?? []).map((t) => t.toUpperCase()),
  ...line.bare,
];
const preferred = (line: Line) => types(line).includes('PREF') || line.params.has('PREF');

/** A line's value as text: decoded, and split at unescaped `;` into its parts when `parts`. */
function textOf(line: Line): string;
function textOf(line: Line, parts: true): string[];
function textOf(line: Line, parts?: true): string | string[] {
  const encoding = (line.params.get('ENCODING')?.[0] ?? '').toUpperCase();
  const raw =
    encoding === 'QUOTED-PRINTABLE' || line.bare.includes('QUOTED-PRINTABLE')
      ? fromQuotedPrintable(line.value, line.params.get('CHARSET')?.[0])
      : line.value;
  const pieces: string[] = [''];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw[++i]!;
      pieces[pieces.length - 1] += next === 'n' || next === 'N' ? '\n' : next;
    } else if (c === ';' && parts) pieces.push('');
    else pieces[pieces.length - 1] += c;
  }
  const tidy = pieces.map((p) => p.replace(/[ \t]+/g, ' ').trim());
  return parts ? tidy : tidy.join(';');
}

/** Values of one kind, the preferred ones first, each once. */
function ranked(
  lines: readonly Line[],
  name: string,
  clean: (v: string) => string,
  first?: (l: Line) => boolean,
) {
  const of = lines.filter((l) => l.name === name);
  const order = [
    ...of.filter(preferred),
    ...of.filter((l) => !preferred(l) && first?.(l)),
    ...of.filter((l) => !preferred(l) && !first?.(l)),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of order) {
    const v = clean(textOf(line));
    const key = v.toLowerCase().replace(/[^a-z0-9@+]/g, '');
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

const firstText = (lines: readonly Line[], name: string) =>
  lines
    .filter((l) => l.name === name)
    .map((l) => textOf(l))
    .find(Boolean) ?? null;

function contactOf(lines: readonly Line[]): VcardContact | null {
  const n = lines.find((l) => l.name === 'N');
  const [family = '', given = '', middle = ''] = n ? textOf(n, true) : [];
  const fullName = firstText(lines, 'FN') ?? '';
  const emails = ranked(lines, 'EMAIL', (v) => v.replace(/^mailto:/i, '').trim());
  const phones = ranked(
    lines,
    'TEL',
    (v) => v.replace(/^tel:/i, '').trim(),
    (l) => types(l).some((t) => t === 'CELL' || t === 'MOBILE' || t === 'IPHONE'),
  );
  const org = lines.find((l) => l.name === 'ORG');
  const company = org ? (textOf(org, true).find(Boolean) ?? null) : null;
  const adrLine =
    lines.find((l) => l.name === 'ADR' && preferred(l)) ?? lines.find((l) => l.name === 'ADR');
  const [, extended = '', street = '', city = '', region = '', postal = ''] = adrLine
    ? textOf(adrLine, true)
    : [];
  const streetLines = street
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const line1 = streetLines[0] ?? null;
  const line2 = [...streetLines.slice(1), extended].filter(Boolean).join(', ') || null;
  const address =
    line1 || line2 || city || region || postal
      ? {
          line1,
          line2,
          city: city || null,
          state: region || null,
          postalCode: postal || null,
        }
      : null;
  const contact: VcardContact = {
    firstName: [given, middle].filter(Boolean).join(' '),
    lastName: family,
    fullName,
    emails,
    phones,
    company,
    jobTitle: firstText(lines, 'TITLE'),
    website: ranked(lines, 'URL', (v) => v.trim())[0] ?? null,
    address,
    birthday: firstText(lines, 'BDAY'),
    note: firstText(lines, 'NOTE'),
  };
  const anything =
    contact.firstName ||
    contact.lastName ||
    contact.fullName ||
    emails.length ||
    phones.length ||
    company;
  return anything ? contact : null;
}

/** Every contact in a vCard file, in the file's order. Text outside BEGIN:VCARD … END:VCARD is passed over. */
export function parseVcards(text: string): VcardContact[] {
  const out: VcardContact[] = [];
  let card: Line[] | null = null;
  let depth = 0;
  for (const raw of unfold(text)) {
    const line = lineOf(raw);
    if (!line) continue;
    const value = line.value.trim().toUpperCase();
    if (line.name === 'BEGIN' && value === 'VCARD') {
      // A vCard inside another (an AGENT) is passed over with its parent's lines.
      if (depth++ === 0) card = [];
      continue;
    }
    if (line.name === 'END' && value === 'VCARD') {
      if (--depth === 0 && card) {
        const contact = contactOf(card);
        if (contact) out.push(contact);
        card = null;
      }
      depth = Math.max(0, depth);
      continue;
    }
    if (card && depth === 1) card.push(line);
  }
  return out;
}

/** Whether text looks like a vCard file: it has a BEGIN:VCARD line. */
export const looksLikeVcard = (text: string): boolean => /^\s*BEGIN:VCARD\s*$/im.test(text);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A vCard birthday as people say it: "Apr 12, 1985", or "Apr 12" with no year; as written when it's neither. */
export function vcardBirthday(value: string): string {
  const v = value.trim();
  const full = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(v);
  const noYear = /^--(\d{2})-?(\d{2})$/.exec(v);
  const [month, day, year] = full
    ? [Number(full[2]), Number(full[3]), full[1]]
    : noYear
      ? [Number(noYear[1]), Number(noYear[2]), null]
      : [0, 0, null];
  if (month < 1 || month > 12 || day < 1 || day > 31) return v;
  return `${MONTHS[month - 1]} ${day}${year && year !== '1604' ? `, ${year}` : ''}`;
}

/** The note lines for what a person has no box for, then the card's own note, as a scanned card's note leads. */
export function vcardNote(c: VcardContact): string | null {
  const lines = [
    c.jobTitle ? BUSINESS_CARD_WORDS.jobTitleLine(c.jobTitle) : '',
    c.website ? BUSINESS_CARD_WORDS.websiteLine(c.website) : '',
    c.birthday ? `Birthday: ${vcardBirthday(c.birthday)}` : '',
    c.note ?? '',
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}

/**
 * Contacts as a spreadsheet the CSV import reads (crm/import-mapping): its headers, a row a contact, and which field
 * each header is. Extra emails and numbers go in columns of their own, up to MAX_OTHER_CONTACTS each.
 */
export function vcardTable(contacts: readonly VcardContact[]): {
  readonly headers: string[];
  readonly rows: Record<string, string>[];
  readonly mapping: Record<string, string>;
} {
  const most = (count: (c: VcardContact) => number) =>
    Math.min(
      MAX_OTHER_CONTACTS,
      contacts.reduce((n, c) => Math.max(n, count(c) - 1), 0),
    );
  const extraEmails = most((c) => c.emails.length);
  const extraPhones = most((c) => c.phones.length);
  const columns: [string, string][] = [
    ['First name', 'first_name'],
    ['Last name', 'last_name'],
    ['Name', 'full_name'],
    ['Email', 'email'],
    ...Array.from({ length: extraEmails }, (_, i): [string, string] => [
      `Other email ${i + 1}`,
      'email_alt',
    ]),
    ['Phone', 'phone'],
    ...Array.from({ length: extraPhones }, (_, i): [string, string] => [
      `Other phone ${i + 1}`,
      'phone_alt',
    ]),
    ['Company', 'company'],
    ['Address', 'address_line1'],
    ['Address line 2', 'address_line2'],
    ['City', 'city'],
    ['State', 'state'],
    ['ZIP', 'postal_code'],
    ['Notes', 'notes'],
  ];
  const rows = contacts.map((c) => {
    // With no first or last name, the import splits Name; with none at all, the company is the name.
    const name = c.firstName || c.lastName ? '' : c.fullName || c.company || '';
    const row: Record<string, string> = {
      'First name': c.firstName,
      'Last name': c.lastName,
      Name: name,
      Email: c.emails[0] ?? '',
      Phone: c.phones[0] ?? '',
      Company: c.company ?? '',
      Address: c.address?.line1 ?? '',
      'Address line 2': c.address?.line2 ?? '',
      City: c.address?.city ?? '',
      State: c.address?.state ?? '',
      ZIP: c.address?.postalCode ?? '',
      Notes: vcardNote(c) ?? '',
    };
    for (let i = 0; i < extraEmails; i++) row[`Other email ${i + 1}`] = c.emails[i + 1] ?? '';
    for (let i = 0; i < extraPhones; i++) row[`Other phone ${i + 1}`] = c.phones[i + 1] ?? '';
    return row;
  });
  return {
    headers: columns.map(([h]) => h),
    rows,
    mapping: Object.fromEntries(columns),
  };
}

/** A contact's name as a list shows it. */
export const vcardName = (c: VcardContact): string =>
  [c.firstName, c.lastName].filter(Boolean).join(' ') ||
  c.fullName ||
  c.company ||
  c.emails[0] ||
  c.phones[0] ||
  '';
