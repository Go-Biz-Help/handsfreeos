import { useLocalSearchParams } from 'expo-router';

import { HomesScreen } from '@/addons/realestate/homes';

/** A buyer's homes, and one home with `?home=<id>`; `?add=1` opens Add a home (board 82). */
export default function HomesRoute() {
  const { dealId, home, add } = useLocalSearchParams<{
    dealId: string;
    home?: string;
    add?: string;
  }>();
  return <HomesScreen dealId={dealId} homeId={home || undefined} add={!!add} />;
}
