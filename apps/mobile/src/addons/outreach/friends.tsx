import { FIT_LEVELS, type FitLevel } from '@hfos/core/addons/outreach/fit';
import {
  FRIEND_EMPTY,
  FRIEND_NO_MATCH,
  FRIEND_VIEW_KEYS,
  FRIEND_VIEWS,
  friendSinceWords,
  type FriendsOutput,
  type FriendView,
} from '@hfos/core/addons/outreach/friends';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { peopleCountsOf } from '@hfos/core/addons/outreach/people-views';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { OutreachFrame } from './frame';
import { NeedsSignal, Note, useOutreachAnswer, useOutreachContext } from './kit';
import { NetworkFilter, NetworkName } from './networks';
import { PersonMenuScope, PersonName } from './person-menu';

/**
 * The friends lists on the phone (decision 128), as the web's: People's Good fits, Friends, Requests and Sent, and under
 * Left alone Keep and Don't pitch (`?view=friends&show=…`; Never contact has its own screen, ./never-contact.tsx). Each
 * row has the person's name, which opens the person sheet, their network, how they fit, since when, and the group they
 * were found in; a friend has the Keep switch (`outreach.friend.set`). Searched by name, every network or one, Show
 * more for the next page. What reads the lists in (Save my friends list, Check my friends, the download file) stays on
 * the web and the computer. It needs signal.
 */

export const friendViewOf = (show: string | undefined): FriendView =>
  FRIEND_VIEW_KEYS.find((k) => k === show && k !== 'never_contact') ?? 'friends';

type Person = FriendsOutput['people'][number];

const FIT_TONE: Record<FitLevel, 'ok' | 'accent' | 'gray' | 'danger'> = {
  good: 'ok',
  maybe: 'accent',
  unknown: 'gray',
  skip: 'danger',
};

export function FriendsScreen({ show, q }: { show?: string; q?: string }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const view = friendViewOf(show);
  const [search, setSearch] = React.useState(q ?? '');
  const [asked, setAsked] = React.useState(q ?? '');
  const [pages, setPages] = React.useState(1);
  const [net, setNet] = React.useState<Platform | null>(null);
  React.useEffect(() => {
    const t = setTimeout(() => setAsked(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);
  React.useEffect(() => setPages(1), [asked, net]);
  const answer = useOutreachAnswer(
    async () => {
      const all: FriendsOutput[] = [];
      for (let page = 1; page <= pages; page++)
        all.push(
          unwrap(
            await api.POST('/v1/queries/outreach.friends', {
              body: {
                workspaceId: ws,
                view,
                page,
                ...(asked ? { search: asked } : {}),
                ...(net ? { platform: net } : {}),
              },
            }),
          ),
        );
      const last = all[all.length - 1]!;
      return { ...last, people: all.flatMap((a) => a.people) };
    },
    `friends:${ws}:${view}:${asked}:${pages}:${net ?? 'all'}`,
    W.rows.friends,
  );
  return (
    <PersonMenuScope
      workspaceId={ws}
      online={ctx.online}
      writesContacts={ctx.writesContacts}
      onChanged={answer.reload}
    >
      <FriendsBody
        view={view}
        net={net}
        onNet={setNet}
        search={search}
        onSearch={setSearch}
        list={answer.data}
        error={answer.error}
        onRetry={answer.reload}
        onMore={() => setPages((p) => p + 1)}
        online={ctx.online}
        onKeep={async (profileId, keep) => {
          await change('outreach.friend.set', { workspaceId: ws, profileId, keep });
          answer.reload();
        }}
      />
    </PersonMenuScope>
  );
}

export function FriendsBody({
  view,
  net = null,
  onNet,
  search,
  onSearch,
  list,
  error,
  onRetry,
  onMore,
  online,
  onKeep,
}: {
  view: FriendView;
  net?: Platform | null;
  onNet?: (net: Platform | null) => void;
  search: string;
  onSearch: (s: string) => void;
  list: FriendsOutput | null;
  error: string | null;
  onRetry: () => void;
  onMore: () => void;
  online: boolean;
  onKeep: (profileId: string, keep: boolean) => Promise<void>;
}) {
  return (
    <OutreachFrame
      page="people"
      list={{ list: 'friends', show: view }}
      counts={peopleCountsOf(list ? { friends: list.counts } : null)}
      testID="outreach-friends"
    >
      {onNet ? <NetworkFilter value={net} onChange={onNet} /> : null}
      <Input
        value={search}
        onChangeText={onSearch}
        placeholder={W.search}
        autoCorrect={false}
        testID="friends-search"
      />
      {list ? (
        list.people.length ? (
          <>
            <Note testID="friends-count">
              {`${FRIEND_VIEWS[view]} · ${list.total.toLocaleString('en-US')}`}
            </Note>
            {list.people.map((p) => (
              <FriendRow key={p.profileId} person={p} online={online} onKeep={onKeep} />
            ))}
            {list.page < list.pages ? (
              <Button variant="secondary" onPress={onMore} testID="friends-more">
                {W.more}
              </Button>
            ) : null}
          </>
        ) : (
          <Card className="gap-1.5 px-5 py-6" testID="friends-empty">
            <Text className="text-[16px] font-semibold">
              {search.trim() ? FRIEND_NO_MATCH.title(search.trim()) : FRIEND_EMPTY[view].title}
            </Text>
            <Note>{search.trim() ? FRIEND_NO_MATCH.body : FRIEND_EMPTY[view].body}</Note>
          </Card>
        )
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="friends-needs-signal" />
      ) : null}
    </OutreachFrame>
  );
}

/** Someone on a friends list: their name (the person sheet), network, fit, since when, where they were found, Keep. */
function FriendRow({
  person: p,
  online,
  onKeep,
}: {
  person: Person;
  online: boolean;
  onKeep: (profileId: string, keep: boolean) => Promise<void>;
}) {
  const [keep, setKeep] = React.useState(p.keep);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setKeep(p.keep), [p.keep]);
  const since = friendSinceWords(p);
  const flip = async (on: boolean) => {
    setKeep(on);
    setBusy(true);
    try {
      await onKeep(p.profileId, on);
    } catch (e) {
      setKeep(!on);
      toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="gap-1.5 px-4 py-3.5" testID="friend">
      <View className="flex-row flex-wrap items-center gap-2">
        <PersonName
          who={{
            profileId: p.profileId,
            name: p.name,
            url: p.url,
            platform: p.platform,
            personId: p.personId,
          }}
          ownSwitches={false}
        />
        <NetworkName platform={p.platform} />
        {p.fit ? (
          <Badge variant={FIT_TONE[p.fit.level]} testID="friend-fit">
            <Text>{FIT_LEVELS[p.fit.level]}</Text>
          </Badge>
        ) : p.mutualFriends ? (
          <Badge variant="gray" testID="friend-mutual">
            <Text>{`${p.mutualFriends.toLocaleString('en-US')} mutual`}</Text>
          </Badge>
        ) : null}
      </View>
      {p.fit?.reasons.length ? <Note>{p.fit.reasons.join(' · ')}</Note> : null}
      {since ? <Note testID="friend-since">{since}</Note> : null}
      {p.group ? <Note>{`Found in ${p.group.name ?? W.person.panel.aGroup}`}</Note> : null}
      {p.state === 'friends' || p.keep ? (
        <View className="flex-row items-center justify-between gap-3">
          <Note>{W.friendKeep}</Note>
          <Switch
            size="sm"
            label={W.friendKeepLabel(p.name)}
            checked={keep}
            disabled={busy || !online}
            onCheckedChange={(on) => void flip(on)}
            testID="friend-keep"
          />
        </View>
      ) : null}
    </Card>
  );
}
