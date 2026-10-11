import { useLocalSearchParams } from 'expo-router';

import { PlaybookScreen } from '@/addons/outreach/playbook';

/** One playbook: each part, and for owners and admins, changing it a part at a time. */
export default function PlaybookRoute() {
  const { playbookId } = useLocalSearchParams<{ playbookId: string }>();
  return <PlaybookScreen playbookId={playbookId} />;
}
