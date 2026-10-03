import { useLocalSearchParams } from 'expo-router';

import { DealScreen } from '@/addons/realestate/deal';

/** A deal, buyer or listing, and with `?duty=` one of its duties (boards 78 and 79). */
export default function DealRoute() {
  const { dealId, duty } = useLocalSearchParams<{ dealId: string; duty?: string }>();
  return <DealScreen dealId={dealId} duty={duty} />;
}
