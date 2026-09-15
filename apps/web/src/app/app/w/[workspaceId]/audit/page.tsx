import type { Metadata } from 'next';
import { AuditLog } from '@/components/audit/audit-log';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AuditPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [initial, teammateName] = await Promise.all([
    api
      .POST('/v1/queries/audit.list', { body: { workspaceId, limit: 50, since } })
      .then(unwrapPage),
    // The AI teammate's name for its rows (the log works without it).
    api
      .POST('/v1/queries/ai_teammate.get', { body: { workspaceId } })
      .then((r) => r.data?.teammate?.name ?? null)
      .catch(() => null),
  ]);
  return (
    <>
      <PageHeader
        title="Audit log"
        description={`Every change in ${got.workspace.name}, who made it, and why. Entries can never be edited or deleted.`}
      />
      <AuditLog workspaceId={workspaceId} initial={initial} teammateName={teammateName} />
    </>
  );
}
