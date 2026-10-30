import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'People' };

/**
 * Social Outreach's People: everyone reached, by where they stand (docs/outreach.md, decision 127).
 */
export default async function Page(props: OutreachPageProps) {
  const { workspaceId } = await props.params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => showOutreach('pipeline', props));
}
