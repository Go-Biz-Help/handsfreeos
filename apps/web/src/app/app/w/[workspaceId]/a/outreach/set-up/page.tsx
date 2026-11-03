import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'Set up Social Outreach' };

/**
 * Social Outreach's Set up page (docs/outreach.md, decision 129): how far the setup has come, each step opening the
 * setup itself, and each network's Get ready. First in the side menu while anything's left.
 */
export default async function Page(props: OutreachPageProps) {
  const { workspaceId } = await props.params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => showOutreach('setup', props));
}
