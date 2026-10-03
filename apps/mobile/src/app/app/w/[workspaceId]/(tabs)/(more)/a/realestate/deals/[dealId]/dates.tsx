import { useLocalSearchParams } from 'expo-router';

import { KeyDatesScreen } from '@/addons/realestate/dates';

/** The deal's key dates, each with where it came from (board 80). */
export default function KeyDatesRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <KeyDatesScreen dealId={dealId} />;
}
