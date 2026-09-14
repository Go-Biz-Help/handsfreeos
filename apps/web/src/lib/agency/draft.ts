'use client';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { WorkflowTemplateSaveDraftBody } from '@/lib/api/types';
import type { DraftAdapter } from '@/lib/workflows/use-draft';

/**
 * An agency template's draft for useWorkflowDraft: saves go to workflow_template.save_draft and "Load their
 * version" to workflow_template.get, with the same base-revision rules as a workflow's draft.
 */
export function templateDraftAdapter(organizationId: string, templateId: string): DraftAdapter {
  return {
    async save(baseRevision, ops) {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/workflow_template.save_draft', {
          body: {
            organizationId,
            templateId,
            baseRevision,
            ops: ops as unknown as WorkflowTemplateSaveDraftBody['ops'],
          },
        }),
      );
      return { revision: out.revision };
    },
    async load() {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/workflow_template.get', {
          body: { organizationId, templateId },
        }),
      );
      return { revision: out.template.revision, definition: out.template.definition };
    },
  };
}
