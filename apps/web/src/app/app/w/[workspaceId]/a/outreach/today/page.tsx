import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'Today' };

/**
 * Social Outreach's Today: what the person's computer is doing on each network, and the plan for today
 * (docs/outreach.md, decision 126).
 */
export default async function Page(props: OutreachPageProps) {
  const { workspaceId } = await props.params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => showOutreach('today', props));
}
