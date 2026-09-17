import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';

/**
 * What emailing from the phone needs from the copy: the business address an email goes from (the conversation's own,
 * else the business's default), and whether the customer's address is stopped (bounced, marked as spam, or by hand).
 */
export interface EmailFacts {
  readonly fromAddress: string | null;
  readonly fromAddressId: string | null;
  /** `bounce`, `spam_complaint` or `manual` while email to the address is stopped. */
  readonly suppressedReason: string | null;
}

export function useEmailFacts(conversationId: string, to: string | null): EmailFacts {
  const { business } = useBusiness();
  const { data: addresses } = useQuery<{
    id: string;
    address: string | null;
    mine: number | null;
  }>(
    `SELECT a.id, a.address, (a.id = (SELECT email_address_id FROM conversations WHERE id = ?)) AS mine
     FROM email_addresses a
     WHERE a.workspace_id = ?
     ORDER BY mine DESC, a.is_default DESC, a.created_at
     LIMIT 1`,
    [conversationId, business.id],
  );
  const { data: suppressed } = useQuery<{ reason: string | null }>(
    `SELECT reason FROM email_suppressions WHERE workspace_id = ? AND lower(address) = lower(?) LIMIT 1`,
    [business.id, to ?? ''],
  );
  const address = addresses[0];
  return React.useMemo(
    () => ({
      fromAddress: address?.address ?? null,
      fromAddressId: address?.id ?? null,
      suppressedReason: to ? (suppressed[0]?.reason ?? null) : null,
    }),
    [address, suppressed, to],
  );
}
