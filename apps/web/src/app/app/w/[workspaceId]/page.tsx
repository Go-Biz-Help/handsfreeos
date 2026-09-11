import Link from 'next/link';
import { UserPlus } from 'lucide-react';
import { SetupChecklist } from '@/components/home/setup-checklist';
import { PageHeader } from '@/components/shell/page-header';
import { Badge, RoleBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiServer, fetchMe, unwrap } from '@/lib/api/server';

const INDUSTRY: Record<string, string> = { home_services: 'Home services', other: 'Other' };

export default async function WorkspaceHomePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [me, got] = await Promise.all([
    await fetchMe(api),
    unwrap(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } })),
  ]);
  const ws = got.workspace;
  const firstName = (me.user.fullName || me.user.email).split(/\s+/)[0];
  const canInvite = ws.role === 'owner' || ws.role === 'admin';
  return (
    <>
      <PageHeader
        title={`Welcome back, ${firstName}`}
        description={`${ws.name} · ${INDUSTRY[ws.industry] ?? ws.industry} · ${ws.timezone}`}
        actions={
          canInvite ? (
            <ButtonLink href={`/app/w/${ws.id}/members?invite=1`}>
              <UserPlus className="h-[18px] w-[18px]" strokeWidth={1.5} />
              Invite teammate
            </ButtonLink>
          ) : null
        }
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="p-6 lg:col-span-2">
          <SetupChecklist
            workspaceId={ws.id}
            invited={got.counts.members > 1 || got.counts.pendingInvitations > 0}
            canInvite={canInvite}
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
          </Card>
          <Card className="border-transparent bg-accent-soft p-5 shadow-none">
            <h3 className="text-[15px] font-semibold text-accent-text">Next up</h3>
            <p className="mt-1.5 text-[13px] text-text-2">
              Customers, pipeline and inbox arrive here in Milestone 2. Until then this page tracks
              setup and your team.
            </p>
            <Badge variant="accent" className="mt-3">
              Milestone 1
            </Badge>
          </Card>
        </div>
      </div>
    </>
  );
}
