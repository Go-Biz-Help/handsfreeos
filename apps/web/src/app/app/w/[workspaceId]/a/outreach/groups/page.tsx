import type { Metadata } from 'next';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'Groups' };

/**
 * Social Outreach's Groups, and a group's own page (`?group=`; docs/outreach.md, decision 126).
 */
export default function Page(props: OutreachPageProps) {
  return showOutreach('groups', props);
}
