/**
 * The agency area (organization level, org.templates.manage): workflow templates saved from a business's
 * workflow (its workspace ids swapped for named placeholders), published as append-only versions and
 * pushed to client businesses; and knowledge starter packs pushed as suggestions. A push writes what was
 * asked and emits a request: the engine installs into each business under that business's own scope.
 */
import { and, desc, eq, inArray, sql as dsql } from 'drizzle-orm';
import {
  knowledgePacks,
  workflows,
  workflowTemplateInstalls,
  workflowTemplates,
  workflowTemplateVersions,
  workspaces,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  KnowledgePackCreateInput,
  KnowledgePackPushInput,
  KnowledgePackPushOutput,
  KnowledgePackUpdateInput,
  KnowledgePackWriteOutput,
} from '../schemas/knowledge';
import {
  WorkflowTemplateApplyUpdateInput,
  WorkflowTemplateApplyUpdateOutput,
  WorkflowTemplateCreateFromWorkflowInput,
  WorkflowTemplateCreateFromWorkflowOutput,
  WorkflowTemplateCreateInput,
  WorkflowTemplateCreateOutput,
  WorkflowTemplateInstallInput,
  WorkflowTemplateInstallOutput,
  WorkflowTemplatePublishOutput,
  WorkflowTemplatePushInput,
  WorkflowTemplatePushOutput,
  WorkflowTemplateRefInput,
  WorkflowTemplateRenameInput,
  WorkflowTemplateRenameOutput,
  WorkflowTemplateSaveDraftInput,
  WorkflowTemplateSaveDraftOutput,
} from '../schemas/workflow';
import { blankDefinition, type WorkflowDefinition } from '../workflows/definition';
import { describeOps, describeTrigger, diffWorkflows } from '../workflows/describe';
import { jsonEqual } from '../workflows/json';
import {
  loadWorkflowCatalogs,
  parseStoredDefinition,
  refUserIds,
  triggerIndex,
} from '../workflows/load';
import { applyWorkflowOps, WorkflowOpError, type WorkflowOp } from '../workflows/ops';
import { extractPlaceholders, placeholdersIn } from '../workflows/recipes';
import { validateWorkflow } from '../workflows/rules';
import { effectiveMapping, templateIssues, unmappedKeys } from '../workflows/template-merge';
import {
  planTemplateUpdate,
  resolveTemplate,
  templateVersionDefinition,
} from '../workflows/template-update';
import { workflowRevisionConflict } from './workflow';

const inOrganization = (i: { organizationId: string }) => ({
  kind: 'organization' as const,
  organizationId: i.organizationId,
});
const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const asJson = (v: unknown) => v as Record<string, unknown>;
/** Audit entries keep the first lines of a long batch. */
const MAX_CHANGE_LINES = 40;
const capLines = (lines: readonly string[]) =>
  lines.length <= MAX_CHANGE_LINES
    ? [...lines]
    : [...lines.slice(0, MAX_CHANGE_LINES - 1), `…and ${lines.length - MAX_CHANGE_LINES + 1} more`];
/** Adds keys to a stored mapping (keys a version no longer uses stay, for a later one that does). */
const mergeMapping = (mapping: Readonly<Record<string, string | null>>) =>
  dsql`${workflowTemplateInstalls.mapping} || ${JSON.stringify(mapping)}::jsonb`;

/** The organization's businesses among `ids`; any other id is a 400 at its position. */
async function orgWorkspaces(
  ctx: CommandContext,
  ids: readonly string[],
): Promise<{ id: string; name: string }[]> {
  const unique = [...new Set(ids)];
  const found = await ctx.tx
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(
      and(eq(workspaces.organizationId, ctx.scope.organizationId!), inArray(workspaces.id, unique)),
    );
  const known = new Set(found.map((w) => w.id));
  const strangers = ids.map((id, i) => ({ id, i })).filter(({ id }) => !known.has(id));
  if (strangers.length)
    throw HfosError.validation(
      strangers.map(({ i }) => ({
        path: `workspaceIds.${i}`,
        message: 'That business isn’t in this organization.',
      })),
    );
  return unique.map((id) => found.find((w) => w.id === id)!);
}

async function loadTemplate(ctx: CommandContext, templateId: string, forUpdate = false) {
  const query = ctx.tx
    .select()
    .from(workflowTemplates)
    .where(
      and(
        eq(workflowTemplates.id, templateId),
        eq(workflowTemplates.organizationId, ctx.scope.organizationId!),
      ),
    );
  const [t] = forUpdate ? await query.for('update') : await query;
  if (!t) throw HfosError.notFound('Template not found.');
  if (t.archivedAt) throw HfosError.conflict('This template is archived.', 'template_archived');
  return t;
}

export const workflowTemplateCreateFromWorkflow = defineCommand({
  name: 'workflow_template.create_from_workflow',
  description:
    'Save one of your businesses’ workflows as an agency template. Its stages, tags, calendars and people become named placeholders each business maps.',
  risk: 1,
  input: WorkflowTemplateCreateFromWorkflowInput,
  output: WorkflowTemplateCreateFromWorkflowOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['workflow_template.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const org = ctx.scope.organizationId!;
    const [wf] = await ctx.tx
      .select({
        id: workflows.id,
        workspaceId: workflows.workspaceId,
        name: workflows.name,
        definition: workflows.definition,
      })
      .from(workflows)
      .innerJoin(workspaces, eq(workspaces.id, workflows.workspaceId))
      .where(and(eq(workflows.id, input.workflowId), eq(workspaces.organizationId, org)));
    if (!wf) throw HfosError.notFound('Workflow not found.');
    const def = parseStoredDefinition(wf.definition);
    const catalogs = await loadWorkflowCatalogs(ctx.tx, wf.workspaceId, {
      extraUserIds: refUserIds(def),
    });
    const { definition, placeholders } = extractPlaceholders(def, catalogs);
    const [row] = await ctx.tx
      .insert(workflowTemplates)
      .values({
        organizationId: org,
        name: input.name,
        description: input.description ?? null,
        definition: asJson(definition),
        definitionVersion: definition.version,
        revision: 1,
        createdBy: me,
      })
      .returning({ id: workflowTemplates.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'workflow_template.created',
      entityType: 'workflow_template',
      entityId: row.id,
      payload: {
        templateId: row.id,
        workflowId: wf.id,
        workspaceId: wf.workspaceId,
        placeholders: placeholders.map((p) => p.key),
      },
      after: { name: input.name, from: wf.name, placeholders: placeholders.length },
    });
    return { templateId: row.id, revision: 1, placeholders };
  },
});

export const workflowTemplateCreate = defineCommand({
  name: 'workflow_template.create',
  description:
    'Start an agency template from scratch: a blank draft with its trigger (by hand when none is given) and no steps, to build, publish and push to client businesses.',
  risk: 1,
  input: WorkflowTemplateCreateInput,
  output: WorkflowTemplateCreateOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['workflow_template.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const definition = blankDefinition(input.trigger ?? { kind: 'manual' });
    const [row] = await ctx.tx
      .insert(workflowTemplates)
      .values({
        organizationId: ctx.scope.organizationId!,
        name: input.name,
        description: input.description ?? null,
        definition: asJson(definition),
        definitionVersion: definition.version,
        revision: 1,
        createdBy: me,
      })
      .returning({ id: workflowTemplates.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'workflow_template.created',
      entityType: 'workflow_template',
      entityId: row.id,
      payload: { templateId: row.id, from: 'blank', triggerKind: definition.trigger.kind },
      after: { name: input.name, source: 'Blank' },
    });
    return { templateId: row.id, revision: 1 };
  },
});

export const workflowTemplateRename = defineCommand({
  name: 'workflow_template.rename',
  description:
    'Rename an agency template or change its description. Businesses’ installed copies keep their own names.',
  risk: 1,
  input: WorkflowTemplateRenameInput,
  output: WorkflowTemplateRenameOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['workflow_template.renamed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const t = await loadTemplate(ctx, input.templateId, true);
    const patch: { name?: string; description?: string | null } = {};
    if (input.name !== undefined && input.name !== t.name) patch.name = input.name;
    if (input.description !== undefined && (input.description ?? null) !== t.description)
      patch.description = input.description ?? null;
    const name = patch.name ?? t.name;
    const description = patch.description !== undefined ? patch.description : t.description;
    if (!Object.keys(patch).length) return { templateId: t.id, name, description };
    await ctx.tx.update(workflowTemplates).set(patch).where(eq(workflowTemplates.id, t.id));
    await ctx.emit({
      type: 'workflow_template.renamed',
      entityType: 'workflow_template',
      entityId: t.id,
      payload: { templateId: t.id, fields: Object.keys(patch) },
      before: {
        name: t.name,
        ...(patch.description !== undefined ? { description: t.description } : {}),
      },
      after: { name, ...(patch.description !== undefined ? { description } : {}) },
    });
    return { templateId: t.id, name, description };
  },
});

export const workflowTemplatePublish = defineCommand({
  name: 'workflow_template.publish',
  description:
    'Publish a template’s current draft as its next version. Businesses on an older version see “Update available”.',
  risk: 1,
  input: WorkflowTemplateRefInput,
  output: WorkflowTemplatePublishOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['workflow_template.published'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const t = await loadTemplate(ctx, input.templateId, true);
    const def = parseStoredDefinition(t.definition);
    const [prev] = await ctx.tx
      .select({
        version: workflowTemplateVersions.version,
        definition: workflowTemplateVersions.definition,
      })
      .from(workflowTemplateVersions)
      .where(eq(workflowTemplateVersions.templateId, t.id))
      .orderBy(desc(workflowTemplateVersions.version))
      .limit(1);
    const prevDef = prev ? parseStoredDefinition(prev.definition) : null;
    if (prev && prevDef && jsonEqual(prevDef, def))
      return { templateId: t.id, version: prev.version, published: false };
    const version = Math.max(t.latestVersion ?? 0, prev?.version ?? 0) + 1;
    const changes = prevDef ? describeOps(diffWorkflows(prevDef, def), prevDef) : ['First version'];
    await ctx.tx.insert(workflowTemplateVersions).values({
      organizationId: t.organizationId,
      templateId: t.id,
      version,
      definition: asJson(def),
      definitionVersion: def.version,
      diffSummary: changes.slice(0, 40) as unknown as Record<string, unknown>[],
      publishedBy: me,
    });
    await ctx.tx
      .update(workflowTemplates)
      .set({ latestVersion: version })
      .where(eq(workflowTemplates.id, t.id));
    await ctx.emit({
      type: 'workflow_template.published',
      entityType: 'workflow_template',
      entityId: t.id,
      payload: { templateId: t.id, version },
      before: { name: t.name, version: t.latestVersion },
      after: { name: t.name, version, changes: changes.slice(0, 40) },
    });
    return { templateId: t.id, version, published: true };
  },
});

export const workflowTemplatePush = defineCommand({
  name: 'workflow_template.push',
  description:
    'Push a template’s newest version to client businesses with each one’s placeholder mapping. The engine installs a draft in each; each business still tests before publishing.',
  risk: 2,
  input: WorkflowTemplatePushInput,
  output: WorkflowTemplatePushOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['workflow_template.pushed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const t = await loadTemplate(ctx, input.templateId);
    if (!t.latestVersion)
      throw HfosError.conflict('Publish the template before pushing it.', 'template_not_published');
    const targets = await orgWorkspaces(ctx, input.workspaceIds);
    const extra = Object.keys(input.mappings).filter((id) => !targets.some((w) => w.id === id));
    if (extra.length)
      throw HfosError.validation(
        extra.map((id) => ({
          path: `mappings.${id}`,
          message: 'Map only the businesses you push to.',
        })),
      );
    const installIds: string[] = [];
    for (const w of targets) {
      const mapping = input.mappings[w.id];
      const [row] = await ctx.tx
        .insert(workflowTemplateInstalls)
        .values({
          organizationId: t.organizationId,
          templateId: t.id,
          workspaceId: w.id,
          mapping: asJson(mapping ?? {}),
          status: 'pending',
          pushedBy: me,
          pushedAt: dsql`now()`,
        })
        .onConflictDoUpdate({
          target: [workflowTemplateInstalls.templateId, workflowTemplateInstalls.workspaceId],
          // A push without a mapping keeps the one the business had.
          set: {
            status: 'pending',
            lastError: null,
            pushedBy: me,
            pushedAt: dsql`now()`,
            ...(mapping ? { mapping: asJson(mapping) } : {}),
          },
        })
        .returning({ id: workflowTemplateInstalls.id });
      if (!row) throw HfosError.forbidden();
      installIds.push(row.id);
    }
    await ctx.emit({
      type: 'workflow_template.pushed',
      entityType: 'workflow_template',
      entityId: t.id,
      payload: {
        templateId: t.id,
        version: t.latestVersion,
        workspaceIds: targets.map((w) => w.id),
        installIds,
      },
      after: {
        name: t.name,
        version: t.latestVersion,
        businesses: targets.map((w) => w.name).join(', '),
      },
    });
    return { templateId: t.id, version: t.latestVersion, installIds };
  },
});

// ---- Knowledge packs ----

async function loadPack(ctx: CommandContext, packId: string, forUpdate = false) {
  const query = ctx.tx
    .select()
    .from(knowledgePacks)
    .where(
      and(
        eq(knowledgePacks.id, packId),
        eq(knowledgePacks.organizationId, ctx.scope.organizationId!),
      ),
    );
  const [p] = forUpdate ? await query.for('update') : await query;
  if (!p) throw HfosError.notFound('Pack not found.');
  return p;
}

export const knowledgePackCreate = defineCommand({
  name: 'knowledge_pack.create',
  description:
    'Build an agency starter pack of FAQs, articles and facts (for example “HVAC FAQs”) to push to client businesses as suggestions.',
  risk: 1,
  input: KnowledgePackCreateInput,
  output: KnowledgePackWriteOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['knowledge_pack.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [row] = await ctx.tx
      .insert(knowledgePacks)
      .values({
        organizationId: ctx.scope.organizationId!,
        name: input.name,
        description: input.description ?? null,
        items: input.items as unknown as Record<string, unknown>[],
        version: 1,
        createdBy: me,
      })
      .returning({ id: knowledgePacks.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'knowledge_pack.created',
      entityType: 'knowledge_pack',
      entityId: row.id,
      payload: { packId: row.id, items: input.items.length },
      after: { name: input.name, items: input.items.length },
    });
    return { packId: row.id, version: 1, updated: [] };
  },
});

export const knowledgePackUpdate = defineCommand({
  name: 'knowledge_pack.update',
  description:
    'Change a starter pack’s name, description or items, or archive it. Every change raises its version.',
  risk: 1,
  input: KnowledgePackUpdateInput,
  output: KnowledgePackWriteOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['knowledge_pack.updated'],
  async handler(ctx, input) {
    const p = await loadPack(ctx, input.packId, true);
    const patch: Partial<typeof knowledgePacks.$inferInsert> = {};
    if (input.name !== undefined && input.name !== p.name) patch.name = input.name;
    if (input.description !== undefined && (input.description ?? null) !== p.description)
      patch.description = input.description ?? null;
    if (input.items !== undefined && !jsonEqual(input.items, p.items))
      patch.items = input.items as unknown as Record<string, unknown>[];
    if (input.archived !== undefined && input.archived !== (p.archivedAt !== null))
      patch.archivedAt = input.archived ? new Date() : null;
    const updated = Object.keys(patch);
    if (!updated.length) return { packId: p.id, version: p.version, updated };
    const version = p.version + 1;
    await ctx.tx
      .update(knowledgePacks)
      .set({ ...patch, version })
      .where(eq(knowledgePacks.id, p.id));
    await ctx.emit({
      type: 'knowledge_pack.updated',
      entityType: 'knowledge_pack',
      entityId: p.id,
      payload: { packId: p.id, version, fields: updated },
      before: { name: p.name, version: p.version },
      after: {
        name: patch.name ?? p.name,
        version,
        ...(patch.items ? { items: input.items!.length } : {}),
        ...(patch.archivedAt !== undefined ? { archived: input.archived } : {}),
      },
    });
    return { packId: p.id, version, updated };
  },
});

export const knowledgePackPush = defineCommand({
  name: 'knowledge_pack.push',
  description:
    'Push a starter pack to client businesses. Each gets its items as suggestions to accept, edit or reject.',
  risk: 2,
  input: KnowledgePackPushInput,
  output: KnowledgePackPushOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['knowledge_pack.pushed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const p = await loadPack(ctx, input.packId);
    if (p.archivedAt) throw HfosError.conflict('This pack is archived.', 'pack_archived');
    if (!p.items.length) throw HfosError.conflict('Add items to the pack first.', 'pack_empty');
    const targets = await orgWorkspaces(ctx, input.workspaceIds);
    await ctx.emit({
      type: 'knowledge_pack.pushed',
      entityType: 'knowledge_pack',
      entityId: p.id,
      payload: {
        packId: p.id,
        version: p.version,
        workspaceIds: targets.map((w) => w.id),
        requestedBy: me,
      },
      after: {
        name: p.name,
        version: p.version,
        businesses: targets.map((w) => w.name).join(', '),
      },
    });
    return { packId: p.id, version: p.version, workspaceIds: targets.map((w) => w.id) };
  },
});

// ---- A template's draft ----

function templateRevisionConflict(revision: number): HfosError {
  return new HfosError(
    'conflict',
    409,
    'Someone saved this template in the meantime. Reload to see their changes.',
    { revision },
    'revision_conflict',
  );
}

/** Applies ops all or nothing; a bad op is a 400 naming its index and what's wrong (as for workflows). */
function applyTemplateOps(def: WorkflowDefinition, ops: readonly unknown[]): WorkflowDefinition {
  try {
    return applyWorkflowOps(def, ops as readonly WorkflowOp[]).definition;
  } catch (e) {
    if (!(e instanceof WorkflowOpError)) throw e;
    throw new HfosError(
      'validation',
      400,
      e.message,
      { opIndex: e.opIndex, code: e.code, stepId: e.stepId, issues: e.issues },
      'workflow_op_invalid',
    );
  }
}

export const workflowTemplateSaveDraft = defineCommand({
  name: 'workflow_template.save_draft',
  description:
    'Save edits to an agency template’s draft as patch ops made against a base revision, as workflow drafts save. A stale base is a 409 revision_conflict; a bad op is a 400 naming its index. Publishing makes it the version businesses get.',
  risk: 1,
  input: WorkflowTemplateSaveDraftInput,
  output: WorkflowTemplateSaveDraftOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['workflow_template.draft_saved'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const t = await loadTemplate(ctx, input.templateId, true);
    if (t.revision !== input.baseRevision) throw templateRevisionConflict(t.revision);
    const current = parseStoredDefinition(t.definition);
    const next = applyTemplateOps(current, input.ops);
    const issues = templateIssues(next);
    if (jsonEqual(next, current))
      return { templateId: t.id, revision: t.revision, changed: false, changes: [], issues };
    const changes = describeOps(input.ops as readonly WorkflowOp[], current);
    const revision = t.revision + 1;
    await ctx.tx
      .update(workflowTemplates)
      .set({ definition: asJson(next), definitionVersion: next.version, revision })
      .where(eq(workflowTemplates.id, t.id));
    await ctx.emit({
      type: 'workflow_template.draft_saved',
      entityType: 'workflow_template',
      entityId: t.id,
      payload: {
        templateId: t.id,
        revision,
        changes: capLines(changes),
        opCount: input.ops.length,
      },
      before: { name: t.name, revision: t.revision },
      after: { name: t.name, revision, changes: capLines(changes) },
    });
    return { templateId: t.id, revision, changed: true, changes, issues };
  },
});

// ---- The engine's side: installs and updates, bound to one business ----

export const workflowTemplateInstall = defineCommand({
  name: 'workflow_template.install',
  description:
    'System: turn one pushed install into a draft in its business: the template’s newest version, its placeholders resolved with the pushed mapping (a suggestion by name for any key never mapped; unmapped ones stay as issues with a Fix). A business that already has its copy keeps it, and sees the update as available. Publishing still needs that business’s own passing test.',
  risk: 1,
  input: WorkflowTemplateInstallInput,
  output: WorkflowTemplateInstallOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['workflow.created', 'workflow_template.installed', 'workflow_template.install_failed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [install] = await ctx.tx
      .select()
      .from(workflowTemplateInstalls)
      .where(
        and(
          eq(workflowTemplateInstalls.id, input.installId),
          eq(workflowTemplateInstalls.workspaceId, ws),
        ),
      )
      .for('update');
    if (!install) throw HfosError.notFound('Install not found.');
    const [t] = await ctx.tx
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.id, install.templateId));
    const fail = async (error: string) => {
      await ctx.tx
        .update(workflowTemplateInstalls)
        .set({ status: 'failed', lastError: error })
        .where(eq(workflowTemplateInstalls.id, install.id));
      await ctx.emit({
        type: 'workflow_template.install_failed',
        entityType: 'workflow_template',
        entityId: install.templateId,
        payload: { installId: install.id, templateId: install.templateId, error },
        after: { name: t?.name ?? 'A template', error },
      });
      return {
        installId: install.id,
        status: 'failed' as const,
        workflowId: install.workflowId,
        version: null,
        created: false,
        unmapped: [],
        error,
      };
    };
    if (!t) return fail('The template is no longer there.');
    if (t.archivedAt) return fail('The template was archived before it could be installed.');
    if (!t.latestVersion) return fail('The template has no published version yet.');
    let def: WorkflowDefinition | null;
    try {
      def = await templateVersionDefinition(ctx.tx, t.id, t.latestVersion);
    } catch {
      def = null;
    }
    if (!def) return fail('The template’s newest version can’t be read.');

    const catalogs = await loadWorkflowCatalogs(ctx.tx, ws);
    const mapping = effectiveMapping(
      placeholdersIn(def),
      install.mapping as Record<string, unknown>,
      catalogs,
    );
    const [copy] = install.workflowId
      ? await ctx.tx
          .select({
            id: workflows.id,
            status: workflows.status,
            templateVersion: workflows.templateVersion,
          })
          .from(workflows)
          .where(and(eq(workflows.id, install.workflowId), eq(workflows.workspaceId, ws)))
      : [];
    let workflowId: string;
    let version: number;
    let created = false;
    let unmapped: string[] = [];
    if (copy && copy.status !== 'archived') {
      // The business has its copy: it stays as it is, and a newer version waits for them to apply it.
      workflowId = copy.id;
      version = copy.templateVersion ?? install.installedVersion ?? t.latestVersion;
    } else {
      const resolved = resolveTemplate(def, mapping);
      unmapped = unmappedKeys(mapping);
      const [row] = await ctx.tx
        .insert(workflows)
        .values({
          workspaceId: ws,
          name: t.name,
          description: t.description,
          status: 'draft',
          definition: asJson(resolved),
          definitionVersion: resolved.version,
          revision: 1,
          ...triggerIndex(resolved),
          templateId: t.id,
          templateVersion: t.latestVersion,
          installedRevision: 1,
          createdBy: install.pushedBy,
        })
        .returning({ id: workflows.id });
      if (!row) throw HfosError.forbidden();
      workflowId = row.id;
      version = t.latestVersion;
      created = true;
      await ctx.emit({
        type: 'workflow.created',
        entityType: 'workflow',
        entityId: row.id,
        payload: {
          name: t.name,
          from: 'template',
          templateId: t.id,
          version,
          triggerKind: resolved.trigger.kind,
        },
        after: {
          name: t.name,
          status: 'draft',
          source: `${t.name} template, version ${version}`,
          trigger: describeTrigger(resolved.trigger, catalogs),
        },
      });
    }
    await ctx.tx
      .update(workflowTemplateInstalls)
      .set({
        status: 'installed',
        workflowId,
        installedVersion: version,
        installedAt: dsql`now()`,
        lastError: null,
        mapping: mergeMapping(mapping),
      })
      .where(eq(workflowTemplateInstalls.id, install.id));
    await ctx.emit({
      type: 'workflow_template.installed',
      entityType: 'workflow_template',
      entityId: t.id,
      payload: { installId: install.id, templateId: t.id, workflowId, version, created, unmapped },
      after: { name: t.name, version, ...(unmapped.length ? { unmapped } : {}) },
    });
    return {
      installId: install.id,
      status: 'installed' as const,
      workflowId,
      version,
      created,
      unmapped,
      error: null,
    };
  },
});

export const workflowTemplateApplyUpdate = defineCommand({
  name: 'workflow_template.apply_update',
  description:
    'System, on a person’s request: bring a business’s copy of an agency template up to the newest version as a new draft revision, never straight to live. The template’s changes come in with the stored mapping; the business’s own changes since it installed stay on top, and any that no longer fit are listed. It needs a passing test before it can be published.',
  risk: 1,
  input: WorkflowTemplateApplyUpdateInput,
  output: WorkflowTemplateApplyUpdateOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['workflow.draft_saved', 'workflow_template.updated'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const plan = await planTemplateUpdate(ctx.tx, ws, input.workflowId, { forUpdate: true });
    const row = plan.workflow;
    if (row.status === 'archived')
      throw HfosError.conflict('This workflow is archived.', 'workflow_archived');
    if (row.revision !== input.baseRevision) throw workflowRevisionConflict(row.revision);
    if (!plan.updateAvailable)
      throw HfosError.conflict('This workflow already has the newest version.', 'template_current');
    const changed = !jsonEqual(plan.merged, plan.draft);
    const revision = changed ? row.revision + 1 : row.revision;
    // Exactly the new version (nothing of theirs kept) counts as freshly installed; otherwise it stays changed.
    const pristine = plan.kept.length === 0;
    await ctx.tx
      .update(workflows)
      .set({
        ...(changed
          ? { definition: asJson(plan.merged), definitionVersion: plan.merged.version, revision }
          : {}),
        // Once a version is published, the dispatcher follows what runs, not the draft.
        ...(changed && !row.activeVersionId ? triggerIndex(plan.merged) : {}),
        templateVersion: plan.latestVersion,
        installedRevision: pristine ? revision : row.installedRevision,
      })
      .where(eq(workflows.id, row.id));
    if (plan.installId)
      await ctx.tx
        .update(workflowTemplateInstalls)
        .set({
          status: 'installed',
          installedVersion: plan.latestVersion,
          lastError: null,
          mapping: mergeMapping(plan.mapping),
        })
        .where(eq(workflowTemplateInstalls.id, plan.installId));
    const lines = [
      `Updated to ${plan.templateName} version ${plan.latestVersion}`,
      ...plan.changes,
    ];
    if (changed)
      await ctx.emit({
        type: 'workflow.draft_saved',
        entityType: 'workflow',
        entityId: row.id,
        payload: {
          revision,
          changes: capLines(lines),
          opCount: plan.ops.length,
          templateVersion: plan.latestVersion,
        },
        before: { name: row.name, revision: row.revision },
        after: { name: row.name, revision, changes: capLines(lines) },
      });
    await ctx.emit({
      type: 'workflow_template.updated',
      entityType: 'workflow',
      entityId: row.id,
      payload: {
        workflowId: row.id,
        templateId: plan.templateId,
        from: plan.installedVersion,
        to: plan.latestVersion,
        revision,
        kept: capLines(plan.kept),
        dropped: capLines(plan.dropped),
      },
      before: { name: row.name, version: plan.installedVersion },
      after: {
        name: row.name,
        version: plan.latestVersion,
        ...(plan.kept.length ? { kept: capLines(plan.kept) } : {}),
        ...(plan.dropped.length ? { dropped: capLines(plan.dropped) } : {}),
      },
    });
    return {
      workflowId: row.id,
      revision,
      version: plan.latestVersion,
      changed,
      changes: plan.changes,
      kept: plan.kept,
      dropped: plan.dropped,
      unmapped: plan.unmapped.map((p) => p.key),
      issues: validateWorkflow(plan.merged, plan.catalogs, Date.now()),
    };
  },
});
