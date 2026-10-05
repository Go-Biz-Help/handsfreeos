import { useLocalSearchParams } from 'expo-router';

import { BuyerWantsScreen } from '@/addons/realestate/buyer';

/** What the buyer wants (board 82). */
export default function BuyerWantsRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <BuyerWantsScreen dealId={dealId} />;
}
