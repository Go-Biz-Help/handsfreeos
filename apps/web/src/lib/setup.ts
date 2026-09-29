import type { WizardStepKey } from '@hfos/core';

/**
 * Where the setup wizard shows a step (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6). Outside `/app/w`, like
 * the quick questions before it, so it has its own frame and not the sidebar.
 */
export const setupHref = (workspaceId: string, step: WizardStepKey): string =>
  `/onboarding/${workspaceId}/setup/${step}`;
