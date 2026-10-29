import type { Metadata } from 'next';
import { showOutreach, type OutreachPageProps } from '../../show';

export const metadata: Metadata = { title: 'Chats' };

/**
 * People's Chats: the person's chats, as the AI read them (docs/outreach.md, decision 126).
 */
export default function Page(props: OutreachPageProps) {
  return showOutreach('chats', props);
}
