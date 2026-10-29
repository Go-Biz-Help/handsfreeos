import type { Metadata } from 'next';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'Playbooks' };

/**
 * Social Outreach's Playbooks, with how each opener did (docs/outreach.md, decision 126).
 */
export default function Page(props: OutreachPageProps) {
  return showOutreach('playbooks', props);
}
