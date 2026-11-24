import { businessAddressOf, calendarSetupContextFrom, can, CALENDAR_SETUP_WORDS } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  CalendarSetupDone,
  CalendarSetupFlow,
} from '@/components/calendar-setup/calendar-setup-flow';
import { assigneeOptions } from '@/lib/api/people';
import {
  apiServer,
  getMe,
  getSetupWorkspace,
  getWorkspace,
  unwrap,
  unwrapPage,
} from '@/lib/api/server';
import { buildCatalogs } from '@/lib/calendar/catalogs';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';

export const metadata: Metadata = { title: CALENDAR_SETUP_WORDS.pageTitle };

const ID = /^[0-9a-f-]{36}$/i;
const DAY = 86_400_000;

/**
 * The guided calendar setup (the owner, 22 Nov 2026, picks C1 a to C4 b): New calendar in Settings → Calendars opens
 * it. One question at a time on a page of its own, saved as it's answered, and nothing made before Check it over.
 * `?made=<id>` is its Done screen, after Make this calendar. Only someone who can change the business's calendars
 * comes here; anyone else goes Home.
 */
export default async function CalendarSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  const home = `/app/w/${workspaceId}`;
  const { api, email } = await apiServer();
  const mine = await getSetupWorkspace(workspaceId);
  if (!mine) notFound();
  if (!can(mine.ws.permissions, 'calendars.manage')) redirect(home);
  const query = await searchParams;
  const made = typeof query['made'] === 'string' && ID.test(query['made']) ? query['made'] : null;
  const [got, me, brandedOrigin] = await Promise.all([
    getWorkspace(workspaceId),
    getMe(),
    brandedOriginFor(api, workspaceId),
  ]);
  const firstName = me.user.fullName.trim().split(/\s+/)[0] || null;

  if (made) {
    const cal = await api
      .POST('/v1/queries/calendar.get', { body: { workspaceId, calendarId: made } })
      .then(unwrapPage);
    return (
      <CalendarSetupDone
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        email={email}
        calendar={cal.calendar}
        brandedOrigin={brandedOrigin}
        meantToOpen={query['open'] === '1'}
        datesMissed={Number(query['missed'] ?? 0) || 0}
      />
    );
  }

  const now = Date.now();
  const [members, team, services, resources, territories] = await Promise.all([
    api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
    api
      .POST('/v1/queries/schedule.team', {
        body: {
          workspaceId,
          from: new Date(now).toISOString(),
          to: new Date(now + DAY).toISOString(),
        },
      })
      .then(unwrapPage),
    api.POST('/v1/queries/service.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/resource.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/territory.list', { body: { workspaceId } }).then(unwrapPage),
  ]);
  // Read as optional: a business that can't see these still gets the questions, with texts and payments not ready.
  const [accounts, moneySettings, textingReady, draft] = await Promise.all([
    api
      .POST('/v1/queries/payment_connection.list', { body: { workspaceId } })
      .then((r) => r.data?.connections ?? [])
      .catch(() => []),
    api
      .POST('/v1/queries/money.settings', { body: { workspaceId } })
      .then((r) => r.data?.settings ?? null)
      .catch(() => null),
    api
      .POST('/v1/queries/phone.setup_status', { body: { workspaceId } })
      .then((r) => unwrap(r).messagingReady)
      .catch(() => false),
    // The web ships a little before the API: a draft it can't read yet is no draft.
    api
      .POST('/v1/queries/guided_setup.get_draft', { body: { workspaceId, setup: 'calendar' } })
      .then((r) => r.data ?? { answers: null, savedAt: null })
      .catch(() => ({ answers: null, savedAt: null })),
  ]);
  const people = assigneeOptions(members).map((p) => ({
    userId: p.id,
    fullName: p.fullName,
    weekly: team.people.find((t) => t.userId === p.id)?.weekly ?? null,
  }));
  const catalogs = buildCatalogs({
    timeZone: got.workspace.timezone,
    people,
    services: services.items,
    resources: resources.items,
    territories: territories.items,
    pipelines: [],
    textingReady,
    paymentAccounts: accounts
      .filter((c) => c.status === 'active')
      .map((c) => ({
        id: c.id,
        name: c.label ?? c.displayName ?? '',
        provider: c.provider,
        isDefault: c.isDefault,
      })),
    businessDeposit: moneySettings?.deposit ?? { kind: 'none' },
  });
  const a = businessAddressOf((got.workspace.settings ?? {}) as Record<string, unknown>);
  const address = a
    ? [a.line1, a.line2, `${a.city}, ${a.state} ${a.postalCode}`].filter(Boolean).join(', ')
    : null;
  const ctx = calendarSetupContextFrom(catalogs, {
    businessName: got.workspace.name,
    businessAddress: address,
    // The founder working in a business as its owner is never on its calendars.
    me: mine.founder ? null : me.user.id,
    ownHours: new Set(team.people.filter((p) => !p.defaultHours).map((p) => p.userId)),
  });
  return (
    <CalendarSetupFlow
      workspaceId={workspaceId}
      email={email}
      firstName={firstName}
      ctx={ctx}
      draft={{ answers: draft.answers, savedAt: draft.savedAt }}
    />
  );
}
