/**
 * A business's copy of an agency template and the newest version waiting for it: what the template changed,
 * what the business changed since it installed, and the two merged (template-merge.ts), both versions
 * resolved with the business's stored mapping. A business can't read its agency's templates, so this runs
 * where they can be read: as the system, bound to the business and its organization (the install and
 * apply-update commands, and the worker's preview route). Server-only; exported from '@hfos/core/server'.
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import {
  workflowTemplateInstalls,
  workflowTemplates,
  workflowTemplateVersions,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import { parseDefinition, type WorkflowDefinition } from './definition';
import { describeOps, diffWorkflows } from './describe';
import {
  loadWorkflow,
  loadWorkflowCatalogs,
  parseStoredDefinition,
  refUserIds,
  type LoadedWorkflowCatalogs,
  type WorkflowRow,
} from './load';
import type { WorkflowOp } from './ops';
import { placeholdersIn, resolvePlaceholders, type WorkflowPlaceholder } from './recipes';
import {
  describeTemplateMerge,
  effectiveMapping,
  mergeTemplateUpdate,
  type PlaceholderIds,
} from './template-merge';

/** One published template version's definition (placeholders still in it); null when there's no such version. */
export async function templateVersionDefinition(
  tx: Tx,
  templateId: string,
  version: number,
): Promise<WorkflowDefinition | null> {
  const [v] = await tx
    .select({ definition: workflowTemplateVersions.definition })
    .from(workflowTemplateVersions)
    .where(
      and(
        eq(workflowTemplateVersions.templateId, templateId),
        eq(workflowTemplateVersions.version, version),
      ),
    );
  return v ? parseStoredDefinition(v.definition) : null;
}

/** A template definition with the business's ids in place of its mapped placeholders. */
export const resolveTemplate = (def: WorkflowDefinition, mapping: PlaceholderIds) =>
  parseDefinition(resolvePlaceholders(def, mapping));

/** Every placeholder in these definitions, once each, in order of first use. */
export function placeholdersOf(...defs: (WorkflowDefinition | null)[]): WorkflowPlaceholder[] {
  const out = new Map<string, WorkflowPlaceholder>();
  for (const def of defs)
    if (def) for (const p of placeholdersIn(def)) if (!out.has(p.key)) out.set(p.key, p);
  return [...out.values()];
}

export interface TemplateUpdatePlan {
  readonly workflow: WorkflowRow;
  /** The copy's draft as it is now. */
  readonly draft: WorkflowDefinition;
  readonly templateId: string;
  readonly templateName: string;
  readonly installId: string | null;
  readonly installedVersion: number | null;
  readonly latestVersion: number;
  readonly updateAvailable: boolean;
  /** The copy's draft moved on since it was installed (the revision counts, even if the content is back). */
  readonly changedSinceInstall: boolean;
  /** What each placeholder stands for here (stored, then suggested for keys never mapped). */
  readonly mapping: PlaceholderIds;
  /** Placeholders the merged draft still has, for the business to pick. */
  readonly unmapped: WorkflowPlaceholder[];
  /** The new version with the business's changes on top. */
  readonly merged: WorkflowDefinition;
  /** The ops that turn the draft into `merged`, and those in plain words. */
  readonly ops: WorkflowOp[];
  readonly changes: string[];
  /** What the template changed between the installed version and the newest. */
  readonly templateChanges: string[];
  /** What the business changed in its copy since it installed. */
  readonly yourChanges: string[];
  /** Of those: put back on top of the new version, and no longer fitting it. */
  readonly kept: string[];
  readonly dropped: string[];
  readonly catalogs: LoadedWorkflowCatalogs;
}

/**
 * The update waiting for a business's copy of a template. Needs a transaction that can read the template
 * (the system, bound to the business and its organization). `forUpdate` locks the workflow row.
 */
export async function planTemplateUpdate(
  tx: Tx,
  workspaceId: string,
  workflowId: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<TemplateUpdatePlan> {
  const { row, definition: draft } = await loadWorkflow(tx, workspaceId, workflowId, opts);
  if (!row.templateId)
    throw HfosError.conflict(
      'This workflow didn’t come from an agency template, so there’s no newer version to update it to.',
      'not_from_template',
    );
  const [t] = await tx
    .select({
      id: workflowTemplates.id,
      name: workflowTemplates.name,
      latestVersion: workflowTemplates.latestVersion,
    })
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, row.templateId));
  if (!t?.latestVersion)
    throw HfosError.conflict(
      'There’s no published version of this template to update to. Ask your agency to publish one.',
      'template_not_published',
    );
  const [install] = await tx
    .select({
      id: workflowTemplateInstalls.id,
      mapping: workflowTemplateInstalls.mapping,
      installedVersion: workflowTemplateInstalls.installedVersion,
    })
    .from(workflowTemplateInstalls)
    .where(
      and(
        eq(workflowTemplateInstalls.templateId, t.id),
        eq(workflowTemplateInstalls.workspaceId, workspaceId),
      ),
    );
  const latestDef = await templateVersionDefinition(tx, t.id, t.latestVersion);
  if (!latestDef)
    throw HfosError.internal(
      'The newest version of this template can’t be found. Try again in a minute.',
    );
  const installedVersion = row.templateVersion ?? install?.installedVersion ?? null;
  const installedDef = installedVersion
    ? await templateVersionDefinition(tx, t.id, installedVersion)
    : null;
  const catalogs = await loadWorkflowCatalogs(tx, workspaceId, {
    extraUserIds: refUserIds(draft),
  });
  const stored = (install?.mapping ?? {}) as Record<string, unknown>;
  const mapping = effectiveMapping(placeholdersOf(latestDef, installedDef), stored, catalogs);
  const theirs = resolveTemplate(latestDef, mapping);
  // Without the installed version there's nothing to tell the business's changes by: the copy is the base.
  const base = installedDef ? resolveTemplate(installedDef, mapping) : draft;
  const merge = mergeTemplateUpdate(base, theirs, draft);
  const ops = diffWorkflows(draft, merge.definition);
  const described = describeTemplateMerge(merge, base, catalogs);
  return {
    workflow: row,
    draft,
    templateId: t.id,
    templateName: t.name,
    installId: install?.id ?? null,
    installedVersion,
    latestVersion: t.latestVersion,
    updateAvailable: (installedVersion ?? 0) < t.latestVersion,
    changedSinceInstall: row.installedRevision !== null && row.revision !== row.installedRevision,
    mapping,
    unmapped: placeholdersIn(merge.definition),
    merged: merge.definition,
    ops,
    changes: describeOps(ops, draft, catalogs),
    templateChanges: described.templateChanges,
    yourChanges: describeOps(merge.yourOps, base, catalogs),
    kept: described.kept,
    dropped: described.dropped,
    catalogs,
  };
}
