'use client';
import { useSyncExternalStore } from 'react';
import { navigationBar, subscribeNavigation, type NavigationBar } from '@/lib/navigation-progress';

const OFF = (): NavigationBar => 'off';

/**
 * The bar along the top of a business's pages while a move to another page is on its way, so a click shows at once
 * that it was heard: the page being left stays as it is, and usable, until the next one is there. It shows only for a
 * move that takes longer than a blink, creeps while the page is fetched, then runs to the end and goes
 * (lib/navigation-progress.ts has when; the motion is `.navigation-progress-bar` in globals.css). A page drawn again
 * in place (a live change, a press) never shows it.
 *
 * Only something to look at: it can't be pressed and takes no room, and a screen reader is told the new page's name
 * by the router as it always was.
 *
 * Why a bar and not an outline of the next page (a route's `loading.tsx`), which was tried first (the speed audit, Nov
 * 2026): under this layout's providers React draws a streamed page itself while the server's copy of it is still in
 * the document, so for a moment after a full load the page is there twice and a browser test that looks for a test id
 * finds two; and a page that sends the person on (`redirect()`) answers with a one-second wait in place of a 307 once
 * its outline has been sent. Both only on the built app, not `next dev`. Check there before adding one.
 */
export function NavigationProgress() {
  const bar = useSyncExternalStore(subscribeNavigation, navigationBar, OFF);
  if (bar === 'off') return null;
  return (
    <div
      aria-hidden="true"
      data-testid="navigation-progress"
      className="pointer-events-none fixed inset-x-0 top-0 z-[90] h-[3px] print:hidden"
    >
      <div className="navigation-progress-bar h-full bg-accent" data-state={bar} />
    </div>
  );
}
