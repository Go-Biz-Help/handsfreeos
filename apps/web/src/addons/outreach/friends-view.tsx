'use client';
/**
 * Social Outreach's Friends tab (docs/outreach.md, decisions 10 to 13): where the person's own Facebook stands with
 * people, as the browser extension saved and noted it (apps/extension/README.md). Their friends against Facebook's
 * cap, the good fits the AI found among their friends and chats (decision 46, **Check my friends**), the friend
 * requests they've got in order of how each fits the playbooks in use, the requests they sent that nobody has
 * answered, the friends they keep (never suggested for unfriending), and the business's Don't pitch list.
 * Which, a name searched for and the page are in the address (./address.ts), so the page asks HandsFreeOS for them.
 * The list follows the search box as a name is typed, a page at a time. Facebook's download file, brought in from
 * the side (./download-card.tsx), adds since when they've been friends and the latest message.
 */
import {
  ASK_TIDY_MOST,
  ASK_WORDS,
  askOpen,
  TIDY_PACE_WORDS,
} from '@hfos/core/addons/outreach/asks';
import {
  CHECK_VERDICTS,
  CHECKS_WORDS,
  checksWords,
  type CheckVerdict,
} from '@hfos/core/addons/outreach/checks';
import { FIT_LEVELS, type FitLevel } from '@hfos/core/addons/outreach/fit';
import {
  DONT_PITCH_TAG,
  FRIEND_STATES,
  FRIEND_VIEW_KEYS,
  FRIEND_VIEWS,
  FRIENDS_PAGE,
  type FriendView,
} from '@hfos/core/addons/outreach/friends';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn, relativeTime } from '@/lib/utils';
import { outreachHref } from './address';
import { AskButton, AskLine, latestAsk } from './asks';
import { DownloadCard } from './download-card';
import { FileAsksCard } from './file-asks';
import { PersonMenu } from './person-menu';
import { ResearchSlot } from './research';
import type { Asks, Friend, Friends, Tidy } from './types';

type Counts = Friends['counts'];
type DontPitch = NonNullable<Friend['dontPitch']>;

const COUNTED: Record<FriendView, keyof Counts> = {
  friends: 'friends',
  fits: 'fits',
  requests: 'requests',
  sent: 'sent',
  keep: 'keep',
  dont_pitch: 'dontPitch',
};

/** The order each list is in. */
const ORDER: Record<FriendView, string> = {
  friends: 'By name',
  fits: 'The good fits first',
  requests: 'The best fit first',
  sent: 'The oldest first',
  keep: 'By name',
  dont_pitch: 'The latest added first',
};

const EMPTY: Record<FriendView, { readonly title: string; readonly body: string }> = {
  friends: {
    title: 'No friends saved yet',
    body: 'Press Save my friends list, and your computer reads your friends list on Facebook and saves it here. Or bring in your Facebook file.',
  },
  fits: {
    title: 'No good fits found yet',
    body: 'Press Check my friends, and your computer reads your friends’ profiles a few at a time for the AI. The ones who fit your playbooks show here, with why and a first step.',
  },
  requests: {
    title: 'No friend requests waiting',
    body: 'Press Check my friend requests, and your computer saves the ones waiting on Facebook. They show here in order of how they fit your playbooks.',
  },
  sent: {
    title: 'No requests waiting on an answer',
    body: 'The friend requests you send, noted by HandsFreeOS Social, show here until they’re answered, the oldest first. Ones you sent before come in with your Facebook file.',
  },
  keep: {
    title: 'Nobody on your Keep list',
    body: 'Turn on Keep for the friends you’ll never unfriend.',
  },
  dont_pitch: {
    title: 'Nobody on the Don’t pitch list',
    body: `Turn on Don’t pitch for anyone nobody here should pitch, like family and close friends. Customers tagged ${DONT_PITCH_TAG} in Contacts count too.`,
  },
};

const CHECK_TONE: Record<CheckVerdict, BadgeVariant> = {
  waiting: 'gray',
  good: 'ok',
  maybe: 'accent',
  not: 'gray',
  failed: 'gray',
};

const FIT_TONE: Record<FitLevel, BadgeVariant> = {
  good: 'ok',
  maybe: 'accent',
  unknown: 'gray',
  skip: 'danger',
};

const WEEK = 7 * 86_400_000;

/** "3 d ago" within the week, then "Sep 1", and "Jul 14, 2019" in another year. */
export function dayWords(iso: string): string {
  const at = new Date(iso);
  if (Date.now() - at.getTime() < WEEK) return relativeTime(iso);
  return at.toLocaleDateString(
    'en-US',
    at.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}

/**
 * "Asked · 3 d ago": when a request came or went, or was deleted. A friend's day is the one Facebook's download file
 * says ("Friends since Mar 2019"); without it, nothing. Then the latest message, from the file or noted since.
 */
function sinceWords(f: Friend): string | null {
  const word =
    f.state === 'request_received'
      ? 'Asked'
      : f.state === 'request_sent'
        ? 'Sent'
        : f.state === 'declined'
          ? 'Deleted'
          : null;
  const since =
    word && f.since
      ? `${word} · ${dayWords(f.since)}`
      : f.state === 'friends' && f.friendsSince
        ? `Friends since ${new Date(f.friendsSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
        : null;
  const message = f.lastMessage
    ? `Last message ${dayWords(f.lastMessage.at)}, from ${f.lastMessage.fromMe ? 'you' : 'them'}`
    : null;
  return [since, message].filter(Boolean).join(' · ') || null;
}

/** Why someone isn't pitched: the list, who put them on it and when, or the Contacts tag. */
function dontPitchWords(d: DontPitch): string {
  const added = d.at
    ? `Added to Don’t pitch${d.by ? ` by ${d.by}` : ''} · ${relativeTime(d.at)}`
    : null;
  if (added && d.tagged) return `${added}, and tagged ${DONT_PITCH_TAG} in Contacts.`;
  if (added) return `${added}.`;
  return `Tagged ${DONT_PITCH_TAG} in Contacts. Take the tag off there to pitch them.`;
}

/** Keep or Don't pitch as switched on a row. */
type Flip = { keep?: boolean; dontPitch?: boolean };

function doneWords(name: string, change: Flip): string {
  if (change.dontPitch === true) return `${name} is on the Don’t pitch list.`;
  if (change.dontPitch === false) return `${name} is off the Don’t pitch list.`;
  return change.keep ? `You’ll keep ${name}.` : `${name} is off your Keep list.`;
}

/** A group's name, or the end of its link until the extension has seen its name. */
const groupName = (g: { readonly name: string | null; readonly url: string }) =>
  g.name ?? `Group ${new URL(g.url).pathname.split('/')[2] ?? ''}`.trim();

export function FriendsView({
  workspaceId,
  businessName,
  friends,
  tidy,
  show,
  search,
  asks,
}: {
  workspaceId: string;
  businessName: string;
  friends: Friends;
  tidy: Tidy;
  show: FriendView;
  search: string;
  /** What the person asked their computer to do on this tab. */
  asks: Asks;
}) {
  // An ask's progress and end: what it saved shows once it ends.
  useLiveRefresh(['outreach_ask'], 800);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The list and name last asked for, ahead of the address while it loads: a name typed as another list opens is
  // looked for in that list. Another list or another name starts again at the first page.
  const asked = useRef({ show, search });
  useEffect(() => {
    asked.current = { show, search };
  }, [show, search]);
  const go = (to: { show?: FriendView; search?: string; page?: number }) => {
    asked.current = {
      show: to.show ?? asked.current.show,
      search: to.search ?? asked.current.search,
    };
    const href = outreachHref(workspaceId, {
      view: 'friends',
      ...asked.current,
      page: to.page ?? 1,
    });
    startTransition(() => router.replace(href, { scroll: false }));
  };
  // A new page opens at its top (below the phone's bar), wherever the list was scrolled to.
  const list = useRef<HTMLDivElement>(null);
  const shownPage = useRef(friends.page);
  useEffect(() => {
    if (friends.page === shownPage.current) return;
    shownPage.current = friends.page;
    const top = list.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' });
  }, [friends.page]);
  // Keep and Don't pitch flip at once, as the pipeline board moves a card: the command goes in the background and
  // a refusal flips the switch back with why. What's still waiting on the server stays flipped through a refresh;
  // what has landed gives way to what the list says, once it's reloaded.
  const [flipped, setFlipped] = useState<Record<string, Flip>>({});
  const waiting = useRef(new Map<string, number>());
  useEffect(() => {
    setFlipped((all) => {
      const kept: Record<string, Flip> = {};
      for (const [id, flip] of Object.entries(all)) {
        const still: Flip = {};
        if (flip.keep !== undefined && waiting.current.get(`${id}:keep`)) still.keep = flip.keep;
        if (flip.dontPitch !== undefined && waiting.current.get(`${id}:dontPitch`))
          still.dontPitch = flip.dontPitch;
        if (still.keep !== undefined || still.dontPitch !== undefined) kept[id] = still;
      }
      return kept;
    });
  }, [friends]);
  const set = async (f: Friend, change: Flip) => {
    const id = f.profileId;
    const keys = Object.keys(change).map((k) => `${id}:${k}`);
    const was = flipped[id];
    for (const k of keys) waiting.current.set(k, (waiting.current.get(k) ?? 0) + 1);
    setFlipped((all) => ({ ...all, [id]: { ...all[id], ...change } }));
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.friend.set', {
          body: { workspaceId, profileId: id, ...change },
        }),
      );
      toast.success(doneWords(f.name, change));
    } catch (e) {
      // Back to what it showed before this click.
      setFlipped((all) => {
        const back: Flip = { ...all[id] };
        for (const k of Object.keys(change) as (keyof Flip)[]) {
          if (was?.[k] !== undefined) back[k] = was[k];
          else delete back[k];
        }
        return { ...all, [id]: back };
      });
      toast.error(errorMessage(e));
    } finally {
      for (const k of keys) waiting.current.set(k, (waiting.current.get(k) ?? 1) - 1);
      router.refresh();
    }
  };
  // Fit comes from the playbooks in use: with none, only mutual friends and groups count.
  const noPlaybook =
    show === 'requests' &&
    friends.people.length > 0 &&
    friends.people.every((f) => !f.fit?.playbookName);
  return (
    <div data-testid="outreach-friends">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="max-w-full overflow-x-auto">
          <Segmented
            ariaLabel="Which people"
            value={show}
            onChange={(v) => go({ show: v })}
            options={FRIEND_VIEW_KEYS.map((k) => ({
              value: k,
              label: (
                <>
                  {FRIEND_VIEWS[k]}
                  <span className="tabular-nums text-text-3">
                    {friends.counts[COUNTED[k]].toLocaleString()}
                  </span>
                </>
              ),
              testId: `friends-show-${k}`,
            }))}
          />
        </div>
        <SearchBox search={search} onSearch={(s) => go({ search: s })} />
      </div>
      <Card className="mb-4 p-4" data-testid="friends-asks">
        <h3 className="text-[15px] font-semibold">{ASK_WORDS.fromFacebook}</h3>
        <p className="mt-0.5 text-[12.5px] text-text-3">{ASK_WORDS.fromFacebookNote}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <AskButton
            workspaceId={workspaceId}
            asks={asks}
            ask={{ kind: 'requests' }}
            label="Check my friend requests"
            testId="ask-requests"
          />
          <AskButton
            workspaceId={workspaceId}
            asks={asks}
            ask={{ kind: 'friends' }}
            label="Save my friends list"
            testId="ask-friends"
          />
        </div>
      </Card>
      <div
        className={cn(
          'grid gap-4 transition-opacity lg:grid-cols-[minmax(0,1fr)_300px]',
          pending && 'opacity-60',
        )}
        aria-busy={pending || undefined}
      >
        <div className="min-w-0 scroll-mt-16 md:scroll-mt-4" ref={list}>
          {friends.people.length ? (
            <Card className="p-0" data-testid="friends-list">
              <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
                <h3 className="text-[15px] font-semibold">{FRIEND_VIEWS[show]}</h3>
                <span className="text-[12.5px] text-text-3" data-testid="friends-range">
                  {ORDER[show]}
                  {friends.pages > 1 ? ` · ${rangeWords(friends)}` : ''}
                </span>
              </div>
              {noPlaybook ? (
                <p className="px-5 pt-1 text-[12.5px] text-text-2">
                  By mutual friends and groups for now.{' '}
                  <Link
                    href={outreachHref(workspaceId, { view: 'playbooks' })}
                    className="text-accent-text hover:underline"
                  >
                    Write a playbook
                  </Link>{' '}
                  with the words to look for in quotes to sort them by fit.
                </p>
              ) : null}
              <ul className="mt-2">
                {friends.people.map((f) => (
                  <FriendRow
                    key={f.profileId}
                    workspaceId={workspaceId}
                    friend={f}
                    show={show}
                    flip={flipped[f.profileId]}
                    asks={asks}
                    onSet={(change) => void set(f, change)}
                  />
                ))}
              </ul>
              {friends.pages > 1 ? (
                <Pager page={friends.page} pages={friends.pages} onPage={(page) => go({ page })} />
              ) : null}
            </Card>
          ) : (
            <Card data-testid="friends-empty">
              {search ? (
                <EmptyState title={`Nobody called “${search}” here`}>
                  Check the spelling, or look in another list.
                </EmptyState>
              ) : (
                <EmptyState title={EMPTY[show].title}>{EMPTY[show].body}</EmptyState>
              )}
            </Card>
          )}
          <TidyCard workspaceId={workspaceId} tidy={tidy} asks={asks} />
        </div>
        <aside className="space-y-4">
          <ChecksCard workspaceId={workspaceId} friends={friends} asks={asks} />
          <CapCard counts={friends.counts} cap={friends.cap} />
          <FileAsksCard workspaceId={workspaceId} asks={asks} />
          <DownloadCard workspaceId={workspaceId} download={friends.download} />
          <Card className="p-4">
            <h3 className="text-[15px] font-semibold">Yours, and the business’s</h3>
            <p className="mt-1.5 text-[13px] text-text-2">
              Your friends and requests are your own: each teammate sees theirs. The Don’t pitch
              list is {businessName}’s, and says who added each person. Nobody here sends friend
              requests, likes, comments or messages to anyone on it, and only whoever added someone,
              or an owner or admin, takes them off.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** "101–200 of 1,459": who this page shows, of everyone in the list. */
function rangeWords(f: Friends): string {
  const first = (f.page - 1) * FRIENDS_PAGE + 1;
  const last = first + f.people.length - 1;
  return `${first.toLocaleString()}–${last.toLocaleString()} of ${f.total.toLocaleString()}`;
}

/** The pages of a long list: the one before, which this is, and the one after. */
export function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  return (
    <nav
      aria-label="Pages"
      className="flex items-center justify-between gap-3 border-t border-border px-5 py-3"
      data-testid="friends-pages"
    >
      <Button
        variant="secondary"
        size="sm"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        data-testid="friends-page-previous"
      >
        Previous
      </Button>
      <span className="text-[12.5px] tabular-nums text-text-2" data-testid="friends-page">
        Page {page.toLocaleString()} of {pages.toLocaleString()}
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        data-testid="friends-page-next"
      >
        Next
      </Button>
    </nav>
  );
}

/** How long the box waits after a key before it looks, so a name typed quickly is one look. */
const SEARCH_WAIT_MS = 300;

/** Part of a name, looked for as it's typed; Enter looks at once. */
export function SearchBox({ search, onSearch }: { search: string; onSearch: (s: string) => void }) {
  const [typed, setTyped] = useState(search);
  // What the box last looked for. The address catches up with it a moment later, and mustn't undo what's been
  // typed since; an address changed some other way, like the Friends tab at the top, shows in the box.
  const looked = useRef(search);
  useEffect(() => {
    if (search === looked.current) return;
    looked.current = search;
    setTyped(search);
  }, [search]);
  const look = (words: string) => {
    if (words === looked.current) return;
    looked.current = words;
    onSearch(words);
  };
  useEffect(() => {
    const words = typed.trim();
    // Clearing the box shows everyone again straight away.
    if (!words) {
      look('');
      return;
    }
    const wait = setTimeout(() => look(words), SEARCH_WAIT_MS);
    return () => clearTimeout(wait);
  }, [typed]);
  return (
    <form
      role="search"
      className="w-full sm:w-[240px]"
      onSubmit={(e) => {
        e.preventDefault();
        look(typed.trim());
      }}
    >
      <Input
        type="search"
        inputSize="sm"
        aria-label="Search by name"
        placeholder="Search by name"
        value={typed}
        maxLength={100}
        onChange={(e) => setTyped(e.target.value)}
        data-testid="friends-search"
      />
    </form>
  );
}

function FriendRow({
  workspaceId,
  friend: f,
  show,
  flip,
  asks,
  onSet,
}: {
  workspaceId: string;
  friend: Friend;
  show: FriendView;
  /** A switch flipped and not yet reloaded: shown over what the list says. */
  flip: Flip | undefined;
  asks: Asks;
  onSet: (change: Flip) => void;
}) {
  const since = sinceWords(f);
  const keep = flip?.keep ?? f.keep;
  const listed = flip?.dontPitch ?? (f.dontPitch !== null && f.dontPitch.at !== null);
  // Where you stand, where the list doesn't say: Don't pitch, or a friend kept who isn't one now.
  const state =
    f.state && (show === 'dont_pitch' || (show === 'keep' && f.state !== 'friends'))
      ? f.state
      : null;
  const mutual = f.fit ? null : f.mutualFriends;
  return (
    <li className="border-t border-border px-5 py-3" data-testid="friend">
      {/* The switches sit on the name's line; they say whether someone's kept or not pitched. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 text-[13.5px]">
          {f.personId ? (
            <Link
              href={`/app/w/${workspaceId}/customers/people/${f.personId}`}
              className="font-medium text-accent-text hover:underline"
            >
              {f.name}
            </Link>
          ) : (
            <span className="font-medium">{f.name}</span>
          )}
          <a
            href={f.url}
            target="_blank"
            rel="noreferrer"
            className="ml-2 text-[12.5px] text-text-3 hover:underline"
          >
            Facebook
          </a>
          {mutual ? (
            <span className="ml-2 align-middle" data-testid="friend-mutual">
              <Badge>{mutual.toLocaleString()} mutual</Badge>
            </span>
          ) : null}
          {since ? (
            <div className="text-[12.5px] text-text-3" data-testid="friend-since">
              {since}
            </div>
          ) : null}
          {f.group ? (
            <div className="text-[12.5px] text-text-3">Found in {groupName(f.group)}</div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-text-2">
          {f.state === 'friends' || f.keep ? (
            <span className="inline-flex items-center gap-2">
              <Switch
                checked={keep}
                onChange={(keep) => onSet({ keep })}
                label={`Keep ${f.name}: never suggest unfriending them`}
                testId="friend-keep"
              />
              Keep
            </span>
          ) : null}
          <span className="inline-flex items-center gap-2">
            <Switch
              checked={listed}
              onChange={(dontPitch) => onSet({ dontPitch })}
              label={`Don’t pitch ${f.name}`}
              testId="friend-dont-pitch"
            />
            Don’t pitch
          </span>
          {/* Add to Contacts and Demo booked; Don't pitch has its switch here. */}
          <PersonMenu workspaceId={workspaceId} who={f} dontPitch={false} />
        </div>
      </div>
      {(f.check && (show === 'fits' || f.check.verdict === 'good')) || f.fit || state ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {f.check && (show === 'fits' || f.check.verdict === 'good') ? (
            <Badge variant={CHECK_TONE[f.check.verdict]} data-testid="friend-check">
              {CHECK_VERDICTS[f.check.verdict]}
              {f.check.playbookName ? ` · ${f.check.playbookName}` : ''}
            </Badge>
          ) : null}
          {f.fit ? (
            <Badge variant={FIT_TONE[f.fit.level]} data-testid="friend-fit">
              {FIT_LEVELS[f.fit.level]}
              {f.fit.playbookName ? ` · ${f.fit.playbookName}` : ''}
            </Badge>
          ) : null}
          {state ? (
            <Badge variant={state === 'friends' ? 'ok' : 'gray'}>{FRIEND_STATES[state]}</Badge>
          ) : null}
        </div>
      ) : null}
      {f.fit?.reasons.length ? (
        <p className="mt-1 text-[12.5px] text-text-2" data-testid="friend-fit-reasons">
          {f.fit.reasons.join(' · ')}
        </p>
      ) : null}
      {f.check && show !== 'fits' && f.check.verdict === 'good' && f.check.why.length ? (
        <FitWhy why={f.check.why} />
      ) : null}
      {f.check && show === 'fits' ? (
        <div className="mt-1 text-[12.5px]" data-testid="friend-check-why">
          {f.check.about ? <p className="text-text">{f.check.about}</p> : null}
          {f.check.why.length ? <FitWhy why={f.check.why} /> : null}
          {f.check.nextStep ? <p className="text-text-2">First step: {f.check.nextStep}</p> : null}
        </div>
      ) : null}
      {/* Research (decision 46a): the button, Researching…, or the AI's answer where the row doesn't say it. */}
      <ResearchSlot
        workspaceId={workspaceId}
        asks={asks}
        profileId={f.profileId}
        name={f.name}
        check={f.check}
        neverPitched={f.dontPitch !== null}
        showResult={show !== 'fits'}
        badge={f.check?.verdict !== 'good'}
      />
      {show === 'requests' && f.intro.length ? (
        <p className="mt-1 text-[12.5px] text-text-3">{f.intro.join(' · ')}</p>
      ) : null}
      {f.dontPitch ? (
        <p className="mt-1 text-[12.5px] text-text-3">{dontPitchWords(f.dontPitch)}</p>
      ) : null}
    </li>
  );
}

/**
 * Why the AI found someone a good fit or might fit (`outreach.check.save` keeps up to three lines): the first line,
 * and the rest on **More**.
 */
function FitWhy({ why }: { why: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const more = why.length > 1 || (why[0]?.length ?? 0) > 110;
  return (
    <div
      className="mt-0.5 flex items-baseline gap-2 text-[12.5px] text-text-2"
      data-testid="friend-check-why-line"
    >
      <span className={open ? 'min-w-0' : 'min-w-0 truncate'}>
        {open ? why.join(' · ') : why[0]}
      </span>
      {more ? (
        <button
          type="button"
          className="shrink-0 text-[12px] text-accent-text hover:underline"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Less' : 'More'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Checking the person's friends and chats for good fits (decision 46): how far it has come, today's against the
 * day's, and **Check my friends**, which asks their computer to read the next ones' profiles for the AI.
 */
function ChecksCard({
  workspaceId,
  friends,
  asks,
}: {
  workspaceId: string;
  friends: Friends;
  asks: Asks;
}) {
  const words = checksWords(friends.checks);
  const room = friends.checks.today < friends.checks.perDay;
  return (
    <Card className="p-4" data-testid="friends-checks">
      <h3 className="text-[15px] font-semibold">{CHECKS_WORDS.title}</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">{CHECKS_WORDS.note}</p>
      {friends.checks.people ? (
        <>
          <p className="mt-3 text-[13px] text-text-2" data-testid="friends-checks-progress">
            {words.progress}
          </p>
          <p className="mt-0.5 text-[12.5px] text-text-3">{words.today}</p>
        </>
      ) : (
        <p className="mt-3 text-[12.5px] text-text-2">{CHECKS_WORDS.none}</p>
      )}
      <div className="mt-3">
        <AskButton
          workspaceId={workspaceId}
          asks={asks}
          ask={{ kind: 'checks' }}
          label={CHECKS_WORDS.button}
          disabled={!room || !friends.checks.people}
          testId="ask-checks"
        />
      </div>
      <p className="mt-2 text-[12.5px] text-text-3">{CHECKS_WORDS.daily}</p>
    </Card>
  );
}

/** How many friends the person has saved, against Facebook's cap. */
function CapCard({ counts, cap }: { counts: Counts; cap: number }) {
  const share = counts.friends / cap;
  return (
    <Card className="p-4" data-testid="friends-cap">
      <h3 className="text-[15px] font-semibold">Your friends</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">
        Facebook allows {cap.toLocaleString()}. Saved by Save my friends list, or from Facebook’s
        download file.
      </p>
      <div className="mt-3 flex items-baseline justify-between gap-2 text-[13px]">
        <span>Friends</span>
        <span
          className={cn(
            'tabular-nums',
            share >= 0.9 ? 'font-semibold text-warning-text' : 'text-text-2',
          )}
        >
          {counts.friends.toLocaleString()} of {cap.toLocaleString()}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-card-2" aria-hidden="true">
        <div
          className={cn('h-full rounded-full', share >= 0.9 ? 'bg-warning' : 'bg-accent')}
          style={{ width: `${Math.min(100, Math.round(share * 100))}%` }}
        />
      </div>
      {share >= 0.9 ? (
        <p className="mt-3 rounded-menu bg-warning-soft p-2.5 text-[12.5px] text-warning-text">
          You’re close to Facebook’s limit. Turn on Keep for the friends you’ll never unfriend, so
          making room never suggests them.
        </p>
      ) : null}
    </Card>
  );
}

/** "Mar 3, 2026". */
const dateWords = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const TIDY = {
  cancel: {
    step: 'cancel_request',
    list: 'cancel',
    title: 'Old friend requests',
    button: 'Cancel the ticked requests',
    done: 'requests cancelled',
  },
  unfriend: {
    step: 'unfriend',
    list: 'unfriend',
    title: 'Friends to unfriend',
    button: 'Unfriend the ticked',
    done: 'unfriended',
  },
} as const;

/**
 * Tidying up the person's friends (decisions 10, 12 and 17): old requests nobody answered, and friends suggested for
 * unfriending. They tick the ones to go, and their computer presses Cancel request or Unfriend on each profile,
 * slowly, in a tab they can see, stopping at today's limit and on any warning from Facebook.
 */
function TidyCard({ workspaceId, tidy, asks }: { workspaceId: string; tidy: Tidy; asks: Asks }) {
  const warnedToday = tidy.warning?.today === true || asks.warnedToday;
  return (
    <Card className="mt-4 p-4" data-testid="friends-tidy">
      <h3 className="text-[15px] font-semibold">Tidy up</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">Tick the ones to go. {TIDY_PACE_WORDS}</p>
      {tidy.warning ? (
        <p
          role="alert"
          className="mt-3 rounded-menu bg-danger-soft p-2.5 text-[12.5px] text-danger-text"
          data-testid="tidy-warning"
        >
          {warningNote(tidy.warning)}
        </p>
      ) : null}
      <div className="mt-3 grid gap-5">
        <TidyList
          workspaceId={workspaceId}
          tidy={tidy}
          asks={asks}
          kind="cancel"
          warned={warnedToday}
        />
        <TidyList
          workspaceId={workspaceId}
          tidy={tidy}
          asks={asks}
          kind="unfriend"
          warned={warnedToday}
        />
      </div>
    </Card>
  );
}

function TidyList({
  workspaceId,
  tidy,
  asks,
  kind,
  warned,
}: {
  workspaceId: string;
  tidy: Tidy;
  asks: Asks;
  kind: keyof typeof TIDY;
  warned: boolean;
}) {
  const words = TIDY[kind];
  const people = tidy[words.list].slice(0, ASK_TIDY_MOST);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const { done, most } = tidy.limits[words.step];
  const room = Math.max(0, most - done);
  const latest = latestAsk(asks, kind);
  const open = latest !== null && askOpen(latest.state);
  // Only the ones still listed count: someone done since drops off the list, and out of the ticks.
  const picked = people.filter((p) => ticked.has(p.profileId)).map((p) => p.profileId);
  const all = people.length > 0 && picked.length === people.length;
  // No more than today's limit leaves: the rest stay ticked for tomorrow.
  const sending = room > 0 ? picked.slice(0, room) : picked;
  const tick = (id: string, on: boolean) =>
    setTicked((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <section data-testid={`tidy-${kind}`}>
      <h4 className="text-[13.5px] font-semibold">
        {words.title} · {tidy.totals[words.step].toLocaleString()}
      </h4>
      <p className="mt-0.5 text-[12.5px] text-text-3">
        {kind === 'cancel'
          ? `Sent more than ${tidy.cancelAfterWeeks === 1 ? 'a week' : `${tidy.cancelAfterWeeks} weeks`} ago and not answered. Facebook pauses your requests when too many wait.`
          : `No contact either way in six months, friends for longer, and not in Contacts, a prospect, kept or on Don’t pitch. You have ${tidy.friends.toLocaleString()} of ${tidy.cap.toLocaleString()} friends.`}
      </p>
      {kind === 'unfriend' && tidy.needsFile ? (
        <p className="mt-2 text-[12.5px] text-text-2" data-testid="tidy-needs-file">
          Bring in your Facebook file first (Let the extension get your file, beside this): it says
          when you last talked to each friend.
        </p>
      ) : !people.length ? (
        <p className="mt-2 text-[12.5px] text-text-2">Nobody right now.</p>
      ) : (
        <>
          <ul className="mt-2 grid gap-1">
            {people.map((p) => (
              <li key={p.profileId} className="text-[13px]">
                <label className="flex items-baseline gap-2">
                  <input
                    type="checkbox"
                    checked={ticked.has(p.profileId)}
                    disabled={open}
                    onChange={(e) => tick(p.profileId, e.target.checked)}
                    data-testid="tidy-tick"
                  />
                  <span className="min-w-0">
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium hover:underline"
                    >
                      {p.name}
                    </a>
                    <span className="text-text-3">
                      {' · '}
                      {kind === 'cancel'
                        ? `sent ${dateWords(p.since)}`
                        : p.lastContact
                          ? `last contact ${dateWords(p.lastContact)}`
                          : 'no contact on record'}
                      {p.fit === 'good' ? ' · fits a playbook' : ''}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {tidy.totals[words.step] > people.length ? (
            <p className="mt-1 text-[12.5px] text-text-3">
              The first {people.length} shown. Do these, and the next ones show.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-start gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={open}
              onClick={() => setTicked(all ? new Set() : new Set(people.map((p) => p.profileId)))}
              data-testid={`tidy-${kind}-all`}
            >
              {all ? 'Untick all' : 'Tick all'}
            </Button>
            {picked.length ? (
              <AskButton
                workspaceId={workspaceId}
                asks={asks}
                ask={{ kind, profileIds: sending }}
                label={`${words.button} (${sending.length})`}
                variant="primary"
                disabled={room <= 0 || warned}
                showLine={false}
                testId={`ask-${kind}`}
                onAsked={() =>
                  setTicked((was) => {
                    // The ones over today's limit stay ticked for tomorrow.
                    const next = new Set(was);
                    for (const id of sending) next.delete(id);
                    return next;
                  })
                }
              />
            ) : (
              <Button size="sm" variant="primary" disabled data-testid={`ask-${kind}`}>
                {words.button}
              </Button>
            )}
          </div>
        </>
      )}
      <p className="mt-2 text-[12.5px] text-text-3">
        {room > 0
          ? `Today: ${done.toLocaleString()} of ${most.toLocaleString()} ${words.done}.`
          : `That’s today’s limit of ${most.toLocaleString()}. Carry on tomorrow.`}
      </p>
      {latest ? (
        <AskLine workspaceId={workspaceId} asks={asks} ask={latest} className="mt-2" />
      ) : null}
    </section>
  );
}
