import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { CalendarPage } from '@/addons/socialcontent/calendar-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Calendar · AI Social Media Content Creator' };

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * Calendar (docs/socialcontent.md, "Making posts"): the business's own posts for today and the two weeks after,
 * written by the AI, each waiting for an OK; `?post=` opens one. It opens through the gate like every add-on page.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const asked = one(sp['post']);
  const openPostId = asked && /^[0-9a-f-]{36}$/i.test(asked) ? asked : null;
  return addonPage(workspaceId, 'socialcontent', 'socialcontent.use', async () => {
    const { api } = await apiServer();
    const calendar = await api
      .POST('/v1/queries/socialcontent.calendar.get', { body: { workspaceId } })
      .then(unwrapPage);
    return <CalendarPage workspaceId={workspaceId} calendar={calendar} openPostId={openPostId} />;
  });
}
