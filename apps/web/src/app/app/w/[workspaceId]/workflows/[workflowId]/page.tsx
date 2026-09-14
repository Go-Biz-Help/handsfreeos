import { hasWorkspacePermission } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WorkflowEditor } from '@/components/workflows/editor';
import type { QuietHours } from '@/components/workflows/editor-context';
import { apiServer, unwrap, unwrapPage } from '@/lib/api/server';
import type { SampleContact } from '@/lib/workflows/sample';

export const metadata: Metadata = { title: 'Workflow' };

const ID = /^[0-9a-f-]{36}$/i;

/** The editor (`?mode=steps&step=<id>`). Members see it read-only. */
export default async function WorkflowEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; workflowId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, workflowId } = await params;
  if (!ID.test(workflowId)) notFound();
  const query = await searchParams;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const canManage = hasWorkspacePermission(got.workspace.role, 'workflows.manage');
  const [wf, catalogs, people] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/workflow.get', { body: { workspaceId, workflowId } })),
    unwrapPage(await api.POST('/v1/queries/workflow.catalogs', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/person.list', { body: { workspaceId, limit: 1 } })),
  ]);
  let quietHours: QuietHours | null = null;
  try {
    quietHours = unwrap(await api.POST('/v1/queries/phone.setup_status', { body: { workspaceId } }))
      .settings.quietHours;
  } catch {
    // Not readable here: the notes fall back to the default 8 PM to 8 AM.
  }
  const first = people.items[0];
  const sample: SampleContact | null = first
    ? {
        id: first.id,
        firstName: first.firstName,
        lastName: first.lastName,
        fullName: first.fullName,
        email: first.email,
        phone: first.phone,
        city: first.address?.city ?? null,
      }
    : null;
  const step = typeof query.step === 'string' ? query.step : null;
  return (
    <WorkflowEditor
      key={workflowId}
      workspaceId={workspaceId}
      workflow={wf.workflow}
      versions={wf.versions}
      catalogs={catalogs.catalogs}
      canManage={canManage}
      businessName={got.workspace.name}
      quietHours={quietHours}
      sample={sample}
      initialStep={step}
    />
  );
}
