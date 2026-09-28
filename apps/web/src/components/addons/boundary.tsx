'use client';
import { catchError, type ErrorInfo } from 'next/error';
import { Card } from '@/components/ui/card';

/** What shows in place of an add-on's panel that broke: one quiet line, and a way to try again. */
function PanelFailed({ addonName }: { addonName: string }, { retry }: ErrorInfo) {
  return (
    <Card className="px-4 py-3 text-[13px] text-text-2" data-testid="addon-panel-error">
      {addonName} couldn’t show this just now.{' '}
      <button
        type="button"
        onClick={retry}
        className="font-medium text-accent-text hover:underline"
      >
        Try again
      </button>
    </Card>
  );
}

/**
 * Fences one add-on's panel off from the page it sits on (FE-5): when the panel throws while drawing, or its code
 * fails to load, the page carries on and only that panel says so. Next's own boundary (`catchError`, next/error),
 * so a redirect or not-found from inside still reaches Next, moving to another page clears it, and Try again
 * reloads the page's data before drawing the panel again.
 */
export const AddonBoundary = catchError(PanelFailed);
