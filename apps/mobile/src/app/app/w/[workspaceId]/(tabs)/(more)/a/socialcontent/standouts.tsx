import { useLocalSearchParams } from 'expo-router';

import { StandoutsScreen } from '@/addons/socialcontent/standouts';

/** Standouts, kept to one network (`?network=`) or one creator (`?creator=`) when a link says so. */
export default function StandoutsRoute() {
  const { network, creator } = useLocalSearchParams<{ network?: string; creator?: string }>();
  return <StandoutsScreen network={network} creator={creator} />;
}
