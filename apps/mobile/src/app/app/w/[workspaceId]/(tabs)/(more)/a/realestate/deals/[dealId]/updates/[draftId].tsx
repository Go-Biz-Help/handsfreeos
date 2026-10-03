import { useLocalSearchParams } from 'expo-router';

import { ClientUpdateScreen } from '@/addons/realestate/client-update';

/** A client update: checked and OK'd anywhere, asking before it goes late (board 81). */
export default function ClientUpdateRoute() {
  const { dealId, draftId } = useLocalSearchParams<{ dealId: string; draftId: string }>();
  return <ClientUpdateScreen dealId={dealId} draftId={draftId} />;
}
