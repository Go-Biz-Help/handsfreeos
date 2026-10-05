import { useLocalSearchParams } from 'expo-router';

import { OpenHousesScreen } from '@/addons/realestate/open-houses';

/** Hosting an open house, with those signed in (board 88); `?plan=1` opens planning one. */
export default function OpenHousesRoute() {
  const { dealId, plan } = useLocalSearchParams<{
    dealId: string;
    plan?: string;
  }>();
  return <OpenHousesScreen dealId={dealId} plan={!!plan} />;
}
