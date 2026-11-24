import { useIsFocused } from 'expo-router';
import * as React from 'react';

/**
 * Whether a screen is the one the person is looking at: not under another screen, and not on a tab that isn't the one
 * picked. A screen stays alive in both, and whatever asks HandsFreeOS again every few seconds went on asking from
 * there (the speed audit, Nov 2026: Social Outreach's pages asked about 34 times a minute from under the Inbox).
 * `useLiveAnswer` reads it, and waits while it's false.
 *
 * A route says so for what it holds (`RouteInView`). With no route saying, it counts as in view, so a screen drawn on
 * its own asks as it always did.
 */
const InView = React.createContext(true);

/** Around a route's screen, or around a layout's own parts: whether that route is the one in view. */
export function RouteInView({ children }: { children: React.ReactNode }) {
  return <InView.Provider value={useIsFocused()}>{children}</InView.Provider>;
}

export function useInView(): boolean {
  return React.useContext(InView);
}

/** For a test, or a part that's drawn somewhere a route can't say: in view or not, as told. */
export const InViewProvider = InView.Provider;
