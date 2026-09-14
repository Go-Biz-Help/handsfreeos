'use client';
import { Plus, ScanSearch } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { ButtonLink } from '@/components/ui/button';

/** "Scan website" and "Add an FAQ" for owners and admins, except on the pages that already are those. */
export function KnowledgeHeaderActions({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const base = `/app/w/${workspaceId}/knowledge`;
  const onWebsite = pathname.startsWith(`${base}/website`);
  const onNew = pathname.startsWith(`${base}/items/new`);
  return (
    <>
      {onWebsite ? null : (
        <ButtonLink href={`${base}/website`} size="sm" data-testid="knowledge-scan-link">
          <ScanSearch className="h-4 w-4" strokeWidth={1.5} />
          Scan website
        </ButtonLink>
      )}
      {onNew ? null : (
        <ButtonLink
          href={`${base}/items/new?kind=faq`}
          variant="primary"
          size="sm"
          data-testid="knowledge-add-faq"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          Add an FAQ
        </ButtonLink>
      )}
    </>
  );
}
