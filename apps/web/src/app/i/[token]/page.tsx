import type { Metadata } from 'next';
import { PublicInvoice } from '@/components/money/public-invoice';

/** The link carries the invoice's key: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Your invoice' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function CustomerInvoicePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // The provider sends the customer back here with what it did in the address; the page reads it after mount,
  // so the return trip never depends on how this request was rendered or cached.
  return <PublicInvoice token={token} />;
}
