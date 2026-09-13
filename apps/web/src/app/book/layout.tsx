import type { ReactNode } from 'react';

/**
 * The public booking pages: no app chrome and no sign-in (proxy.ts leaves /book, /m and /w open). The
 * site's own layout adds the business's name and phone and the "Booking by HandsFreeOS" line.
 */
export default function BookLayout({ children }: { children: ReactNode }) {
  return children;
}
