import { useLocalSearchParams } from 'expo-router';

import { DocumentsScreen } from '@/addons/realestate/documents';

/** The deal's documents: names, versions and who signed on the phone, each opened with signal (board 81). */
export default function DocumentsRoute() {
  const { dealId, esign } = useLocalSearchParams<{ dealId: string; esign?: string }>();
  return <DocumentsScreen dealId={dealId} esign={esign} />;
}
