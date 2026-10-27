import { personFromContact, PICKED_CONTACT_WORDS as W } from '@hfos/core';
import * as React from 'react';

import HfosPhone from '../../modules/hfos-phone';

import { addCustomer } from './add-customer';

/** What picking a customer from the phone's contacts came to. */
export type PickedCustomer =
  | { readonly kind: 'added'; readonly id: string; readonly name: string }
  | { readonly kind: 'already'; readonly id: string; readonly name: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Picks one customer from the phone's own contacts and adds them to the business, or finds them already there
 * (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8, call 8: one at a time, never the whole address book).
 * The phone's own picker hands over only the contact picked, so the app asks for no contacts permission. Adding works
 * with no signal: the customer is on this phone at once, and reaches HandsFreeOS with the next signal.
 */
export async function pickCustomerFromContacts(workspaceId: string): Promise<PickedCustomer> {
  try {
    const picked = await HfosPhone.pickContact();
    if (picked === 'cancelled') return { kind: 'cancelled' };
    if (picked === 'unavailable') return { kind: 'failed', message: W.unavailable };
    const made = personFromContact(picked);
    if (!made.ok) return { kind: 'failed', message: made.message };
    const { kind, id, name } = await addCustomer(workspaceId, made.person, made.name);
    return { kind, id, name };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** `pickCustomerFromContacts` for a button: one picker at a time, and whether one is open. */
export function usePickCustomer(workspaceId: string): {
  readonly pick: () => Promise<PickedCustomer>;
  readonly picking: boolean;
} {
  const [picking, setPicking] = React.useState(false);
  const open = React.useRef(false);
  const pick = React.useCallback(async (): Promise<PickedCustomer> => {
    if (open.current) return { kind: 'cancelled' };
    open.current = true;
    setPicking(true);
    try {
      return await pickCustomerFromContacts(workspaceId);
    } finally {
      open.current = false;
      setPicking(false);
    }
  }, [workspaceId]);
  return { pick, picking };
}
