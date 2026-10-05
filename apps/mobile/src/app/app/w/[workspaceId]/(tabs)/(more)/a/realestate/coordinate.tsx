import { useLocalSearchParams } from 'expo-router';

import { CoordinateScreen } from '@/addons/realestate/coordinate';
import { DutyScreen } from '@/addons/realestate/duty-sheet';

/** Coordinate: today, exceptions, the waiting room and workload, and with `?duty=` one duty (boards 77 and 79). */
export default function CoordinateRoute() {
  const { tab, mine, agent, duty } = useLocalSearchParams<{
    tab?: string;
    mine?: string;
    agent?: string;
    duty?: string;
  }>();
  if (duty) return <DutyScreen dutyId={duty} />;
  return <CoordinateScreen tab={tab} mine={mine} agent={agent} />;
}
