import { addDays, localInstant } from '@hfos/core';
import Link from 'next/link';
import { Plus, UserPlus } from 'lucide-react';
import { HomeSummary } from '@/components/home/home-summary';
import { SetupChecklist } from '@/components/home/setup-checklist';
import { PageHeader } from '@/components/shell/page-header';
import { Badge, RoleBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, fetchMe, unwrapPage } from '@/lib/api/server';
import { todayIn } from '@/lib/calendar/time';

const INDUSTRY: Record<string, string> = { home_services: 'Home services', other: 'Other' };

export default async function WorkspaceHomePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api, userId } = await apiServer();
  const [me, got, summary] = await Promise.all([
    await fetchMe(api),
    unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/crm.summary', { body: { workspaceId } })),
  ]);
  const ws = got.workspace;
  const firstName = (me.user.fullName || me.user.email).split(/\s+/)[0];
  const canManage = ws.role === 'owner' || ws.role === 'admin';
  const hasCustomers = summary.people + summary.companies > 0;
  const hour = Number(
    new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: ws.timezone }),
  );
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: ws.timezone,
  });

  // Today's card: today's and tomorrow's appointments, in the workspace's zone.
  const todayDate = todayIn(ws.timezone);
  const tomorrow = addDays(todayDate, 1);
  const [tasks, leads, audit, members, appointments] = hasCustomers
    ? await Promise.all([
        unwrapPage(
          await api.POST('/v1/queries/task.list', {
            body: { workspaceId, scope: 'mine', status: 'open', limit: 6 },
          }),
        ),
        unwrapPage(
          await api.POST('/v1/queries/lead.list', {
            body: { workspaceId, status: 'open', limit: 50 },
          }),
        ),
        canManage
          ? unwrapPage(
              await api.POST('/v1/queries/audit.list', { body: { workspaceId, limit: 6 } }),
            )
          : Promise.resolve({ entries: [] }),
        unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
        unwrapPage(
          await api.POST('/v1/queries/appointment.list', {
            body: {
              workspaceId,
              from: new Date(localInstant(todayDate, '00:00', ws.timezone)).toISOString(),
              to: new Date(localInstant(tomorrow, '24:00', ws.timezone)).toISOString(),
            },
          }),
        ),
      ])
    : [null, null, null, null, null];

  return (
    <>
      <PageHeader
        title={hasCustomers ? `${greeting}, ${firstName}` : `Welcome back, ${firstName}`}
        description={
          hasCustomers
            ? `${ws.name} · ${today}`
            : `${ws.name} · ${INDUSTRY[ws.industry] ?? ws.industry} · ${ws.timezone}`
        }
        actions={
          <>
            {hasCustomers ? (
              <ButtonLink href={`/app/w/${ws.id}/pipeline`} variant="secondary">
                <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
                New lead
              </ButtonLink>
            ) : null}
            <ButtonLink href={`/app/w/${ws.id}/customers`} variant="primary">
              <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
              Add person
            </ButtonLink>
          </>
        }
      />
      {hasCustomers && tasks && leads && audit && members ? (
        <HomeSummary
          workspaceId={ws.id}
          summary={summary}
          tasks={tasks.items}
          coldLeads={leads.items.filter((l) => l.needsNextAction).slice(0, 5)}
          recent={audit.entries}
          members={assigneeOptions(members)}
          myUserId={userId}
          canModerate={canManage}
          today={
            appointments
              ? {
                  timeZone: ws.timezone,
                  date: todayDate,
                  tomorrow,
                  items: appointments.items,
                }
              : null
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Card className="p-6 lg:col-span-2">
            <SetupChecklist
              workspaceId={ws.id}
              invited={got.counts.members > 1 || got.counts.pendingInvitations > 0}
              canInvite={canManage}
            />
          </Card>
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
              {canManage ? (
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
            <Card className="border-transparent bg-accent-soft p-5 shadow-none">
              <h3 className="text-[15px] font-semibold text-accent-text">Next up</h3>
              <p className="mt-1.5 text-[13px] text-text-2">
                Add your first customer, or import a spreadsheet, and this page turns into your
                morning briefing: open leads, follow-ups that are due, and what the team did.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <ButtonLink href={`/app/w/${ws.id}/customers`} variant="primary" size="sm">
                  Add a person
                </ButtonLink>
                {canManage ? (
                  <ButtonLink href={`/app/w/${ws.id}/imports/new`} variant="secondary" size="sm">
                    Import a spreadsheet
                  </ButtonLink>
                ) : null}
              </div>
              <Badge variant="accent" className="mt-3">
                Milestone 2
              </Badge>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
