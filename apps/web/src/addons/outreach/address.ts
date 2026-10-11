/**
 * What Social Outreach's page shows, from its address: the tab (`?view=live`, `waiting`, `today`, `pipeline`, `groups`,
 * `friends`, `chats`, `playbooks` or `settings`, else the activity); for the pipeline, which stage (`?show=ready`…, else
 * everyone in play); for settings, whose (`?for=` someone's id, for owners and admins); for groups, which (`?show=maybe`, `skip` or `all`, else Work these); for the activity the stretch of days (`?period=today`, `week` or `month`) and whose steps
 * (`?who=everyone`, for owners and admins); for friends, which of them (`?show=fits`, `requests`, `sent`, `keep` or
 * `dont_pitch`); for chats, which (`?show=tagged`, `read` or `waiting`) and a tag (`?tag=`); for both, a name
 * searched for (`?q=`) and the page (`?page=2`). A plain module, so the page reads it on the server and the tabs
 * build their links from it.
 */
import { ACTIVITY_PERIOD_KEYS, type ActivityPeriod } from '@hfos/core/addons/outreach/activity';
import { CHAT_VIEW_KEYS, type ChatView } from '@hfos/core/addons/outreach/chat-read';
import { FRIEND_VIEW_KEYS, type FriendView } from '@hfos/core/addons/outreach/friends';
import { GROUP_VIEWS, type GroupView } from '@hfos/core/addons/outreach/groups';
import { STAGE_VIEW_KEYS, type StageView } from '@hfos/core/addons/outreach/stages';

export const GROUP_VIEW_KEYS = Object.keys(GROUP_VIEWS) as GroupView[];

/** The stretch the activity opens on. */
export const DEFAULT_PERIOD: ActivityPeriod = 'week';

export type OutreachView =
  | 'activity'
  | 'live'
  | 'waiting'
  | 'today'
  | 'pipeline'
  | 'groups'
  | 'friends'
  | 'chats'
  | 'playbooks'
  | 'settings';
const VIEWS: readonly OutreachView[] = [
  'live',
  'waiting',
  'today',
  'pipeline',
  'groups',
  'friends',
  'chats',
  'playbooks',
  'settings',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OutreachAddress {
  readonly view: OutreachView;
  readonly period: ActivityPeriod;
  /** The whole team's steps, asked for; the page shows them only to owners and admins. */
  readonly everyone: boolean;
  /**
   * Which friends: the person's own, the good fits among friends and chats, their requests, the ones they sent, Keep,
   * or the business's Don't pitch.
   */
  readonly show: FriendView;
  /** Which chats: likely prospects, the tagged, all read, or not read yet. */
  readonly chats: ChatView;
  /** Which groups: Work these, Maybe, Skip, or all. */
  readonly groups: GroupView;
  /** Which of the pipeline: everyone in play, or one stage. */
  readonly stages: StageView;
  /** One of the tags, for chats. */
  readonly tag: string;
  /** Part of a name, for groups, friends and chats. */
  readonly search: string;
  /** Which page of groups, friends or chats, from 1. */
  readonly page: number;
  /** Whose settings, for an owner or admin: someone's id, or empty for their own. */
  readonly for: string;
}

export function readOutreachAddress(
  sp: Record<string, string | string[] | undefined>,
): OutreachAddress {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const view = one(sp.view);
  return {
    view: VIEWS.find((v) => v === view) ?? 'activity',
    period: ACTIVITY_PERIOD_KEYS.find((k) => k === one(sp.period)) ?? DEFAULT_PERIOD,
    everyone: one(sp.who) === 'everyone',
    show: FRIEND_VIEW_KEYS.find((k) => k === one(sp.show)) ?? 'friends',
    chats: CHAT_VIEW_KEYS.find((k) => k === one(sp.show)) ?? 'prospects',
    groups: GROUP_VIEW_KEYS.find((k) => k === one(sp.show)) ?? 'work',
    stages: STAGE_VIEW_KEYS.find((k) => k === one(sp.show)) ?? 'all',
    tag: one(sp.tag).trim().slice(0, 40),
    search: one(sp.q).trim().slice(0, 100),
    page: /^[1-9]\d{0,4}$/.test(one(sp.page)) ? Number(one(sp.page)) : 1,
    for: UUID.test(one(sp.for)) ? one(sp.for).toLowerCase() : '',
  };
}

/**
 * A tab's address: for the activity its stretch and whose; for groups, friends and chats which, the name searched for
 * and the page.
 */
export function outreachHref(workspaceId: string, to: Partial<OutreachAddress> = {}): string {
  const params = new URLSearchParams();
  if (to.view === 'playbooks' || to.view === 'today' || to.view === 'live' || to.view === 'waiting')
    params.set('view', to.view);
  else if (to.view === 'settings') {
    params.set('view', 'settings');
    if (to.for) params.set('for', to.for);
  } else if (to.view === 'groups') {
    params.set('view', 'groups');
    if (to.groups && to.groups !== 'work') params.set('show', to.groups);
    if (to.search) params.set('q', to.search);
    if (to.page && to.page > 1) params.set('page', String(to.page));
  } else if (to.view === 'friends') {
    params.set('view', 'friends');
    if (to.show && to.show !== 'friends') params.set('show', to.show);
    if (to.search) params.set('q', to.search);
    if (to.page && to.page > 1) params.set('page', String(to.page));
  } else if (to.view === 'pipeline') {
    params.set('view', 'pipeline');
    if (to.stages && to.stages !== 'all') params.set('show', to.stages);
    if (to.search) params.set('q', to.search);
    if (to.page && to.page > 1) params.set('page', String(to.page));
  } else if (to.view === 'chats') {
    params.set('view', 'chats');
    if (to.chats && to.chats !== 'prospects') params.set('show', to.chats);
    if (to.tag) params.set('tag', to.tag);
    if (to.search) params.set('q', to.search);
    if (to.page && to.page > 1) params.set('page', String(to.page));
  } else {
    if (to.period && to.period !== DEFAULT_PERIOD) params.set('period', to.period);
    if (to.everyone) params.set('who', 'everyone');
  }
  const qs = params.toString();
  return `/app/w/${workspaceId}/a/outreach${qs ? `?${qs}` : ''}`;
}
