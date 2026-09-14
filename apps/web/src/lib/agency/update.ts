'use client';
import { ApiError } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';

/**
 * "Update available" on a business's copy of an agency template. The business can't read its agency's
 * templates, so the worker answers both (apps/worker/src/workflows/templates-routes.ts): what applying would
 * do, and applying it as a draft revision on your behalf. Owners and admins of the business only.
 */
export interface TemplateUpdatePreview {
  readonly workflowId: string;
  /** The draft revision the preview was made against (apply sends it back). */
  readonly revision: number;
  readonly templateId: string;
  readonly templateName: string;
  readonly installedVersion: number | null;
  readonly latestVersion: number;
  readonly updateAvailable: boolean;
  /** The copy was edited since it was installed. */
  readonly changedSinceInstall: boolean;
  /** The draft's changes if applied, in plain words. */
  readonly changes: readonly string[];
  /** What the agency changed since the installed version. */
  readonly templateChanges: readonly string[];
  /** What this business changed in its copy, and which of those stay or no longer fit. */
  readonly yourChanges: readonly string[];
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
  /** Details still to pick in this business. */
  readonly unmapped: readonly { key: string; kind: string; label: string }[];
}

export interface TemplateUpdateApplied {
  readonly workflowId: string;
  readonly revision: number;
  readonly version: number;
  readonly changed: boolean;
  readonly changes: readonly string[];
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
  readonly unmapped: readonly string[];
}

async function call<T>(path: string, body: unknown): Promise<T> {
  try {
    return await workerPost<T>(path, body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 0)
      throw new ApiError(
        0,
        'internal',
        'HandsFreeOS isn’t reachable right now. Try again in a minute.',
      );
    throw e;
  }
}

export function previewTemplateUpdate(
  workspaceId: string,
  workflowId: string,
): Promise<TemplateUpdatePreview> {
  return call('/v1/workflows/template-update', { workspaceId, workflowId });
}

export function applyTemplateUpdate(
  workspaceId: string,
  workflowId: string,
  baseRevision: number,
): Promise<TemplateUpdateApplied> {
  return call('/v1/workflows/template-update/apply', { workspaceId, workflowId, baseRevision });
}
