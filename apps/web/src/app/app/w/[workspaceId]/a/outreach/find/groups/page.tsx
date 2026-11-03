import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { showOutreach, type OutreachPageProps } from '../../show';

export const metadata: Metadata = { title: 'Groups' };

/**
 * Social Outreach's Groups, under Find people, and a group's own page (`?group=`; docs/outreach.md, decisions 103 and
 * 128).
 */
export default async function Page(props: OutreachPageProps) {
  const { workspaceId } = await props.params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => showOutreach('groups', props));
}
