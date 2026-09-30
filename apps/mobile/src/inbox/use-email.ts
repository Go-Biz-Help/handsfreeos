import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';

/**
 * What emailing from the phone needs from the copy: the business address an email goes from, and whether the
 * customer's address is stopped (bounced, marked as spam, or by hand).
 *
 * Which address (M19): someone's own mail answers only from its own address, and the team's mail only from the team's
 * (the thread's own when it is one, else the business's default). An address someone owns is theirs alone, so it is
 * never picked for a team thread, not even by its owner; the server would refuse the send.
 */
export interface EmailFacts {
  readonly fromAddress: string | null;
  readonly fromAddressId: string | null;
  /** The address is the person's own (M19), which the From line says. */
  readonly fromOwn: boolean;
  /** `bounce`, `spam_complaint` or `manual` while email to the address is stopped. */
  readonly suppressedReason: string | null;
}

/** The From address for a conversation: its own when it is someone's own mail, else a team address, its own first. */
export const FROM_ADDRESS_SQL = `
  SELECT a.id, a.address, a.owner_user_id IS NOT NULL AS own,
    (a.id = c.email_address_id) AS this_thread
  FROM email_addresses a
  LEFT JOIN conversations c ON c.id = ?
  WHERE a.workspace_id = ?
    AND CASE WHEN c.private_to IS NOT NULL THEN a.id = c.email_address_id
      ELSE a.owner_user_id IS NULL END
  ORDER BY this_thread DESC, a.is_default DESC, a.created_at
  LIMIT 1`;

export function useEmailFacts(conversationId: string, to: string | null): EmailFacts {
  const { business } = useBusiness();
  const { data: addresses } = useQuery<{
    id: string;
    address: string | null;
    own: number | null;
    this_thread: number | null;
  }>(FROM_ADDRESS_SQL, [conversationId, business.id]);
  const { data: suppressed } = useQuery<{ reason: string | null }>(
    `SELECT reason FROM email_suppressions WHERE workspace_id = ? AND lower(address) = lower(?) LIMIT 1`,
    [business.id, to ?? ''],
  );
  const address = addresses[0];
  return React.useMemo(
    () => ({
      fromAddress: address?.address ?? null,
      fromAddressId: address?.id ?? null,
      fromOwn: Number(address?.own ?? 0) > 0,
      suppressedReason: to ? (suppressed[0]?.reason ?? null) : null,
    }),
    [address, suppressed, to],
  );
}
