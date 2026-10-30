/**
 * What Social Outreach's pages show, from their addresses. Each page has its own path under `/a/outreach/`, so the side
 * menu's pop-out lights the one open (docs/outreach.md, decision 127):
 *
 * - **Needs you** (`/needs-you`): everything waiting on the person, on every network.
 * - **Today** (`/today`): what their computer is doing on each network, and the network shown's list (`?net=`).
 * - **People**: everyone reached by where they stand (`/people`, `?show=ready`… for one stage, else the board), their
 *   friends (`/people/friends`, `?show=fits`, `requests`, `sent`, `keep`, `dont_pitch` or `never_contact`), their chats
 *   (`/people/chats`, `?show=tagged`, `read` or `waiting`, and a tag `?tag=`), and their Partners list
 *   (`/people/partners`, `?show=asked`… for one stage, else everyone).
 * - **Groups** (`/groups`, `?show=maybe`, `skip` or `all`, else Work these), and a group's own page (`?group=` its id,
 *   decision 103): who was found there and how each turned out, `?show=` one outcome (`not_reached`, `talking`…).
 * - **Results** (`/results`): the stretch of days (`?period=today`, `week` or `month`) and whose steps
 *   (`?who=everyone`, for owners and admins).
 * - **Playbooks** (`/playbooks`): the business's playbooks, with how each opener did.
 * - **Settings** (`/settings`, General; `/settings/<part>` for a network, Your computer or Start fresh), whose with
 *   `?for=` someone's id, for owners and admins.
 *
 * Lists take a name searched for (`?q=`) and the page (`?page=2`). Today takes the network whose list it shows, and
 * the People lists the network they're narrowed to (`?net=linkedin`); with none in the address, the one the person
 * picked last (`netCookie`), else Today's first network and every network. The old addresses, one page with
 * `?view=` (decision 59), still work: the bare page forwards them here (`forwardedHref`). A plain module, so the
 * pages read it on the server and build their links from it.
 */
import { ACTIVITY_PERIOD_KEYS, type ActivityPeriod } from '@hfos/core/addons/outreach/activity';
import { CHAT_VIEW_KEYS, type ChatView } from '@hfos/core/addons/outreach/chat-read';
import { FRIEND_VIEW_KEYS, type FriendView } from '@hfos/core/addons/outreach/friends';
import { GROUP_VIEWS, type GroupView } from '@hfos/core/addons/outreach/groups';
import { GROUP_PEOPLE_VIEW_KEYS, type GroupPeopleView } from '@hfos/core/addons/outreach/journey';
import { readNetwork } from '@hfos/core/addons/outreach/network-words';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { OutreachPage } from '@hfos/core/addons/outreach/pages';
import { PARTNER_VIEW_KEYS, type PartnerView } from '@hfos/core/addons/outreach/partners';
import { settingsPartOf, type SettingsPart } from '@hfos/core/addons/outreach/settings-parts';
import { STAGE_VIEW_KEYS, type StageView } from '@hfos/core/addons/outreach/stages';

export const GROUP_VIEW_KEYS = Object.keys(GROUP_VIEWS) as GroupView[];

/** The stretch the results open on. */
export const DEFAULT_PERIOD: ActivityPeriod = 'week';

export type OutreachView =
  | 'needs'
  | 'today'
  | 'pipeline'
  | 'friends'
  | 'chats'
  | 'partners'
  | 'groups'
  | 'results'
  | 'settings'
  | 'playbooks';

/** Each view's path under `/a/outreach/` (Settings' part goes after its own). */
const VIEW_PATH: Readonly<Record<OutreachView, string>> = {
  needs: 'needs-you',
  today: 'today',
  pipeline: 'people',
  friends: 'people/friends',
  chats: 'people/chats',
  partners: 'people/partners',
  groups: 'groups',
  results: 'results',
  settings: 'settings',
  playbooks: 'playbooks',
};

/** The side menu's page a view is on: its title, and the menu's light. */
export function pageOf(view: OutreachView): OutreachPage {
  switch (view) {
    case 'needs':
      return 'needs-you';
    case 'today':
      return 'today';
    case 'pipeline':
    case 'friends':
    case 'chats':
    case 'partners':
      return 'people';
    case 'groups':
      return 'groups';
    case 'results':
      return 'results';
    case 'playbooks':
      return 'playbooks';
    case 'settings':
      return 'gear';
  }
}

/**
 * The old addresses' views (`?view=`, decision 59, and the phone's own), as the pages they became. What pushes,
 * emails, notifications already sent, the extension and old phones still open.
 */
const OLD_VIEWS: Readonly<Record<string, OutreachView>> = {
  waiting: 'needs',
  // A code a network emailed waits under Needs you (decision 82's ask, in "Your computer needs you").
  code: 'needs',
  today: 'today',
  // The computer's whole day folded into Today (decision 127).
  live: 'today',
  activity: 'results',
  results: 'results',
  pipeline: 'pipeline',
  friends: 'friends',
  chats: 'chats',
  partners: 'partners',
  groups: 'groups',
  settings: 'settings',
  playbooks: 'playbooks',
  // The phone's Never contact list, and the lists the country setting makes, are the Friends lists here.
  never_contact: 'friends',
  countries: 'friends',
};

/** The cookie keeping the network the person picked last, for each business: `all` for every network. */
export const netCookie = (workspaceId: string) => `outreach-net-${workspaceId}`;

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
  /** One group's page: its id, or empty for the list. */
  readonly group: string;
  /** Who of a group's page: everyone found there, one outcome, or those not reached yet. */
  readonly outcome: GroupPeopleView;
  /** Which of the pipeline: everyone in play (the board), or one stage. */
  readonly stages: StageView;
  /** Which of the Partners list: everyone on it, or one stage. */
  readonly partners: PartnerView;
  /** One of the tags, for chats. */
  readonly tag: string;
  /** Part of a name, for the pipeline, groups, friends and chats. */
  readonly search: string;
  /** Which page of the pipeline, groups, friends, chats or partners, from 1. */
  readonly page: number;
  /** Whose settings, for an owner or admin: someone's id, or empty for their own. */
  readonly for: string;
  /** Which part of Settings: General, a network's page, Your computer or Start fresh. */
  readonly part: SettingsPart;
  /** Today's network, or the network a list is narrowed to: null for the first, or every one. */
  readonly net: Platform | null;
}

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/**
 * A page's address, read: the view is its path's (`part` too, for Settings), the rest its query's. `remembered` is
 * the network the person picked last (`netCookie`), for an address naming none.
 */
export function readOutreachAddress(
  view: OutreachView,
  sp: Query,
  { part = '', remembered = null }: { part?: string; remembered?: string | null } = {},
): OutreachAddress {
  return {
    view,
    period: ACTIVITY_PERIOD_KEYS.find((k) => k === one(sp.period)) ?? DEFAULT_PERIOD,
    everyone: one(sp.who) === 'everyone',
    show: FRIEND_VIEW_KEYS.find((k) => k === one(sp.show)) ?? 'friends',
    chats: CHAT_VIEW_KEYS.find((k) => k === one(sp.show)) ?? 'prospects',
    groups: GROUP_VIEW_KEYS.find((k) => k === one(sp.show)) ?? 'work',
    group: UUID.test(one(sp.group)) ? one(sp.group).toLowerCase() : '',
    outcome: GROUP_PEOPLE_VIEW_KEYS.find((k) => k === one(sp.show)) ?? 'all',
    stages: STAGE_VIEW_KEYS.find((k) => k === one(sp.show)) ?? 'all',
    partners: PARTNER_VIEW_KEYS.find((k) => k === one(sp.show)) ?? 'all',
    tag: one(sp.tag).trim().slice(0, 40),
    search: one(sp.q).trim().slice(0, 100),
    page: /^[1-9]\d{0,4}$/.test(one(sp.page)) ? Number(one(sp.page)) : 1,
    for: UUID.test(one(sp.for)) ? one(sp.for).toLowerCase() : '',
    part: settingsPartOf(part),
    // The address's own; with none, the last picked; `all` (or nothing) is every network.
    net: sp.net !== undefined ? readNetwork(one(sp.net)) : readNetwork(remembered),
  };
}

/**
 * Where an old address goes (`/a/outreach?view=…`, decision 59's page and the phone's views): the page its view
 * became, with the rest of its query kept, Settings' part as its path. Null for the bare page with no query at all,
 * which opens Today (or the setup, for a first-timer).
 */
export function forwardedHref(workspaceId: string, sp: Query): string | null {
  const old = one(sp.view);
  if (!old && !Object.keys(sp).length) return null;
  const view = OLD_VIEWS[old] ?? 'today';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key === 'view' || key === 'part' || value === undefined) continue;
    params.set(key, one(value));
  }
  if (old === 'never_contact') params.set('show', 'never_contact');
  const part = view === 'settings' ? settingsPartOf(one(sp.part)) : 'general';
  const path = `${VIEW_PATH[view]}${part !== 'general' ? `/${part}` : ''}`;
  const qs = params.toString();
  return `/app/w/${workspaceId}/a/outreach/${path}${qs ? `?${qs}` : ''}`;
}

/**
 * A view's address: for the results their stretch and whose; for the pipeline, groups, friends and chats which, the
 * name searched for and the page; for a group's page the group, who and the page; for partners which and the page;
 * for settings, the part and whose.
 */
export function outreachHref(workspaceId: string, to: Partial<OutreachAddress> = {}): string {
  const params = new URLSearchParams();
  const view = to.view ?? 'today';
  let path = VIEW_PATH[view];
  if (
    to.net &&
    (view === 'today' ||
      view === 'pipeline' ||
      view === 'friends' ||
      view === 'chats' ||
      view === 'partners')
  )
    params.set('net', to.net);
  if (view === 'settings') {
    if (to.part && to.part !== 'general') path = `${path}/${to.part}`;
    if (to.for) params.set('for', to.for);
  } else if (view === 'groups' && to.group) {
    params.set('group', to.group);
    if (to.outcome && to.outcome !== 'all') params.set('show', to.outcome);
    if (to.page && to.page > 1) params.set('page', String(to.page));
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
  } else if (view === 'partners') {
    if (to.partners && to.partners !== 'all') params.set('show', to.partners);
    if (to.page && to.page > 1) params.set('page', String(to.page));
  } else if (view === 'results') {
    if (to.period && to.period !== DEFAULT_PERIOD) params.set('period', to.period);
    if (to.everyone) params.set('who', 'everyone');
  }
  const qs = params.toString();
  return `/app/w/${workspaceId}/a/outreach/${path}${qs ? `?${qs}` : ''}`;
}
