import type { Metadata } from 'next';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'Today' };

/**
 * Social Outreach's Today: what the person's computer is doing on each network, and the plan for today
 * (docs/outreach.md, decision 126).
 */
export default function Page(props: OutreachPageProps) {
  return showOutreach('today', props);
}
