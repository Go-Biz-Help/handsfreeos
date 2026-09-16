import type { Metadata } from 'next';
import { PublicEstimate } from '@/components/money/public-estimate';

/** The link carries the estimate's key: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Your estimate' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function CustomerEstimatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // Everything is read from the customer's own browser, so the worker's per-address limits count per customer.
  return <PublicEstimate token={token} />;
}
