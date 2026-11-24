/**
 * What runs in the browser before the app does (Next's `instrumentation-client`). It has one job: the bar along the
 * top that says a click was heard (components/shell/navigation-progress.tsx) is told when a move to another page
 * starts, and when the page is there (lib/navigation-progress.ts).
 */
import { navigationLanded, navigationMove, navigationStarted } from '@/lib/navigation-progress';

/** Next calls this as a move starts: a link, `router.push` or `replace`, Back and Forward. Never for a page drawn again in place. */
export function onRouterTransitionStart(): void {
  navigationStarted();
}

// The router writes the address into the browser's history as the page lands, even when a move ends where it began,
// so that is when the bar finishes. It writes from inside React's commit, where nothing may be asked to draw, so the
// bar is told a moment later. Wrapped here, before the app starts, so the router's own wrapper goes around this one;
// what is asked of the history, and what it answers, pass through untouched.
for (const method of ['pushState', 'replaceState'] as const) {
  const write = window.history[method];
  window.history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
    const move = navigationMove();
    queueMicrotask(() => navigationLanded(move));
    return write.apply(this, args);
  };
}
