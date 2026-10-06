/**
 * An agency's saved answers for quick setup (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §9): its owners and
 * admins save the answers one client business was set up with, those that aren't about that business, so its other
 * businesses can start quick setup from them (the owner's 58B). Saving, renaming or removing them changes no
 * business: one set up from them keeps its answers.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { aiSetupTemplates, workspaces } from '@hfos/db/schema';
import { loadAiSetupState } from '../ai-setup/load';
import { aiSetupTemplateOfBusiness } from '../ai-setup/templates';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { isUniqueViolation } from '../kernel/pg-errors';
import type { CommandContext } from '../kernel/types';
import {
  AiSetupTemplateDeleteInput,
  AiSetupTemplateDeleteOutput,
  AiSetupTemplateRenameInput,
  AiSetupTemplateRenameOutput,
  AiSetupTemplateSaveInput,
  AiSetupTemplateSaveOutput,
} from '../schemas/ai-setup';

const inOrganization = (i: { organizationId: string }) => ({
  kind: 'organization' as const,
  organizationId: i.organizationId,
});

const nameTaken = (name: string) =>
  HfosError.conflict(
    `Your agency already has saved answers called “${name}”. Pick a different name, or rename those in the agency area under AI setups.`,
    'name_taken',
  );

const gone = () =>
  HfosError.notFound(
    'Those saved answers aren’t there anymore. Someone may have removed them. Refresh the page to see what’s saved.',
  );

/** Refuses a name the agency already uses for other saved answers, whatever its case or spaces. */
async function checkName(ctx: CommandContext, name: string, except?: string) {
  const [taken] = await ctx.tx
    .select({ id: aiSetupTemplates.id })
    .from(aiSetupTemplates)
    .where(
      and(
        eq(aiSetupTemplates.organizationId, ctx.scope.organizationId!),
        sql`lower(btrim(${aiSetupTemplates.name})) = lower(btrim(${name}))`,
        except ? ne(aiSetupTemplates.id, except) : undefined,
      ),
    );
  if (taken) throw nameTaken(name);
}

/** Runs a write, refusing a name another write took meanwhile. */
async function namedWrite<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isUniqueViolation(e, 'ai_setup_templates_name_key')) throw nameTaken(name);
    throw e;
  }
}

export const aiSetupTemplateSave = defineCommand({
  name: 'ai_setup_template.save',
  description:
    'Save the AI teammate answers one of your client businesses was set up with (what it helps with, when it answers, its name, how it says it’s AI, its tone, prices and questions for leads; nothing about the business itself) so your other businesses can start quick setup from them.',
  risk: 1,
  input: AiSetupTemplateSaveInput,
  output: AiSetupTemplateSaveOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['ai_setup_template.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const org = ctx.scope.organizationId!;
    const [ws] = await ctx.tx
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, input.workspaceId),
          eq(workspaces.organizationId, org),
          sql`${workspaces.deletionRequestedAt} is null`,
        ),
      );
    if (!ws)
      throw HfosError.notFound(
        'That business isn’t one of this agency’s anymore. Refresh the page and pick another.',
      );
    const state = await loadAiSetupState(ctx.tx, ws.id);
    if (!state.teammate)
      throw HfosError.rule(
        'no_teammate',
        409,
        `${ws.name} hasn’t set up its AI teammate yet, so there are no answers to save. Run quick setup there first.`,
      );
    await checkName(ctx, input.name);
    const answers = aiSetupTemplateOfBusiness(state);
    const [row] = await namedWrite(input.name, () =>
      ctx.tx
        .insert(aiSetupTemplates)
        .values({
          organizationId: org,
          name: input.name,
          kind: state.kind,
          answers,
          fromWorkspaceId: ws.id,
          createdBy: me,
          updatedBy: me,
        })
        .returning({ id: aiSetupTemplates.id }),
    );
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'ai_setup_template.saved',
      entityType: 'ai_setup_template',
      entityId: row.id,
      payload: { templateId: row.id, workspaceId: ws.id, kind: state.kind },
      after: { name: input.name, from: ws.name, kind: state.kind },
    });
    return { templateId: row.id, name: input.name, kind: state.kind };
  },
});

export const aiSetupTemplateRename = defineCommand({
  name: 'ai_setup_template.rename',
  description: 'Rename answers your agency saved for quick setup.',
  risk: 1,
  input: AiSetupTemplateRenameInput,
  output: AiSetupTemplateRenameOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['ai_setup_template.renamed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const org = ctx.scope.organizationId!;
    const mine = and(
      eq(aiSetupTemplates.id, input.templateId),
      eq(aiSetupTemplates.organizationId, org),
    );
    const [was] = await ctx.tx
      .select({ name: aiSetupTemplates.name })
      .from(aiSetupTemplates)
      .where(mine)
      .for('update');
    if (!was) throw gone();
    if (was.name !== input.name) {
      await checkName(ctx, input.name, input.templateId);
      const [row] = await namedWrite(input.name, () =>
        ctx.tx
          .update(aiSetupTemplates)
          .set({ name: input.name, updatedBy: me })
          .where(mine)
          .returning({ id: aiSetupTemplates.id }),
      );
      if (!row) throw HfosError.forbidden();
      await ctx.emit({
        type: 'ai_setup_template.renamed',
        entityType: 'ai_setup_template',
        entityId: input.templateId,
        payload: { templateId: input.templateId },
        before: { name: was.name },
        after: { name: input.name },
      });
    }
    return { templateId: input.templateId, name: input.name };
  },
});

export const aiSetupTemplateDelete = defineCommand({
  name: 'ai_setup_template.delete',
  description:
    'Remove answers your agency saved for quick setup. Businesses already set up from them keep their answers.',
  risk: 2,
  input: AiSetupTemplateDeleteInput,
  output: AiSetupTemplateDeleteOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  emits: ['ai_setup_template.deleted'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .delete(aiSetupTemplates)
      .where(
        and(
          eq(aiSetupTemplates.id, input.templateId),
          eq(aiSetupTemplates.organizationId, ctx.scope.organizationId!),
        ),
      )
      .returning({ name: aiSetupTemplates.name, kind: aiSetupTemplates.kind });
    if (!row) throw gone();
    await ctx.emit({
      type: 'ai_setup_template.deleted',
      entityType: 'ai_setup_template',
      entityId: input.templateId,
      payload: { templateId: input.templateId },
      before: { name: row.name, kind: row.kind },
    });
    return { templateId: input.templateId };
  },
});
