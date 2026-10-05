'use client';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { SlotProps } from '../registry';
import { DealsPanel } from './deals-panel';

/** The deal a Pipeline lead became, or Start one from it: its customer is the client. */
export default function LeadPanel({ workspaceId, leadId, personId }: SlotProps<'lead.panels'>) {
  return (
    <DealsPanel
      workspaceId={workspaceId}
      of={{ leadId, personId }}
      lead
      defaults={async () => {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/lead.get', { body: { workspaceId, leadId } }),
        );
        const p = out.lead.person ?? (personId ? { id: personId, fullName: '' } : null);
        return {
          lead: { leadId, title: out.lead.title },
          client: p ? { personId: p.id, name: p.fullName } : null,
        };
      }}
    />
  );
}
