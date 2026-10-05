import { useLocalSearchParams } from 'expo-router';

import { FinancingScreen } from '@/addons/realestate/financing';

/** The loan’s steps from the lender, ticked with no signal when they call (board 85). */
export default function FinancingRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <FinancingScreen dealId={dealId} />;
}
