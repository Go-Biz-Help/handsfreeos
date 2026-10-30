import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'Find people' };

/**
 * Social Outreach's Find people (docs/outreach.md, decision 128): every way it finds new people, with what each found
 * this week.
 */
export default async function Page(props: OutreachPageProps) {
  const { workspaceId } = await props.params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => showOutreach('find', props));
}
