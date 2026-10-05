import { useLocalSearchParams } from 'expo-router';

import { ListingDescriptionScreen } from '@/addons/realestate/listing-description';

/** A listing’s description and its versions; writing one needs signal (board 87). */
export default function DescriptionRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <ListingDescriptionScreen dealId={dealId} />;
}
