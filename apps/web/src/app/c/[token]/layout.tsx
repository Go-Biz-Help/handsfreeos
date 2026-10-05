import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PortalShell } from '@/components/portal/portal-shell';

/** The link carries the portal's key: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Your portal' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * A customer's portal (Real Estate round two, core). Everything in it is read in the customer's browser, with the
 * device's own sign-in, so the frame stays put while its pages change.
 */
export default async function PortalLayout({
  params,
  children,
}: {
  params: Promise<{ token: string }>;
  children: ReactNode;
}) {
  const { token } = await params;
  return <PortalShell token={token}>{children}</PortalShell>;
}
