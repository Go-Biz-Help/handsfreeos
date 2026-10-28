import { DOCUMENT_STATUS_LABELS, type DocumentStatus } from '@hfos/core';
import type { BadgeVariant } from '@/components/ui/badge';

/** A document's state as a badge: out, finishing (everyone signed, the copy being made), signed, or closed. */
export function documentBadge(
  status: DocumentStatus,
  finishing = false,
): { label: string; variant: BadgeVariant } {
  if (finishing) return { label: 'Making the signed copy', variant: 'accent' };
  const variant: Record<DocumentStatus, BadgeVariant> = {
    out: 'pending',
    completed: 'ok',
    declined: 'danger',
    voided: 'gray',
    expired: 'gray',
  };
  return { label: DOCUMENT_STATUS_LABELS[status], variant: variant[status] };
}

/** Where the customer, company, lead or record a document is about lives in the app. */
export function aboutHref(
  workspaceId: string,
  about: { kind: 'person' | 'company' | 'lead' | 'custom_record'; id: string },
): string {
  const base = `/app/w/${workspaceId}`;
  switch (about.kind) {
    case 'person':
      return `${base}/customers/people/${about.id}`;
    case 'company':
      return `${base}/customers/companies/${about.id}`;
    case 'lead':
      return `${base}/leads/${about.id}`;
    case 'custom_record':
      return `${base}/customers/records/${about.id}`;
  }
}
