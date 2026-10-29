import type { Metadata } from 'next';
import { showOutreach, type OutreachPageProps } from '../show';

export const metadata: Metadata = { title: 'Social Outreach settings' };

/**
 * Social Outreach's Settings, on General (docs/outreach.md, decisions 73 and 126).
 */
export default function Page(props: OutreachPageProps) {
  return showOutreach('settings', props);
}
