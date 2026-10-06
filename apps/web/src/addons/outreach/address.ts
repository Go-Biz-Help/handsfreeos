/**
 * What Social Outreach's page shows, from its address: the tab (`?view=playbooks`, else the activity), and for the
 * activity the stretch of days (`?period=today`, `week` or `month`) and whose steps (`?who=everyone`, for owners and
 * admins). A plain module, so the page reads it on the server and the tabs build their links from it.
 */
import { ACTIVITY_PERIOD_KEYS, type ActivityPeriod } from '@hfos/core/addons/outreach/activity';

/** The stretch the activity opens on. */
export const DEFAULT_PERIOD: ActivityPeriod = 'week';

export interface OutreachAddress {
  readonly view: 'activity' | 'playbooks';
  readonly period: ActivityPeriod;
  /** The whole team's steps, asked for; the page shows them only to owners and admins. */
  readonly everyone: boolean;
}

export function readOutreachAddress(
  sp: Record<string, string | string[] | undefined>,
): OutreachAddress {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  return {
    view: one(sp.view) === 'playbooks' ? 'playbooks' : 'activity',
    period: ACTIVITY_PERIOD_KEYS.find((k) => k === one(sp.period)) ?? DEFAULT_PERIOD,
    everyone: one(sp.who) === 'everyone',
  };
}

/** The address of a tab, and for the activity its stretch and whose. */
export function outreachHref(workspaceId: string, to: Partial<OutreachAddress> = {}): string {
  const params = new URLSearchParams();
  if (to.view === 'playbooks') params.set('view', 'playbooks');
  else {
    if (to.period && to.period !== DEFAULT_PERIOD) params.set('period', to.period);
    if (to.everyone) params.set('who', 'everyone');
  }
  const qs = params.toString();
  return `/app/w/${workspaceId}/a/outreach${qs ? `?${qs}` : ''}`;
}
