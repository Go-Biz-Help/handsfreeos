import type { Metadata } from 'next';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'Results' };

/**
 * Social Outreach's Results: from reached to booked (docs/outreach.md, decision 126).
 */
export default function Page(props: OutreachPageProps) {
  return showOutreach('results', props);
}
