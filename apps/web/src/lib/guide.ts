import { personalOnboardingOf } from '@hfos/core';
import type { Me, WorkspaceSummary } from './api/types';

/**
 * Whether this person's Getting started guide in a business is hidden, or finished for good, and whether they've
 * taken the tour, from their own settings (which the shell already has). Get help turns into a short menu while
 * the guide isn't finished. Turned off for the whole business, it counts as finished and the tour as taken: Get
 * help is only the form, and the tour never opens by itself.
 *
 * `business` is the one the shell draws (`getWorkspaceShell`), never looked up in the person's own list of
 * businesses: the founder working in one as its owner (20261013002100) isn't in that list, and a business that
 * turned the guide off would show it to them all the same.
 */
export function guideOf(me: Me, business: Pick<WorkspaceSummary, 'id' | 'gettingStarted'>) {
  const g = personalOnboardingOf(me.user.settings, business.id);
  const on = business.gettingStarted;
  return {
    hidden: g.hidden,
    finished: !on || !!g.finishedAt,
    tourTaken: !on || !!g.tourDoneAt,
  };
}
