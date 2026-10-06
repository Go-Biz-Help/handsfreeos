/**
 * The onboarding setup's query (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5): what the business has
 * today, and where the screens start, from what someone answered so far or else from today's picks. The AI part
 * starts from the newest answers the business's agency saved for its kind of business, as the AI quick setup does.
 */
import { eq } from 'drizzle-orm';
import { workspaces } from '@hfos/db/schema';
import { loadAiSetupTemplates } from '../ai-setup/load';
import { chosenAiSetupTemplate } from '../ai-setup/templates';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { onboardingSetupOf } from '../onboarding-setup/answers';
import { loadOnboardingSetupState } from '../onboarding-setup/load';
import { resumeOnboardingSetup, startingOnboardingSetupAnswers } from '../onboarding-setup/picks';
import { OnboardingSetupGetInput, OnboardingSetupGetOutput } from '../schemas/onboarding-setup';

export const onboardingSetupGet = defineQuery({
  name: 'onboarding_setup.get',
  description:
    'The onboarding setup: what the business has today (its address, website, hours, services, number, payments, customers, booking page, team and AI teammate), the answers to start from (what someone answered so far, else picks for its kind of business), how far it got, and when it was finished.',
  input: OnboardingSetupGetInput,
  output: OnboardingSetupGetOutput,
  // It sets the business up, so it's for those who may change it.
  permission: 'workspace.update',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const state = await loadOnboardingSetupState(
      ctx.tx,
      input.workspaceId,
      requireHuman(ctx).userId,
    );
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings, organizationId: workspaces.organizationId })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId));
    const record = onboardingSetupOf((w?.settings ?? {}) as Record<string, unknown>);
    // Saved answers start a business that has no teammate yet.
    const templates =
      w && !state.teammate ? await loadAiSetupTemplates(ctx.tx, w.organizationId) : [];
    const template = chosenAiSetupTemplate(templates, undefined, state.kind)?.answers ?? null;
    return {
      state: {
        ...state,
        teammate: state.teammate && {
          ...state.teammate,
          config: state.teammate.config as unknown as Record<string, unknown>,
        },
      },
      answers: resumeOnboardingSetup(state, record, template),
      starting: startingOnboardingSetupAnswers(state, template),
      reached: record.reached,
      started: record.started,
      finished: record.finished,
    };
  },
});
