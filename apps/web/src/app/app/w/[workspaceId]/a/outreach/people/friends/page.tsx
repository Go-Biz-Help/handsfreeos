import type { Metadata } from 'next';
import { showOutreach, type OutreachPageProps } from '../../show';

export const metadata: Metadata = { title: 'Friends' };

/**
 * People's Friends: the person's friends and requests, and the Don't pitch and Never contact lists
 * (docs/outreach.md, decision 126).
 */
export default function Page(props: OutreachPageProps) {
  return showOutreach('friends', props);
}
