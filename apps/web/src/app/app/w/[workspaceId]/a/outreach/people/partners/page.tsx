import type { Metadata } from 'next';
import { showOutreach, type OutreachPageProps } from '../../show';

export const metadata: Metadata = { title: 'Partners' };

/**
 * People's Partners list (docs/outreach.md, decisions 81 and 126).
 */
export default function Page(props: OutreachPageProps) {
  return showOutreach('partners', props);
}
