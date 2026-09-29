import { addDays, can, localInstant } from '@hfos/core';
import Link from 'next/link';
import { Plus, UserPlus } from 'lucide-react';
import { ActionCenter } from '@/components/home/action-center';
import { ActionCenterIntro } from '@/components/home/action-center-intro';
import { AddonSuggestionCard } from '@/components/home/addon-suggestion';
import type { MemberOption } from '@/components/home/attention-context';
import { SetupChecklist } from '@/components/home/setup-checklist';
import { PageHeader } from '@/components/shell/page-header';
import { RoleBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiServer, getMe, unwrap, unwrapPage } from '@/lib/api/server';
import type { Members, Task } from '@/lib/api/types';
import { todayIn } from '@/lib/calendar/time';

const INDUSTRY: Record<string, string> = { home_services: 'Home services', other: 'Other' };

/** Everyone an item can be assigned to: the workspace's members, and the organization's owners and admins. */
function memberOptions(m: Members): MemberOption[] {
  const out = new Map<string, MemberOption>();
  for (const x of m.members)
    out.set(x.userId, { id: x.userId, fullName: x.fullName || x.email, role: x.role });
  for (const x of m.organizationAdmins)
    if (!out.has(x.userId))
      out.set(x.userId, { id: x.userId, fullName: x.fullName || x.email, role: x.orgRole });
  return [...out.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export default async function WorkspaceHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  // The Assistant's cards link to one item: /app/w/<id>?item=<itemId>.
  const linked = (await searchParams)['item'];
  const { api, userId } = await apiServer();
  const workspace = api
    .POST('/v1/queries/workspace.get', { body: { workspaceId } })
    .then((r) => unwrapPage(r));
  const [me, got, summary, list, suggested] = await Promise.all([
    getMe(),
    workspace,
    api.POST('/v1/queries/crm.summary', { body: { workspaceId } }).then((r) => unwrapPage(r)),
    api
      .POST('/v1/queries/attention.list', { body: { workspaceId, includeHandled: true } })
      .then((r) => unwrap(r))
      .catch(() => null),
    // Now and then an add-on that fits the business, for owners and admins only: nobody else is ever asked about
    // one (the owner's decision, 2026-09-28). A nicety: if it fails, Home carries on without it.
    workspace.then((w) =>
      can(w.workspace.permissions, 'addons.manage')
        ? api
            .POST('/v1/queries/addon.suggestion', { body: { workspaceId } })
            .then((r) => r.data?.suggestion ?? null)
            .catch(() => null)
        : null,
    ),
  ]);
  const ws = got.workspace;
  const suggestion = suggested ? (
    <AddonSuggestionCard workspaceId={ws.id} suggestion={suggested} />
  ) : null;
  const firstName = (me.user.fullName || me.user.email).split(/\s+/)[0];
  const canInvite = can(ws.permissions, 'members.invite');
  // The setup checklist is for a brand-new business only: no customers, and nothing needing attention. Someone
  // texting a number nobody has added to Contacts still belongs on the Action Center.
  const brandNew =
    summary.people + summary.companies === 0 &&
    (list?.counts.total ?? 0) === 0 &&
    (list?.handledToday ?? 0) === 0;

  if (brandNew)
    return (
      <>
        <PageHeader
          title={`Welcome back, ${firstName}`}
          description={`${ws.name} · ${INDUSTRY[ws.industry] ?? ws.industry} · ${ws.timezone}`}
          actions={
            <ButtonLink href={`/app/w/${ws.id}/customers`} variant="primary">
              <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
              Add person
            </ButtonLink>
          }
        />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="flex flex-col gap-5 lg:col-span-2">
            <Card className="p-6">
              <SetupChecklist
                workspaceId={ws.id}
                invited={got.counts.members > 1 || got.counts.pendingInvitations > 0}
                canInvite={canInvite}
              />
            </Card>
            <ActionCenterIntro
              workspaceId={ws.id}
              canImport={can(ws.permissions, 'records.import')}
            />
          </div>
          <div className="flex flex-col gap-5">
            <Card className="p-5">
              <div className="mb-3.5 flex items-center justify-between">
                <h3 className="text-[15px] font-semibold">Workspace</h3>
                <RoleBadge role={ws.role} />
              </div>
              <dl className="flex flex-col gap-2.5 text-[13px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-text-2">Business</dt>
                  <dd className="font-medium">{ws.name}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-2">Industry</dt>
                  <dd className="font-medium">{INDUSTRY[ws.industry] ?? ws.industry}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-2">Time zone</dt>
                  <dd className="font-medium">{ws.timezone}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-2">People</dt>
                  <dd className="font-medium">
                    {got.counts.members} member{got.counts.members === 1 ? '' : 's'}
                    {got.counts.pendingInvitations
                      ? ` · ${got.counts.pendingInvitations} invited`
                      : ''}
                  </dd>
                </div>
              </dl>
              <div className="my-4 h-px bg-border" />
              <Link
                href={`/app/w/${ws.id}/members`}
                className="text-[13px] font-medium text-accent-text hover:underline"
              >
                Manage members
              </Link>
              {canInvite ? (
                <>
                  <span className="mx-2 text-text-3">·</span>
                  <Link
                    href={`/app/w/${ws.id}/members?invite=1`}
                    className="text-[13px] font-medium text-accent-text hover:underline"
                  >
                    <UserPlus className="mr-1 inline h-3.5 w-3.5" strokeWidth={1.5} />
                    Invite
                  </Link>
                </>
              ) : null}
            </Card>
            {suggestion}
          </div>
        </div>
      </>
    );

  const now = new Date();
  const hour = Number(
    now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: ws.timezone }),
  );
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const dateLabel = now.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: ws.timezone,
  });
  // Today and tomorrow, for the Today card (an item carries its own appointment).
  const todayDate = todayIn(ws.timezone);
  const tomorrow = addDays(todayDate, 1);
  const [members, appointments, tasks, teammateName] = await Promise.all([
    api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then((r) => unwrapPage(r)),
    api
      .POST('/v1/queries/appointment.list', {
        body: {
          workspaceId,
          from: new Date(localInstant(todayDate, '00:00', ws.timezone)).toISOString(),
          to: new Date(localInstant(tomorrow, '24:00', ws.timezone)).toISOString(),
        },
      })
      .then((r) => unwrapPage(r).items),
    api
      .POST('/v1/queries/task.list', {
        body: { workspaceId, scope: 'all', status: 'open', limit: 100 },
      })
      .then((r) => unwrap(r).items)
      .catch((): Task[] => []),
    api
      .POST('/v1/queries/ai_teammate.get', { body: { workspaceId } })
      .then((r) => r.data?.teammate?.name ?? null)
      .catch(() => null),
  ]);

  return (
    <ActionCenter
      workspaceId={ws.id}
      timeZone={ws.timezone}
      myUserId={userId}
      greeting={`${greeting}, ${firstName}`}
      dateLabel={dateLabel}
      initial={list}
      members={memberOptions(members)}
      teammateName={teammateName}
      appointments={appointments}
      tasks={tasks}
      today={todayDate}
      tomorrow={tomorrow}
      newLeadHref={`/app/w/${ws.id}/pipeline`}
      highlightItem={typeof linked === 'string' ? linked : null}
      suggestion={suggestion}
    />
  );
}
