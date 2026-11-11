import { useLocalSearchParams } from 'expo-router';

import { VisitScreen } from '@/addons/contractor/work-order';

/** A visit's work order: its checklist and photos, what it needs, the time on it and its notes. */
export default function ContractorVisitRoute() {
  const { appointmentId } = useLocalSearchParams<{ appointmentId: string }>();
  return <VisitScreen appointmentId={appointmentId} />;
}
