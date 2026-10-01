import { and, eq, ne } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { people } from '@hfos/db/schema';

/**
 * Keeps a customer's yes to the separate box for offers (20261013002300), where it was ticked.
 *
 * Never over a STOP: a customer who stopped texts, or turned offers down, stays that way until they say
 * otherwise themselves. Server-only: it writes in the caller's transaction.
 */
export async function recordOffersConsent(tx: Tx, personId: string, source: string): Promise<void> {
  await tx
    .update(people)
    .set({ offersConsent: 'opted_in', offersConsentAt: new Date(), offersConsentSource: source })
    .where(
      and(
        eq(people.id, personId),
        ne(people.smsConsent, 'opted_out'),
        ne(people.offersConsent, 'opted_out'),
      ),
    );
}
