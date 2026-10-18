'use client';
/**
 * Social Outreach's page (docs/outreach.md): four tabs and the gear (decision 59), each view with its own address
 * (./address.ts), so a link, a push or the builder's way back opens the one it's about.
 *
 * - **Today**: what the person's computer is doing with Start my day and Stop for today, everything that needs them
 *   (decision 42's list), and their list for the day; `?view=live` is the full detail of their computer's day.
 * - **People**: everyone reached by where they stand (the board, or one stage), their friends and the Don't pitch list,
 *   their chats as the AI read them, and their Partners list (decision 81).
 * - **Groups**: the groups saved and how they fit.
 * - **Results**: from reached to booked, by group and by person.
 * - **Settings**: a menu beside a page for each part (decision 73): General, then each network (its On or Off for the
 *   person shown, and the networks still to come), then the business's playbooks, the person's computer, and Start
 *   fresh for owners. On a phone the menu is a list to pick from, above the page.
 *
 * The page asks HandsFreeOS for what the view shows (`app/w/[workspaceId]/a/outreach/page.tsx`), with what the person
 * asked their computer to do on it: the buttons on People, Groups and Today ask the computer (./asks.tsx), and why
 * they wait is said once, under the tabs.
 */
import type { ActivityPeriod } from '@hfos/core/addons/outreach/activity';
import type { ChatView } from '@hfos/core/addons/outreach/chat-read';
import type { FriendView } from '@hfos/core/addons/outreach/friends';
import type { GroupView } from '@hfos/core/addons/outreach/groups';
import { networksOn } from '@hfos/core/addons/outreach/network-words';
import { PLATFORM_KEYS, PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import type { PartnerView } from '@hfos/core/addons/outreach/partners';
import {
  NEXT_NETWORKS,
  SETTINGS_WORDS as S,
  type SettingsPart,
} from '@hfos/core/addons/outreach/settings-parts';
import type { StageView } from '@hfos/core/addons/outreach/stages';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import {
  BookOpen,
  CircleDashed,
  Globe,
  Laptop,
  RotateCcw,
  Settings,
  SlidersHorizontal,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ComponentType } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ActivityView } from './activity-view';
import { OUTREACH_TABS, outreachHref, TAB_VIEW, tabOf, type OutreachView } from './address';
import { ComputerNote } from './asks';
import { ChatsView } from './chats-view';
import { FriendsView } from './friends-view';
import { GroupsView } from './groups-view';
import { LiveView } from './live-view';
import type { Board } from './board';
import { PartnersView } from './partners-view';
import { PipelineView } from './pipeline-view';
import { PlaybooksView } from './playbooks-page';
import { SettingsView } from './settings-page';
import { SetupBanner } from './setup-view';
import type { NetworkLive } from './status-strip';
import { TodayView } from './today-view';
import type {
  Activity,
  Asks,
  Automation,
  AutomationPeople,
  Chats,
  Friends,
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
      readonly asks: Asks;
      /** Everything that needs the person: null when it couldn't be had. */
      readonly waiting: Waiting | null;
      /** What's left before the extension reaches anyone for them (decision 63): null once they're ready. */
      readonly readiness: Readiness | null;
    }
  | {
      readonly view: 'live';
      readonly live: Live;
      readonly team: LiveTeam | null;
      readonly asks: Asks;
      /** The network whose day it shows, of those the person works. */
      readonly platform: Platform;
      readonly networks: readonly Platform[];
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
      readonly view: 'groups';
      readonly groups: Groups;
      readonly show: GroupView;
      readonly search: string;
      readonly asks: Asks;
      /** Find groups' box starts with these. */
      readonly searchWords: string;
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

/** A row of links that looks like a segmented control: People's lists. */
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
 * The Settings tab's menu (decision 73, the "Social Outreach settings by platform" design): Settings with General;
 * Networks, each with whether it's on for the person shown (left out when the page doesn't know, as on Playbooks),
 * then the networks still to come; and More: Playbooks, Your computer (their own) and Start fresh (an owner's). A part
 * keeps whose settings an owner or admin is looking at. On a phone it's a list to pick from, above the page.
 */
function SettingsMenu({
  workspaceId,
  view,
  part,
  whose,
  mine,
  canStartFresh,
  networks,
}: {
  workspaceId: string;
  view: OutreachView;
  /** The part shown, on the settings view. */
  part: SettingsPart | null;
  /** Someone else's id, when an owner or admin is looking at theirs. */
  whose: string | null;
  mine: boolean;
  canStartFresh: boolean;
  /** The networks on for the person shown: null when it isn't known here. */
  networks: readonly Platform[] | null;
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
          badge: networks
            ? networks.includes(p)
              ? { words: S.on, on: true }
              : { words: S.off, on: false }
            : null,
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
        {
          key: 'playbooks',
          label: P.playbooks,
          icon: BookOpen,
          href: outreachHref(workspaceId, { view: 'playbooks' }),
          active: view === 'playbooks',
        },
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

export function OutreachHome({
  workspaceId,
  businessName,
  shown,
  canManage,
  canStartFresh = false,
  waitingCount = null,
}: {
  workspaceId: string;
  businessName: string;
  shown: OutreachShown;
  /** Owners and admins write the playbooks and see everyone's activity. */
  canManage: boolean;
  /** An owner, who may erase everything and start fresh: for the Settings tab's menu. */
  canStartFresh?: boolean;
  /** How many things need the person, on the Today tab: null when it couldn't be had. */
  waitingCount?: number | null;
}) {
  const tab = tabOf(shown.view);
  const count = shown.view === 'today' && shown.waiting ? shown.waiting.count : waitingCount;
  const asks =
    'asks' in shown && shown.view !== 'today' && shown.view !== 'live' && shown.view !== 'pipeline'
      ? shown.asks
      : null;
  return (
    <div data-testid="outreach-home">
      <PageHeader title={W.title} description={W.pageAbout} />
      <nav
        aria-label={W.title}
        className="mb-5 flex gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:none]"
      >
        {OUTREACH_TABS.map((t) => {
          const active = t === tab;
          return (
            <Link
              key={t}
              href={outreachHref(workspaceId, { view: TAB_VIEW[t] })}
              aria-current={active ? 'page' : undefined}
              data-testid={`outreach-tab-${t}`}
              className={cn(
                '-mb-px flex h-10 flex-none items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors max-md:h-11',
                t === 'settings' && 'ml-auto',
                active
                  ? 'border-accent text-accent-text'
                  : 'border-transparent text-text-2 hover:text-text',
              )}
            >
              {t === 'settings' ? (
                <Settings className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
              ) : null}
              <span className={cn(t === 'settings' && 'max-md:sr-only')}>{W.tabs[t]}</span>
              {t === 'today' && count ? (
                <span
                  className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold tabular-nums text-white"
                  data-testid="outreach-tab-today-count"
                >
                  {count.toLocaleString()}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <SetupBanner workspaceId={workspaceId} />
      {tab === 'people' ? (
        <div className="mb-4">
          <LinkSegments
            label={W.tabs.people}
            items={(['pipeline', 'friends', 'chats', 'partners'] as const).map((v) => ({
              href: outreachHref(workspaceId, { view: v }),
              label: W.peopleParts[v],
              active: shown.view === v,
              testId: `outreach-people-${v}`,
            }))}
          />
        </div>
      ) : null}
      {/* Why the buttons that ask the computer wait: once, not on every card. */}
      {asks ? <ComputerNote asks={asks} className="mb-4" /> : null}
      {tab === 'settings' ? (
        <div className="grid gap-x-8 gap-y-5 md:grid-cols-[220px_minmax(0,1fr)]">
          {shown.view === 'settings' ? (
            <SettingsMenu
              workspaceId={workspaceId}
              view={shown.view}
              part={shown.part}
              whose={shown.mine ? null : shown.me.userId}
              mine={shown.mine}
              canStartFresh={canStartFresh}
              networks={networksOn(shown.me.settings, shown.me.rules.networksAllowed)}
            />
          ) : (
            <SettingsMenu
              workspaceId={workspaceId}
              view={shown.view}
              part={null}
              whose={null}
              mine
              canStartFresh={canStartFresh}
              networks={null}
            />
          )}
          <div className="min-w-0 max-w-3xl">
            {shown.view === 'settings' ? (
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
            ) : shown.view === 'playbooks' ? (
              <PlaybooksView
                workspaceId={workspaceId}
                list={shown.list}
                openers={shown.openers}
                canManage={canManage}
              />
            ) : null}
          </div>
        </div>
      ) : shown.view === 'today' ? (
        <TodayView
          workspaceId={workspaceId}
          platform={shown.platform}
          networks={shown.networks}
          today={shown.today}
          helpful={shown.helpful}
          wheels={shown.wheels}
          asks={shown.asks}
          waiting={shown.waiting}
          readiness={shown.readiness}
        />
      ) : shown.view === 'live' ? (
        <LiveView
          workspaceId={workspaceId}
          live={shown.live}
          team={shown.team}
          asks={shown.asks}
          platform={shown.platform}
          networks={shown.networks}
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
