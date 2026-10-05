import type { Metadata } from 'next';
import { SafetyContactPage } from '@/components/safety/contact-page';

/** The link carries the alert's key: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Safety check' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * An outside safety contact's page (round six, core): the link in their text or email when someone who picked them
 * missed a check-out. Opening it only shows the check-in; a mail scanner opening it changes nothing.
 */
export default async function SafetyContact({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SafetyContactPage token={token} />;
}
