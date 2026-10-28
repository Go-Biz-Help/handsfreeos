import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { SendDocumentScreen, type SendAboutKind } from '@/documents/send';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined) =>
  typeof v === 'string' && UUID.test(v) ? v : null;

/**
 * Sending a document, at the web's own address (/app/w/<business>/documents/send): `?template=` picks it, `?person=`
 * (or `company`, `lead`) who it's about, and `?from=` a voided or declined document it corrects (answer 15a).
 */
export default function SendDocumentRoute() {
  const q = useLocalSearchParams<{
    template?: string;
    person?: string;
    company?: string;
    lead?: string;
    from?: string;
  }>();
  const about = React.useMemo(() => {
    const pick = (kind: SendAboutKind, id: string | null) => (id ? { kind, id } : null);
    return (
      pick('person', one(q.person)) ?? pick('company', one(q.company)) ?? pick('lead', one(q.lead))
    );
  }, [q.person, q.company, q.lead]);
  return (
    <SendDocumentScreen templateId={one(q.template)} about={about} fromDocumentId={one(q.from)} />
  );
}
