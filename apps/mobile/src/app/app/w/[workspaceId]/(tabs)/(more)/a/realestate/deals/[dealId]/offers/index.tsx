import { useLocalSearchParams } from 'expo-router';

import { OffersScreen } from '@/addons/realestate/offers';

/** A deal's offers (board 84); `?start=1` opens starting one on the web. */
export default function OffersRoute() {
  const { dealId, start } = useLocalSearchParams<{ dealId: string; start?: string }>();
  return <OffersScreen dealId={dealId} start={!!start} />;
}
