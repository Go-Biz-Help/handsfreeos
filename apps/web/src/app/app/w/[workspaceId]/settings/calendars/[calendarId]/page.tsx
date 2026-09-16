import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CalendarBuilder } from '@/components/calendars/builder';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrap, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Calendar settings' };

const ID = /^[0-9a-f-]{36}$/i;
const DAY = 86_400_000;
const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** The builder: every module, labels, conflicts with Fix, the booking link, Save with the impact review. */
export default async function CalendarBuilderPage({
  params,
}: {
  params: Promise<{ workspaceId: string; calendarId: string }>;
}) {
  const { workspaceId, calendarId } = await params;
  if (!ID.test(calendarId)) notFound();
  const { api, userId } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (got.workspace.role !== 'owner' && got.workspace.role !== 'admin') notFound();
  const now = Date.now();
  const [cal, members, team, services, resources, territories, pipelines] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/calendar.get', { body: { workspaceId, calendarId } })),
    unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
    unwrapPage(
      await api.POST('/v1/queries/schedule.team', {
        body: {
          workspaceId,
          from: new Date(now).toISOString(),
          to: new Date(now + DAY).toISOString(),
        },
      }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/service.list', { body: { workspaceId, includeArchived: true } }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/resource.list', {
        body: { workspaceId, includeArchived: true },
      }),
    ),
    unwrapPage(await api.POST('/v1/queries/territory.list', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/pipeline.list', { body: { workspaceId } })),
  ]);
  let textingReady = false;
  try {
    textingReady = unwrap(
      await api.POST('/v1/queries/phone.setup_status', { body: { workspaceId } }),
    ).messagingReady;
  } catch {
    // Not able to read it: treat texting as not ready, which only adds a warning.
  }
  // Settings → Payments, for the Payments module: the accounts money can be taken into, and the deposit the
  // business asks for. Both are the business's, set once; the calendar only chooses whether to ask.
  const [accounts, moneySettings] = await Promise.all([
    api
      .POST('/v1/queries/payment_connection.list', { body: { workspaceId } })
      .then((r) => r.data?.connections ?? [])
      .catch(() => []),
    api
      .POST('/v1/queries/money.settings', { body: { workspaceId } })
      .then((r) => r.data?.settings ?? null)
      .catch(() => null),
  ]);
  const roles = new Map(members.members.map((m) => [m.userId, m.role]));
  const people = assigneeOptions(members).map((p) => ({
    userId: p.id,
    fullName: p.fullName,
    role: ROLE[roles.get(p.id) ?? ''] ?? 'Organization admin',
    weekly: team.people.find((t) => t.userId === p.id)?.weekly ?? null,
  }));
  return (
    <CalendarBuilder
      key={cal.calendar.id}
      workspaceId={workspaceId}
      myUserId={userId}
      calendar={cal.calendar}
      revisions={cal.revisions}
      people={people}
      services={services.items}
      resources={resources.items}
      territories={territories.items}
      pipelines={pipelines.pipelines}
      textingReady={textingReady}
      payments={{
        // Only a live account counts, exactly as the server's `paymentsAvailable` counts it.
        accounts: accounts
          .filter((c) => c.status === 'active')
          .map((c) => ({
            id: c.id,
            name: c.label ?? c.displayName ?? '',
            provider: c.provider,
            isDefault: c.isDefault,
          })),
        deposit: moneySettings?.deposit ?? { kind: 'none' },
      }}
    />
  );
}
