import { useLocalSearchParams } from 'expo-router';

import { DocumentPagesScreen } from '@/documents/screens';

/** A sent document's pages as they're filled in (docs/documents.md, part 3). The web shows them on the document. */
export default function DocumentPagesRoute() {
  const { documentId } = useLocalSearchParams<{ documentId: string }>();
  return <DocumentPagesScreen documentId={String(documentId ?? '')} />;
}
