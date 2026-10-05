import { useLocalSearchParams } from 'expo-router';

import { OfferSummaryScreen } from '@/addons/realestate/offers';

/** An offer's one-page summary, as the client sees it (board 84). */
export default function OfferSummaryRoute() {
  const { dealId, offerId } = useLocalSearchParams<{ dealId: string; offerId: string }>();
  return <OfferSummaryScreen dealId={dealId} offerId={offerId} />;
}
