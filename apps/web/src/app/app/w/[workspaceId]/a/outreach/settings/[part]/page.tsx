import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { showOutreach, type OutreachPageProps } from '../../show';

export const metadata: Metadata = { title: 'Social Outreach settings' };

/**
 * A part of Social Outreach's Settings: a network's page, Your computer or Start fresh (docs/outreach.md,
 * decisions 73 and 126).
 */
export default async function Page(props: OutreachPageProps) {
  const { workspaceId } = await props.params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => showOutreach('settings', props));
}
