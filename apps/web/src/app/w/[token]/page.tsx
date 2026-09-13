import type { Metadata } from 'next';
import { WaitlistOffer } from '@/components/booking/waitlist-offer';

/** The link carries the offer's key: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'A time opened up' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** A waitlist offer's link (/w/<token>): the time held for this customer, and booking it. */
export default async function WaitlistOfferPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <WaitlistOffer token={token} />;
}
