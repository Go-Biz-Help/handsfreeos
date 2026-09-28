'use client';
import { SearchX } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useWorkspaceShell } from './workspace-shell';

/**
 * "We could not find that", drawn inside the business's shell: a link to a record that has gone, a page this
 * person may not open, or a place that isn't there. The menu stays beside it, so the way on is one press away
 * (app/app/w/[workspaceId]/not-found.tsx, and error.tsx for a refused page). The words are the app's own 404's.
 */
export function MissingPage() {
  const { workspaceId } = useWorkspaceShell();
  return (
    <div className="mx-auto max-w-[480px] py-8 md:py-14" data-testid="missing-page">
      <Card className="rounded-dialog p-7 text-center md:p-9">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-card-2 text-text-2">
          <SearchX className="h-5 w-5" strokeWidth={1.5} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">We could not find that</h1>
        <p className="mt-2 text-text-2">
          The page does not exist, or you do not have access to it.
        </p>
        <ButtonLink
          href={workspaceId ? `/app/w/${workspaceId}` : '/app'}
          variant="primary"
          className="mt-6"
        >
          Go to Home
        </ButtonLink>
      </Card>
    </div>
  );
}
