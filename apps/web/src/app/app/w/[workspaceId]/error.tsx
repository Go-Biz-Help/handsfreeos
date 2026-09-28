'use client';
import { TriangleAlert } from 'lucide-react';
import { AddonUnavailable } from '@/components/addons/unavailable';
import { MissingPage } from '@/components/shell/missing-page';
import { useWorkspaceShell } from '@/components/shell/workspace-shell';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { pageRefusalOf } from '@/lib/api/page-refusals';

/**
 * When a page in a business breaks, only the page does (FE-1). Next wraps each page of this segment in this
 * boundary inside the workspace layout, so the sidebar, the menu and the Assistant stay put and the rest of
 * HandsFreeOS keeps working; before it, one failing look-up blanked the whole app.
 *
 * A page load the API refused (lib/api/page-refusals.ts) isn't a breakage: an add-on that is off shows as off, and
 * anything else as the page not being there, the same as a 404. Everything else says so plainly, with Try again
 * (which loads the page afresh) and a way home. The reference is what the server logged it under.
 */
export default function WorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const { workspaceId, permissions } = useWorkspaceShell();
  const refusal = pageRefusalOf(error);
  if (refusal === 'addon_off')
    return (
      <AddonUnavailable
        workspaceId={workspaceId}
        canManage={permissions.includes('addons.manage')}
      />
    );
  if (refusal === 'refused') return <MissingPage />;
  return (
    <div className="mx-auto max-w-[480px] py-8 md:py-14" data-testid="page-error">
      <Card className="rounded-dialog p-7 text-center md:p-9">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-danger-soft text-danger-text">
          <TriangleAlert className="h-5 w-5" strokeWidth={1.5} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">This page didn’t load</h1>
        <p className="mt-2 text-text-2">
          Something went wrong on our side. The rest of HandsFreeOS is fine: try again, or go back
          home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button onClick={retry} data-testid="page-error-retry">
            Try again
          </Button>
          <ButtonLink href={`/app/w/${workspaceId}`} variant="secondary">
            Go to Home
          </ButtonLink>
        </div>
        {error.digest ? (
          <p className="mt-5 font-mono text-xs text-text-3">Reference {error.digest}</p>
        ) : null}
      </Card>
    </div>
  );
}
