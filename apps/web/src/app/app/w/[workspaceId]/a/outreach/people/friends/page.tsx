import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { showOutreach, type OutreachPageProps } from '../../show';

export const metadata: Metadata = { title: 'Friends' };

/**
 * People's Friends: the person's friends and requests, and the Don't pitch and Never contact lists
 * (docs/outreach.md, decision 126).
 */
export default async function Page(props: OutreachPageProps) {
  const { workspaceId } = await props.params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => showOutreach('friends', props));
}
