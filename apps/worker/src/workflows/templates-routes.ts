/**
 * "Update available" on a business's copy of an agency template (bearer token; workflows.manage there):
 * - POST /v1/workflows/template-update {workspaceId, workflowId} → what applying would do: the template's
 *   changes since the installed version, the business's own changes and which of them stay on top, the
 *   draft's changes in plain words, and placeholders still to pick. Nothing changes.
 * - POST /v1/workflows/template-update/apply {workspaceId, workflowId, baseRevision} → the update applied
 *   as a draft revision on the person's behalf (core's workflow_template.apply_update), never straight to
 *   live: it needs a passing test before it can be published. A stale revision is a 409 revision_conflict.
 * A business can't read its agency's templates, so both run as the system bound to that business.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  executeQuery,
  planTemplateUpdate,
  workflowTemplateApplyUpdate,
  workspaceGet,
  type HumanActor,
  type TemplateUpdatePlan,
} from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, header, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { systemActor, type TenantScope } from '../services';

const Ref = z.object({ workspaceId: z.uuid(), workflowId: z.uuid() });
const Apply = Ref.extend({ baseRevision: z.int().min(1) });

/** What the web's "Update available" dialog shows (apps/web/src/lib/agency/update.ts mirrors it). */
export interface TemplateUpdatePreview {
  readonly workflowId: string;
  readonly revision: number;
  readonly templateId: string;
  readonly templateName: string;
  readonly installedVersion: number | null;
  readonly latestVersion: number;
  readonly updateAvailable: boolean;
  readonly changedSinceInstall: boolean;
  /** The draft's changes if applied, in plain words. */
  readonly changes: readonly string[];
  readonly templateChanges: readonly string[];
  readonly yourChanges: readonly string[];
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
  readonly unmapped: readonly { key: string; kind: string; label: string }[];
}

export function previewOf(plan: TemplateUpdatePlan): TemplateUpdatePreview {
  return {
    workflowId: plan.workflow.id,
    revision: plan.workflow.revision,
    templateId: plan.templateId,
    templateName: plan.templateName,
    installedVersion: plan.installedVersion,
    latestVersion: plan.latestVersion,
    updateAvailable: plan.updateAvailable,
    changedSinceInstall: plan.changedSinceInstall,
    changes: plan.changes,
    templateChanges: plan.templateChanges,
    yourChanges: plan.yourChanges,
    kept: plan.kept,
    dropped: plan.dropped,
    unmapped: plan.unmapped.map((p) => ({ key: p.key, kind: p.kind, label: p.label })),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The business, once the person is known to see it and to manage its workflows. */
async function businessScope(
  deps: HttpDeps,
  actor: HumanActor,
  workspaceId: string,
): Promise<TenantScope> {
  const { workspace } = await executeQuery(deps.httpDb, workspaceGet, { workspaceId }, actor, {
    correlationId: randomUUID(),
    channel: 'web',
  });
  await requirePermission(deps, actor.userId, workspaceId, 'workflows.manage');
  return { workspaceId, organizationId: workspace.organizationId };
}

const correlationOf = (req: FastifyRequest) => {
  const id = header(req, 'x-correlation-id');
  return id && UUID_RE.test(id) ? id : randomUUID();
};

export async function registerTemplateRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  app.post('/v1/workflows/template-update', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(Ref, req.body);
    const scope = await businessScope(deps, actor, input.workspaceId);
    const plan = await asWorker(deps.httpDb, scope, (tx) =>
      planTemplateUpdate(tx, input.workspaceId, input.workflowId),
    );
    return previewOf(plan);
  });

  app.post('/v1/workflows/template-update/apply', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(Apply, req.body);
    const scope = await businessScope(deps, actor, input.workspaceId);
    const { output } = await executeCommand(
      deps.httpDb,
      workflowTemplateApplyUpdate,
      input,
      systemActor(scope, actor.userId),
      { correlationId: correlationOf(req), causationId: null, channel: 'web' },
    );
    return output;
  });
}
