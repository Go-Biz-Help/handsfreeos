import { DOCUMENT_SCREEN_WORDS as W } from '@hfos/core';
import * as React from 'react';

import { List, ListLabel } from '@/components/shell/list';
import { useNetwork } from '@/lib/network';

import { documentCalls, useSendsDocuments, type DocumentRow } from './calls';
import { DocumentListRow } from './screens';

/**
 * A customer's documents on their page (docs/documents.md, part 3): the latest ones sent to them and where each one
 * is, each opening its own page. For whoever can send documents; none of it is in the phone's copy, so it's asked for
 * while there's signal and stays out of the way without, or when nothing's been sent.
 */
export function DocumentsCard({
  workspaceId,
  personId,
}: {
  workspaceId: string;
  personId: string;
}) {
  const sends = useSendsDocuments();
  const { online } = useNetwork();
  const [rows, setRows] = React.useState<readonly DocumentRow[] | null>(null);

  React.useEffect(() => {
    if (!sends || !online) return;
    let cancelled = false;
    documentCalls(workspaceId)
      .list({ personId, limit: 5 })
      .then((got) => {
        if (!cancelled) setRows(got.documents);
      })
      .catch(() => {
        // A side card: what can't load stays out of the way.
      });
    return () => {
      cancelled = true;
    };
  }, [sends, online, workspaceId, personId]);

  if (!sends || !rows?.length) return null;
  return (
    <>
      <ListLabel>{W.phone.customerTitle}</ListLabel>
      <List testID="person-documents">
        {rows.map((r) => (
          <DocumentListRow key={r.id} workspaceId={workspaceId} row={r} about={false} />
        ))}
      </List>
    </>
  );
}
