import { useLocalSearchParams } from 'expo-router';

import { MatchesScreen } from '@/addons/realestate/matches';

/** A buyer's new matches from the MLS (board 82). */
export default function MatchesRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <MatchesScreen dealId={dealId} />;
}
