import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SettingsNav } from '@/components/settings/settings-nav';
import { TemplatesEditor } from '@/components/settings/templates-editor';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Templates' };

export default async function TemplatesSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'templates.manage')) notFound();
  const { templates, folders } = unwrapPage(
    await api.POST('/v1/queries/template.list', { body: { workspaceId, includeArchived: true } }),
  );
  return (
    <>
      <PageHeader title="Settings" description={`How ${got.workspace.name} is set up.`} />
      <SettingsNav workspaceId={workspaceId} permissions={got.workspace.permissions} />
      <div className="mb-3">
        <h2 className="text-lg font-semibold tracking-tight">Templates</h2>
        <p className="text-[13px] text-text-2">
          The wording you send again and again. Anyone can reach for these when they write a
          message; what they say is up to you. Put <code>{'{{person.first_name}}'}</code> where a
          name goes — the same shorthand a workflow uses.
        </p>
      </div>
      <TemplatesEditor workspaceId={workspaceId} templates={templates} folders={folders} />
    </>
  );
}
