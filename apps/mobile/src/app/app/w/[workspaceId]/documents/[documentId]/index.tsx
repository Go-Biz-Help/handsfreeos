import { useLocalSearchParams } from 'expo-router';

import { DocumentScreen } from '@/documents/screens';

/** One document sent to sign, at the web's own address (/app/w/<business>/documents/<document>). */
export default function DocumentRoute() {
  const { documentId } = useLocalSearchParams<{ documentId: string }>();
  return <DocumentScreen documentId={String(documentId ?? '')} />;
}
