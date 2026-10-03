import { useLocalSearchParams } from 'expo-router';

import { ShowingsScreen } from '@/addons/realestate/showings';

/** A listing’s showing requests, what’s coming up and what buyers said (board 89). */
export default function ShowingsRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <ShowingsScreen dealId={dealId} />;
}
