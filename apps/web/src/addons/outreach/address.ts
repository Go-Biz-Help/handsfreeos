/**
 * What Social Outreach's page shows, from its address. Four tabs and the gear (docs/outreach.md, decision 59):
 *
 * - **Today** (`?view=today`, and the bare page): what needs the person and their list. `?view=waiting`, the old
 *   Waiting for you tab's address that pushes and links still use, opens it too; `?view=live` is the detail of what
 *   their computer is doing, under the same tab.
 * - **People**: everyone reached by where they stand (`?view=pipeline`, `?show=ready`… for one stage, else the board),
 *   their friends (`?view=friends`, `?show=fits`, `requests`, `sent`, `keep`, `dont_pitch` or
 *   `never_contact`) and their chats
 *   (`?view=chats`, `?show=tagged`, `read` or `waiting`, and a tag `?tag=`).
 * - **Groups** (`?view=groups`, `?show=maybe`, `skip` or `all`, else Work these).
 * - **Results** (`?view=results`, and the old `?view=activity`): the stretch of days (`?period=today`, `week` or
 *   `month`) and whose steps (`?who=everyone`, for owners and admins).
 * - **Settings** (`?view=settings`, whose with `?for=` someone's id, for owners and admins) and the business's playbooks
 *   (`?view=playbooks`).
 *
 * Lists take a name searched for (`?q=`) and the page (`?page=2`). Today and Live take the network whose day they show, and
 * the pipeline, friends and chats the network they're narrowed to (`?net=linkedin`): Today's first network, and every
 * network, when left out. A plain module, so the page reads it on the server and the tabs build their links from it.
 */
import { ACTIVITY_PERIOD_KEYS, type ActivityPeriod } from '@hfos/core/addons/outreach/activity';
import { CHAT_VIEW_KEYS, type ChatView } from '@hfos/core/addons/outreach/chat-read';
import { FRIEND_VIEW_KEYS, type FriendView } from '@hfos/core/addons/outreach/friends';
import { GROUP_VIEWS, type GroupView } from '@hfos/core/addons/outreach/groups';
import { readNetwork } from '@hfos/core/addons/outreach/network-words';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { STAGE_VIEW_KEYS, type StageView } from '@hfos/core/addons/outreach/stages';

export const GROUP_VIEW_KEYS = Object.keys(GROUP_VIEWS) as GroupView[];

/** The stretch the results open on. */
export const DEFAULT_PERIOD: ActivityPeriod = 'week';

export type OutreachView =
  | 'today'
  | 'live'
  | 'pipeline'
  | 'friends'
  | 'chats'
  | 'groups'
  | 'results'
  | 'settings'
  | 'playbooks';
const VIEWS: readonly OutreachView[] = [
  'today',
  'live',
  'pipeline',
  'friends',
  'chats',
  'groups',
  'results',
  'settings',
  'playbooks',
];
/** The old tabs' addresses, which pushes, emails and old phones still open. */
const OLD_VIEWS: Readonly<Record<string, OutreachView>> = {
  waiting: 'today',
  activity: 'results',
};

/** The four tabs and the gear (decision 59). */
export type OutreachTab = 'today' | 'people' | 'groups' | 'results' | 'settings';
export const OUTREACH_TABS: readonly OutreachTab[] = [
  'today',
  'people',
  'groups',
  'results',
  'settings',
];

/** The tab a view sits under. */
export function tabOf(view: OutreachView): OutreachTab {
  switch (view) {
    case 'today':
    case 'live':
      return 'today';
    case 'pipeline':
    case 'friends':
    case 'chats':
      return 'people';
    case 'groups':
      return 'groups';
    case 'results':
      return 'results';
    case 'settings':
    case 'playbooks':
      return 'settings';
  }
}

/** Where a tab's own link goes. */
export const TAB_VIEW: Readonly<Record<OutreachTab, OutreachView>> = {
  today: 'today',
  people: 'pipeline',
  groups: 'groups',
  results: 'results',
  settings: 'settings',
};

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
  /** Which of the pipeline: everyone in play (the board), or one stage. */
  readonly stages: StageView;
  /** One of the tags, for chats. */
  readonly tag: string;
  /** Part of a name, for the pipeline, groups, friends and chats. */
  readonly search: string;
  /** Which page of the pipeline, groups, friends or chats, from 1. */
  readonly page: number;
  /** Whose settings, for an owner or admin: someone's id, or empty for their own. */
  readonly for: string;
  /** Today's network, or the network a list is narrowed to: null for the first, or every one. */
  readonly net: Platform | null;
}

export function readOutreachAddress(
  sp: Record<string, string | string[] | undefined>,
): OutreachAddress {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const view = one(sp.view);
  // The phone's Never contact list (`?view=never_contact`) is the Friends tab's list here.
  if (view === 'never_contact')
    return readOutreachAddress({ ...sp, view: 'friends', show: 'never_contact' });
  return {
    view: VIEWS.find((v) => v === view) ?? OLD_VIEWS[view] ?? 'today',
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
    net: readNetwork(one(sp.net)),
  };
}

/**
 * A view's address: for the results their stretch and whose; for the pipeline, groups, friends and chats which, the
 * name searched for and the page; for settings, whose.
 */
export function outreachHref(workspaceId: string, to: Partial<OutreachAddress> = {}): string {
  const params = new URLSearchParams();
  const view = to.view ?? 'today';
  params.set('view', view);
  if (
    to.net &&
    (view === 'today' ||
      view === 'live' ||
      view === 'pipeline' ||
      view === 'friends' ||
      view === 'chats')
  )
    params.set('net', to.net);
  if (view === 'settings') {
    if (to.for) params.set('for', to.for);
  } else if (view === 'groups') {
    if (to.groups && to.groups !== 'work') params.set('show', to.groups);
    if (to.search) params.set('q', to.search);
    if (to.page && to.page > 1) params.set('page', String(to.page));
  } else if (view === 'friends') {
    if (to.show && to.show !== 'friends') params.set('show', to.show);
    if (to.search) params.set('q', to.search);
    if (to.page && to.page > 1) params.set('page', String(to.page));
  } else if (view === 'pipeline') {
    if (to.stages && to.stages !== 'all') params.set('show', to.stages);
    if (to.search) params.set('q', to.search);
    if (to.page && to.page > 1) params.set('page', String(to.page));
  } else if (view === 'chats') {
    if (to.chats && to.chats !== 'prospects') params.set('show', to.chats);
    if (to.tag) params.set('tag', to.tag);
    if (to.search) params.set('q', to.search);
    if (to.page && to.page > 1) params.set('page', String(to.page));
  } else if (view === 'results') {
    if (to.period && to.period !== DEFAULT_PERIOD) params.set('period', to.period);
    if (to.everyone) params.set('who', 'everyone');
  }
  return `/app/w/${workspaceId}/a/outreach?${params.toString()}`;
}
