import { alreadyACustomer, type CustomerContactRow, type PersonFromContact } from '@hfos/core';

import { change, changes, newId } from '@/changes';

/**
 * A customer to add on this phone: one picked from the phone's own contacts, or one typed in (New appointment's New
 * contact), which has no source to name.
 */
export type NewCustomer = Omit<PersonFromContact, 'source'> & { readonly source?: string | null };

/** A customer added on this phone, or found here already by one of their numbers or emails. */
export type AddedCustomer =
  | {
      readonly kind: 'added';
      readonly id: string;
      readonly name: string;
      /** The change that adds them, for what's made for them next to wait for (`dependsOn`). */
      readonly changeId: string;
    }
  | { readonly kind: 'already'; readonly id: string; readonly name: string };

/** The business's customers as the phone's copy holds them, for telling whether someone is one already. */
const CUSTOMER_CONTACTS_SQL = `
  SELECT id, first_name, last_name, email, phone_e164, other_phones, other_emails FROM people
  WHERE workspace_id = ? AND archived_at IS NULL`;

const INSERT_PERSON = `
  INSERT INTO people (id, workspace_id, first_name, last_name, email, phone, phone_e164, address_line1,
    address_line2, city, state, postal_code, country, other_emails, other_phones, other_addresses, source,
    created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** The customer as the phone shows them until HandsFreeOS answers with its own row. */
function personRow(id: string, workspaceId: string, person: NewCustomer): unknown[] {
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
    person.source ?? null,
    now,
    now,
  ];
}

/**
 * Adds a customer, or finds them among the business's customers on this phone when one of their numbers or emails is
 * already somebody's. `anyway` adds them all the same: the person said they're someone else. Works with no signal:
 * the customer is on this phone at once, and reaches HandsFreeOS with the next signal.
 */
export async function addCustomer(
  workspaceId: string,
  person: NewCustomer,
  name: string,
  options: { readonly anyway?: boolean } = {},
): Promise<AddedCustomer> {
  const db = changes.open?.db;
  if (db && !options.anyway) {
    const rows = await db.getAll<CustomerContactRow>(CUSTOMER_CONTACTS_SQL, [workspaceId]);
    const found = alreadyACustomer(rows, person);
    if (found) return { kind: 'already', ...found };
  }

  const id = newId();
  const made = await change(
    'person.create',
    { workspaceId, id, ...person, ...(options.anyway ? { ignoreDuplicates: true } : {}) },
    { optimistic: (tx) => tx.execute(INSERT_PERSON, personRow(id, workspaceId, person)) },
  );
  return { kind: 'added', id, name, changeId: made.id };
}
