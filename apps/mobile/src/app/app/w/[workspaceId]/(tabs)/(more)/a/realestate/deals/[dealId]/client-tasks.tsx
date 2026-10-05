import { useLocalSearchParams } from 'expo-router';

import { ClientTasksScreen } from '@/addons/realestate/client-tasks';

/** What the clients still have to do in their portal (board 85); `?invite=1` asks the first client not in it yet. */
export default function ClientTasksRoute() {
  const { dealId, invite } = useLocalSearchParams<{
    dealId: string;
    invite?: string;
  }>();
  return <ClientTasksScreen dealId={dealId} invite={!!invite} />;
}
