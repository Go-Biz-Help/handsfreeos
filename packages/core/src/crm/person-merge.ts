/**
 * Two records for the same customer, merged into one (person.merge): what the record kept takes from the duplicate.
 *
 * The kept record's own details stand. The duplicate fills in only what the kept one is missing — a name, the
 * email, the number, the address, the company, the source — and its email, number and address join the kept
 * record's other ones when it already has its own (0103), so nothing that reached the customer is lost. Notes are
 * kept from both. Everything else that was the duplicate's (leads, the timeline, bills, bookings and the rest) moves
 * in the database, in `private.merge_people`.
 *
 * Pure and browser-safe: the command writes what this says, and the Assistant's card shows it first.
 */
import type { OtherAddressOut, OtherEmailOut, OtherPhoneOut } from '../schemas/crm';
import {
  MAX_OTHER_CONTACTS,
  otherAddressesOf,
  otherAddressesStored,
  otherEmailsStored,
  otherPhonesStored,
  otherEmailsOf,
  otherPhonesOf,
  tidyOtherAddresses,
  tidyOtherEmails,
  tidyOtherPhones,
  type OtherAddress,
  type OtherEmail,
  type OtherPhone,
} from './contact-points';
import { formatPhone } from './phone';

/** One side of a merge, as the people table holds it. */
export interface MergeSide {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly phoneE164: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string;
  readonly otherEmails: unknown;
  readonly otherPhones: unknown;
  readonly otherAddresses: unknown;
  readonly companyId: string | null;
  readonly notes: string | null;
  readonly source: string | null;
}

/** What changes on the record kept, by column, and the details that change in plain words. */
export interface MergedDetails {
  readonly patch: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phoneE164?: string;
    phone?: string;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string;
    otherEmails?: OtherEmail[];
    otherPhones?: OtherPhone[];
    otherAddresses?: OtherAddress[];
    companyId?: string;
    notes?: string;
    source?: string;
  };
  /** "email", "phone number", "other numbers"…, in the order the record shows them. */
  readonly filled: string[];
}

/** The longest notes a record keeps (the notes input's limit). */
const NOTES_MAX = 10000;

const blank = (v: string | null | undefined): boolean => !v || !v.trim();

const mainAddress = (s: MergeSide) => ({
  line1: s.addressLine1,
  line2: s.addressLine2,
  city: s.city,
  state: s.state,
  postalCode: s.postalCode,
});

const hasAddress = (s: MergeSide): boolean =>
  !blank(s.addressLine1) || !blank(s.city) || !blank(s.postalCode);

const sameList = (a: readonly object[], b: readonly object[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** What `keep` takes from `dup` when `dup` is merged into it. */
export function mergedDetails(keep: MergeSide, dup: MergeSide): MergedDetails {
  const patch: MergedDetails['patch'] = {};
  const filled: string[] = [];

  if (blank(keep.firstName) && !blank(dup.firstName)) {
    patch.firstName = dup.firstName;
    filled.push('first name');
  }
  if (blank(keep.lastName) && !blank(dup.lastName)) {
    patch.lastName = dup.lastName;
    filled.push('last name');
  }

  // The main ones as they will stand; the duplicate's own main ones join the other ones when these are taken.
  const email = keep.email ?? dup.email;
  if (!keep.email && dup.email) {
    patch.email = dup.email;
    filled.push('email');
  }
  const phone = keep.phoneE164 ?? dup.phoneE164;
  if (!keep.phoneE164 && dup.phoneE164) {
    patch.phoneE164 = dup.phoneE164;
    patch.phone = formatPhone(dup.phoneE164);
    filled.push('phone number');
  }
  const takeAddress = !hasAddress(keep) && hasAddress(dup);
  const address = takeAddress ? mainAddress(dup) : mainAddress(keep);
  if (takeAddress) {
    patch.addressLine1 = dup.addressLine1;
    patch.addressLine2 = dup.addressLine2;
    patch.city = dup.city;
    patch.state = dup.state;
    patch.postalCode = dup.postalCode;
    patch.country = dup.country;
    filled.push('address');
  }

  const keptEmails = otherEmailsOf(keep.otherEmails);
  const emails = tidyOtherEmails(
    [
      ...keptEmails,
      ...(dup.email ? [{ email: dup.email }] : []),
      ...otherEmailsOf(dup.otherEmails),
    ],
    email,
  ).slice(0, MAX_OTHER_CONTACTS);
  if (!sameList(emails, tidyOtherEmails(keptEmails, email))) {
    patch.otherEmails = emails;
    filled.push('other emails');
  }
  const keptPhones = otherPhonesOf(keep.otherPhones);
  const phones = tidyOtherPhones(
    [
      ...keptPhones,
      ...(dup.phoneE164 ? [{ phone: dup.phoneE164 }] : []),
      ...otherPhonesOf(dup.otherPhones),
    ],
    phone,
  ).slice(0, MAX_OTHER_CONTACTS);
  if (!sameList(phones, tidyOtherPhones(keptPhones, phone))) {
    patch.otherPhones = phones;
    filled.push('other numbers');
  }
  const keptAddresses = otherAddressesOf(keep.otherAddresses);
  const addresses = tidyOtherAddresses(
    [
      ...keptAddresses,
      ...(hasAddress(dup) && !takeAddress ? [{ ...mainAddress(dup), country: dup.country }] : []),
      ...otherAddressesOf(dup.otherAddresses),
    ],
    address,
  ).slice(0, MAX_OTHER_CONTACTS);
  if (!sameList(addresses, tidyOtherAddresses(keptAddresses, address))) {
    patch.otherAddresses = addresses;
    filled.push('other addresses');
  }

  if (!keep.companyId && dup.companyId) {
    patch.companyId = dup.companyId;
    filled.push('company');
  }
  // Notes from both: what was written on the duplicate is still true of the customer.
  const keptNotes = keep.notes?.trim() ?? '';
  const dupNotes = dup.notes?.trim() ?? '';
  if (dupNotes && !keptNotes.includes(dupNotes)) {
    patch.notes = (keptNotes ? `${keptNotes}\n\n${dupNotes}` : dupNotes).slice(0, NOTES_MAX);
    filled.push('notes');
  }
  if (blank(keep.source) && !blank(dup.source)) {
    patch.source = dup.source!;
    filled.push('source');
  }
  return { patch, filled };
}

/** A customer as person.get answers, as one side of a merge: for showing what a merge would fill in before it runs. */
export function mergeSideOf(p: MergeSideSource): MergeSide {
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    phoneE164: p.phoneE164,
    addressLine1: p.address.line1,
    addressLine2: p.address.line2,
    city: p.address.city,
    state: p.address.state,
    postalCode: p.address.postalCode,
    country: p.address.country,
    otherEmails: otherEmailsStored(p.otherEmails),
    otherPhones: otherPhonesStored(p.otherPhones),
    otherAddresses: otherAddressesStored(p.otherAddresses),
    companyId: p.company?.id ?? null,
    notes: p.notes ?? null,
    source: p.source,
  };
}

/** What mergeSideOf reads of person.get's answer. */
export interface MergeSideSource {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly phoneE164: string | null;
  readonly address: {
    readonly line1: string | null;
    readonly line2: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
    readonly country: string;
  };
  readonly otherEmails: readonly OtherEmailOut[];
  readonly otherPhones: readonly OtherPhoneOut[];
  readonly otherAddresses: readonly OtherAddressOut[];
  readonly company: { readonly id: string } | null;
  readonly notes?: string | null;
  readonly source: string | null;
}
