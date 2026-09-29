import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AiTagging } from '@/components/settings/ai-tagging';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Tags' };

/**
 * Settings → Tags (0107): the business's tags, the AI's pass over the whole customer list — start it, watch it, stop
 * it — and the log of what the AI changed lately and why. Setting up tags (`tags.manage`).
 */
export default async function TagsSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'tags.manage')) notFound();
  const [{ tags }, status, reviews] = await Promise.all([
    api.POST('/v1/queries/tag.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/contact_ai.status', { body: { workspaceId } }).then(unwrapPage),
    api
      .POST('/v1/queries/contact_ai.reviews', {
        body: { workspaceId, changedOnly: true, limit: 15 },
      })
      .then(unwrapPage),
  ]);
  return (
    <>
      <AiTagging
        workspaceId={workspaceId}
        tags={tags}
        status={status}
        reviews={reviews.items}
        canSeeAudit={can(got.workspace.permissions, 'audit.read')}
        canChangeAutomations={can(got.workspace.permissions, 'workspace.update')}
      />
    </>
  );
}
