import { alreadyACustomer, type CustomerContactRow } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { api, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * Who an email nobody has linked is from (the owner, 2026-10-29: "quickly create a new contact from it or assign that
 * email to an existing contact"): the customer on this phone who already has the address, so linking them is one tap,
 * and the name the sender's mail gave, so adding them starts with it. The name isn't in the phone's copy, so it's asked
 * of HandsFreeOS while there's signal, and adding them without it just starts with an empty name.
 */
export interface Sender {
  readonly name: string | null;
  readonly known: { readonly id: string; readonly name: string } | null;
}

/** The customers who might have the address, main or other; `alreadyACustomer` then checks them as the server does. */
const HAS_ADDRESS_SQL = `
  SELECT id, first_name, last_name, email, phone_e164, other_phones, other_emails FROM people
  WHERE workspace_id = ? AND archived_at IS NULL AND (lower(email) = ? OR other_emails LIKE ?)
  ORDER BY lower(email) = ? DESC, updated_at DESC
  LIMIT 5`;

/** `address` is the thread's when it is email from somebody not linked yet, else null and nothing is looked up. */
export function useSender(
  workspaceId: string,
  conversationId: string,
  address: string | null,
): Sender {
  const { online } = useNetwork();
  const wanted = address?.toLowerCase() ?? '';
  const { data: rows } = useQuery<CustomerContactRow>(HAS_ADDRESS_SQL, [
    workspaceId,
    wanted,
    wanted ? `%${wanted}%` : '',
    wanted,
  ]);
  const [asked, setAsked] = React.useState<{
    name: string | null;
    customer: { id: string; fullName: string } | null;
  } | null>(null);
  React.useEffect(() => {
    if (!address || !online) return;
    let cancelled = false;
    api
      .POST('/v1/queries/conversation.get', { body: { workspaceId, conversationId } })
      .then((r) => {
        if (!cancelled) setAsked(unwrap(r).sender);
      })
      .catch(() => {
        // The name is a head start: without it, the person types it.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, conversationId, address, online]);
  return React.useMemo<Sender>(() => {
    if (!address) return { name: null, known: null };
    const here = alreadyACustomer(rows, {
      firstName: '',
      lastName: '',
      phone: null,
      email: wanted,
      otherPhones: [],
      otherEmails: [],
    });
    const there = asked?.customer ? { id: asked.customer.id, name: asked.customer.fullName } : null;
    return { name: asked?.name ?? null, known: here ?? there };
  }, [address, wanted, rows, asked]);
}
