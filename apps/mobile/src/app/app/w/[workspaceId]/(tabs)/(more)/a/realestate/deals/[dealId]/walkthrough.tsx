import { useLocalSearchParams } from 'expo-router';

import { WalkthroughScreen } from '@/addons/realestate/walkthrough';

/** The final walkthrough, checked on the phone with no signal (board 86). */
export default function WalkthroughRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <WalkthroughScreen dealId={dealId} />;
}
