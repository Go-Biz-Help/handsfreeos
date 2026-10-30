'use client';
/**
 * Social Outreach's pages (docs/outreach.md, decision 127): each its own address (./address.ts) and one of the side
 * menu's pages, which pop out from the add-on's one row there, so a link, a push or the builder's way back opens the
 * one it's about. Each has its name and what it's for at the top.
 *
 * - **Needs you**: everything waiting on the person (decision 42's list), on every network, never narrowed.
 * - **Today**: what the person's computer is doing, a card for each network with Start my day and Stop for today,
 *   one Heads up for what to know, the feed of today's steps and the team's, and their list for the day.
 * - **People**: one list with a view for each kind (decision 128, `people-views.ts` in core): everyone in play (the
 *   board, or one stage), the good fits, those talking, friends, requests got and sent, chats as the AI read them, the
 *   Partners list (decision 81), clients, and Left alone, with a row of its own lists.
 * - **Find people**: what each way of finding people found this week (decision 128), and the groups saved and how
 *   they fit.
 * - **Results**: from reached to booked, by group and by person.
 * - **Playbooks**: the business's playbooks, with how each opener did.
 * - **Settings**: a menu beside a page for each part (decision 73): General, then each network (its On or Off for the
 *   person shown, and the networks still to come), then the person's computer, and Start fresh for owners. On a phone
 *   the menu is a list to pick from, above the page.
 *
 * Today and People's lists have the network picker at the top: the one picked is kept for the next page (a cookie,
 * `netCookie`), so the person picks it once. The page asks HandsFreeOS for what it shows
 * (`app/w/[workspaceId]/a/outreach/show.tsx`), with what the person asked their computer to do on it: the buttons on
 * People, Groups and Today ask the computer (./asks.tsx), and why they wait is said once, under the title.
 */
import type { ActivityPeriod } from '@hfos/core/addons/outreach/activity';
import type { ChatView } from '@hfos/core/addons/outreach/chat-read';
import type { FriendView } from '@hfos/core/addons/outreach/friends';
import type { GroupView } from '@hfos/core/addons/outreach/groups';
import type { GroupPeopleView } from '@hfos/core/addons/outreach/journey';
import { networksOn } from '@hfos/core/addons/outreach/network-words';
import {
  PLATFORM_KEYS,
  PLATFORMS,
  WORKING_PLATFORMS,
  type Platform,
} from '@hfos/core/addons/outreach/networks';
import { OUTREACH_PAGE_ABOUT, OUTREACH_PAGES } from '@hfos/core/addons/outreach/pages';
import type { PartnerView } from '@hfos/core/addons/outreach/partners';
import {
  LEFT_ALONE,
  LEFT_ALONE_KEYS,
  PEOPLE_VIEW_KEYS,
  PEOPLE_VIEW_WORDS as PV,
  PEOPLE_VIEWS,
  peopleCountsOf,
  peopleListOf,
  peopleViewOf,
  type PeopleList,
} from '@hfos/core/addons/outreach/people-views';
import {
  NEXT_NETWORKS,
  SETTINGS_WORDS as S,
  type SettingsPart,
} from '@hfos/core/addons/outreach/settings-parts';
import type { StageView } from '@hfos/core/addons/outreach/stages';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { CircleDashed, Globe, Laptop, RotateCcw, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ComponentProps, ComponentType } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ActivityView } from './activity-view';
import { outreachHref, pageOf, type OutreachView } from './address';
import { ComputerNote } from './asks';
import { ChatsView } from './chats-view';
import { SkippedCountryCard } from './country-skipped';
import { FindView } from './find-view';
import { FriendsView } from './friends-view';
import { GroupPage } from './group-page';
import { GroupsView } from './groups-view';
import type { Board } from './board';
import { NetworkPicker } from './network-ui';
import { PartnersView } from './partners-view';
import { PipelineView } from './pipeline-view';
import { PlaybooksView } from './playbooks-page';
import { SettingsView } from './settings-page';
import { SetupBanner } from './setup-view';
import type { NetworkLive } from './status-strip';
import { TodayView } from './today-view';
import { NeedsYou } from './waiting-view';
import type {
  Activity,
  Asks,
  Automation,
  AutomationPeople,
  Chats,
  FindsWeek,
  Friends,
  GroupPeople,
  Groups,
  HelpfulList,
  Live,
  LiveTeam,
  Openers,
  Partners,
  Pipeline,
  PlaybookList,
  Readiness,
  Tidy,
  TodayList,
  Tracking,
  Waiting,
  WheelsList,
} from './types';

export type OutreachShown =
  | {
      readonly view: 'today';
      /** The network whose list is shown. */
      readonly platform: Platform;
      /** Each network the person works, with what their computer is doing there: those that could be had. */
      readonly networks: readonly NetworkLive[];
      readonly today: TodayList;
      readonly helpful: HelpfulList;
      readonly wheels: WheelsList | null;
      /** How each person's extension is doing on the network shown, for owners and admins: else null. */
      readonly team: LiveTeam | null;
      readonly asks: Asks;
      /** Everything that needs the person: null when it couldn't be had. */
      readonly waiting: Waiting | null;
      /**
       * Get ready on the network shown (decisions 63 and 90): what's left, the profile's advice among it. Null when it
       * couldn't be had; `today.ready` says whether anything holds the day.
       */
      readonly readiness: Readiness | null;
    }
  | {
      /** Everything waiting on the person, on every network. */
      readonly view: 'needs';
      readonly waiting: Waiting;
    }
  | {
      readonly view: 'results';
      readonly activity: Activity;
      readonly tracking: Tracking | null;
      readonly period: ActivityPeriod;
    }
  | {
      readonly view: 'pipeline';
      readonly pipeline: Pipeline;
      /** Everyone in play by stage, side by side: on the bare People tab, not for one stage or a search. */
      readonly board: Board | null;
      readonly show: StageView;
      readonly search: string;
      /** The network it's narrowed to: null for every network. */
      readonly net: Platform | null;
      /** Research's asks, for the rows: null when they couldn't be had. */
      readonly asks: Asks | null;
    }
  | {
      /** Find people: what each way found this week. */
      readonly view: 'find';
      readonly week: FindsWeek;
      /** The groups' counts, and the people left in them: null when they couldn't be had. */
      readonly groups: Groups | null;
      readonly playbooks: PlaybookList | null;
      readonly asks: Asks;
      /** The network picked: null for every network. */
      readonly net: Platform | null;
    }
  | {
      /** Left alone's Skipped for country, which loads itself. */
      readonly view: 'skipped';
    }
  | {
      readonly view: 'groups';
      readonly groups: Groups;
      readonly show: GroupView;
      readonly search: string;
      readonly asks: Asks;
      /** Find groups' box starts with these. */
      readonly searchWords: string;
    }
  | {
      /** A group's own page (decision 103), under the Groups tab. */
      readonly view: 'group';
      readonly groupId: string;
      /** Null when it couldn't be had, `problem` saying why. */
      readonly people: GroupPeople | null;
      readonly problem: string | null;
      readonly outcome: GroupPeopleView;
    }
  | {
      readonly view: 'friends';
      readonly friends: Friends;
      readonly tidy: Tidy;
      readonly show: FriendView;
      readonly search: string;
      /** The network it's narrowed to: null for every network. */
      readonly net: Platform | null;
      readonly asks: Asks;
    }
  | {
      readonly view: 'chats';
      readonly chats: Chats;
      readonly show: ChatView;
      readonly tag: string;
      readonly search: string;
      /** The network it's narrowed to: null for every network. */
      readonly net: Platform | null;
      readonly asks: Asks;
    }
  | {
      readonly view: 'partners';
      readonly partners: Partners;
      readonly show: PartnerView;
      /** The network it's narrowed to: null for every network. */
      readonly net: Platform | null;
      readonly page: number;
    }
  | { readonly view: 'playbooks'; readonly list: PlaybookList; readonly openers: Openers }
  | {
      readonly view: 'settings';
      /** The part shown (`?part=`). */
      readonly part: SettingsPart;
      readonly me: Automation;
      readonly mine: boolean;
      readonly people: AutomationPeople | null;
      readonly business: Readonly<Record<string, unknown>> | null;
      /** An owner, who may erase everything and start fresh. */
      readonly canStartFresh: boolean;
      /** The person's computers, to rename: null when it couldn't be had. */
      readonly live: Live | null;
      /** The business's own link to the extension's zip, when it gave one. */
      readonly extensionLink: string | null;
      /** On a network's page, the person's own: Check LinkedIn's ask, and their computer (decision 74). */
      readonly asks?: Asks | null;
      /** On a network's page, the person's own profile there, read and checked (decision 80). */
      readonly readiness?: Readiness | null;
    };

/** A row of links that looks like a segmented control: People's views, Left alone's lists, Find people's parts. */
function LinkSegments({
  label,
  items,
}: {
  label: string;
  items: readonly {
    readonly href: string;
    readonly label: string;
    readonly active: boolean;
    readonly testId: string;
    /** How many are on it, where the page knows. */
    readonly count?: number;
  }[];
}) {
  return (
    <nav
      aria-label={label}
      className="inline-flex max-w-full overflow-x-auto rounded-[9px] border border-border bg-card-2 p-[3px]"
    >
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={i.active ? 'page' : undefined}
          data-testid={i.testId}
          className={cn(
            'inline-flex h-8 items-center whitespace-nowrap rounded-[6px] px-3.5 text-[13px] font-medium transition-colors max-md:h-10',
            i.active ? 'bg-card text-text shadow-1' : 'text-text-2 hover:text-text',
          )}
        >
          {i.label}
          {i.count !== undefined ? (
            <span className="ml-1.5 tabular-nums text-text-3">{i.count.toLocaleString()}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

/** A row of the Settings menu: a part, Playbooks, or a network still to come. */
interface MenuRow {
  readonly key: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  /** Null for a network still to come, which never opens. */
  readonly href: string | null;
  readonly active?: boolean;
  /** A network's On or Off for the person shown, or Soon. */
  readonly badge?: { readonly words: string; readonly on: boolean } | null;
  readonly danger?: boolean;
}

/**
 * Settings' menu (decision 73, the "Social Outreach settings by platform" design): Settings with General; Networks,
 * each with whether it's on for the person shown, then the networks still to come; and More: Your computer (their
 * own) and Start fresh (an owner's). Playbooks have their own page in the side menu (decision 127). A part keeps whose
 * settings an owner or admin is looking at. On a phone it's a list to pick from, above the page.
 */
function SettingsMenu({
  workspaceId,
  part,
  whose,
  mine,
  canStartFresh,
  networks,
}: {
  workspaceId: string;
  /** The part shown. */
  part: SettingsPart;
  /** Someone else's id, when an owner or admin is looking at theirs. */
  whose: string | null;
  mine: boolean;
  canStartFresh: boolean;
  /** The networks on for the person shown. */
  networks: readonly Platform[];
}) {
  const router = useRouter();
  const P = W.settingsParts;
  const partHref = (p: SettingsPart, keepWhose = true) =>
    outreachHref(workspaceId, {
      view: 'settings',
      part: p,
      ...(keepWhose && whose ? { for: whose } : {}),
    });
  const groups: readonly { readonly label: string; readonly rows: readonly MenuRow[] }[] = [
    {
      label: S.menu.settings,
      rows: [
        {
          key: 'general',
          label: S.general,
          icon: SlidersHorizontal,
          href: partHref('general'),
          active: part === 'general',
        },
      ],
    },
    {
      label: S.menu.networks,
      rows: [
        ...PLATFORM_KEYS.map((p) => ({
          key: p,
          label: PLATFORMS[p],
          icon: Globe,
          href: partHref(p),
          active: part === p,
          badge: networks.includes(p) ? { words: S.on, on: true } : { words: S.off, on: false },
        })),
        ...NEXT_NETWORKS.map((name) => ({
          key: name.toLowerCase(),
          label: name,
          icon: CircleDashed,
          href: null,
          badge: { words: S.soon, on: false },
        })),
      ],
    },
    {
      label: S.menu.more,
      rows: [
        ...(mine
          ? [
              {
                key: 'computer',
                label: P.computer,
                icon: Laptop,
                href: partHref('computer'),
                active: part === 'computer',
              },
            ]
          : []),
        // The business's, not the person's shown.
        ...(canStartFresh
          ? [
              {
                key: 'fresh',
                label: P.fresh,
                icon: RotateCcw,
                href: partHref('fresh', false),
                active: part === 'fresh',
                danger: true,
              },
            ]
          : []),
      ],
    },
  ];
  const current = groups.flatMap((g) => g.rows).find((r) => r.active);
  return (
    <>
      <Select
        className="md:hidden"
        aria-label={W.tabs.settings}
        value={current?.href ?? ''}
        onChange={(e) => router.push(e.target.value)}
        data-testid="outreach-settings-picker"
      >
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.rows.map((r) => (
              <option key={r.key} value={r.href ?? r.key} disabled={r.href === null}>
                {r.badge ? `${r.label} · ${r.badge.words}` : r.label}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
      <nav
        aria-label={W.tabs.settings}
        className="flex flex-col gap-0.5 max-md:hidden md:sticky md:top-4 md:self-start"
      >
        {groups.map((g, i) => (
          <div key={g.label} className="flex flex-col gap-0.5">
            <div
              className={cn(
                'px-2.5 pb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3',
                i > 0 && 'pt-3',
              )}
            >
              {g.label}
            </div>
            {g.rows.map((r) => {
              const Icon = r.icon;
              const inside = (
                <>
                  <Icon className="h-4 w-4 flex-none" strokeWidth={1.5} />
                  <span className="min-w-0 truncate">{r.label}</span>
                  {r.href === null ? (
                    <span className="ml-auto text-[12px] font-normal">{r.badge?.words}</span>
                  ) : r.badge ? (
                    <Badge
                      variant={r.badge.on ? 'ok' : 'gray'}
                      className="ml-auto"
                      data-testid={`outreach-settings-part-${r.key}-state`}
                    >
                      {r.badge.words}
                    </Badge>
                  ) : null}
                </>
              );
              const row =
                'flex h-9 items-center gap-2.5 rounded-control px-2.5 text-[14px] font-medium';
              return r.href === null ? (
                <div
                  key={r.key}
                  aria-disabled="true"
                  className={cn(row, 'cursor-default text-text-3')}
                  data-testid={`outreach-settings-soon-${r.key}`}
                >
                  {inside}
                </div>
              ) : (
                <Link
                  key={r.key}
                  href={r.href}
                  aria-current={r.active ? 'page' : undefined}
                  data-testid={`outreach-settings-part-${r.key}`}
                  className={cn(
                    row,
                    'transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                    r.active
                      ? 'bg-accent-soft text-accent-text'
                      : r.danger
                        ? 'text-danger-text hover:bg-card-2'
                        : 'text-text-2 hover:bg-card-2 hover:text-text',
                  )}
                >
                  {inside}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}

/** The list a People page shows, as People's views know it. */
function peopleListShown(shown: OutreachShown): PeopleList | null {
  switch (shown.view) {
    case 'pipeline':
      return { list: 'stages', show: shown.show };
    case 'friends':
      return { list: 'friends', show: shown.show };
    case 'chats':
      return { list: 'chats' };
    case 'partners':
      return { list: 'partners' };
    case 'skipped':
      return { list: 'country' };
    default:
      return null;
  }
}

/** A list's address: the board for in play, a stage, a friends list, the chats, the partners or Skipped for country. */
function peopleHref(workspaceId: string, at: PeopleList): string {
  switch (at.list) {
    case 'stages':
      return outreachHref(workspaceId, { view: 'pipeline', stages: at.show });
    case 'friends':
      return outreachHref(workspaceId, { view: 'friends', show: at.show });
    case 'chats':
      return outreachHref(workspaceId, { view: 'chats' });
    case 'partners':
      return outreachHref(workspaceId, { view: 'partners' });
    case 'country':
      return outreachHref(workspaceId, { view: 'skipped' });
  }
}

/**
 * People's views (decision 128): one row for the one list, each view one of the lists HandsFreeOS keeps; and under
 * Left alone, a row of its own lists.
 */
function PeopleViews({ workspaceId, shown }: { workspaceId: string; shown: OutreachShown }) {
  const list = peopleListShown(shown);
  if (!list) return null;
  const at = peopleViewOf(list);
  const counts = peopleCountsOf(
    shown.view === 'friends'
      ? { friends: shown.friends.counts }
      : shown.view === 'pipeline'
        ? { stages: shown.pipeline.counts }
        : null,
  );
  return (
    <div className="mb-4 space-y-2">
      <LinkSegments
        label={PV.label}
        items={PEOPLE_VIEW_KEYS.map((v) => ({
          href: peopleHref(workspaceId, peopleListOf(v)),
          label: PEOPLE_VIEWS[v],
          active: at.view === v,
          testId: `people-view-${v}`,
          count: counts[v],
        }))}
      />
      {at.alone ? (
        <div className="space-y-1.5">
          <LinkSegments
            label={PV.leftAloneLabel}
            items={LEFT_ALONE_KEYS.map((k) => ({
              href: peopleHref(workspaceId, peopleListOf(k)),
              label: LEFT_ALONE[k],
              active: at.alone === k,
              testId: `people-alone-${k}`,
              count: counts[k],
            }))}
          />
          <p className="text-[12.5px] text-text-3">{PV.leftAloneAbout}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The network picker at the top of Today and People's lists (decision 127): on Today, the networks the person works,
 * whose list shows; on a list, every network or one. Each choice keeps what else the page shows, from its first page.
 * Null on the pages it doesn't narrow: Needs you never hides what waits.
 */
function networkPickerOf(
  workspaceId: string,
  shown: OutreachShown,
): Omit<ComponentProps<typeof NetworkPicker>, 'workspaceId'> | null {
  const at = (to: Parameters<typeof outreachHref>[1]) => (net: Platform | null) =>
    outreachHref(workspaceId, { ...to, ...(net ? { net } : {}) });
  switch (shown.view) {
    case 'today':
      return shown.networks.length > 1
        ? {
            value: shown.platform,
            networks: shown.networks.map((n) => n.platform),
            every: false,
            hrefOf: at({ view: 'today' }),
          }
        : null;
    case 'pipeline':
      return {
        value: shown.net,
        networks: WORKING_PLATFORMS,
        every: true,
        hrefOf: at({ view: 'pipeline', stages: shown.show, search: shown.search }),
      };
    case 'friends':
      return {
        value: shown.net,
        networks: WORKING_PLATFORMS,
        every: true,
        hrefOf: at({ view: 'friends', show: shown.show, search: shown.search }),
      };
    case 'chats':
      return {
        value: shown.net,
        networks: WORKING_PLATFORMS,
        every: true,
        hrefOf: at({ view: 'chats', chats: shown.show, tag: shown.tag, search: shown.search }),
      };
    case 'partners':
      return {
        value: shown.net,
        networks: WORKING_PLATFORMS,
        every: true,
        hrefOf: at({ view: 'partners', partners: shown.show }),
      };
    case 'find':
      return {
        value: shown.net,
        networks: WORKING_PLATFORMS,
        every: true,
        hrefOf: at({ view: 'find' }),
      };
    default:
      return null;
  }
}

export function OutreachHome({
  workspaceId,
  businessName,
  shown,
  canManage,
  canStartFresh = false,
}: {
  workspaceId: string;
  businessName: string;
  shown: OutreachShown;
  /** Owners and admins write the playbooks and see everyone's activity. */
  canManage: boolean;
  /** An owner, who may erase everything and start fresh: for Settings' menu. */
  canStartFresh?: boolean;
}) {
  // A group's own page sits under Groups.
  const view: OutreachView = shown.view === 'group' ? 'groups' : shown.view;
  const page = pageOf(view);
  const asks =
    'asks' in shown && shown.view !== 'today' && shown.view !== 'pipeline' ? shown.asks : null;
  const picker = networkPickerOf(workspaceId, shown);
  return (
    <div data-testid="outreach-home" data-page={page}>
      <p className="mb-1 text-[12.5px] font-medium text-text-3">{W.title}</p>
      <PageHeader
        title={OUTREACH_PAGES[page]}
        description={OUTREACH_PAGE_ABOUT[page]}
        actions={picker ? <NetworkPicker workspaceId={workspaceId} {...picker} /> : undefined}
      />
      <SetupBanner workspaceId={workspaceId} />
      {page === 'people' ? <PeopleViews workspaceId={workspaceId} shown={shown} /> : null}
      {page === 'find' ? (
        <div className="mb-4">
          <LinkSegments
            label={OUTREACH_PAGES.find}
            items={[
              {
                href: outreachHref(workspaceId, { view: 'find' }),
                label: W.findParts.ways,
                active: shown.view === 'find',
                testId: 'find-part-ways',
              },
              {
                href: outreachHref(workspaceId, { view: 'groups' }),
                label: W.findParts.groups,
                active: shown.view === 'groups' || shown.view === 'group',
                testId: 'find-part-groups',
              },
            ]}
          />
        </div>
      ) : null}
      {/* Why the buttons that ask the computer wait: once, not on every card. */}
      {asks ? <ComputerNote asks={asks} className="mb-4" /> : null}
      {shown.view === 'settings' ? (
        <div className="grid gap-x-8 gap-y-5 md:grid-cols-[220px_minmax(0,1fr)]">
          <SettingsMenu
            workspaceId={workspaceId}
            part={shown.part}
            whose={shown.mine ? null : shown.me.userId}
            mine={shown.mine}
            canStartFresh={canStartFresh}
            networks={networksOn(shown.me.settings, shown.me.rules.networksAllowed)}
          />
          <div className="min-w-0 max-w-3xl">
            <SettingsView
              workspaceId={workspaceId}
              part={shown.part}
              me={shown.me}
              mine={shown.mine}
              people={shown.people}
              business={shown.business}
              canStartFresh={shown.canStartFresh}
              live={shown.live}
              extensionLink={shown.extensionLink}
              asks={shown.asks ?? null}
              readiness={shown.readiness ?? null}
            />
          </div>
        </div>
      ) : shown.view === 'playbooks' ? (
        <div className="max-w-3xl">
          <PlaybooksView
            workspaceId={workspaceId}
            list={shown.list}
            openers={shown.openers}
            canManage={canManage}
          />
        </div>
      ) : shown.view === 'needs' ? (
        <NeedsYou workspaceId={workspaceId} waiting={shown.waiting} />
      ) : shown.view === 'today' ? (
        <TodayView
          workspaceId={workspaceId}
          platform={shown.platform}
          networks={shown.networks}
          today={shown.today}
          helpful={shown.helpful}
          wheels={shown.wheels}
          team={shown.team}
          asks={shown.asks}
          waiting={shown.waiting}
          readiness={shown.readiness}
          canManage={canManage}
        />
      ) : shown.view === 'results' ? (
        <ActivityView
          workspaceId={workspaceId}
          activity={shown.activity}
          tracking={shown.tracking}
          period={shown.period}
          canManage={canManage}
        />
      ) : shown.view === 'pipeline' ? (
        <PipelineView
          workspaceId={workspaceId}
          pipeline={shown.pipeline}
          board={shown.board}
          show={shown.show}
          search={shown.search}
          net={shown.net}
          asks={shown.asks}
        />
      ) : shown.view === 'groups' ? (
        <GroupsView
          workspaceId={workspaceId}
          groups={shown.groups}
          show={shown.show}
          search={shown.search}
          asks={shown.asks}
          searchWords={shown.searchWords}
        />
      ) : shown.view === 'group' ? (
        <GroupPage
          workspaceId={workspaceId}
          groupId={shown.groupId}
          people={shown.people}
          problem={shown.problem}
          outcome={shown.outcome}
        />
      ) : shown.view === 'friends' ? (
        <FriendsView
          workspaceId={workspaceId}
          businessName={businessName}
          friends={shown.friends}
          tidy={shown.tidy}
          show={shown.show}
          search={shown.search}
          net={shown.net}
          asks={shown.asks}
        />
      ) : shown.view === 'chats' ? (
        <ChatsView
          workspaceId={workspaceId}
          chats={shown.chats}
          show={shown.show}
          tag={shown.tag}
          search={shown.search}
          net={shown.net}
          canManage={canManage}
          asks={shown.asks}
        />
      ) : shown.view === 'find' ? (
        <FindView
          workspaceId={workspaceId}
          week={shown.week}
          groups={shown.groups}
          playbooks={shown.playbooks}
          asks={shown.asks}
          net={shown.net}
        />
      ) : shown.view === 'skipped' ? (
        <SkippedCountryCard workspaceId={workspaceId} />
      ) : shown.view === 'partners' ? (
        <PartnersView
          workspaceId={workspaceId}
          partners={shown.partners}
          show={shown.show}
          net={shown.net}
          page={shown.page}
        />
      ) : null}
    </div>
  );
}
