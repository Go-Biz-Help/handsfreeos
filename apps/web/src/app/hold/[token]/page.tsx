import type { Metadata } from 'next';
import { HoldPage } from '@/components/booking/hold-page';

/** The link carries the booking's key: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Hold your time' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function BookingHoldPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // The provider sends the customer back here with what it did in the address; the page reads it after mount,
  // so the return trip never depends on how this request was rendered or cached.
  return <HoldPage token={token} />;
}
