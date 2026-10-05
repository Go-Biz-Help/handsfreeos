import { useLocalSearchParams } from 'expo-router';

import { OfferScreen } from '@/addons/realestate/offers';

/** One offer and its versions (board 84). */
export default function OfferRoute() {
  const { dealId, offerId } = useLocalSearchParams<{ dealId: string; offerId: string }>();
  return <OfferScreen dealId={dealId} offerId={offerId} />;
}
