import { useLocalSearchParams } from 'expo-router';

import { ListingFactsScreen } from '@/addons/realestate/listing-facts';

/** A listing’s facts with where each came from, and what the MLS said (board 87). */
export default function FactsRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <ListingFactsScreen dealId={dealId} />;
}
