import type { Metadata } from 'next';
import { UnsubscribePage } from '@/components/campaigns/unsubscribe-page';

/** The link carries the email's key: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Unsubscribe' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function Unsubscribe({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Opening the link only shows the button: a mail scanner opening it must never unsubscribe anybody.
  return <UnsubscribePage token={token} />;
}
