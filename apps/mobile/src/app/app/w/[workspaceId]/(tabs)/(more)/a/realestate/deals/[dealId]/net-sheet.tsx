import { useLocalSearchParams } from 'expo-router';

import { NetSheetScreen } from '@/addons/realestate/net-sheet';

/** What the seller walks away with, offer by offer (board 88). */
export default function NetSheetRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <NetSheetScreen dealId={dealId} />;
}
