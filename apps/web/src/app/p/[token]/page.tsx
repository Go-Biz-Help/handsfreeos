import type { Metadata } from 'next';
import { PublicPlan } from '@/components/money/public-plan';

/** The link carries the plan's key: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Your plan' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function CustomerPlanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // The provider sends the customer back here with the card token in the address; the page reads it after
  // mount, so the return trip never depends on how this request was rendered or cached.
  return <PublicPlan token={token} />;
}
