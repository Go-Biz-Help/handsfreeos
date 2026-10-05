import { useLocalSearchParams } from 'expo-router';

import { ContingenciesScreen } from '@/addons/realestate/contingencies';

/** The deal's contingencies, resolved with no signal (board 80). */
export default function ContingenciesRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <ContingenciesScreen dealId={dealId} />;
}
