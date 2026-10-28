/**
 * A customer's own way into a HandsFreeOS video call (docs/video-calls.md): `/j/<token>`. Two kinds share the path,
 * told apart by their length.
 *
 * - **A booking's Join link** (18 letters and digits, booking/links.ts): the booking's reference and a signed code.
 *   It opens the appointment's call from an hour before it starts.
 * - **The link the team sent** for a call that isn't for an appointment (part 5): a random key 32 letters and digits
 *   long, made by `video_call.start`, which keeps only its hash. It opens the call for a day after it was made, and
 *   for as long as the call is going.
 */
import { createHash } from 'node:crypto';
import { isVideoCallLinkKey } from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import { resolveJoinToken, type BookingLinks } from '../booking/links';
import type { TenantScope } from '../services';

export type CustomerLink =
  | { readonly kind: 'booking'; readonly scope: TenantScope; readonly attendeeId: string }
  | { readonly kind: 'call'; readonly scope: TenantScope; readonly callId: string };

/** Which call a customer's link is for, and whose: null when it isn't one. */
export async function resolveCustomerLink(
  db: Db,
  links: BookingLinks,
  token: string,
): Promise<CustomerLink | null> {
  if (isVideoCallLinkKey(token)) {
    const hash = createHash('sha256').update(token).digest('hex');
    const [row] = await asWorker(db, {}, (tx) =>
      rows<{ call_id: string; workspace_id: string; organization_id: string }>(
        tx,
        sql`select call_id, workspace_id, organization_id from private.video_call_by_link(${hash})`,
      ),
    );
    return row
      ? {
          kind: 'call',
          callId: row.call_id,
          scope: { workspaceId: row.workspace_id, organizationId: row.organization_id },
        }
      : null;
  }
  const found = await resolveJoinToken(db, links, token);
  return found.status === 'ok'
    ? { kind: 'booking', scope: found.scope, attendeeId: found.attendeeId }
    : null;
}
