import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { SafetySettingsPage } from '@/components/settings/safety-settings';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Safety' };

/**
 * Settings → Safety (round six, core): the business's times for check-ins and its safety person. Everyone in the
 * business may read them (the phone says when it asks and when it tells); whoever may change the business's settings
 * (`workspace.update`) changes them, and the menu shows the page to them.
 */
export default async function SafetySettings({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [got, settings] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/safety.settings', { body: { workspaceId } }).then(unwrapPage),
  ]);
  const canChange = can(got.workspace.permissions, 'workspace.update');
  // The team, for the safety person; someone who may not list it changes nothing here anyway.
  const members = canChange
    ? await api
        .POST('/v1/queries/workspace.members', { body: { workspaceId } })
        .then((r) => (r.response.status === 403 ? null : unwrapPage(r)))
    : null;
  const people = (members?.members ?? [])
    .map((m) => ({ id: m.userId, name: m.fullName || m.email, role: m.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <SafetySettingsPage
      workspaceId={workspaceId}
      settings={settings}
      people={people}
      canChange={canChange}
    />
  );
}
