import { useLocalSearchParams } from 'expo-router';

import { InspectionsScreen } from '@/addons/realestate/inspections';

/** The inspections and their findings, added at the home with no signal (board 85). */
export default function InspectionsRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <InspectionsScreen dealId={dealId} />;
}
