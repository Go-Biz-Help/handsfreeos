'use client';
/**
 * The onboarding setup's calls from the browser (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7): where
 * it stands, keeping the answers as each screen is finished (with what can't wait), and "Stay in the loop", which
 * saves the rest.
 */
import {
  OnboardingSetupFinishOutput,
  OnboardingSetupSaveOutput,
  type OnboardingSetupAnswers,
  type OnboardingSetupScreen,
  type onboardingSetupBusinessOf,
} from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { OnboardingSetupFinishBody, OnboardingSetupSaveBody } from '@/lib/api/types';
import {
  onboardingSetupGotOf,
  type OnboardingSetupFinished,
  type OnboardingSetupGot,
  type OnboardingSetupSaved,
} from './data';

export function onboardingSetupActions(workspaceId: string) {
  // Made when first used: the screens create these while they render, on the server too.
  const api = () => apiBrowser();
  return {
    get: async (): Promise<OnboardingSetupGot> =>
      onboardingSetupGotOf(
        unwrap(await api().POST('/v1/queries/onboarding_setup.get', { body: { workspaceId } })),
      ),
    save: async (input: {
      screen: OnboardingSetupScreen;
      answers: OnboardingSetupAnswers;
      /** The first screen's answers, saved to the business straight away. */
      business?: ReturnType<typeof onboardingSetupBusinessOf>;
      /** "Invite them now", on the goal. */
      invite?: readonly string[];
      /** Start from: saved answers picked on the first screen, or null for our picks. */
      templateId?: string | null;
    }): Promise<OnboardingSetupSaved> =>
      OnboardingSetupSaveOutput.parse(
        unwrap(
          await api().POST('/v1/commands/onboarding_setup.save', {
            body: {
              workspaceId,
              screen: input.screen,
              answers: input.answers as unknown as OnboardingSetupSaveBody['answers'],
              ...(input.business
                ? { business: input.business as OnboardingSetupSaveBody['business'] }
                : {}),
              ...(input.invite?.length ? { invite: [...input.invite] } : {}),
              ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
            },
          }),
        ),
      ),
    finish: async (input: {
      answers: OnboardingSetupAnswers;
      baseRevision: number | null;
      /** Where the simple page is shown, for a chat on it. */
      pageOrigin?: string;
      /** An agency handing the business over: the owner's email, or null to send nothing yet. */
      owner?: { email: string | null };
    }): Promise<OnboardingSetupFinished> =>
      OnboardingSetupFinishOutput.parse(
        unwrap(
          await api().POST('/v1/commands/onboarding_setup.finish', {
            body: {
              workspaceId,
              answers: input.answers as unknown as OnboardingSetupFinishBody['answers'],
              baseRevision: input.baseRevision,
              ...(input.pageOrigin ? { pageOrigin: input.pageOrigin } : {}),
              ...(input.owner ? { owner: input.owner } : {}),
            },
          }),
        ),
      ),
  };
}

export type OnboardingSetupActions = ReturnType<typeof onboardingSetupActions>;
