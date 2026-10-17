import {
  ADDON_CATALOG,
  coreFeatureHeld,
  MAIN_OFFER_PHONE_WORDS as PW,
  offerRowLine,
} from '@hfos/core';

import { useGrants } from '@/lib/grants';
import { useLiveAnswer } from '@/lib/live-answer';

import { mainOfferCalls } from './calls';

/**
 * Settings' Main offer row: whether it shows, from the person's own permissions with no signal (an add-on that uses
 * the offer runs here and they hold one of its permissions), and the line under it, from `main_offer.get` while
 * there's signal. With none, it says what the screen is for (answered 4).
 */
export function useMainOfferRow(workspaceId: string): {
  readonly here: boolean;
  readonly line: string;
} {
  const { permissions } = useGrants();
  const here = coreFeatureHeld(ADDON_CATALOG, permissions ?? [], 'main_offer');
  const answer = useLiveAnswer(
    here ? () => mainOfferCalls(workspaceId).get() : null,
    workspaceId,
    PW.rowOffline,
  );
  return { here, line: answer.data ? offerRowLine(answer.data) : PW.rowOffline };
}
