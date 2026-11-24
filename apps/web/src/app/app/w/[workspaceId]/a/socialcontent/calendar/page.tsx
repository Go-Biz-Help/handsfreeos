import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import {
  isCalendarLook,
  lookRange,
  type CalendarLook,
} from '@hfos/core/addons/socialcontent/calendar-looks';
import { addonPage } from '@/addons/gate';
import { CalendarPage } from '@/addons/socialcontent/calendar-page';
import { dayAsked, LOOK_COOKIE } from '@/addons/socialcontent/looks';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Calendar · AI Social Media Content Creator' };

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * Calendar (docs/socialcontent.md, "Making posts" and "Picking many posts"): the business's own posts, written by the
 * AI, each waiting for an OK. It looks like a list of today and the two weeks after (the default), a week from Monday,
 * or a month (`?look=`, else the look picked last; `?day=` is a day in the week or month shown); `?post=` opens one.
 * It opens through the gate like every add-on page.
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
  const lookParam = one(sp['look']);
  const remembered = (await cookies()).get(LOOK_COOKIE)?.value;
  const look: CalendarLook = isCalendarLook(lookParam)
    ? lookParam
    : isCalendarLook(remembered)
      ? remembered
      : 'list';
  const day = dayAsked(one(sp['day']));
  return addonPage(workspaceId, 'socialcontent', 'socialcontent.use', async () => {
    const { api } = await apiServer();
    const get = (range?: { from?: string; days?: number; look?: 'week' | 'month' }) =>
      api
        .POST('/v1/queries/socialcontent.calendar.get', { body: { workspaceId, ...range } })
        .then(unwrapPage);
    // A week or month with no day asked for is the one with today in it, in the business's time zone, which the
    // server knows: one ask, where a one-day ask used to find today first (speed audit, Nov 2026).
    let calendar = await get(
      look === 'list' ? undefined : day ? lookRange(look, day, day) : { look },
    );
    // An API from before it took `look` (the minutes of a release) answers with today's list: ask for the days then.
    if (look !== 'list' && !day) {
      const want = lookRange(look, calendar.today, calendar.today);
      if (calendar.from !== want.from || calendar.days !== want.days) calendar = await get(want);
    }
    return (
      <CalendarPage
        workspaceId={workspaceId}
        calendar={calendar}
        openPostId={openPostId}
        look={look}
        day={look === 'list' ? calendar.today : (day ?? calendar.today)}
      />
    );
  });
}
