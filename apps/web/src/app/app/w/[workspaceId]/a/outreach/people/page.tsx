import type { Metadata } from 'next';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'People' };

/**
 * Social Outreach's People: everyone reached, by where they stand (docs/outreach.md, decision 126).
 */
export default function Page(props: OutreachPageProps) {
  return showOutreach('pipeline', props);
}
