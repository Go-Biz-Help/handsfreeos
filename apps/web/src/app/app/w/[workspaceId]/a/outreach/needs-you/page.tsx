import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'Needs you' };

/**
 * Social Outreach's Needs you: everything waiting on the person, on every network (docs/outreach.md,
 * decision 127).
 */
export default async function Page(props: OutreachPageProps) {
  const { workspaceId } = await props.params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => showOutreach('needs', props));
}
