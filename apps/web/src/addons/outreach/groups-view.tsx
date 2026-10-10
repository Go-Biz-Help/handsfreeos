'use client';
/**
 * Social Outreach's Groups tab (docs/outreach.md, the plan's Phase 1 step 4): the Facebook groups the extension saved,
 * scored against the business's playbooks as Work these, Maybe or Skip, with why; how many people were saved from
 * each and who runs it; and whether its admins and moderators are read, which Today waits for before it suggests
 * anyone from it. Which, the name and the page are in the address (./address.ts), so the page asks HandsFreeOS for them.
 */
import {
  ASK_LINK_MOST,
  ASK_WORDS,
  ASK_WORDS_MOST,
  askedWords,
} from '@hfos/core/addons/outreach/asks';
import { GROUP_VIEWS, GROUPS_PAGE, type GroupView } from '@hfos/core/addons/outreach/groups';
import { brought, resultWords } from '@hfos/core/addons/outreach/results';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { GROUP_VIEW_KEYS, outreachHref } from './address';
import { AskButton, AskLine, cantAskWhy, ComputerNote, latestAsk, targetOf } from './asks';
import { dayWords, Pager, SearchBox } from './friends-view';
import type { Asks, Group, Groups } from './types';
import { useAct } from './use-act';

const EMPTY = W.groupsEmpty;

const VERDICT_BADGE = { work: 'ok', maybe: 'gray', skip: 'danger' } as const;

export function GroupsView({
  workspaceId,
  groups,
  show,
  search,
  asks,
  searchWords,
}: {
  workspaceId: string;
  groups: Groups;
  show: GroupView;
  search: string;
  /** What the person asked their computer to do on this tab. */
  asks: Asks;
  /** Find groups' box starts with these: the first playbook in use's words to search for groups. */
  searchWords: string;
}) {
  // An ask's progress and end: the groups it saved show once it ends.
  useLiveRefresh(['outreach_ask'], 800);
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
      <GroupAsks workspaceId={workspaceId} asks={asks} searchWords={searchWords} />
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
                  Bringing demos and replies first, then the best fit
                  {groups.pages > 1
                    ? ` · ${first.toLocaleString()}–${(first + groups.groups.length - 1).toLocaleString()} of ${groups.total.toLocaleString()}`
                    : ''}
                </span>
              </div>
              <ul className="mt-2">
                {groups.groups.map((g) => (
                  <GroupRow key={g.groupId} workspaceId={workspaceId} asks={asks} group={g} />
                ))}
              </ul>
              {groups.pages > 1 ? (
                <Pager page={groups.page} pages={groups.pages} onPage={(page) => go({ page })} />
              ) : null}
            </Card>
          ) : (
            <Card data-testid="groups-empty">
              {search ? (
                <EmptyState title={W.groupsNoMatch.title}>{W.groupsNoMatch.body}</EmptyState>
              ) : (
                <EmptyState title={EMPTY[show].title}>{EMPTY[show].body}</EmptyState>
              )}
            </Card>
          )}
        </div>
        <aside className="space-y-4">
          <Card className="p-4">
            <h3 className="text-[15px] font-semibold">The groups that bring results</h3>
            <p className="mt-1.5 text-[13px] text-text-2">
              Groups whose people wrote back or booked a demo come first, and the extension works
              them more: most of the groups it goes through each day are those, and the rest are
              others, so a new group gets its chance. Today puts people from them ahead of others
              who fit as well.
            </p>
          </Card>
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
              Today suggests a group’s members only after its admins and moderators are saved. Save
              its members does both: your computer reads who runs the group first.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/**
 * What the person can ask their computer to do with groups: save the ones they're in, find more with a playbook's
 * words, save a group from its link, save the members of the best ones, and find posts worth a comment.
 */
function GroupAsks({
  workspaceId,
  asks,
  searchWords,
}: {
  workspaceId: string;
  asks: Asks;
  searchWords: string;
}) {
  const [words, setWords] = useState(searchWords);
  const lastSearch = latestAsk(asks, 'group_search');
  return (
    <Card className="mb-4 p-4" data-testid="groups-asks">
      <h3 className="text-[15px] font-semibold">{ASK_WORDS.fromFacebook}</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">{ASK_WORDS.fromFacebookNote}</p>
      <ComputerNote asks={asks} className="mt-3" />
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <AskButton
          workspaceId={workspaceId}
          asks={asks}
          ask={{ kind: 'groups' }}
          label={ASK_WORDS.saveGroups}
          testId="ask-groups"
        />
        <div className="grid content-start gap-1.5">
          <form
            className="flex gap-2"
            onSubmit={(e) => e.preventDefault()}
            data-testid="group-search-form"
          >
            <Input
              aria-label={ASK_WORDS.searchFor}
              placeholder={ASK_WORDS.searchFor}
              value={words}
              maxLength={ASK_WORDS_MOST}
              onChange={(e) => setWords(e.target.value)}
            />
            <AskButton
              workspaceId={workspaceId}
              asks={asks}
              ask={{ kind: 'group_search', words: words.trim() }}
              label={ASK_WORDS.findGroups}
              disabled={words.trim().length < 2}
              showLine={false}
              testId="ask-group-search"
            />
          </form>
          {lastSearch ? <AskLine workspaceId={workspaceId} asks={asks} ask={lastSearch} /> : null}
        </div>
        <SaveGroupByLink workspaceId={workspaceId} asks={asks} />
        <AskButton
          workspaceId={workspaceId}
          asks={asks}
          ask={{ kind: 'members' }}
          label={ASK_WORDS.saveMembers}
          testId="ask-members"
        />
        <AskButton
          workspaceId={workspaceId}
          asks={asks}
          ask={{ kind: 'posts' }}
          label={ASK_WORDS.findPosts}
          testId="ask-posts"
        />
      </div>
    </Card>
  );
}

/** Save a group from a link the person pasted: its members, its admins first. The refusal's words show under the box. */
function SaveGroupByLink({ workspaceId, asks }: { workspaceId: string; asks: Asks }) {
  const { busy, act } = useAct();
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // The ask the last paste made: a group already saved is kept by its id, not by the link.
  const [madeId, setMadeId] = useState<string | null>(null);
  const asked = url.trim() ? latestAsk(asks, 'members', targetOf({ kind: 'members', url })) : null;
  const made = madeId ? (asks.asks.find((a) => a.askId === madeId) ?? null) : null;
  const lastLink = asks.asks.find((a) => a.kind === 'members' && a.target.startsWith('link:'));
  const shown = asked ?? made ?? lastLink ?? null;
  const why = cantAskWhy(asks, 'members');
  const save = () =>
    void act('link', async () => {
      setProblem(null);
      try {
        const made = unwrap(
          await apiBrowser().POST('/v1/commands/outreach.ask.make', {
            body: { workspaceId, ask: { kind: 'members', url: url.trim() } },
          }),
        );
        toast.success(askedWords(made, asks, Date.now()));
        setMadeId(made.ask.askId);
        setUrl('');
      } catch (e) {
        setProblem(errorMessage(e));
        throw e;
      }
    });
  return (
    <div className="grid content-start gap-1.5">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        data-testid="group-link-form"
      >
        <Input
          aria-label="Paste a group’s link"
          placeholder="Paste a group’s link"
          value={url}
          maxLength={ASK_LINK_MOST}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          loading={busy === 'link'}
          disabled={busy !== null || !url.trim() || why !== null}
          title={why ?? undefined}
          data-testid="ask-group-link"
        >
          Save a group
        </Button>
      </form>
      {problem ? (
        <p className="text-[12.5px] text-danger-text" role="alert" data-testid="group-link-problem">
          {problem}
        </p>
      ) : null}
      {shown ? <AskLine workspaceId={workspaceId} asks={asks} ask={shown} /> : null}
    </div>
  );
}

function GroupRow({
  workspaceId,
  asks,
  group: g,
}: {
  workspaceId: string;
  asks: Asks;
  group: Group;
}) {
  const facts = [
    g.privacy === 'public' ? 'Public' : g.privacy === 'private' ? 'Private' : null,
    g.members !== null ? W.groupMembers(g.members) : null,
    g.joined ? W.joined : g.joined === false ? W.notJoined : null,
    g.seenAt ? `Seen ${dayWords(g.seenAt)}` : null,
  ].filter(Boolean);
  const saved = g.people
    ? [
        W.peopleSaved(g.people),
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
          {brought(g) ? (
            <Badge variant="ok" data-testid="group-results">
              {resultWords(g)}
            </Badge>
          ) : null}
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
      <div className="mt-2">
        <AskButton
          workspaceId={workspaceId}
          asks={asks}
          ask={{ kind: 'members', groupIds: [g.groupId] }}
          label={ASK_WORDS.saveItsMembers}
          variant="ghost"
          testId="ask-group-members"
        />
      </div>
    </li>
  );
}
