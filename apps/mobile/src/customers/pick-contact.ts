import {
  alreadyACustomer,
  personFromContact,
  PICKED_CONTACT_WORDS as W,
  type CustomerContactRow,
  type PersonFromContact,
} from '@hfos/core';
import * as React from 'react';

import { change, changes, newId } from '@/changes';

import HfosPhone from '../../modules/hfos-phone';

/** What picking a customer from the phone's contacts came to. */
export type PickedCustomer =
  | { readonly kind: 'added'; readonly id: string; readonly name: string }
  | { readonly kind: 'already'; readonly id: string; readonly name: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

/** The business's customers as the phone's copy holds them, for telling whether a picked contact is one already. */
const CUSTOMER_CONTACTS_SQL = `
  SELECT id, first_name, last_name, email, phone_e164, other_phones, other_emails FROM people
  WHERE workspace_id = ? AND archived_at IS NULL`;

const INSERT_PERSON = `
  INSERT INTO people (id, workspace_id, first_name, last_name, email, phone, phone_e164, address_line1,
    address_line2, city, state, postal_code, country, other_emails, other_phones, other_addresses, source,
    created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** The customer as the phone shows them until HandsFreeOS answers with its own row. */
function personRow(id: string, workspaceId: string, person: PersonFromContact): unknown[] {
  const now = new Date().toISOString();
  const a = person.address;
  return [
    id,
    workspaceId,
    person.firstName,
    person.lastName,
    person.email,
    person.phone,
    person.phone,
    a?.line1 ?? null,
    a?.line2 ?? null,
    a?.city ?? null,
    a?.state ?? null,
    a?.postalCode ?? null,
    a ? (a.country ?? 'US') : null,
    JSON.stringify(person.otherEmails),
    JSON.stringify(person.otherPhones),
    JSON.stringify(person.otherAddresses.map((o) => ({ ...o, country: o.country ?? 'US' }))),
    person.source,
    now,
    now,
  ];
}

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

    const db = changes.open?.db;
    if (db) {
      const rows = await db.getAll<CustomerContactRow>(CUSTOMER_CONTACTS_SQL, [workspaceId]);
      const found = alreadyACustomer(rows, made.person);
      if (found) return { kind: 'already', ...found };
    }

    const id = newId();
    await change(
      'person.create',
      { workspaceId, id, ...made.person },
      { optimistic: (tx) => tx.execute(INSERT_PERSON, personRow(id, workspaceId, made.person)) },
    );
    return { kind: 'added', id, name: made.name };
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
