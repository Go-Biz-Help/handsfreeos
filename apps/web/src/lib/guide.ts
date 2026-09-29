import { personalOnboardingOf } from '@hfos/core';
import type { Me } from './api/types';

/**
 * Whether this person's Getting started guide in a business is hidden, or finished for good, from their own
 * settings (which the shell already has). Get help turns into a short menu while it isn't finished.
 */
export function guideOf(me: Me, workspaceId: string) {
  const g = personalOnboardingOf(me.user.settings, workspaceId);
  return { hidden: g.hidden, finished: !!g.finishedAt };
}
