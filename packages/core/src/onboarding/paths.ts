import { isWizardStep, type OnboardingStepKey, type WizardStepKey } from './steps';

/**
 * Where each Getting started step is done on the web, as a path: for the web's card, and for the link the phone
 * emails ("Email me a link"). One copy, so the card, the wizard and the email agree.
 */

/** The setup wizard's screen for a step. Outside `/app/w`, like the quick questions, so it has its own frame. */
export const setupPath = (workspaceId: string, step: WizardStepKey): string =>
  `/onboarding/${workspaceId}/setup/${step}`;

/**
 * The page for a step, or null for the two done on the phone itself (the app, and its notifications).
 * `passkeys`: the web signs in with passkeys, so "Sign in faster" opens that section rather than Google's.
 * `phase`: how far a step has got, from its note (email and chat: the mailbox is in, chat is next).
 */
export function stepPath(
  workspaceId: string,
  step: OnboardingStepKey,
  opts: { readonly passkeys?: boolean; readonly phase?: string | undefined } = {},
): string | null {
  if (isWizardStep(step)) return setupPath(workspaceId, step);
  const base = `/app/w/${workspaceId}`;
  switch (step) {
    case 'team':
      return `${base}/members?invite=1`;
    case 'email_chat':
      return opts.phase === 'mailbox' ? `${base}/settings/website-chat` : `${base}/settings/email`;
    case 'sign_in':
      return `${base}/settings#${opts.passkeys ? 'passkeys' : 'google'}`;
    case 'my_calendar':
      return `${base}/settings/my-calendar`;
    case 'app':
    case 'notifications':
      return null;
  }
}
