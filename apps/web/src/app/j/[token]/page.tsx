import type { Metadata } from 'next';
import { JoinSession } from '@/components/booking/join-session';

/** The link carries the person's own way into a session: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Join your session' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function JoinSessionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinSession token={token} />;
}
