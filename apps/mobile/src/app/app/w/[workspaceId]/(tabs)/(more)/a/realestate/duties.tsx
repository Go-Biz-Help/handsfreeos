import { useLocalSearchParams } from 'expo-router';

import { DutiesScreen } from '@/addons/realestate/duties';
import { DutyScreen } from '@/addons/realestate/duty-sheet';

/** My duties, late first, and with `?duty=` the duty itself with its proof checklist (boards 77 and 79). */
export default function DutiesRoute() {
  const { scope, duty } = useLocalSearchParams<{ scope?: string; duty?: string }>();
  if (duty) return <DutyScreen dutyId={duty} />;
  return <DutiesScreen scope={scope} />;
}
