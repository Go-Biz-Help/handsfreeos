import { can, myCalendarSetupScreen, MY_CALENDAR_SETUP_WORDS } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  MyCalendarSetupDone,
  MyCalendarSetupFlow,
} from '@/components/my-calendar-setup/my-calendar-setup-flow';
import { apiServer, getMe, getSetupWorkspace } from '@/lib/api/server';

export const metadata: Metadata = { title: MY_CALENDAR_SETUP_WORDS.pageTitle };

/**
 * The guided My calendar setup (the owner, 24 Nov 2026: M1 a to M4 a). Getting started's Connect your calendar opens
 * it (`?from=home`: Finish later and Done go Home), and so does Settings → My calendar (Start until it's set up,
 * then Change and Go through the questions again). One question at a time on a page of its own, saved as it's
 * answered, and nothing changed before Check it over. `?at=<question>` is Settings' Change for one answer;
 * `?step=done` is Done, where Google's, Microsoft's and Zoom's sign-ins come back to (with `?calendar=` or
 * `?meeting=`, through setup-return.ts). Everyone sets up their own; someone whose role doesn't take appointments
 * goes to Settings → My calendar, and so does everyone while the API can't answer for it yet.
 */
export default async function MyCalendarSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  const settings = `/app/w/${workspaceId}/settings/my-calendar`;
  const { api, email } = await apiServer();
  // The person's own business, or one the founder is working in as its owner.
  const mine = await getSetupWorkspace(workspaceId);
  if (!mine) notFound();
  if (!can(mine.ws.permissions, 'appointments.write')) redirect(settings);
  const query = await searchParams;
  const from = query['from'] === 'home' ? 'home' : 'settings';
  const one = (key: string) => (typeof query[key] === 'string' ? query[key] : null);
  // The web ships a little before the API: until it can answer, today's page does it all.
  const ctx = await api
    .POST('/v1/queries/my_calendar_setup.get', { body: { workspaceId } })
    .then((r) => r.data ?? null)
    .catch(() => null);
  if (!ctx) redirect(settings);
  const businessName = mine.ws.name;

  if (query['step'] === 'done')
    return (
      <MyCalendarSetupDone
        workspaceId={workspaceId}
        businessName={businessName}
        email={email}
        ctx={ctx}
        result={one('calendar')}
        meetingResult={one('meeting')}
        zoom={query['zoom'] === '1'}
        from={from}
      />
    );

  const [draft, me] = await Promise.all([
    api
      .POST('/v1/queries/guided_setup.get_draft', { body: { workspaceId, setup: 'my_calendar' } })
      .then((r) => r.data ?? { answers: null, savedAt: null })
      .catch(() => ({ answers: null, savedAt: null })),
    getMe(),
  ]);
  const at = myCalendarSetupScreen.safeParse(query['at']);
  return (
    <MyCalendarSetupFlow
      workspaceId={workspaceId}
      businessName={businessName}
      email={email}
      firstName={me.user.fullName.trim().split(/\s+/)[0] || null}
      ctx={ctx}
      draft={{ answers: draft.answers, savedAt: draft.savedAt }}
      at={at.success ? at.data : null}
      from={from}
    />
  );
}
