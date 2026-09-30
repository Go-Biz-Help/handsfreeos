import { personalOnboardingOf } from '@hfos/core';
import type { Me } from './api/types';

/**
 * Whether this person's Getting started guide in a business is hidden, or finished for good, and whether they've
 * taken the tour, from their own settings (which the shell already has). Get help turns into a short menu while
 * the guide isn't finished. Turned off for the whole business, it counts as finished and the tour as taken: Get
 * help is only the form, and the tour never opens by itself.
 */
export function guideOf(me: Me, workspaceId: string) {
  const g = personalOnboardingOf(me.user.settings, workspaceId);
  const on = me.workspaces.find((w) => w.id === workspaceId)?.gettingStarted ?? true;
  return {
    hidden: g.hidden,
    finished: !on || !!g.finishedAt,
    tourTaken: !on || !!g.tourDoneAt,
  };
}
