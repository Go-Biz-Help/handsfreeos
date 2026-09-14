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
  WorkflowTemplateCreateFromWorkflowInput,
  WorkflowTemplateCreateFromWorkflowOutput,
  WorkflowTemplatePublishOutput,
  WorkflowTemplatePushInput,
  WorkflowTemplatePushOutput,
  WorkflowTemplateRefInput,
} from '../schemas/workflow';
import { describeOps, diffWorkflows } from '../workflows/describe';
import { jsonEqual } from '../workflows/json';
import { loadWorkflowCatalogs, parseStoredDefinition, refUserIds } from '../workflows/load';
import { extractPlaceholders } from '../workflows/recipes';

const inOrganization = (i: { organizationId: string }) => ({
  kind: 'organization' as const,
  organizationId: i.organizationId,
});
const asJson = (v: unknown) => v as Record<string, unknown>;

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
