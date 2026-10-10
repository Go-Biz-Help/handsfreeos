'use client';
/**
 * Social Outreach's page (docs/outreach.md): the activity the browser extension noted, what it's doing right now
 * with Start my day and Stop for today (Live), the person's list for today,
 * the groups saved and how they fit, the person's friends and the Don't pitch list, their chats as the AI read them, the business's playbooks, and
 * every setting the extension follows, each a tab with its own address (./address.ts), so a link or the
 * builder's way back opens the one it's about. The page asks HandsFreeOS for what the tab shows
 * (`app/w/[workspaceId]/a/outreach/page.tsx`).
 */
import type { ActivityPeriod } from '@hfos/core/addons/outreach/activity';
import type { ChatView } from '@hfos/core/addons/outreach/chat-read';
import type { FriendView } from '@hfos/core/addons/outreach/friends';
import type { GroupView } from '@hfos/core/addons/outreach/groups';
import Link from 'next/link';
import { PageHeader } from '@/components/shell/page-header';
import { cn } from '@/lib/utils';
import { ActivityView } from './activity-view';
import { outreachHref } from './address';
import { ChatsView } from './chats-view';
import { FriendsView } from './friends-view';
import { GroupsView } from './groups-view';
import { LiveView } from './live-view';
import { PlaybooksView } from './playbooks-page';
import { SettingsView } from './settings-view';
import { TodayView } from './today-view';
import type {
  Activity,
  Automation,
  AutomationPeople,
  Chats,
  Friends,
  Groups,
  Live,
  LiveTeam,
  Openers,
  PlaybookList,
  Tidy,
  TodayList,
  WheelsList,
} from './types';

export type OutreachShown =
  | { readonly view: 'activity'; readonly activity: Activity; readonly period: ActivityPeriod }
  | { readonly view: 'live'; readonly live: Live; readonly team: LiveTeam | null }
  | { readonly view: 'today'; readonly today: TodayList; readonly wheels: WheelsList | null }
  | {
      readonly view: 'groups';
      readonly groups: Groups;
      readonly show: GroupView;
      readonly search: string;
    }
  | {
      readonly view: 'friends';
      readonly friends: Friends;
      readonly tidy: Tidy;
      readonly show: FriendView;
      readonly search: string;
    }
  | {
      readonly view: 'chats';
      readonly chats: Chats;
      readonly show: ChatView;
      readonly tag: string;
      readonly search: string;
    }
  | { readonly view: 'playbooks'; readonly list: PlaybookList; readonly openers: Openers }
  | {
      readonly view: 'settings';
      readonly me: Automation;
      readonly mine: boolean;
      readonly people: AutomationPeople | null;
      readonly business: Readonly<Record<string, unknown>> | null;
    };

const TABS = [
  { view: 'activity', label: 'Activity' },
  { view: 'live', label: 'Live' },
  { view: 'today', label: 'Today' },
  { view: 'groups', label: 'Groups' },
  { view: 'friends', label: 'Friends' },
  { view: 'chats', label: 'Chats' },
  { view: 'playbooks', label: 'Playbooks' },
  { view: 'settings', label: 'Settings' },
] as const;

export function OutreachHome({
  workspaceId,
  businessName,
  shown,
  canManage,
}: {
  workspaceId: string;
  businessName: string;
  shown: OutreachShown;
  /** Owners and admins write the playbooks and see everyone's activity. */
  canManage: boolean;
}) {
  return (
    <div data-testid="outreach-home">
      <PageHeader
        title="Social Outreach"
        description={`${businessName} · finding and following up with people on Facebook`}
      />
      <nav aria-label="Social Outreach" className="mb-4 flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => {
          const active = t.view === shown.view;
          return (
            <Link
              key={t.view}
              href={outreachHref(workspaceId, { view: t.view })}
              aria-current={active ? 'page' : undefined}
              data-testid={`outreach-tab-${t.view}`}
              className={cn(
                'inline-flex h-8 flex-none items-center rounded-full border px-3 text-[13px] font-medium transition-colors max-md:h-11 max-md:px-4',
                active
                  ? 'border-transparent bg-accent-soft text-accent-text'
                  : 'border-border-strong bg-card text-text-2 hover:text-text',
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {shown.view === 'activity' ? (
        <ActivityView
          workspaceId={workspaceId}
          businessName={businessName}
          activity={shown.activity}
          period={shown.period}
          canManage={canManage}
        />
      ) : shown.view === 'live' ? (
        <LiveView workspaceId={workspaceId} live={shown.live} team={shown.team} />
      ) : shown.view === 'today' ? (
        <TodayView workspaceId={workspaceId} today={shown.today} wheels={shown.wheels} />
      ) : shown.view === 'groups' ? (
        <GroupsView
          workspaceId={workspaceId}
          groups={shown.groups}
          show={shown.show}
          search={shown.search}
        />
      ) : shown.view === 'friends' ? (
        <FriendsView
          workspaceId={workspaceId}
          businessName={businessName}
          friends={shown.friends}
          tidy={shown.tidy}
          show={shown.show}
          search={shown.search}
        />
      ) : shown.view === 'chats' ? (
        <ChatsView
          workspaceId={workspaceId}
          chats={shown.chats}
          show={shown.show}
          tag={shown.tag}
          search={shown.search}
          canManage={canManage}
        />
      ) : shown.view === 'settings' ? (
        <SettingsView
          workspaceId={workspaceId}
          me={shown.me}
          mine={shown.mine}
          people={shown.people}
          business={shown.business}
        />
      ) : (
        <PlaybooksView
          workspaceId={workspaceId}
          list={shown.list}
          openers={shown.openers}
          canManage={canManage}
        />
      )}
    </div>
  );
}
