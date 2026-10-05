import { useLocalSearchParams } from 'expo-router';

import { ListingPriceScreen } from '@/addons/realestate/listing-price';

/** A listing’s price and a change waiting on the seller (board 88); `?change=1` opens a new one. */
export default function PriceRoute() {
  const { dealId, change } = useLocalSearchParams<{
    dealId: string;
    change?: string;
  }>();
  return <ListingPriceScreen dealId={dealId} change={!!change} />;
}
