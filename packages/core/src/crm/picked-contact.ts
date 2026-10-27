/**
 * A customer picked from the phone's own contacts (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8, the
 * owner's call 8: one at a time, never the whole address book). The phone hands over the one contact the person
 * picked, through the phone's own picker, which needs no contacts permission. This turns it into what `person.create`
 * takes, and finds them among the business's customers when they're already there, so every phone adds them, or says
 * they're here, the same way.
 *
 * An iPhone hands over the card: names, company, numbers, emails and addresses. An Android phone hands over the name
 * and the one number picked, since reading more of the card would need the contacts permission.
 *
 * Browser-safe: no database. The phone looks for the customer in its own copy (`alreadyACustomer`); the server still
 * flags a possible duplicate the phone's copy didn't hold.
 */
import { z } from 'zod';

import { CONTACT_EDIT_WORDS, joinName, splitName, type NameParts } from '../inbox/contact';
import {
  addressKey,
  MAX_OTHER_CONTACTS,
  otherEmailsOf,
  otherPhonesOf,
  type OtherAddress,
} from './contact-points';
import { normalizePhone } from './phone';

/** One number on the picked contact. `e164` is the phone's own reading of it, when it has one (Android). */
export interface PickedContactPhone {
  readonly number: string;
  readonly e164?: string | null;
  readonly label?: string | null;
}

export interface PickedContactEmail {
  readonly email: string;
  readonly label?: string | null;
}

/** An address as the phone keeps it: the street may run over two lines, and the country is a two-letter code. */
export interface PickedContactAddress {
  readonly street?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
  readonly label?: string | null;
}

/** The contact the phone's picker handed over. Every part may be missing. */
export interface PickedContact {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  /** The whole name, when that's all the phone gives (Android). */
  readonly name?: string | null;
  readonly company?: string | null;
  readonly phones?: readonly PickedContactPhone[];
  readonly emails?: readonly PickedContactEmail[];
  readonly addresses?: readonly PickedContactAddress[];
}

/** Where a picked customer came from, shown on their page as "Added today · Phone contacts". */
export const PICKED_CONTACT_SOURCE = 'Phone contacts';

/** What the phone says while picking customers from its contacts, on the setup's customers screen and Customers. */
export const PICKED_CONTACT_WORDS = {
  pick: 'Pick from your contacts',
  pickAnother: 'Pick another',
  /** The Customers screen's button, for a screen reader. */
  addFromContacts: 'Add a customer from your contacts',
  onlyPicked:
    'Pick your customers one at a time. Only the people you pick come into HandsFreeOS; the rest of your contacts stay on your phone.',
  added: CONTACT_EDIT_WORDS.added,
  already: (name: string) => `${name} is already a customer.`,
  open: 'Open',
  /** The setup's list of who came in, and who was there already. */
  addedTag: 'Added',
  alreadyTag: 'Already a customer',
  noName: 'This contact has no name. Add one in your phone’s Contacts app, then pick them again.',
  unavailable: 'This phone has no contacts app to pick from.',
} as const;

/** What `person.create` gets for a picked contact, with the workspace and the id the phone adds. */
export interface PersonFromContact {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly otherPhones: { readonly phone: string; readonly label?: string }[];
  readonly otherEmails: { readonly email: string; readonly label?: string }[];
  /** Left out when the contact has none, as `person.create` takes no empty address. */
  readonly address?: PickedAddress;
  readonly otherAddresses: (PickedAddress & { readonly label?: string })[];
  readonly source: string;
}

/** An address part by part, empty parts left out; the country only when the phone knew it. */
export type PickedAddress = Omit<OtherAddress, 'label' | 'country'> & { readonly country?: string };

export type ContactAsPerson =
  | { readonly ok: true; readonly name: string; readonly person: PersonFromContact }
  | { readonly ok: false; readonly rule: 'no_name'; readonly message: string };

const clip = (value: string | null | undefined, max: number): string =>
  (value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** A name that is only a number or punctuation (a phone shows a nameless contact by its number) isn't a name. */
const hasLetters = (name: NameParts): boolean => /\p{L}/u.test(joinName(name));

function nameOf(contact: PickedContact): NameParts {
  const first = clip(contact.firstName, 80);
  const last = clip(contact.lastName, 80);
  const candidates: NameParts[] = [
    { firstName: first, lastName: last },
    splitName(contact.name ?? ''),
    { firstName: clip(contact.company, 80), lastName: '' },
  ];
  const named = candidates.find(hasLetters);
  return named
    ? { firstName: named.firstName.slice(0, 80), lastName: named.lastName.slice(0, 80) }
    : { firstName: '', lastName: '' };
}

/** The phone's labels ("mobile", "iPhone", "home"), as the editors offer them; any other label keeps its words. */
const LABELS = {
  phone: {
    mobile: 'Mobile',
    iphone: 'Mobile',
    cell: 'Mobile',
    work: 'Work',
    home: 'Home',
    other: 'Other',
  },
  email: { work: 'Work', home: 'Personal', icloud: 'Personal', other: 'Other' },
  address: { home: 'Home', work: 'Work', other: 'Other' },
} as const satisfies Record<string, Record<string, string>>;

function labelOf(raw: string | null | undefined, kind: keyof typeof LABELS): { label?: string } {
  const label = clip(raw, 40);
  if (!label) return {};
  const known = (LABELS[kind] as Readonly<Record<string, string>>)[label.toLowerCase()];
  return { label: known ?? label.charAt(0).toUpperCase() + label.slice(1) };
}

const isMobile = (raw: string | null | undefined): boolean =>
  ['mobile', 'iphone', 'cell'].includes(clip(raw, 40).toLowerCase());

function addressOf(a: PickedContactAddress) {
  const lines = (a.street ?? '')
    .split(/\r?\n/)
    .map((line) => clip(line, 200))
    .filter(Boolean);
  const parts = {
    line1: lines[0] ?? '',
    line2: clip(lines.slice(1).join(', '), 200),
    city: clip(a.city, 100),
    state: clip(a.state, 50),
    postalCode: clip(a.postalCode, 20),
  };
  if (!parts.line1 && !parts.city && !parts.postalCode) return null;
  const country = (a.country ?? '').trim().toUpperCase();
  return {
    ...labelOf(a.label, 'address'),
    ...Object.fromEntries(Object.entries(parts).filter(([, v]) => v)),
    ...(/^[A-Z]{2}$/.test(country) ? { country } : {}),
  } as PickedAddress & { readonly label?: string };
}

/** The main address carries no label: the columns have none. */
function withoutLabel({ label: _label, ...address }: PickedAddress & { readonly label?: string }) {
  return address;
}

function once<T>(list: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The customer a picked contact makes. The main number is the first mobile one, so texts reach a cell; the main email
 * and address are the first ones. A number or email the server would refuse is left out rather than refusing the
 * customer, and a contact with no name says so (rule `no_name`).
 */
export function personFromContact(contact: PickedContact): ContactAsPerson {
  const name = nameOf(contact);
  if (!name.firstName && !name.lastName) {
    return { ok: false, rule: 'no_name', message: PICKED_CONTACT_WORDS.noName };
  }

  const phones = once(
    (contact.phones ?? []).flatMap((p) => {
      const phone = normalizePhone(p.e164?.trim() || p.number) ?? normalizePhone(p.number);
      return phone ? [{ phone, mobile: isMobile(p.label), ...labelOf(p.label, 'phone') }] : [];
    }),
    (p) => p.phone,
  );
  const mainPhone = phones.find((p) => p.mobile) ?? phones[0] ?? null;

  const emails = once(
    (contact.emails ?? []).flatMap((e) => {
      const email = e.email.trim().toLowerCase();
      return email.length <= 254 && z.email().safeParse(email).success
        ? [{ email, ...labelOf(e.label, 'email') }]
        : [];
    }),
    (e) => e.email,
  );

  const addresses = once(
    (contact.addresses ?? []).flatMap((a) => {
      const address = addressOf(a);
      return address ? [address] : [];
    }),
    addressKey,
  );
  const [mainAddress, ...moreAddresses] = addresses;

  return {
    ok: true,
    name: joinName(name),
    person: {
      ...name,
      phone: mainPhone?.phone ?? null,
      email: emails[0]?.email ?? null,
      otherPhones: phones
        .filter((p) => p !== mainPhone)
        .slice(0, MAX_OTHER_CONTACTS)
        .map(({ phone, label }) => (label ? { phone, label } : { phone })),
      otherEmails: emails.slice(1, 1 + MAX_OTHER_CONTACTS),
      ...(mainAddress ? { address: withoutLabel(mainAddress) } : {}),
      otherAddresses: moreAddresses.slice(0, MAX_OTHER_CONTACTS),
      source: PICKED_CONTACT_SOURCE,
    },
  };
}

/** A customer as the phone's copy holds them, for telling whether a picked contact is already one. */
export interface CustomerContactRow {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly email: string | null;
  readonly phone_e164: string | null;
  readonly other_phones: unknown;
  readonly other_emails: unknown;
}

/**
 * The customer a picked contact already is: someone with one of its numbers or emails, main or other, as the server's
 * duplicate check matches them. Archived customers are left out of `rows` by the caller, as the server leaves them out.
 * A contact typed in on the phone (New appointment's New contact) is looked for the same way.
 */
export function alreadyACustomer(
  rows: readonly CustomerContactRow[],
  person: Pick<
    PersonFromContact,
    'firstName' | 'lastName' | 'phone' | 'email' | 'otherPhones' | 'otherEmails'
  >,
): { readonly id: string; readonly name: string } | null {
  const phones = new Set(
    [person.phone, ...person.otherPhones.map((p) => p.phone)].filter((p): p is string => !!p),
  );
  const emails = new Set(
    [person.email, ...person.otherEmails.map((e) => e.email)].filter((e): e is string => !!e),
  );
  for (const row of rows) {
    const theirPhones = [row.phone_e164, ...otherPhonesOf(row.other_phones).map((p) => p.phone)];
    const theirEmails = [row.email, ...otherEmailsOf(row.other_emails).map((e) => e.email)].map(
      (e) => e?.toLowerCase() ?? null,
    );
    if (
      theirPhones.some((p) => !!p && phones.has(p)) ||
      theirEmails.some((e) => !!e && emails.has(e))
    ) {
      const name = joinName({ firstName: row.first_name ?? '', lastName: row.last_name ?? '' });
      return { id: row.id, name: name || row.email || row.phone_e164 || joinName(person) };
    }
  }
  return null;
}
