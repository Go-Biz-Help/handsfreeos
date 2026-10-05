'use client';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { SlotProps } from '../registry';
import { dealHref } from './bits';
import { DealsPanel } from './deals-panel';

/**
 * On a record of the add-on's own kinds: a property's deals (both sides of a sale are two deals on one property),
 * or, on a deal's plain record page, the way to its page in Real Estate Agent.
 */
export default function RecordPanel({
  workspaceId,
  recordId,
  recordTypeKey,
}: SlotProps<'record.panels'>) {
  if (recordTypeKey === 'realestate_deal')
    return (
      <Card className="p-4 md:p-5">
        <p className="text-[13.5px] text-text-2">
          This is a deal in Real Estate Agent: its duties, dates and documents are on its own page.
        </p>
        <Link
          href={dealHref(workspaceId, recordId)}
          className="mt-2 inline-block text-[13.5px] text-accent-text hover:underline"
        >
          Open the deal
        </Link>
      </Card>
    );
  if (recordTypeKey !== 'realestate_property') return null;
  return (
    <DealsPanel
      workspaceId={workspaceId}
      of={{ propertyId: recordId }}
      defaults={async () => {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/custom_record.get', {
            body: { workspaceId, customRecordId: recordId },
          }),
        );
        return { property: { propertyId: recordId, address: out.record.name } };
      }}
    />
  );
}
