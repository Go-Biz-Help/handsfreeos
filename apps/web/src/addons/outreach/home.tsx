'use client';
/**
 * Social Outreach's page (docs/outreach.md): four tabs and the gear (decision 59), each view with its own address
 * (./address.ts), so a link, a push or the builder's way back opens the one it's about.
 *
 * - **Today**: what the person's computer is doing with Start my day and Stop for today, everything that needs them
 *   (decision 42's list), and their list for the day; `?view=live` is the full detail of their computer's day.
 * - **People**: everyone reached by where they stand (the board, or one stage), their friends and the Don't pitch list,
 *   and their chats as the AI read them.
 * - **Groups**: the groups saved and how they fit.
 * - **Results**: from reached to booked, by group and by person.
 * - **Settings**: every setting the extension follows, the business's playbooks, the person's computers, and Start
 *   fresh for owners.
 *
 * The page asks HandsFreeOS for what the view shows (`app/w/[workspaceId]/a/outreach/page.tsx`), with what the person
 * asked their computer to do on it: the buttons on People, Groups and Today ask the computer (./asks.tsx), and why
 * they wait is said once, under the tabs.
 */
import type { ActivityPeriod } from '@hfos/core/addons/outreach/activity';
import type { ChatView } from '@hfos/core/addons/outreach/chat-read';
import type { FriendView } from '@hfos/core/addons/outreach/friends';
import type { GroupView } from '@hfos/core/addons/outreach/groups';
import type { StageView } from '@hfos/core/addons/outreach/stages';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { Settings } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/shell/page-header';
import { cn } from '@/lib/utils';
import { ActivityView } from './activity-view';
import { OUTREACH_TABS, outreachHref, TAB_VIEW, tabOf, type OutreachView } from './address';
import { ComputerNote } from './asks';
import { ChatsView } from './chats-view';
import { FriendsView } from './friends-view';
import { GroupsView } from './groups-view';
import { LiveView } from './live-view';
import type { Board } from './board';
import { PipelineView } from './pipeline-view';
import { PlaybooksView } from './playbooks-page';
import { SettingsView } from './settings-view';
import { SetupBanner } from './setup-view';
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
  Pipeline,
  PlaybookList,
  Tidy,
  TodayList,
  Waiting,
  WheelsList,
} from './types';

export type OutreachShown =
  | {
      readonly view: 'today';
      readonly today: TodayList;
      readonly helpful: HelpfulList;
      readonly wheels: WheelsList | null;
      readonly asks: Asks;
      /** What the person's computer is doing: null when it couldn't be had. */
      readonly live: Live | null;
      /** Everything that needs the person: null when it couldn't be had. */
      readonly waiting: Waiting | null;
    }
  | {
      readonly view: 'live';
      readonly live: Live;
      readonly team: LiveTeam | null;
      readonly asks: Asks;
    }
  | { readonly view: 'results'; readonly activity: Activity; readonly period: ActivityPeriod }
  | {
      readonly view: 'pipeline';
      readonly pipeline: Pipeline;
      /** Everyone in play by stage, side by side: on the bare People tab, not for one stage or a search. */
      readonly board: Board | null;
      readonly show: StageView;
      readonly search: string;
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
      readonly asks: Asks;
    }
  | {
      readonly view: 'chats';
      readonly chats: Chats;
      readonly show: ChatView;
      readonly tag: string;
      readonly search: string;
      readonly asks: Asks;
    }
  | { readonly view: 'playbooks'; readonly list: PlaybookList; readonly openers: Openers }
  | {
      readonly view: 'settings';
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
    };

/** A row of links that looks like a segmented control: People's three lists. */
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

function SettingsMenu({
  workspaceId,
  view,
  canManage,
  canStartFresh,
}: {
  workspaceId: string;
  view: OutreachView;
  canManage: boolean;
  canStartFresh: boolean;
}) {
  const P = W.settingsParts;
  const settings = outreachHref(workspaceId, { view: 'settings' });
  const row = (key: string, href: string, label: string, active: boolean, danger = false) => (
    <Link
      key={key}
      href={href}
      aria-current={active ? 'page' : undefined}
      data-testid={`outreach-settings-part-${key}`}
      className={cn(
        'flex h-9 flex-none items-center whitespace-nowrap rounded-control px-2.5 text-[14px] font-medium transition-colors max-md:h-11',
        active
          ? 'bg-accent-soft text-accent-text'
          : danger
            ? 'text-danger-text hover:bg-card-2'
            : 'text-text-2 hover:bg-card-2 hover:text-text',
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav
      aria-label={W.tabs.settings}
      className="flex gap-0.5 overflow-x-auto md:sticky md:top-4 md:flex-col md:self-start"
    >
      {row('mine', `${settings}#mine`, P.mine, view === 'settings')}
      {canManage ? row('business', `${settings}#business`, P.business, false) : null}
      {row(
        'playbooks',
        outreachHref(workspaceId, { view: 'playbooks' }),
        P.playbooks,
        view === 'playbooks',
      )}
      {row('computer', `${settings}#computer`, P.computer, false)}
      {canStartFresh ? row('fresh', `${settings}#fresh`, P.fresh, false, true) : null}
    </nav>
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
            items={(['pipeline', 'friends', 'chats'] as const).map((v) => ({
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
        <div className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
          <SettingsMenu
            workspaceId={workspaceId}
            view={shown.view}
            canManage={canManage}
            canStartFresh={canStartFresh}
          />
          <div className="min-w-0">
            {shown.view === 'settings' ? (
              <SettingsView
                workspaceId={workspaceId}
                me={shown.me}
                mine={shown.mine}
                people={shown.people}
                business={shown.business}
                canStartFresh={shown.canStartFresh}
                live={shown.live}
                extensionLink={shown.extensionLink}
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
          today={shown.today}
          helpful={shown.helpful}
          wheels={shown.wheels}
          asks={shown.asks}
          live={shown.live}
          waiting={shown.waiting}
        />
      ) : shown.view === 'live' ? (
        <LiveView workspaceId={workspaceId} live={shown.live} team={shown.team} asks={shown.asks} />
      ) : shown.view === 'results' ? (
        <ActivityView
          workspaceId={workspaceId}
          activity={shown.activity}
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
          asks={shown.asks}
        />
      ) : shown.view === 'chats' ? (
        <ChatsView
          workspaceId={workspaceId}
          chats={shown.chats}
          show={shown.show}
          tag={shown.tag}
          search={shown.search}
          canManage={canManage}
          asks={shown.asks}
        />
      ) : null}
    </div>
  );
}
