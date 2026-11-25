import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { showOutreach, type OutreachPageProps } from '../../show';

export const metadata: Metadata = { title: 'Today' };

/**
 * A part of Social Outreach's Today: Plan (decision 195), Your list, Posts and events, Done today, or Your team for
 * owners and admins (docs/outreach.md, decision 193).
 */
export default async function Page(props: OutreachPageProps) {
  const { workspaceId } = await props.params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => showOutreach('today', props));
}
