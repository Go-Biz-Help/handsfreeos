import { calendarCardLines, can, parseConfig } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CalendarCard } from '@/components/calendars/calendar-card';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, getWorkspace, unwrapPage } from '@/lib/api/server';
import { buildCatalogs } from '@/lib/calendar/catalogs';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';

export const metadata: Metadata = { title: 'Calendar' };

const ID = /^[0-9a-f-]{36}$/i;

/**
 * A calendar's card (the owner, 22 Nov 2026, C3 a): the guided setup's seven answers, read back from what it does now,
 * each with Change, and All settings (./all) behind it with every setting it has.
 */
export default async function CalendarCardPage({
  params,
}: {
  params: Promise<{ workspaceId: string; calendarId: string }>;
}) {
  const { workspaceId, calendarId } = await params;
  if (!ID.test(calendarId)) notFound();
  const { api } = await apiServer();
  const got = await getWorkspace(workspaceId);
  if (!can(got.workspace.permissions, 'calendars.manage')) notFound();
  const [cal, members, services, resources, territories, brandedOrigin] = await Promise.all([
    api.POST('/v1/queries/calendar.get', { body: { workspaceId, calendarId } }).then(unwrapPage),
    api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
    api
      .POST('/v1/queries/service.list', { body: { workspaceId, includeArchived: true } })
      .then(unwrapPage),
    api
      .POST('/v1/queries/resource.list', { body: { workspaceId, includeArchived: true } })
      .then(unwrapPage),
    api.POST('/v1/queries/territory.list', { body: { workspaceId } }).then(unwrapPage),
    brandedOriginFor(api, workspaceId),
  ]);
  const config = parseConfig(cal.calendar.config);
  // Names only: the card says who, what and where in words, and the server's own check says what to fix.
  const catalogs = buildCatalogs({
    timeZone: cal.calendar.timezone,
    people: assigneeOptions(members).map((p) => ({ userId: p.id, fullName: p.fullName })),
    departed: config.team.members.map((m) => m.userId),
    services: services.items,
    resources: resources.items,
    territories: territories.items,
    pipelines: [],
    textingReady: true,
  });
  return (
    <CalendarCard
      key={cal.calendar.id}
      workspaceId={workspaceId}
      calendar={cal.calendar}
      lines={calendarCardLines(config, catalogs)}
      brandedOrigin={brandedOrigin}
    />
  );
}
