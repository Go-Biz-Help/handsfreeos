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
 * The business's number: the one it has chosen to send from, else the newest it has.
 *
 * **This is the second copy of one rule, and `defaultNumber()` is the first.** A stream query cannot join,
 * so the phone works the answer out itself — and it has to work out the *same* answer, or a business with
 * two numbers sees one on the web and another here. `packages/core/src/messaging/store.ts` is the original:
 * `is_default` first, then the same `created_at desc`, over the same three statuses that can actually send.
 * Change one, change the other.
 *
 * Null until it has one.
 */
export function useBusinessNumber(workspaceId: string): BusinessNumber | null {
  const { data } = useQuery<Pick<PhoneNumbersRow, 'e164' | 'status'>>(
    `SELECT e164, status FROM phone_numbers
     WHERE workspace_id = ? AND status IN ('provisioning', 'active', 'releasing')
     ORDER BY is_default DESC, created_at DESC LIMIT 1`,
    [workspaceId],
  );
  const row = data[0];
  return row?.e164 ? { e164: row.e164, active: row.status === 'active' } : null;
}

/**
 * The number a conversation sends from: the one the customer has been writing to, else the business's default.
 *
 * **The phone's half of the split-thread fix.** A customer who texted the dispatch line and gets a reply from
 * the front-desk line sees two threads and no longer knows which to use, so the server glues a conversation
 * to the number it arrived on (`conversationNumber`, `packages/core/src/messaging/store.ts`). This screen
 * used to show the business's default whatever the thread was — the web said one number and the phone said
 * another, on the very case the gluing exists for.
 *
 * Falls back exactly as the server does, and for the same reason: a thread from before that shipped has no
 * number, and one whose number has since been released should show the number that replaced it rather than
 * nothing.
 */
export function useConversationNumber(
  workspaceId: string,
  conversationId: string,
): BusinessNumber | null {
  const { data } = useQuery<Pick<PhoneNumbersRow, 'e164' | 'status'>>(
    `SELECT n.e164, n.status FROM conversations c
     JOIN phone_numbers n ON n.id = c.phone_number_id
     WHERE c.id = ? AND n.workspace_id = ? AND n.status IN ('provisioning', 'active', 'releasing')
     LIMIT 1`,
    [conversationId, workspaceId],
  );
  const fallback = useBusinessNumber(workspaceId);
  const row = data[0];
  return row?.e164 ? { e164: row.e164, active: row.status === 'active' } : fallback;
}
