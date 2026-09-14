import type { apiServer } from '@/lib/api/server';
import { unwrapPage } from '@/lib/api/server';
import type { WorkflowTemplateGet } from '@/lib/api/types';

type Api = Awaited<ReturnType<typeof apiServer>>['api'];

/** Every template of an agency, with its versions and installs (the Templates and Client businesses pages). */
export async function loadTemplates(
  api: Api,
  organizationId: string,
): Promise<WorkflowTemplateGet[]> {
  const list = unwrapPage(
    await api.POST('/v1/queries/workflow_template.list', { body: { organizationId } }),
  );
  return Promise.all(
    list.items.map(async (t) =>
      unwrapPage(
        await api.POST('/v1/queries/workflow_template.get', {
          body: { organizationId, templateId: t.id },
        }),
      ),
    ),
  );
}
