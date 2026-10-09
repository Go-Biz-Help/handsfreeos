'use client';
/**
 * Social Outreach's activity tab (docs/outreach.md, decision 7): what the browser extension noted as people worked on
 * Facebook (apps/extension/README.md, "What it notes"), over a stretch of days. How many people were reached and how,
 * by the group they were found in and person by person, and the person's own day against the daily limits. Owners and
 * admins can see the whole team's. The stretch and whose are in the address (./address.ts), so the page asks
 * HandsFreeOS for them and Back still works.
 */
import {
  ACTIVITY_PERIOD_KEYS,
  ACTIVITY_PERIODS,
  type ActivityPeriod,
} from '@hfos/core/addons/outreach/activity';
import { DAILY_STEPS, DAILY_WORDS, pastLimitWords } from '@hfos/core/addons/outreach/limits';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { cn, relativeTime } from '@/lib/utils';
import { outreachHref } from './address';
import type { Activity } from './types';

type Numbers = Activity['numbers'];
type Group = Activity['groups'][number];
type Person = Activity['people'][number];

/** The numbers across the top: who was reached, then how. */
const NUMBERS: readonly { readonly key: keyof Numbers; readonly label: string }[] = [
  { key: 'people', label: 'People reached' },
  { key: 'friendRequests', label: 'Friend requests' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'chatsStarted', label: 'Chats started' },
  { key: 'followUps', label: 'Follow-ups' },
  { key: 'replies', label: 'Wrote back' },
];

/** How far someone has come, a step at a time. */
const STEPS: readonly {
  readonly key: 'requestedAt' | 'likedAt' | 'commentedAt' | 'messagedAt' | 'repliedAt';
  readonly label: string;
}[] = [
  { key: 'requestedAt', label: 'Friend request' },
  { key: 'likedAt', label: 'Liked' },
  { key: 'commentedAt', label: 'Commented' },
  { key: 'messagedAt', label: 'Messaged' },
  { key: 'repliedAt', label: 'Wrote back' },
];

/** "today", "in the last 7 days". */
const within = (period: ActivityPeriod) =>
  period === 'today' ? 'today' : `in the ${ACTIVITY_PERIODS[period].label.toLowerCase()}`;

/** A group's name, or the end of its link until the extension has seen its name. */
const groupName = (g: { readonly name: string | null; readonly url: string }) =>
  g.name ?? `Group ${new URL(g.url).pathname.split('/')[2] ?? ''}`.trim();

export function ActivityView({
  workspaceId,
  businessName,
  activity,
  period,
  canManage,
}: {
  workspaceId: string;
  businessName: string;
  activity: Activity;
  period: ActivityPeriod;
  /** Owners and admins can see everyone's steps. */
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (to: { period?: ActivityPeriod; everyone?: boolean }) =>
    startTransition(() =>
      router.replace(
        outreachHref(workspaceId, {
          period: to.period ?? period,
          everyone: to.everyone ?? activity.everyone,
        }),
        { scroll: false },
      ),
    );
  const nothing = activity.numbers.people === 0 && activity.people.length === 0;
  return (
    <div data-testid="outreach-activity">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel="How far back"
          value={period}
          onChange={(p) => go({ period: p })}
          options={ACTIVITY_PERIOD_KEYS.map((k) => ({
            value: k,
            label: ACTIVITY_PERIODS[k].label,
            testId: `activity-period-${k}`,
          }))}
        />
        {canManage ? (
          <Segmented
            ariaLabel="Whose steps"
            value={activity.everyone ? 'everyone' : 'you'}
            onChange={(who) => go({ everyone: who === 'everyone' })}
            options={[
              { value: 'you', label: 'You', testId: 'activity-who-you' },
              { value: 'everyone', label: 'Everyone', testId: 'activity-who-everyone' },
            ]}
          />
        ) : null}
      </div>
      <div
        className={cn('space-y-4 transition-opacity', pending && 'opacity-60')}
        aria-busy={pending || undefined}
      >
        {nothing ? null : <NumbersRow numbers={activity.numbers} />}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-4">
            {nothing ? (
              <Card data-testid="activity-empty">
                <EmptyState title={`Nothing noted ${within(period)}`}>
                  When {activity.everyone ? 'your team sends' : 'you send'} friend requests, likes,
                  comments and messages on Facebook with HandsFreeOS Social signed in, they show up
                  here.
                </EmptyState>
              </Card>
            ) : (
              <>
                <GroupsCard groups={activity.groups} />
                <PeopleCard
                  workspaceId={workspaceId}
                  people={activity.people}
                  more={activity.morePeople}
                />
              </>
            )}
          </div>
          <aside className="space-y-4">
            <DayCard today={activity.today} limits={activity.limits} warning={activity.warning} />
            <Card className="p-4">
              <h3 className="text-[15px] font-semibold">The browser extension</h3>
              <p className="mt-1.5 text-[13px] text-text-2">
                HandsFreeOS Social works beside you on Facebook. Sign in to it with your HandsFreeOS
                email and pick {businessName}. It notes the friend requests, likes, comments and
                messages you send, with the group you found each person in, and never what you
                wrote. Press <strong>Save to HandsFreeOS</strong> on a profile or a chat to add the
                person to Contacts. It’s a test build for now, loaded into Chrome by hand.
              </p>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}

function NumbersRow({ numbers }: { numbers: Numbers }) {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7"
      data-testid="activity-numbers"
    >
      {NUMBERS.map((n) => (
        <Card key={n.key} className="p-3.5" data-testid={`activity-number-${n.key}`}>
          <div className="text-[22px] font-semibold leading-tight tabular-nums">
            {numbers[n.key].toLocaleString()}
          </div>
          <div className="mt-0.5 text-[12.5px] text-text-2">{n.label}</div>
        </Card>
      ))}
    </div>
  );
}

function GroupsCard({ groups }: { groups: readonly Group[] }) {
  return (
    <Card className="overflow-x-auto p-0" data-testid="activity-groups">
      <div className="px-5 pt-4">
        <h3 className="text-[15px] font-semibold">By group</h3>
        <p className="text-[12.5px] text-text-3">Where the people reached were found.</p>
      </div>
      {groups.length ? (
        <table className="mt-2 w-full min-w-[600px] text-left text-[13.5px]">
          <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
            <tr>
              <th className="px-5 py-2.5 font-semibold">Group</th>
              <th className="px-3 py-2.5 text-right font-semibold">People</th>
              <th className="px-3 py-2.5 text-right font-semibold">Friend requests</th>
              <th className="px-3 py-2.5 text-right font-semibold">Liked or commented</th>
              <th className="px-3 py-2.5 text-right font-semibold">Chats started</th>
              <th className="px-5 py-2.5 text-right font-semibold">Wrote back</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr
                key={g.groupId}
                className="border-b border-border last:border-b-0"
                data-testid="activity-group"
              >
                <td className="px-5 py-2.5">
                  <a
                    href={g.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-accent-text hover:underline"
                  >
                    {groupName(g)}
                  </a>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{g.people}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{g.friendRequests}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{g.warmedUp}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{g.chatsStarted}</td>
                <td className="px-5 py-2.5 text-right tabular-nums">{g.replies}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-5 pb-4 pt-2 text-[13px] text-text-2">
          Nobody here was found in a group yet. A step on a group’s page or post, or with someone
          opened from a group’s members, is kept with that group.
        </p>
      )}
    </Card>
  );
}

function PeopleCard({
  workspaceId,
  people,
  more,
}: {
  workspaceId: string;
  people: readonly Person[];
  more: number;
}) {
  return (
    <Card className="p-0" data-testid="activity-people">
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
        <h3 className="text-[15px] font-semibold">People</h3>
        <span className="text-[12.5px] text-text-3">The latest first</span>
      </div>
      <ul className="mt-2">
        {people.map((p) => (
          <li
            key={p.profileId}
            className="border-t border-border px-5 py-3"
            data-testid="activity-person"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 text-[13.5px]">
                {p.personId ? (
                  <Link
                    href={`/app/w/${workspaceId}/customers/people/${p.personId}`}
                    className="font-medium text-accent-text hover:underline"
                  >
                    {p.name}
                  </Link>
                ) : (
                  <span className="font-medium">{p.name}</span>
                )}
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 text-[12.5px] text-text-3 hover:underline"
                >
                  Facebook
                </a>
                {p.group ? (
                  <div className="text-[12.5px] text-text-3">From {groupName(p.group)}</div>
                ) : null}
              </div>
              <span className="text-[12.5px] text-text-3">{relativeTime(p.lastAt)}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {STEPS.map((s) => {
                const at = p[s.key];
                return at ? (
                  <Badge
                    key={s.key}
                    variant={s.key === 'repliedAt' ? 'ok' : 'gray'}
                    title={new Date(at).toLocaleString()}
                  >
                    {s.label} · {relativeTime(at)}
                  </Badge>
                ) : null;
              })}
            </div>
          </li>
        ))}
      </ul>
      {more ? (
        <p className="border-t border-border px-5 py-3 text-[12.5px] text-text-3">
          And {more.toLocaleString()} more, not shown.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * The person's own day so far against the daily limits, whatever the stretch above shows: halved for a week after
 * Facebook warns them (docs/outreach.md, decision 25), with a red note saying so.
 */
function DayCard({
  today,
  limits,
  warning,
}: {
  today: Activity['today'];
  limits: Activity['limits'];
  warning: Activity['warning'];
}) {
  const past = pastLimitWords(today, limits);
  return (
    <Card className="p-4" data-testid="activity-today">
      <h3 className="text-[15px] font-semibold">Your day so far</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">
        Against the daily limits. Stay under them so Facebook doesn’t block your account.
      </p>
      {warning ? (
        <p
          role="alert"
          data-testid="activity-warning"
          className="mt-3 rounded-menu bg-danger-soft p-2.5 text-[12.5px] text-danger-text"
        >
          {warningNote(warning)}
        </p>
      ) : null}
      <ul className="mt-3 space-y-2.5">
        {DAILY_STEPS.map((step) => {
          const count = today[step];
          const limit = limits[step];
          const full = count >= limit;
          return (
            <li key={step} data-testid={`activity-today-${step}`}>
              <div className="flex items-baseline justify-between gap-2 text-[13px]">
                <span>{DAILY_WORDS[step].label}</span>
                <span
                  className={cn(
                    'tabular-nums',
                    full ? 'font-semibold text-warning-text' : 'text-text-2',
                  )}
                >
                  {count} of {limit}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-card-2" aria-hidden="true">
                <div
                  className={cn('h-full rounded-full', full ? 'bg-warning' : 'bg-accent')}
                  style={{ width: `${Math.min(100, Math.round((count / limit) * 100))}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {past ? (
        <p className="mt-3 rounded-menu bg-warning-soft p-2.5 text-[12.5px] text-warning-text">
          {past}
        </p>
      ) : null}
    </Card>
  );
}
