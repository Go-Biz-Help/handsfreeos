'use client';
/**
 * Social Outreach's Friends tab (docs/outreach.md, decisions 10 to 13): where the person's own Facebook stands with
 * people, as the browser extension saved and noted it (apps/extension/README.md). Their friends against Facebook's
 * cap, the friend requests they've got in order of how each fits the playbooks in use, the requests they sent that
 * nobody has answered, the friends they keep (never suggested for unfriending), and the business's Don't pitch list.
 * Which, and a name searched for, are in the address (./address.ts), so the page asks HandsFreeOS for them.
 */
import { FIT_LEVELS, type FitLevel } from '@hfos/core/addons/outreach/fit';
import {
  DONT_PITCH_TAG,
  FRIEND_STATES,
  FRIEND_VIEW_KEYS,
  FRIEND_VIEWS,
  type FriendView,
} from '@hfos/core/addons/outreach/friends';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn, relativeTime } from '@/lib/utils';
import { outreachHref } from './address';
import type { Friend, Friends } from './types';
import { useAct } from './use-act';

type Counts = Friends['counts'];
type DontPitch = NonNullable<Friend['dontPitch']>;

const COUNTED: Record<FriendView, keyof Counts> = {
  friends: 'friends',
  requests: 'requests',
  sent: 'sent',
  keep: 'keep',
  dont_pitch: 'dontPitch',
};

/** The order each list is in. */
const ORDER: Record<FriendView, string> = {
  friends: 'By name',
  requests: 'The best fit first',
  sent: 'The oldest first',
  keep: 'By name',
  dont_pitch: 'The latest added first',
};

const EMPTY: Record<FriendView, { readonly title: string; readonly body: string }> = {
  friends: {
    title: 'No friends saved yet',
    body: 'Open your friends list on Facebook with HandsFreeOS Social, scroll to the end, and press Save my friends in its panel.',
  },
  requests: {
    title: 'No friend requests waiting',
    body: 'Open your friend requests on Facebook with HandsFreeOS Social and press Save these requests. They show here in order of how they fit your playbooks.',
  },
  sent: {
    title: 'No requests waiting on an answer',
    body: 'The friend requests you send, noted by HandsFreeOS Social, show here until they’re answered, the oldest first. For ones you sent before, open View sent requests on Facebook and press Save these sent requests.',
  },
  keep: {
    title: 'Nobody on your Keep list',
    body: 'Turn on Keep for the friends you’ll never unfriend, here or in the extension’s panel on their profile.',
  },
  dont_pitch: {
    title: 'Nobody on the Don’t pitch list',
    body: `Turn on Don’t pitch for anyone nobody here should pitch, like family and close friends. Customers tagged ${DONT_PITCH_TAG} in Contacts count too.`,
  },
};

const FIT_TONE: Record<FitLevel, BadgeVariant> = {
  good: 'ok',
  maybe: 'accent',
  unknown: 'gray',
  skip: 'danger',
};

/** "Asked · 3 d ago": when a request came or went, or was deleted. Nothing for friends, whose day isn't known. */
function sinceWords(f: Friend): string | null {
  if (!f.since) return null;
  const word =
    f.state === 'request_received'
      ? 'Asked'
      : f.state === 'request_sent'
        ? 'Sent'
        : f.state === 'declined'
          ? 'Deleted'
          : null;
  return word ? `${word} · ${relativeTime(f.since)}` : null;
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

function doneWords(name: string, change: { keep?: boolean; dontPitch?: boolean }): string {
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
  show,
  search,
}: {
  workspaceId: string;
  businessName: string;
  friends: Friends;
  show: FriendView;
  search: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (to: { show?: FriendView; search?: string }) =>
    startTransition(() =>
      router.replace(
        outreachHref(workspaceId, {
          view: 'friends',
          show: to.show ?? show,
          search: to.search ?? search,
        }),
        { scroll: false },
      ),
    );
  const { busy, act } = useAct();
  const set = (f: Friend, change: { keep?: boolean; dontPitch?: boolean }) =>
    act(
      `set:${f.profileId}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.friend.set', {
            body: { workspaceId, profileId: f.profileId, ...change },
          }),
        ),
      doneWords(f.name, change),
    );
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
        <SearchBox key={search} search={search} onSearch={(s) => go({ search: s })} />
      </div>
      <div
        className={cn(
          'grid gap-4 transition-opacity lg:grid-cols-[minmax(0,1fr)_300px]',
          pending && 'opacity-60',
        )}
        aria-busy={pending || undefined}
      >
        <div className="min-w-0">
          {friends.people.length ? (
            <Card className="p-0" data-testid="friends-list">
              <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
                <h3 className="text-[15px] font-semibold">{FRIEND_VIEWS[show]}</h3>
                <span className="text-[12.5px] text-text-3">{ORDER[show]}</span>
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
                    busy={busy === `set:${f.profileId}`}
                    onSet={(change) => void set(f, change)}
                  />
                ))}
              </ul>
              {friends.more ? (
                <p className="border-t border-border px-5 py-3 text-[12.5px] text-text-3">
                  And {friends.more.toLocaleString()} more, not shown. Search for a name to find
                  them.
                </p>
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
        </div>
        <aside className="space-y-4">
          <CapCard counts={friends.counts} cap={friends.cap} />
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

/** Part of a name, looked for when Enter is pressed. */
function SearchBox({ search, onSearch }: { search: string; onSearch: (s: string) => void }) {
  const [typed, setTyped] = useState(search);
  return (
    <form
      role="search"
      className="w-full sm:w-[240px]"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(typed.trim());
      }}
    >
      <Input
        type="search"
        inputSize="sm"
        aria-label="Search by name"
        placeholder="Search by name"
        value={typed}
        maxLength={100}
        onChange={(e) => {
          setTyped(e.target.value);
          // Clearing the box shows everyone again.
          if (!e.target.value && search) onSearch('');
        }}
        data-testid="friends-search"
      />
    </form>
  );
}

function FriendRow({
  workspaceId,
  friend: f,
  show,
  busy,
  onSet,
}: {
  workspaceId: string;
  friend: Friend;
  show: FriendView;
  busy: boolean;
  onSet: (change: { keep?: boolean; dontPitch?: boolean }) => void;
}) {
  const since = sinceWords(f);
  const listed = f.dontPitch !== null && f.dontPitch.at !== null;
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
          {since ? <span className="ml-2 text-[12.5px] text-text-3">{since}</span> : null}
          {f.group ? (
            <div className="text-[12.5px] text-text-3">Found in {groupName(f.group)}</div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-text-2">
          {f.state === 'friends' || f.keep ? (
            <span className="inline-flex items-center gap-2">
              <Switch
                checked={f.keep}
                onChange={(keep) => onSet({ keep })}
                label={`Keep ${f.name}: never suggest unfriending them`}
                disabled={busy}
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
              disabled={busy}
              testId="friend-dont-pitch"
            />
            Don’t pitch
          </span>
        </div>
      </div>
      {f.fit || state || mutual ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {f.fit ? (
            <Badge variant={FIT_TONE[f.fit.level]} data-testid="friend-fit">
              {FIT_LEVELS[f.fit.level]}
              {f.fit.playbookName ? ` · ${f.fit.playbookName}` : ''}
            </Badge>
          ) : null}
          {state ? (
            <Badge variant={state === 'friends' ? 'ok' : 'gray'}>{FRIEND_STATES[state]}</Badge>
          ) : null}
          {mutual ? <Badge>{mutual.toLocaleString()} mutual</Badge> : null}
        </div>
      ) : null}
      {f.fit?.reasons.length ? (
        <p className="mt-1 text-[12.5px] text-text-2" data-testid="friend-fit-reasons">
          {f.fit.reasons.join(' · ')}
        </p>
      ) : null}
      {show === 'requests' && f.intro.length ? (
        <p className="mt-1 text-[12.5px] text-text-3">{f.intro.join(' · ')}</p>
      ) : null}
      {f.dontPitch ? (
        <p className="mt-1 text-[12.5px] text-text-3">{dontPitchWords(f.dontPitch)}</p>
      ) : null}
    </li>
  );
}

/** How many friends the person has saved, against Facebook's cap. */
function CapCard({ counts, cap }: { counts: Counts; cap: number }) {
  const share = counts.friends / cap;
  return (
    <Card className="p-4" data-testid="friends-cap">
      <h3 className="text-[15px] font-semibold">Your friends</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">
        Facebook allows {cap.toLocaleString()}. Saved from your friends list with the extension.
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
