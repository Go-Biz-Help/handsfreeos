import { useSyncExternalStore } from 'react';

import { deviceStore } from '@/lib/device-store';

import HfosPhone from '../../modules/hfos-phone';

/**
 * The contacts card on My cell phone (the plan's "iPhone call screening"): once the cell is verified, it offers to add
 * the business's number to Contacts, so a phone that silences unknown callers still rings for HandsFreeOS's calls.
 * The phone's own New Contact screen saves it, so the app never asks to read contacts. Whether it was added is kept on
 * this phone per person and number, and only to say so under the button — the offer itself never goes away, because a
 * contact deleted later, or a second phone, needs it again.
 */

export type ContactCardState = 'added' | null;

const keyOf = (userId: string, businessNumber: string) => `contactCard:${userId}:${businessNumber}`;

export function contactCardState(userId: string, businessNumber: string): ContactCardState {
  const value = deviceStore.get<string>(keyOf(userId, businessNumber));
  // A phone that stored the old 'dismissed' reads as null, so the offer comes back rather than staying hidden.
  return value === 'added' ? value : null;
}

export function setContactCardState(
  userId: string,
  businessNumber: string,
  state: Exclude<ContactCardState, null>,
): void {
  deviceStore.set(keyOf(userId, businessNumber), state);
}

export function useContactCardState(
  userId: string,
  businessNumber: string | null,
): ContactCardState {
  return useSyncExternalStore(
    (listener) => deviceStore.subscribe(listener),
    () => (businessNumber ? contactCardState(userId, businessNumber) : null),
  );
}

/**
 * Adds the business's number through the phone's New Contact screen. iPhone says whether it was saved; Android only
 * that the contacts app opened, which counts as offered.
 */
export async function addBusinessContact(
  businessName: string,
  businessNumber: string,
): Promise<'added' | 'cancelled' | 'opened' | 'unavailable'> {
  try {
    return await HfosPhone.addContact(businessName, businessNumber);
  } catch {
    return 'unavailable';
  }
}
