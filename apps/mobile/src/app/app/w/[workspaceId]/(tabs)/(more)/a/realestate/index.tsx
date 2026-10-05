import { useLocalSearchParams } from 'expo-router';

import { DealsScreen } from '@/addons/realestate/deals';

/** Deals: mine, or every deal for whoever sees them all, with what could stop each and the filters (board 76). */
export default function DealsRoute() {
  const { view } = useLocalSearchParams<{ view?: string }>();
  return <DealsScreen view={view} />;
}
