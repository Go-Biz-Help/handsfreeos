/**
 * Quick setup's query (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5): what the business has today, and
 * where the screens start, from what someone answered so far or else from today's picks, or from answers the
 * business's agency saved (§9).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { workspaces } from '@hfos/db/schema';
import { aiSetupOf, resumeAiSetup } from '../ai-setup/answers';
import { loadAiSetupState, loadAiSetupTemplates } from '../ai-setup/load';
import { startingAiSetupAnswers } from '../ai-setup/plan';
import { chosenAiSetupTemplate } from '../ai-setup/templates';
import { defineQuery } from '../kernel/define';
import {
  AiSetupGetInput,
  AiSetupGetOutput,
  AiSetupTemplateListInput,
  AiSetupTemplateListOutput,
} from '../schemas/ai-setup';

/**
 * Where this person may save a business's answers for the agency's other businesses: its owners and admins, once
 * it has more than one business.
 */
async function saveToOf(tx: Tx, organizationId: string) {
  const [org] = await rows<{ name: string; manages: boolean; businesses: number }>(
    tx,
    sql`select o.name, private.has_org_permission(o.id, 'org.templates.manage') as manages,
          (select count(*) from app.workspaces w
            where w.organization_id = o.id and w.deletion_requested_at is null)::int as businesses
        from app.organizations o where o.id = ${organizationId}`,
  );
  return org?.manages && org.businesses > 1 ? { organizationId, name: org.name } : null;
}

export const aiSetupGet = defineQuery({
  name: 'ai_setup.get',
  description:
    'Quick setup for the AI teammate: what the business has today (its kind, website, open hours, profile, services, calendars, chat and teammate), the answers to start from (what someone answered so far, else picks for its kind of business or answers its agency saved), and how far it got.',
  input: AiSetupGetInput,
  output: AiSetupGetOutput,
  // The answers become the teammate's settings, so it's for those who may change them.
  permission: 'ai_team.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const state = await loadAiSetupState(ctx.tx, input.workspaceId);
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings, organizationId: workspaces.organizationId })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId));
    const record = aiSetupOf((w?.settings ?? {}) as Record<string, unknown>);
    // Saved answers start a business that has no teammate yet.
    const templates =
      w && !state.teammate ? await loadAiSetupTemplates(ctx.tx, w.organizationId) : [];
    const template = chosenAiSetupTemplate(templates, record.template, state.kind);
    const starting = startingAiSetupAnswers(state, template?.answers ?? null);
    return {
      state: {
        ...state,
        teammate: state.teammate && {
          ...state.teammate,
          config: state.teammate.config as unknown as Record<string, unknown>,
        },
      },
      answers: resumeAiSetup(starting, record, state.kind),
      starting,
      reached: record.draft ? record.reached : null,
      started: record.started,
      finished: record.finished,
      runs: record.runs,
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        about: t.about,
        updatedAt: t.updatedAt,
      })),
      templateId: template?.id ?? null,
      templatePicked: record.template !== undefined,
      saveTo: w ? await saveToOf(ctx.tx, w.organizationId) : null,
    };
  },
});

export const aiSetupTemplateList = defineQuery({
  name: 'ai_setup_template.list',
  description:
    'The answers your agency saved for quick setup, by name: what each sets, the kind of business it suits and the business it was saved from.',
  input: AiSetupTemplateListInput,
  output: AiSetupTemplateListOutput,
  permission: 'org.templates.manage',
  scope: (i) => ({ kind: 'organization', organizationId: i.organizationId }),
  async handler(ctx, input) {
    const list = await loadAiSetupTemplates(ctx.tx, input.organizationId);
    const ids = [...new Set(list.flatMap((t) => (t.fromWorkspaceId ? [t.fromWorkspaceId] : [])))];
    const names = new Map(
      (ids.length
        ? await ctx.tx
            .select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .where(
              and(
                inArray(workspaces.id, ids),
                eq(workspaces.organizationId, input.organizationId),
                isNull(workspaces.deletionRequestedAt),
              ),
            )
        : []
      ).map((w) => [w.id, w.name]),
    );
    return {
      items: list.map((t) => {
        const name = t.fromWorkspaceId ? names.get(t.fromWorkspaceId) : undefined;
        return {
          id: t.id,
          name: t.name,
          kind: t.kind,
          about: t.about,
          updatedAt: t.updatedAt,
          createdAt: t.createdAt,
          from: name ? { workspaceId: t.fromWorkspaceId!, name } : null,
        };
      }),
    };
  },
});
