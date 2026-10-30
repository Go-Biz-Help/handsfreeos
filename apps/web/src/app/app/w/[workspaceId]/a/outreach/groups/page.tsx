import { redirect } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import type { OutreachPageProps } from '../show';

/**
 * Where Groups was for a day (decision 127): it's under Find people now (decision 128), so a link to it goes there,
 * with its query.
 */
export default async function Page({ params, searchParams }: OutreachPageProps) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  return addonPage(workspaceId, 'outreach', 'outreach.use', () => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(sp))
      if (value !== undefined) query.set(key, Array.isArray(value) ? (value[0] ?? '') : value);
    const qs = query.toString();
    redirect(`/app/w/${workspaceId}/a/outreach/find/groups${qs ? `?${qs}` : ''}`);
  });
}
