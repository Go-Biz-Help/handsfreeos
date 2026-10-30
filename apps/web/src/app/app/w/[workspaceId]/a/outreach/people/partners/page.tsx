import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { showOutreach, type OutreachPageProps } from '../../show';

export const metadata: Metadata = { title: 'Partners' };

/**
 * People's Partners list (docs/outreach.md, decisions 81 and 127).
 */
export default async function Page(props: OutreachPageProps) {
  const { workspaceId } = await props.params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => showOutreach('partners', props));
}
