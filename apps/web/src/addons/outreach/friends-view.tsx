'use client';
/**
 * Social Outreach's Friends tab (docs/outreach.md, decisions 10 to 13): where the person's own Facebook stands with
 * people, as the browser extension saved and noted it (apps/extension/README.md). Their friends against Facebook's
 * cap, the good fits the AI found among their friends and chats (decision 46, **Check my friends**), the friend
 * requests they've got in order of how each fits the playbooks in use, the requests they sent that nobody has
 * answered, the friends they keep (never suggested for unfriending), and the business's Don't pitch and Never contact
 * lists.
 * Which, a name searched for and the page are in the address (./address.ts), so the page asks HandsFreeOS for them.
 * The list follows the search box as a name is typed, a page at a time. Facebook's download file, brought in from
 * the side (./download-card.tsx), adds since when they've been friends and the latest message.
 */
import {
  ASK_TIDY_MOST,
  ASK_WORDS,
  askableOn,
  askOpen,
  type TIDY_ASK_KINDS,
} from '@hfos/core/addons/outreach/asks';
import {
  CHECK_VERDICTS,
  CHECKS_WORDS,
  checksAgainDone,
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
import { saveListOn, tidyWordsOn } from '@hfos/core/addons/outreach/network-words';
import { NETWORKS, PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { OUTREACH_WORDS } from '@hfos/core/addons/outreach/words';
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
import { AskButton, AskLine, latestAskOn } from './asks';
import { CancelAllBox } from './cancel-all';
import { SkippedCountryCard } from './country-skipped';
import { DownloadCard } from './download-card';
import { FileAsksCard } from './file-asks';
import { PersonName } from './person-menu';
import { ResearchSlot } from './research';
import type { Asks, Friend, Friends, Tidy } from './types';
import { useAct } from './use-act';

type Counts = Friends['counts'];
type DontPitch = NonNullable<Friend['dontPitch']>;
type NeverContact = NonNullable<Friend['neverContact']>;

const COUNTED: Record<FriendView, keyof Counts> = {
  friends: 'friends',
  fits: 'fits',
  requests: 'requests',
  sent: 'sent',
  keep: 'keep',
  dont_pitch: 'dontPitch',
  never_contact: 'neverContact',
};

/** The order each list is in. */
const ORDER: Record<FriendView, string> = {
  friends: 'By name',
  fits: 'The good fits first',
  requests: 'The best fit first',
  sent: 'The oldest first',
  keep: 'By name',
  dont_pitch: 'The latest added first',
  never_contact: 'The latest added first',
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
  never_contact: {
    title: 'Nobody on the Never contact list',
    body: 'Turn on Never contact for anyone nobody here should deal with at all: no friend request, like, comment or message, not even a reply, and their friend requests are never confirmed.',
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

/** Who put someone on Never contact, and when. */
function neverContactWords(n: NeverContact): string {
  return `On Never contact${n.by ? `, added by ${n.by}` : ''}${n.at ? ` · ${relativeTime(n.at)}` : ''}. Nobody here reaches them at all.`;
}

/** Keep, Don't pitch or Never contact as switched on a row. */
type Flip = { keep?: boolean; dontPitch?: boolean; neverContact?: boolean };
const FLIPS = ['keep', 'dontPitch', 'neverContact'] as const;

function doneWords(name: string, change: Flip): string {
  if (change.neverContact === true) return OUTREACH_WORDS.person.neverContactDone(name);
  if (change.neverContact === false) return OUTREACH_WORDS.person.neverContactOff(name);
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
  net = null,
  asks,
}: {
  workspaceId: string;
  businessName: string;
  friends: Friends;
  tidy: Tidy;
  show: FriendView;
  search: string;
  /** The network it's narrowed to: null for every network. */
  net?: Platform | null;
  /** What the person asked their computer to do on this tab. */
  asks: Asks;
}) {
  // An ask's progress and end: what it saved shows once it ends.
  useLiveRefresh(['outreach_ask'], 800);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The list and name last asked for, ahead of the address while it loads: a name typed as another list opens is
  // looked for in that list. Another list or another name starts again at the first page.
  const asked = useRef({ show, search, net });
  useEffect(() => {
    asked.current = { show, search, net };
  }, [show, search, net]);
  const go = (to: { show?: FriendView; search?: string; page?: number }) => {
    asked.current = {
      show: to.show ?? asked.current.show,
      search: to.search ?? asked.current.search,
      net: asked.current.net,
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
        for (const k of FLIPS)
          if (flip[k] !== undefined && waiting.current.get(`${id}:${k}`)) still[k] = flip[k];
        if (FLIPS.some((k) => still[k] !== undefined)) kept[id] = still;
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
  // The asks are the network shown's: Facebook's when the list is every network's.
  const asking = net ?? 'facebook';
  const words = NETWORKS[asking].words;
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
        <h3 className="text-[15px] font-semibold">{`From ${PLATFORMS[asking]}`}</h3>
        <p className="mt-0.5 text-[12.5px] text-text-3">{ASK_WORDS.fromFacebookNote}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <AskButton
            workspaceId={workspaceId}
            asks={asks}
            ask={{ kind: 'requests' }}
            platform={asking}
            label={`Check my ${words.friendRequests}`}
            testId="ask-requests"
          />
          <AskButton
            workspaceId={workspaceId}
            asks={asks}
            ask={{ kind: 'friends' }}
            platform={asking}
            label={saveListOn(asking)}
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
          {/* Each network's own tidying: LinkedIn withdraws old invitations, and never removes a connection. */}
          {tidyWordsOn(asking).kinds.length ? (
            <TidyCard workspaceId={workspaceId} platform={asking} tidy={tidy} asks={asks} />
          ) : null}
          <SkippedCountryCard workspaceId={workspaceId} />
        </div>
        <aside className="space-y-4">
          <ChecksCard workspaceId={workspaceId} friends={friends} asks={asks} platform={asking} />
          <CapCard counts={friends.counts} cap={friends.cap} platform={asking} />
          {/* The download file is Facebook's alone yet: shown where it can be asked for. */}
          {askableOn(asking, 'file_in') ? (
            <>
              <FileAsksCard workspaceId={workspaceId} asks={asks} />
              <DownloadCard workspaceId={workspaceId} download={friends.download} />
            </>
          ) : null}
          <Card className="p-4">
            <h3 className="text-[15px] font-semibold">Yours, and the business’s</h3>
            <p className="mt-1.5 text-[13px] text-text-2">
              Your friends and requests are your own: each teammate sees theirs. The Don’t pitch
              list is {businessName}’s, and says who added each person. Nobody here sends friend
              requests, likes, comments or messages to anyone on it, and only whoever added someone,
              or an owner or admin, takes them off. Never contact is the business’s too, and goes
              further: no reply either, their friend requests are never confirmed, and their
              messages don’t buzz your phone.
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
  const off = flip?.neverContact ?? f.neverContact !== null;
  // Where you stand, where the list doesn't say: Don't pitch, Never contact, or a friend kept who isn't one now.
  const state =
    f.state &&
    (show === 'dont_pitch' ||
      show === 'never_contact' ||
      (show === 'keep' && f.state !== 'friends'))
      ? f.state
      : null;
  const mutual = f.fit ? null : f.mutualFriends;
  return (
    <li className="border-t border-border px-5 py-3" data-testid="friend">
      {/* The switches sit on the name's line; they say whether someone's kept or not pitched. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 text-[13.5px]">
          {/* The name opens the person menu (decision 91): their page, Contacts, Client and Demo booked; Don't pitch
              and Never contact have their switches here. */}
          <PersonName
            workspaceId={workspaceId}
            who={{
              profileId: f.profileId,
              name: f.name,
              platform: f.platform,
              url: f.url,
              personId: f.personId,
            }}
            ownSwitches
            className={cn('font-medium', f.personId && 'text-accent-text')}
          />
          <a
            href={f.url}
            target="_blank"
            rel="noreferrer"
            className="ml-2 text-[12.5px] text-text-3 hover:underline"
            data-testid="network-name"
          >
            {PLATFORMS[f.platform]}
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
          <span className="inline-flex items-center gap-2">
            <Switch
              checked={off}
              onChange={(neverContact) => onSet({ neverContact })}
              label={`Never contact ${f.name}`}
              testId="friend-never-contact"
            />
            Never contact
          </span>
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
        platform={f.platform}
        name={f.name}
        check={f.check}
        neverPitched={f.dontPitch !== null || f.neverContact !== null}
        showResult={show !== 'fits'}
        badge={f.check?.verdict !== 'good'}
      />
      {show === 'requests' && f.intro.length ? (
        <p className="mt-1 text-[12.5px] text-text-3">{f.intro.join(' · ')}</p>
      ) : null}
      {f.dontPitch ? (
        <p className="mt-1 text-[12.5px] text-text-3">{dontPitchWords(f.dontPitch)}</p>
      ) : null}
      {f.neverContact ? (
        <p className="mt-1 text-[12.5px] text-text-3" data-testid="friend-never-contact-words">
          {neverContactWords(f.neverContact)}
        </p>
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
 * day's, and **Check my friends**, which asks their computer to read the next ones' profiles for the AI. **Check
 * everyone again** puts everyone checked before back on that list.
 */
function ChecksCard({
  workspaceId,
  friends,
  asks,
  platform,
}: {
  workspaceId: string;
  friends: Friends;
  asks: Asks;
  /** The network the checks are asked on. */
  platform: Platform;
}) {
  const words = checksWords(friends.checks);
  const room = friends.checks.today < friends.checks.perDay;
  const { busy, act } = useAct();
  const checkAgain = () =>
    act('checks-again', async () => {
      const { again } = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.checks.again', { body: { workspaceId } }),
      );
      toast.success(checksAgainDone(again, friends.checks.perDay));
    });
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
          platform={platform}
          label={CHECKS_WORDS.button}
          disabled={!room || !friends.checks.people}
          testId="ask-checks"
        />
      </div>
      <p className="mt-2 text-[12.5px] text-text-3">{CHECKS_WORDS.daily}</p>
      {friends.checks.checked ? (
        <div className="mt-3 border-t border-border pt-3">
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'checks-again'}
            onClick={checkAgain}
            data-testid="checks-again"
          >
            {CHECKS_WORDS.again}
          </Button>
          <p className="mt-1.5 text-[12.5px] text-text-3">{CHECKS_WORDS.againNote}</p>
        </div>
      ) : null}
    </Card>
  );
}

/** How many friends or connections the person has saved, against their network's cap. */
function CapCard({ counts, cap, platform }: { counts: Counts; cap: number; platform: Platform }) {
  const share = counts.friends / cap;
  const { name, words } = NETWORKS[platform];
  const many = `${words.friends.charAt(0).toUpperCase()}${words.friends.slice(1)}`;
  return (
    <Card className="p-4" data-testid="friends-cap">
      <h3 className="text-[15px] font-semibold">{`Your ${words.friends}`}</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">
        {`${name} allows ${cap.toLocaleString()}. Saved by Save my ${words.friends} list, or from ${name}’s download file.`}
      </p>
      <div className="mt-3 flex items-baseline justify-between gap-2 text-[13px]">
        <span>{many}</span>
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
          {`You’re close to ${name}’s limit. Turn on Keep for the ${words.friends} you’ll never remove, so making room never suggests them.`}
        </p>
      ) : null}
    </Card>
  );
}

/** "Mar 3, 2026". */
const dateWords = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

type TidyAsk = (typeof TIDY_ASK_KINDS)[number];

/**
 * Tidying up the person's friends on a network (decisions 10, 12 and 17), in its words: old requests nobody answered,
 * and friends suggested for unfriending, where the network has each (LinkedIn withdraws old invitations, and never
 * removes a connection). They tick the ones to go, and their computer presses Cancel request, Withdraw or Unfriend on
 * each profile, slowly, in a tab they can see, stopping at today's limit there and on any warning from that network.
 * Or Cancel all, for every request waiting however new (decision 121, ./cancel-all.tsx).
 */
function TidyCard({
  workspaceId,
  platform,
  tidy,
  asks,
}: {
  workspaceId: string;
  platform: Platform;
  tidy: Tidy;
  asks: Asks;
}) {
  const T = tidyWordsOn(platform);
  // Facebook's warning today is on the asks; any network's is on its own tidy answer.
  const warnedToday = tidy.warning?.today === true || (platform === 'facebook' && asks.warnedToday);
  return (
    <Card className="mt-4 p-4" data-testid="friends-tidy">
      <h3 className="text-[15px] font-semibold">{T.title}</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">{T.about}</p>
      {tidy.warning ? (
        <p
          role="alert"
          className="mt-3 rounded-menu bg-danger-soft p-2.5 text-[12.5px] text-danger-text"
          data-testid="tidy-warning"
        >
          {warningNote(tidy.warning, Date.now(), platform)}
        </p>
      ) : null}
      <div className="mt-3 grid gap-5">
        {T.kinds.map((kind) => (
          <TidyList
            key={kind}
            workspaceId={workspaceId}
            platform={platform}
            tidy={tidy}
            asks={asks}
            kind={kind}
            warned={warnedToday}
          />
        ))}
      </div>
    </Card>
  );
}

function TidyList({
  workspaceId,
  platform,
  tidy,
  asks,
  kind,
  warned,
}: {
  workspaceId: string;
  platform: Platform;
  tidy: Tidy;
  asks: Asks;
  kind: TidyAsk;
  warned: boolean;
}) {
  const T = tidyWordsOn(platform);
  const words = T[kind];
  const step = T.step[kind];
  const people = tidy[kind].slice(0, ASK_TIDY_MOST);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const { done, most } = tidy.limits[step];
  const room = Math.max(0, most - done);
  const latest = latestAskOn(asks, platform, kind);
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
        {words.title} · {tidy.totals[step].toLocaleString()}
      </h4>
      <p className="mt-0.5 text-[12.5px] text-text-3">
        {kind === 'cancel'
          ? T.cancel.about(tidy.cancelAfterWeeks)
          : T.unfriend.about(tidy.friends, tidy.cap)}
      </p>
      {kind === 'cancel' ? (
        <CancelAllBox
          workspaceId={workspaceId}
          platform={platform}
          tidy={tidy}
          asks={asks}
          warned={warned}
        />
      ) : null}
      {kind === 'unfriend' && tidy.needsFile ? (
        <p className="mt-2 text-[12.5px] text-text-2" data-testid="tidy-needs-file">
          {T.unfriend.needsFile}
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
                        ? `${T.cancel.since} ${dateWords(p.since)}`
                        : p.lastContact
                          ? `last contact ${dateWords(p.lastContact)}`
                          : 'no contact on record'}
                      {p.fit === 'good' ? ' · fits a playbook' : ''}
                      {p.going && T.all ? ` · ${T.all.marked}` : ''}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {tidy.totals[step] > people.length ? (
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
                platform={platform}
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
