import { defineQuery } from '../kernel/define';
import { loadOnboardingStatus } from '../onboarding/load';
import { OnboardingStatusInput, OnboardingStatusOutput } from '../schemas/onboarding';

export const onboardingStatus = defineQuery({
  name: 'onboarding.status',
  description:
    'Where your Getting started guide stands in this business: each step in order, done, waiting on someone else, needing a fix, to do or skipped, with the counts, the next step and whether the guide shows on Home. Owners and admins get the business’s steps; teammates get their own short list. `device` adds what only the browser or the phone knows.',
  input: OnboardingStatusInput,
  output: OnboardingStatusOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  handler: (ctx, input) => loadOnboardingStatus(ctx, input.workspaceId, input.device),
});
