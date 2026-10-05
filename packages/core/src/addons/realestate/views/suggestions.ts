/**
 * Our listings suggested to a buyer, from a phone's copy (Real Estate round six): what `realestate.suggestions`
 * answers (ops/matching.ts), worked out from the buyer deal's suggestions the phone keeps. Each carries its own copy
 * of the listing's public facts, so nothing of the listing's deal is needed.
 * `packages/core/test/addons/realestate-phone-listing.test.ts` holds it to the server's answer.
 *
 * Suggestions go only to the buyer deal's people: on a deal kept as its summary the view is null and waits for signal,
 * as it is for a listing deal (which the server refuses).
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import type { SuggestionsOutput } from '../schemas';
import { isoOr } from './deal-facts';
import { wholeDeal } from './listing';
import { byText, iso, ms, text, type RealestateCopy } from './synced';

export type SuggestionsView = z.infer<typeof SuggestionsOutput>;
type Suggestion = SuggestionsView['suggestions'][number];

/** New first, then added, set aside and gone; newest first within each, as on the server. */
const ORDER = { new: 0, added: 1, not_a_fit: 2, gone: 3 } as const;

export function suggestionsOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null },
): SuggestionsView | null {
  if (!wholeDeal(copy, dealId, ctx.userId, 'buyer')) return null;
  return {
    dealId,
    suggestions: copy
      .rows('listing_suggestions', dealId)
      .map(({ id, data: s }) => {
        const facts =
          s.facts && typeof s.facts === 'object' && !Array.isArray(s.facts)
            ? (s.facts as Record<string, unknown>)
            : {};
        const by = text(s.decided_by);
        const out: Suggestion = {
          id,
          address: text(s.address) ?? '',
          priceCents: typeof facts['price_cents'] === 'number' ? facts['price_cents'] : null,
          facts,
          fit: (Array.isArray(s.fit) ? s.fit : []) as Suggestion['fit'],
          mlsNumber: text(s.mls_number),
          pageSlug: text(s.page_slug),
          state: (text(s.state) ?? 'new') as Suggestion['state'],
          homeId: text(s.home_id),
          decidedBy: by ? { id: by, fullName: copy.user(by) ?? 'Former member' } : null,
          decidedAt: isoOr(s.decided_at),
          decidedReason: text(s.decided_reason),
          createdAt: isoOr(s.created_at) ?? iso(0),
        };
        return { out, at: ms(s.created_at) ?? 0 };
      })
      .sort(
        (a, b) =>
          ORDER[a.out.state] - ORDER[b.out.state] || b.at - a.at || byText(b.out.id, a.out.id),
      )
      .map((s) => s.out),
  };
}
