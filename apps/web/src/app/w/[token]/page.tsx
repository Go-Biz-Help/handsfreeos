import { Clock } from 'lucide-react';
import type { Metadata } from 'next';
import { PublicFrame, PublicState } from '@/components/booking/public-shell';

export const metadata: Metadata = {
  title: { absolute: 'A spot opened up' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * A waitlist offer's link (/w/<token>). Claiming the offer online arrives with the reminders and
 * waitlist-offer step; until then this page says so.
 */
export default function WaitlistOfferPage() {
  return (
    <PublicFrame business={null}>
      <PublicState
        tone="accent"
        icon={<Clock size={20} />}
        title="Claiming a spot online is coming soon"
      >
        This page will let you claim a time that opened up. For now, call the business and they’ll
        book you in.
      </PublicState>
    </PublicFrame>
  );
}
