import { documentBadge as badgeOf, type DocumentStatus } from '@hfos/core';
import type { BadgeVariant } from '@/components/ui/badge';

/** A document's state as a badge, in core's words and colours (the phone's are the same). */
export function documentBadge(
  status: DocumentStatus,
  finishing = false,
): { label: string; variant: BadgeVariant } {
  const { label, tone } = badgeOf(status, finishing);
  return { label, variant: tone };
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
