'use client';
/**
 * A booking page shown on the business's own website (`?embed=1`, the calendar's Booking link → On your website): the
 * parts of the flow that would leave the page do it in a tab of their own, since the pages they open can't be shown
 * inside somebody else's site (paying on the provider's page, Change or cancel), and each new step brings the top of
 * the box back into view on the site around it (/embed/v1/book.js). Off by default, so every other page that draws
 * these parts is unchanged.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { FRAME_TOP_MESSAGE } from '@/lib/forms/embed-script';

const Embedded = createContext(false);

export function EmbeddedBooking({ children }: { children: ReactNode }) {
  return <Embedded.Provider value>{children}</Embedded.Provider>;
}

/** Whether this booking page is inside the business's own site. */
export const useEmbedded = (): boolean => useContext(Embedded);

/** Asks the site around an embedded booking page to show the top of its box: the flow moved on a step. */
export function showFrameTop(): void {
  if (window.parent === window) return;
  window.parent.postMessage({ type: FRAME_TOP_MESSAGE }, '*');
}
