/**
 * What Social Outreach's page shows, from its address: the tab (`?view=friends` or `playbooks`, else the activity);
 * for the activity the stretch of days (`?period=today`, `week` or `month`) and whose steps (`?who=everyone`, for
 * owners and admins); for friends, which of them (`?show=requests`, `sent`, `keep` or `dont_pitch`), a name
 * searched for (`?q=`) and the page (`?page=2`). A plain module, so the page reads it on the server and the tabs
 * build their links from it.
 */
import { ACTIVITY_PERIOD_KEYS, type ActivityPeriod } from '@hfos/core/addons/outreach/activity';
import { FRIEND_VIEW_KEYS, type FriendView } from '@hfos/core/addons/outreach/friends';

/** The stretch the activity opens on. */
export const DEFAULT_PERIOD: ActivityPeriod = 'week';

export type OutreachView = 'activity' | 'friends' | 'playbooks';

export interface OutreachAddress {
  readonly view: OutreachView;
  readonly period: ActivityPeriod;
  /** The whole team's steps, asked for; the page shows them only to owners and admins. */
  readonly everyone: boolean;
  /** Which friends: the person's own, their requests, the ones they sent, Keep, or the business's Don't pitch. */
  readonly show: FriendView;
  /** Part of a name, for friends. */
  readonly search: string;
  /** Which page of friends, from 1. */
  readonly page: number;
}

export function readOutreachAddress(
  sp: Record<string, string | string[] | undefined>,
): OutreachAddress {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const view = one(sp.view);
  return {
    view: view === 'playbooks' || view === 'friends' ? view : 'activity',
    period: ACTIVITY_PERIOD_KEYS.find((k) => k === one(sp.period)) ?? DEFAULT_PERIOD,
    everyone: one(sp.who) === 'everyone',
    show: FRIEND_VIEW_KEYS.find((k) => k === one(sp.show)) ?? 'friends',
    search: one(sp.q).trim().slice(0, 100),
    page: /^[1-9]\d{0,4}$/.test(one(sp.page)) ? Number(one(sp.page)) : 1,
  };
}

/** A tab's address: for the activity its stretch and whose, for friends which, the name searched for and the page. */
export function outreachHref(workspaceId: string, to: Partial<OutreachAddress> = {}): string {
  const params = new URLSearchParams();
  if (to.view === 'playbooks') params.set('view', 'playbooks');
  else if (to.view === 'friends') {
    params.set('view', 'friends');
    if (to.show && to.show !== 'friends') params.set('show', to.show);
    if (to.search) params.set('q', to.search);
    if (to.page && to.page > 1) params.set('page', String(to.page));
  } else {
    if (to.period && to.period !== DEFAULT_PERIOD) params.set('period', to.period);
    if (to.everyone) params.set('who', 'everyone');
  }
  const qs = params.toString();
  return `/app/w/${workspaceId}/a/outreach${qs ? `?${qs}` : ''}`;
}
