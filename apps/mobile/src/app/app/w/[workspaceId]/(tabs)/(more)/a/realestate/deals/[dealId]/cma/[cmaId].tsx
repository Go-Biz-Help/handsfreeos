import { useLocalSearchParams } from 'expo-router';

import { CmaScreen } from '@/addons/realestate/cma';

/** A CMA (board 84). */
export default function CmaRoute() {
  const { dealId, cmaId } = useLocalSearchParams<{ dealId: string; cmaId: string }>();
  return <CmaScreen dealId={dealId} cmaId={cmaId} />;
}
