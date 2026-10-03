import { useLocalSearchParams } from 'expo-router';

import { HistoryScreen } from '@/addons/realestate/history';

/** What happened on the deal, newest first (board 81). */
export default function HistoryRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <HistoryScreen dealId={dealId} />;
}
