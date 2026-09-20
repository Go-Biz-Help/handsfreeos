import { hasWorkspacePermission } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SettingsNav } from '@/components/settings/settings-nav';
import { TextingPage } from '@/components/settings/texting-page';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, fetchMe, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Texting & calls' };

/** Owners and admins set up the business number and the carrier registration here. */
export default async function TextingSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [got, status, me, members] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/phone.setup_status', { body: { workspaceId } })),
    fetchMe(api),
    unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
  ]);
  const canManage = got.workspace.role === 'owner' || got.workspace.role === 'admin';
  if (!canManage) notFound();
  // Everyone who works the inbox — by first name for the "these browsers ring" line, and with their ids
  // for choosing who each number rings (M17).
  const inbox = members.members.filter((m) => hasWorkspacePermission(m.role, 'inbox.use'));
  const team = inbox.map((m) => (m.fullName.trim() || m.email).split(/\s+/)[0] ?? m.email);
  const people = inbox.map((m) => ({
    userId: m.userId,
    name: m.fullName.trim() || m.email,
  }));
  return (
    <>
      <PageHeader title="Settings" description="Your account, and how this workspace is set up." />
      <SettingsNav workspaceId={workspaceId} canManage />
      <TextingPage
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        status={status}
        me={{ fullName: me.user.fullName, email: me.user.email }}
        team={team}
        people={people}
      />
    </>
  );
}
