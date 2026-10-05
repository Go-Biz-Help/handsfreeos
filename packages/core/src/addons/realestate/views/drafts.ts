/**
 * A client update from a phone's copy (Real Estate round six, board 81): what `realestate.status_email.get` answers
 * about its draft (its words, who it's to, where it stands), worked out from the rows the phone keeps. Checking it for
 * fair housing is the server's, with signal; the phone keeps whether the flags were acknowledged and when it was last
 * edited. `packages/core/test/addons/realestate-phone-views.test.ts` holds it to the server's answer.
 *
 * A deal kept as its summary has no drafts on the phone: null.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import type { StatusEmailGetOutput } from '../schemas';
import { holdsWhole, isoOr } from './deal-facts';
import { text, type RealestateCopy } from './synced';

type DraftOut = z.infer<typeof StatusEmailGetOutput>['draft'];
export type ClientUpdateView = Omit<DraftOut, 'failure' | 'requestedAt'> & {
  /** When it was last edited by a person, if it was. */
  readonly editedAt: string | null;
  /** Its fair-housing flags were acknowledged, with a reason, on the web. */
  readonly acknowledged: boolean;
};

/** The client update, or null when the phone doesn't hold it. */
export function clientUpdateOfCopy(
  copy: RealestateCopy,
  dealId: string,
  draftId: string,
  ctx: { readonly userId: string | null },
): ClientUpdateView | null {
  if (!copy.deals.has(dealId) || !holdsWhole(copy, dealId, ctx.userId)) return null;
  const row = copy.rows('drafts', dealId).find((r) => r.id === draftId);
  if (!row) return null;
  const d = row.data;
  const personId = text(d.person_id);
  const parts = personId ? copy.personParts(personId) : null;
  return {
    draftId,
    dealId,
    milestone: (text(d.milestone) ?? 'asked') as ClientUpdateView['milestone'],
    status: (text(d.status) ?? 'drafting') as ClientUpdateView['status'],
    subject: text(d.subject),
    body: text(d.body),
    // As the server names them: their name, else their email, else "Client".
    to:
      personId && parts
        ? { personId, name: copy.personPlain(personId) ?? 'Client', email: parts.email }
        : null,
    sentAt: isoOr(d.sent_at),
    editedAt: isoOr(d.edited_at),
    acknowledged: text(d.flags_acknowledged_at) !== null,
  };
}
