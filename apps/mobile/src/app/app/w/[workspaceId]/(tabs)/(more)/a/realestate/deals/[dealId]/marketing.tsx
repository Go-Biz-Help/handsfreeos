import { useLocalSearchParams } from 'expo-router';

import { ListingMarketingScreen } from '@/addons/realestate/listing-marketing';

/** What’s out and what’s ready for a listing (board 88); `?live=1` opens marking it live on the MLS. */
export default function MarketingRoute() {
  const { dealId, live } = useLocalSearchParams<{
    dealId: string;
    live?: string;
  }>();
  return <ListingMarketingScreen dealId={dealId} live={!!live} />;
}
