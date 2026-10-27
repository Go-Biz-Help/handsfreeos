/**
 * A new contact started from a customer search that found nobody: New appointment's Customer, on the web and the
 * phone. Typing a name nobody has offers "Add “Dana Smith” as a new contact", and the form opens with what was typed
 * already in it, where it belongs: a number in Phone, an email in Email, a name as the name. Once added, they're the
 * customer the visit is for, so booking someone new takes one detour instead of a trip to Contacts and back.
 *
 * The web opens its Add a person form for this. The phone has no such form, and an iPhone shows one sheet at a time,
 * so its New appointment sheet asks for the name, number and email itself and checks them here first, the way the
 * server will: what it adds with no signal must not be refused hours later for a number that was mistyped.
 *
 * Browser-safe: words and small pure helpers only.
 */
import { z } from 'zod';

import { CONTACT_EDIT_WORDS, joinName, splitName, type NameParts } from '../inbox/contact';
import { typedDigits } from '../search/probes';
import { normalizePhone } from './phone';

/** What both apps say, from the search that found nobody to the contact being added. */
export const NEW_CONTACT_WORDS = {
  /** Under a search that found nobody. */
  nobody: (typed: string) => `No one matches “${typed}”.`,
  /** The button under it, which starts the contact with what was typed. */
  add: (typed: string) => `Add “${typed}” as a new contact`,

  /** The phone's form, inside the New appointment sheet. */
  title: 'New contact',
  name: 'Name',
  phone: 'Phone',
  email: 'Email',
  namePlaceholder: CONTACT_EDIT_WORDS.namePlaceholder,
  phonePlaceholder: '(713) 555-0100',
  emailPlaceholder: 'mike@example.com',
  /** Only the name is needed; the rest can wait. */
  hint: 'A name is enough. A number or email lets them hear about the visit.',
  save: 'Add contact',
  cancel: 'Cancel',
  added: CONTACT_EDIT_WORDS.added,

  /** Someone already has the number or email typed: book them, or add the new contact anyway. */
  already: (name: string, has: { readonly phone: boolean; readonly email: boolean }) =>
    `${name} already has this ${
      has.phone && has.email ? 'number or email' : has.phone ? 'number' : 'email'
    }.`,
  choose: (name: string) => `Choose ${name}`,
  addAnyway: 'Add anyway',

  noName: CONTACT_EDIT_WORDS.nameEmpty,
  badPhone: 'Enter a valid phone number, or leave it blank.',
  badEmail: 'Enter a valid email address, or leave it blank.',
} as const;

/** What a new contact starts with: each part as it goes in its box, or empty. */
export interface ContactStart {
  readonly name: string;
  readonly phone: string;
  readonly email: string;
}

/**
 * Where what was typed in a customer search goes on a new contact: digits in Phone (read the way the search reads a
 * number, `typedDigits`, so a number not finished yet goes there too), anything with an @ in Email, and anything
 * else with a letter in it as the name. Text with a digit in it that isn't a number ("12 Oak St", "Unit 4") starts
 * nothing, since no name has digits: the form opens empty and the person types the name.
 */
export function contactFromSearch(typed: string): ContactStart {
  const q = (typed ?? '').trim().replace(/\s+/g, ' ');
  if (typedDigits(q)) return { name: '', phone: q, email: '' };
  if (q.includes('@')) return { name: '', phone: '', email: q };
  const name = /\p{L}/u.test(q) && !/\d/.test(q) ? q : '';
  return { name, phone: '', email: '' };
}

/** A new contact as `person.create` takes it, with the workspace and the id the phone adds. */
export interface NewContactPerson extends NameParts {
  /** E.164, or none. */
  readonly phone: string | null;
  /** Lower-cased, or none. */
  readonly email: string | null;
}

export type NewContactCheck =
  | { readonly ok: true; readonly name: string; readonly person: NewContactPerson }
  | {
      readonly ok: false;
      readonly rule: 'no_name' | 'bad_phone' | 'bad_email';
      readonly field: 'name' | 'phone' | 'email';
      readonly message: string;
    };

/**
 * The phone's New contact form, checked the way `person.create` will check it: a name, and a number and an email
 * that are real when given (both may be left blank). The number comes back in E.164, as the server keeps it, so the
 * phone's copy shows it, and finds whoever already has it, the same way.
 */
export function checkNewContact(form: ContactStart): NewContactCheck {
  const parts = splitName(form.name);
  const name = { firstName: parts.firstName.slice(0, 80), lastName: parts.lastName.slice(0, 80) };
  if (!name.firstName)
    return { ok: false, rule: 'no_name', field: 'name', message: NEW_CONTACT_WORDS.noName };
  const typedPhone = form.phone.trim();
  const phone = typedPhone ? normalizePhone(typedPhone) : null;
  if (typedPhone && !phone)
    return { ok: false, rule: 'bad_phone', field: 'phone', message: NEW_CONTACT_WORDS.badPhone };
  const email = form.email.trim().toLowerCase() || null;
  if (email && (email.length > 254 || !z.email().safeParse(email).success))
    return { ok: false, rule: 'bad_email', field: 'email', message: NEW_CONTACT_WORDS.badEmail };
  return { ok: true, name: joinName(name), person: { ...name, phone, email } };
}
