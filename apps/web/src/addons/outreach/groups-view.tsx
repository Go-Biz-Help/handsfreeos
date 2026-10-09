'use client';
/**
 * Social Outreach's Groups tab (docs/outreach.md, the plan's Phase 1 step 4): the Facebook groups the extension saved,
 * scored against the business's playbooks as Work these, Maybe or Skip, with why; how many people were saved from
 * each and who runs it; and whether its admins and moderators are read, which Today waits for before it suggests
 * anyone from it. Which, the name and the page are in the address (./address.ts), so the page asks HandsFreeOS for them.
 */
import { GROUP_VIEWS, GROUPS_PAGE, type GroupView } from '@hfos/core/addons/outreach/groups';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { GROUP_VIEW_KEYS, outreachHref } from './address';
import { dayWords, Pager, SearchBox } from './friends-view';
import type { Group, Groups } from './types';

const EMPTY: Record<GroupView, { readonly title: string; readonly body: string }> = {
  work: {
    title: 'No groups to work yet',
    body: 'Open your groups or search for groups on Facebook with the extension’s panel and press Save these groups. Groups that match a playbook’s words to search for groups show here.',
  },
  maybe: {
    title: 'No maybes',
    body: 'Groups that match a little, or that are just big, show here.',
  },
  skip: {
    title: 'Nothing to skip',
    body: 'Groups that match none of your playbooks, or match who to skip, show here.',
  },
  all: {
    title: 'No groups saved yet',
    body: 'Open your groups or search for groups on Facebook with the extension’s panel and press Save these groups.',
  },
};

const VERDICT_BADGE = { work: 'ok', maybe: 'gray', skip: 'danger' } as const;

export function GroupsView({
  workspaceId,
  groups,
  show,
  search,
}: {
  workspaceId: string;
  groups: Groups;
  show: GroupView;
  search: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // What was last asked for, ahead of the address while it loads (as the Friends tab).
  const asked = useRef({ groups: show, search });
  useEffect(() => {
    asked.current = { groups: show, search };
  }, [show, search]);
  const go = (to: { groups?: GroupView; search?: string; page?: number }) => {
    asked.current = {
      groups: to.groups ?? asked.current.groups,
      search: to.search ?? asked.current.search,
    };
    const href = outreachHref(workspaceId, {
      view: 'groups',
      ...asked.current,
      page: to.page ?? 1,
    });
    startTransition(() => router.replace(href, { scroll: false }));
  };
  const first = (groups.page - 1) * GROUPS_PAGE + 1;
  return (
    <div data-testid="outreach-groups">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="max-w-full overflow-x-auto">
          <Segmented
            ariaLabel="Which groups"
            value={show}
            onChange={(v) => go({ groups: v })}
            options={GROUP_VIEW_KEYS.map((k) => ({
              value: k,
              label: (
                <>
                  {GROUP_VIEWS[k]}
                  <span className="tabular-nums text-text-3">
                    {groups.counts[k].toLocaleString()}
                  </span>
                </>
              ),
              testId: `groups-show-${k}`,
            }))}
          />
        </div>
        <SearchBox search={search} onSearch={(s) => go({ search: s })} />
      </div>
      <div
        className={cn(
          'grid gap-4 transition-opacity lg:grid-cols-[minmax(0,1fr)_300px]',
          pending && 'opacity-60',
        )}
        aria-busy={pending || undefined}
      >
        <div className="min-w-0">
          {groups.groups.length ? (
            <Card className="p-0" data-testid="groups-list">
              <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
                <h3 className="text-[15px] font-semibold">{GROUP_VIEWS[show]}</h3>
                <span className="text-[12.5px] text-text-3">
                  The best fit first
                  {groups.pages > 1
                    ? ` · ${first.toLocaleString()}–${(first + groups.groups.length - 1).toLocaleString()} of ${groups.total.toLocaleString()}`
                    : ''}
                </span>
              </div>
              <ul className="mt-2">
                {groups.groups.map((g) => (
                  <GroupRow key={g.groupId} group={g} />
                ))}
              </ul>
              {groups.pages > 1 ? (
                <Pager page={groups.page} pages={groups.pages} onPage={(page) => go({ page })} />
              ) : null}
            </Card>
          ) : (
            <Card data-testid="groups-empty">
              {search ? (
                <EmptyState title="No groups like that here">
                  Check the spelling and look again.
                </EmptyState>
              ) : (
                <EmptyState title={EMPTY[show].title}>{EMPTY[show].body}</EmptyState>
              )}
            </Card>
          )}
        </div>
        <aside className="space-y-4">
          <Card className="p-4">
            <h3 className="text-[15px] font-semibold">How groups are scored</h3>
            <p className="mt-1.5 text-[13px] text-text-2">
              A group is worth working when its name has one of a playbook’s words to search for
              groups, its area, or a sign you’re looking for. Big groups and ones you’re in count a
              little more; a name with someone to skip makes it a skip.
            </p>
          </Card>
          <Card className="p-4">
            <h3 className="text-[15px] font-semibold">People who run a group are left alone</h3>
            <p className="mt-1.5 text-[13px] text-text-2">
              Today suggests a group’s members only after its admins and moderators are saved. Open
              the group’s People tab, then Admins and moderators, See all, and save that page with
              the extension.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function GroupRow({ group: g }: { group: Group }) {
  const facts = [
    g.privacy === 'public' ? 'Public' : g.privacy === 'private' ? 'Private' : null,
    g.members !== null ? `${g.members.toLocaleString()} members` : null,
    g.joined ? 'You’re in it' : g.joined === false ? 'Not joined' : null,
    g.seenAt ? `Seen ${dayWords(g.seenAt)}` : null,
  ].filter(Boolean);
  const saved = g.people
    ? [
        `${g.people.toLocaleString()} ${g.people === 1 ? 'person' : 'people'} saved`,
        g.runsGroup ? `${g.runsGroup.toLocaleString()} who run it` : null,
        g.requests
          ? `${g.requests.toLocaleString()} ${g.requests === 1 ? 'request' : 'requests'} sent`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  return (
    <li className="border-t border-border px-5 py-3" data-testid="group">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 text-[13.5px]">
          <a
            href={g.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-text hover:underline"
          >
            {g.name ?? 'A group'}
          </a>
          {facts.length ? (
            <div className="text-[12.5px] text-text-3">{facts.join(' · ')}</div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={VERDICT_BADGE[g.verdict]}>{GROUP_VIEWS[g.verdict]}</Badge>
          {g.people && !g.adminsRead ? <Badge variant="pending">Admins not read</Badge> : null}
        </div>
      </div>
      {g.reasons.length ? (
        <p className="mt-1.5 text-[12.5px] text-text-2" data-testid="group-reasons">
          {g.reasons.join(' · ')}
          {g.playbookName ? ` · ${g.playbookName}` : ''}
        </p>
      ) : null}
      {saved ? <p className="mt-1 text-[12.5px] text-text-3">{saved}</p> : null}
    </li>
  );
}
