import { SearchX } from 'lucide-react';
import type { Metadata } from 'next';
import { PublicFrame, PublicState } from '@/components/booking/public-shell';

export const metadata: Metadata = { title: { absolute: 'Booking page not found' } };

/** A booking link that doesn't lead anywhere (a missing or private calendar looks the same). */
export default function BookingNotFound() {
  return (
    <PublicFrame business={null}>
      <PublicState icon={<SearchX size={20} />} title="We couldn’t find that booking page">
        Check the link, or contact the business directly.
      </PublicState>
    </PublicFrame>
  );
}
