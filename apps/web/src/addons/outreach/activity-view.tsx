'use client';
/**
 * Social Outreach's Results tab (docs/outreach.md, decisions 7, 34 and 59): what the browser extension noted as people
 * worked on Facebook (apps/extension/README.md, "What it notes"), over a stretch of days. It leads with what came of
 * it: demos booked, then each step from reached to booked with how many of the step before made it, then what was
 * done along the way, by the group people were found in and person by person. The day against the daily limits is on
 * Today. Owners and admins can see the whole team's. The stretch and whose are in the address (./address.ts), so the
 * page asks HandsFreeOS for them and Back still works.
 */
import {
  ACTIVITY_PERIOD_KEYS,
  ACTIVITY_PERIODS,
  type ActivityPeriod,
} from '@hfos/core/addons/outreach/activity';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { ChevronRight } from 'lucide-react';
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

/** From reached to booked, each step from the one before. */
const FUNNEL = [
  'people',
  'chatsStarted',
  'replies',
  'demos',
] as const satisfies readonly (keyof Numbers)[];
/** What was done along the way. */
const ALONG: readonly { readonly key: keyof Numbers; readonly label: string }[] = [
  { key: 'friendRequests', label: 'Friend requests' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'followUps', label: 'Follow-ups' },
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
  activity,
  period,
  canManage,
}: {
  workspaceId: string;
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
          view: 'results',
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
        {nothing ? null : <Funnel numbers={activity.numbers} />}
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
    </div>
  );
}

/** What came of it: demos booked first, then each step from reached to booked, then what was done along the way. */
function Funnel({ numbers }: { numbers: Numbers }) {
  const R = W.results;
  return (
    <section aria-label={W.tabs.results} className="space-y-3" data-testid="activity-numbers">
      <p className="text-[26px] font-semibold leading-tight tracking-[-0.015em] tabular-nums">
        {R.headline(numbers.demos)}{' '}
        <span className="font-medium text-text-2">{R.from(numbers.people)}</span>
      </p>
      <ol className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        {FUNNEL.map((key, i) => {
          const before = i > 0 ? FUNNEL[i - 1]! : null;
          const of = before ? numbers[before] : 0;
          const pct = before && of > 0 ? Math.round((numbers[key] / of) * 100) : null;
          const width = numbers.people > 0 ? Math.round((numbers[key] / numbers.people) * 100) : 0;
          const last = key === 'demos';
          return (
            <li
              key={key}
              className={cn(
                'relative grid gap-2 rounded-card border p-4',
                last ? 'border-success-soft bg-success-soft' : 'border-border bg-card shadow-1',
              )}
              data-testid={`activity-number-${key}`}
            >
              <span
                className={cn(
                  'text-[13px] font-medium',
                  last ? 'text-success-text' : 'text-text-2',
                )}
              >
                {R.funnel[key]}
              </span>
              <span
                className={cn(
                  'text-[26px] font-semibold leading-tight tabular-nums',
                  last && 'text-success-text',
                )}
              >
                {numbers[key].toLocaleString()}
              </span>
              <div
                className={cn('h-2 rounded-full', last ? 'bg-card' : 'bg-card-2')}
                aria-hidden="true"
              >
                <div
                  className={cn('h-2 rounded-full', last ? 'bg-success' : 'bg-accent')}
                  style={{ width: `${numbers[key] > 0 ? Math.max(3, width) : 0}%` }}
                />
              </div>
              <span className={cn('text-[12.5px]', last ? 'text-success-text' : 'text-text-3')}>
                {pct !== null && before ? R.rate(pct, R.funnel[before]) : '\u00a0'}
              </span>
              {i < FUNNEL.length - 1 ? (
                <ChevronRight
                  className="absolute -right-[15px] top-1/2 z-10 hidden h-4 w-4 -translate-y-1/2 text-text-3 lg:block"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-text-2">
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {R.along}
        </span>
        {ALONG.map((n) => (
          <span key={n.key} data-testid={`activity-number-${n.key}`}>
            {n.label}{' '}
            <span className="font-medium tabular-nums text-text">
              {numbers[n.key].toLocaleString()}
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}

function GroupsCard({ groups }: { groups: readonly Group[] }) {
  return (
    <Card className="overflow-x-auto p-0" data-testid="activity-groups">
      <div className="px-5 pt-4">
        <h3 className="text-[15px] font-semibold">By group</h3>
        <p className="text-[12.5px] text-text-3">
          Where the people reached were found, and what came of it. The groups that bring demos and
          replies come first, and the extension works them more.
        </p>
      </div>
      {groups.length ? (
        <table className="mt-2 w-full min-w-[680px] text-left text-[13.5px]">
          <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
            <tr>
              <th className="px-5 py-2.5 font-semibold">Group</th>
              <th className="px-3 py-2.5 text-right font-semibold">People</th>
              <th className="px-3 py-2.5 text-right font-semibold">Friend requests</th>
              <th className="px-3 py-2.5 text-right font-semibold">Liked or commented</th>
              <th className="px-3 py-2.5 text-right font-semibold">Chats started</th>
              <th className="px-3 py-2.5 text-right font-semibold">Wrote back</th>
              <th className="px-5 py-2.5 text-right font-semibold">Demos</th>
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
                <td className="px-3 py-2.5 text-right tabular-nums">{g.replies}</td>
                <td className="px-5 py-2.5 text-right tabular-nums">{g.demos}</td>
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
