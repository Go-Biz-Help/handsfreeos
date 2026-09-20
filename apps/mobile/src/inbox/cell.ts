import { useQuery } from '@powersync/react-native';

import type { PhoneNumbersRow, UserPhonesRow } from '@/sync/app-schema';

/**
 * What calling through your own cell needs from the phone's copy: your cell (me_v1's `user_phones`, only yours reach
 * the phone) and the business's number.
 */

export interface MyCell {
  readonly id: string;
  readonly e164: string;
  readonly verifiedAt: string | null;
  readonly lastVerificationAt: string | null;
}

/** Your cell as the copy has it, or null when you haven't entered one. */
export function useMyCell(): { readonly cell: MyCell | null; readonly loading: boolean } {
  const { data, isLoading } = useQuery<
    Pick<UserPhonesRow, 'id' | 'e164' | 'verified_at' | 'last_verification_at'>
  >(
    `SELECT id, e164, verified_at, last_verification_at FROM user_phones
     ORDER BY verified_at IS NULL, updated_at DESC LIMIT 1`,
  );
  const row = data[0];
  return {
    cell:
      row && row.e164
        ? {
            id: row.id,
            e164: row.e164,
            verifiedAt: row.verified_at,
            lastVerificationAt: row.last_verification_at,
          }
        : null,
    loading: isLoading,
  };
}

export interface BusinessNumber {
  readonly e164: string;
  /** Texts and calls go from it (a number still being set up, or on its way out, doesn't text). */
  readonly active: boolean;
}

/**
 * The business's number, as the phone can currently work it out: the newest one being set up, active or
 * being released.
 *
 * **This no longer matches the server.** Since M17 a business may have several numbers and one of them is
 * marked `is_default`, which is the one `defaultNumber()` returns — so for a business with more than one,
 * the phone can show a different number from the web. Closing it needs `is_default` in the phone's contract
 * and in the `phone_numbers` sync rule, then `pnpm --filter @hfos/mobile schema`; recording a contract reads
 * the live table, so it needs a machine with the database up. Harmless until then: a one-number business is
 * unaffected, and the phone has no number management to get wrong.
 * Null until it has one.
 */
export function useBusinessNumber(workspaceId: string): BusinessNumber | null {
  const { data } = useQuery<Pick<PhoneNumbersRow, 'e164' | 'status'>>(
    `SELECT e164, status FROM phone_numbers
     WHERE workspace_id = ? AND status IN ('provisioning', 'active', 'releasing')
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
  const row = data[0];
  return row?.e164 ? { e164: row.e164, active: row.status === 'active' } : null;
}
