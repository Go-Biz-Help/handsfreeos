import type { Metadata } from 'next';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'Needs you' };

/**
 * Social Outreach's Needs you: everything waiting on the person, on every network (docs/outreach.md,
 * decision 126).
 */
export default function Page(props: OutreachPageProps) {
  return showOutreach('needs', props);
}
