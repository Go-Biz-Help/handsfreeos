import type { Metadata } from 'next';
import { ManageBooking } from '@/components/booking/manage-booking';

/** The link carries the booking's key: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Your appointment' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function ManageBookingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <ManageBooking token={token} />;
}
