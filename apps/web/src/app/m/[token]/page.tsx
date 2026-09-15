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
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  // The reminder email's Confirm button adds ?confirm=1. It only points at the button: a mail scanner opening the
  // link must never confirm, so confirming stays a press.
  return <ManageBooking token={token} highlightConfirm={query.confirm === '1'} />;
}
