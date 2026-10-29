import type { Metadata } from 'next';
import { showOutreach, type OutreachPageProps } from '../../show';

export const metadata: Metadata = { title: 'Social Outreach settings' };

/**
 * A part of Social Outreach's Settings: a network's page, Your computer or Start fresh (docs/outreach.md,
 * decisions 73 and 126).
 */
export default function Page(props: OutreachPageProps) {
  return showOutreach('settings', props);
}
