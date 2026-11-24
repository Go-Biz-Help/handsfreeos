import { useLocalSearchParams } from 'expo-router';

import { PlaybookScreen } from '@/addons/outreach/playbook';
import { RouteInView } from '@/lib/in-view';

/** One playbook: each part, and for owners and admins, changing it a part at a time. */
export default function PlaybookRoute() {
  const { playbookId } = useLocalSearchParams<{ playbookId: string }>();
  return (
    <RouteInView>
      <PlaybookScreen playbookId={playbookId} />
    </RouteInView>
  );
}
