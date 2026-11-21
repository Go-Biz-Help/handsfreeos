import type { ReactNode } from 'react';

/**
 * The public booking pages: no app chrome and no sign-in (proxy.ts leaves /book, /m and /w open). Each page puts
 * itself under the business's name and phone with the "Booking by HandsFreeOS" line (PublicFrame), except a calendar
 * shown on the business's own website (`?embed=1`), which the site around it frames instead.
 */
export default function BookLayout({ children }: { children: ReactNode }) {
  return children;
}
