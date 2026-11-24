import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { showOutreach, type OutreachPageProps } from '../../show';

export const metadata: Metadata = { title: 'Needs you' };

/**
 * A part of Social Outreach's Needs you: one kind of thing waiting on the person, such as the messages to OK or the
 * steps it couldn't do (docs/outreach.md, decision 193).
 */
export default async function Page(props: OutreachPageProps) {
  const { workspaceId } = await props.params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => showOutreach('needs', props));
}
