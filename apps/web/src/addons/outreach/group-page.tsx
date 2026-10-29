'use client';
/**
 * A group's own page on the Groups tab (`?view=groups&group=`, docs/outreach.md decision 103): everyone the extension
 * found in it, its admins and moderators marked, and how each turned out for the person, the furthest first, then
 * who's still to reach. One outcome at a time, counted; a customer opens their page, anyone else their profile. Which
 * teammate works it shows at the top, and an owner or admin can move it to another (decision 107).
 */
import {
  GROUP_PEOPLE_PAGE,
  GROUP_PEOPLE_VIEW_KEYS,
  GROUP_PEOPLE_VIEWS,
  type GroupPeopleView,
} from '@hfos/core/addons/outreach/journey';
import { OWNER_WORDS, type TeamOwner } from '@hfos/core/addons/outreach/owners';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn, relativeTime } from '@/lib/utils';
import { outreachHref } from './address';
import { Pager } from './friends-view';
import { NetworkName } from './network-ui';
import { STAGE_TONE } from './pipeline-view';
import type { GroupPeople } from './types';
import { useAct } from './use-act';

export function GroupPage({
  workspaceId,
  groupId,
  people,
  problem,
  outcome,
}: {
  workspaceId: string;
  groupId: string;
  /** The page: null when it couldn't be had, `problem` saying why. */
  people: GroupPeople | null;
  problem: string | null;
  outcome: GroupPeopleView;
}) {
  // Someone reached, written to or saved from the group shows as it lands.
  useLiveRefresh(['outreach_profile', 'outreach_group'], 800);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (to: { outcome?: GroupPeopleView; page?: number }) =>
    startTransition(() =>
      router.replace(
        outreachHref(workspaceId, {
          view: 'groups',
          group: groupId,
          outcome: to.outcome ?? outcome,
          page: to.page ?? 1,
        }),
        { scroll: false },
      ),
    );
  const back = (
    <Link
      href={outreachHref(workspaceId, { view: 'groups' })}
      className="mb-3 inline-flex items-center gap-1 text-[13px] text-accent-text hover:underline"
      data-testid="group-page-back"
    >
      <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      All groups
    </Link>
  );
  if (!people)
    return (
      <div data-testid="group-page">
        {back}
        <Card data-testid="group-page-problem">
          <EmptyState title="This group can’t be shown">
            {problem ?? 'Try again in a minute.'}
          </EmptyState>
        </Card>
      </div>
    );
  const { group, counts } = people;
  // Every outcome someone has, and the one shown; the rest would only ever say 0.
  const views = GROUP_PEOPLE_VIEW_KEYS.filter((k) => k === 'all' || k === outcome || counts[k] > 0);
  const first = (people.page - 1) * GROUP_PEOPLE_PAGE + 1;
  return (
    <div data-testid="group-page">
      {back}
      <Card className="mb-4 p-4 md:p-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <a
            href={group.url}
            target="_blank"
            rel="noreferrer"
            className="text-[17px] font-semibold text-accent-text hover:underline"
            data-testid="group-page-name"
          >
            {group.name ?? 'This group'}
          </a>
          <NetworkName platform={group.platform} />
          {group.joined ? <Badge variant="ok">You’re in it</Badge> : null}
        </div>
        <p className="mt-1 text-[13px] text-text-2" data-testid="group-page-summary">
          {group.members !== null ? `${group.members.toLocaleString()} members · ` : ''}
          {counts.all.toLocaleString()} found here,{' '}
          {(counts.all - counts.not_reached).toLocaleString()} reached
          {counts.booked + counts.client
            ? `, ${(counts.booked + counts.client).toLocaleString()} booked a demo or became a client`
            : ''}
        </p>
        <div
          className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-text-2"
          data-testid="group-page-owner"
        >
          <span>{OWNER_WORDS.group(group.owner)}</span>
          {people.moveTo.length ? (
            <MoveGroup
              workspaceId={workspaceId}
              groupId={group.groupId}
              owner={group.owner}
              teammates={people.moveTo}
            />
          ) : null}
        </div>
      </Card>
      <div className="mb-3 max-w-full overflow-x-auto">
        <Segmented
          ariaLabel="Who"
          value={outcome}
          onChange={(v) => go({ outcome: v })}
          options={views.map((k) => ({
            value: k,
            label: (
              <>
                {GROUP_PEOPLE_VIEWS[k]}
                <span className="tabular-nums text-text-3">{counts[k].toLocaleString()}</span>
              </>
            ),
            testId: `group-page-show-${k}`,
          }))}
        />
      </div>
      {people.people.length ? (
        <Card
          className={cn('p-0 transition-opacity', pending && 'opacity-60')}
          aria-busy={pending || undefined}
          data-testid="group-page-list"
        >
          <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
            <h3 className="text-[15px] font-semibold">{GROUP_PEOPLE_VIEWS[outcome]}</h3>
            <span className="text-[12.5px] text-text-3">
              Furthest along first
              {people.pages > 1
                ? ` · ${first.toLocaleString()}–${(first + people.people.length - 1).toLocaleString()} of ${people.total.toLocaleString()}`
                : ''}
            </span>
          </div>
          <ul className="mt-2">
            {people.people.map((p) => (
              <li
                key={p.profileId}
                className="border-t border-border px-5 py-3"
                data-testid="group-page-person"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 text-[13.5px]">
                    {p.personId ? (
                      <Link
                        href={`/app/w/${workspaceId}/customers/people/${p.personId}`}
                        className="font-medium text-accent-text hover:underline"
                      >
                        {p.name}
                      </Link>
                    ) : (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-accent-text hover:underline"
                      >
                        {p.name}
                      </a>
                    )}
                    <div className="text-[12.5px] text-text-3" data-testid="group-page-why">
                      {p.why.join(' · ')}
                      {p.part ? ` · Found in ${p.part}` : ''}
                    </div>
                  </div>
                  <Badge
                    variant={p.stage ? STAGE_TONE[p.stage] : 'gray'}
                    data-testid="group-page-stage"
                  >
                    {p.stage ? GROUP_PEOPLE_VIEWS[p.stage] : GROUP_PEOPLE_VIEWS.not_reached}
                  </Badge>
                </div>
                {p.nextStep ? (
                  <p className="mt-1 text-[12.5px] text-text-2">
                    {W.nextStepLabel}: {p.nextStep}
                  </p>
                ) : null}
                {p.lastAt ? (
                  <p className="mt-1 text-[12px] text-text-3">Latest {relativeTime(p.lastAt)}</p>
                ) : null}
              </li>
            ))}
          </ul>
          {people.pages > 1 ? (
            <Pager page={people.page} pages={people.pages} onPage={(page) => go({ page })} />
          ) : null}
        </Card>
      ) : (
        <Card data-testid="group-page-empty">
          <EmptyState title="Nobody here yet">
            {counts.all
              ? 'Nobody found in this group is at this point. Pick another above.'
              : 'Nobody from this group is saved yet. Ask your computer to save its members on the Groups tab.'}
          </EmptyState>
        </Card>
      )}
    </div>
  );
}

/** For an owner or admin: give the group to another teammate who uses Social Outreach (`outreach.owner.move`). */
function MoveGroup({
  workspaceId,
  groupId,
  owner,
  teammates,
}: {
  workspaceId: string;
  groupId: string;
  owner: TeamOwner | null;
  teammates: readonly TeamOwner[];
}) {
  const { busy, act } = useAct();
  const move = (to: TeamOwner) =>
    void act(
      'move',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.owner.move', {
            body: { workspaceId, kind: 'group', id: groupId, userId: to.userId },
          }),
        ),
      OWNER_WORDS.moved('group', to),
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="secondary"
          loading={busy !== null}
          aria-label={OWNER_WORDS.moveLabel}
          data-testid="group-page-move"
        >
          {OWNER_WORDS.move}
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {teammates
          .filter((t) => t.userId !== owner?.userId)
          .map((t, i) => (
            <DropdownMenuItem
              key={t.userId}
              onSelect={() => move(t)}
              data-testid={`group-page-move-${i}`}
            >
              {t.you ? `${t.name} (you)` : t.name}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
