import {
  addressLine,
  contactLabelWords,
  RECORD_WORDS,
  telHref,
  type OtherAddressOut,
  type OtherEmailOut,
  type OtherPhoneOut,
} from '@hfos/core';
import { Linking } from 'react-native';

/** A customer's or a company's other ways to reach them (0103), and who is on them (0104). */
interface Reachable {
  readonly otherPhones: readonly OtherPhoneOut[];
  readonly otherEmails: readonly OtherEmailOut[];
  readonly otherAddresses: readonly OtherAddressOut[];
  readonly owner: { readonly fullName: string } | null;
  readonly team: readonly { readonly fullName: string }[];
}

export interface ContactLine {
  readonly key: string;
  readonly text: string;
  readonly onPress?: () => void;
}

export interface DetailLine {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
}

/** Their other numbers, for the head under the main one: "(713) 555-0199 · Work", and a tap calls it. */
export function otherPhoneLines(r: Pick<Reachable, 'otherPhones'>): ContactLine[] {
  return r.otherPhones.map((p) => ({
    key: `phone-${p.phoneE164}`,
    text: `${p.phone} · ${contactLabelWords(p.label, 'phone')}`,
    onPress: () => {
      const href = telHref(p.phoneE164);
      if (href) void Linking.openURL(href);
    },
  }));
}

/** "Maria Lopez, Chris Diaz": the main person first, then everyone else on them. */
export function assignedWords(r: Pick<Reachable, 'owner' | 'team'>): string | null {
  const names = [r.owner, ...r.team].filter((p) => p !== null).map((p) => p.fullName);
  return names.length ? names.join(', ') : null;
}

/**
 * The details tab's rows, in the web's order: each main detail followed by the others of its kind, each under its
 * own label ("Work", or "Other number" when it has none).
 */
export function contactDetails(
  r: Reachable,
  main: { readonly phone: string | null; readonly email: string | null; readonly address: string },
): DetailLine[] {
  return [
    { key: 'phone', label: RECORD_WORDS.labels.phone, value: main.phone },
    ...r.otherPhones.map((p) => ({
      key: `phone-${p.phoneE164}`,
      label: contactLabelWords(p.label, 'phone'),
      value: p.phone,
    })),
    { key: 'email', label: RECORD_WORDS.labels.email, value: main.email },
    ...r.otherEmails.map((e) => ({
      key: `email-${e.email}`,
      label: contactLabelWords(e.label, 'email'),
      value: e.email,
    })),
    { key: 'address', label: RECORD_WORDS.labels.address, value: main.address || null },
    ...r.otherAddresses.map((a, i) => ({
      key: `address-${i}`,
      label: contactLabelWords(a.label, 'address'),
      value: addressLine(a) || null,
    })),
  ];
}
