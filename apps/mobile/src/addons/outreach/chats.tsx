import { ASK_WORDS, READ_CHATS_WORDS, type AsksOutput } from '@hfos/core/addons/outreach/asks';
import {
  CHAT_VIEW_KEYS,
  CHAT_VIEWS,
  type ChatsOutput,
  type ChatView,
} from '@hfos/core/addons/outreach/chat-read';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { chatUrlOn, openChatWords } from '@hfos/core/addons/outreach/network-words';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { ExternalLink, UserRound } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { openWebPath } from '@/home/open';
import { api, errorMessage, unwrap } from '@/lib/api';

import { OutreachFrame } from './frame';
import {
  AskButton,
  ComputerNote,
  useAskActions,
  useAsks,
  useDoneReload,
  type AskActions,
} from './asks';
import { NeedsSignal, Note, openOutside, useOutreachAnswer, useOutreachContext } from './kit';
import { NetworkFilter, NetworkName } from './networks';
import { PersonMenuScope, PersonName } from './person-menu';

/**
 * Chats on the phone (decision 44): the person's Facebook chats the AI read, likely prospects first, with each one's
 * summary, tags and next step; by tag, searched by name, Show more for the next page. Each opens in Messenger, and in
 * Customers once it went in Contacts. **Read my chats** asks the person's computer to read them (decision 43,
 * ./asks.tsx). Every network's chats, each naming its network and opening in its messaging, or one network's; Read my
 * chats asks the network shown, Facebook's when the list is every network's. It needs signal. The name of who a chat
 * is with, once they're kept as a profile, opens the person menu (./person-menu.tsx), without its Don't pitch and Never
 * contact: the chat has its own switches.
 */

export const chatViewOf = (show: string | undefined): ChatView =>
  CHAT_VIEW_KEYS.find((k) => k === show) ?? 'prospects';

export function ChatsScreen({ show, tag, q }: { show?: string; tag?: string; q?: string }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const [view, setView] = React.useState<ChatView>(chatViewOf(show));
  const [theTag, setTag] = React.useState(tag ?? '');
  const [search, setSearch] = React.useState(q ?? '');
  const [asked, setAsked] = React.useState(q ?? '');
  const [pages, setPages] = React.useState(1);
  const [net, setNet] = React.useState<Platform | null>(null);
  React.useEffect(() => {
    const t = setTimeout(() => setAsked(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);
  React.useEffect(() => setPages(1), [view, asked, theTag, net]);
  const answer = useOutreachAnswer(
    async () => {
      const all: ChatsOutput[] = [];
      for (let page = 1; page <= pages; page++)
        all.push(
          unwrap(
            await api.POST('/v1/queries/outreach.chats', {
              body: {
                workspaceId: ws,
                view,
                page,
                ...(asked ? { search: asked } : {}),
                ...(theTag ? { tag: theTag } : {}),
                ...(net ? { platform: net } : {}),
              },
            }),
          ),
        );
      const last = all[all.length - 1]!;
      return { ...last, chats: all.flatMap((a) => a.chats) };
    },
    `chats:${ws}:${view}:${theTag}:${asked}:${pages}:${net ?? 'all'}`,
    W.rows.chats,
  );
  const asks = useAsks('chats', W.rows.chats);
  const actions = useAskActions(asks.data, asks.reload);
  useDoneReload(asks.data, answer.reload);
  return (
    <PersonMenuScope
      workspaceId={ws}
      online={ctx.online}
      writesContacts={ctx.writesContacts}
      onChanged={answer.reload}
    >
      <ChatsBody
        view={view}
        onView={setView}
        net={net}
        onNet={setNet}
        tag={theTag}
        onTag={setTag}
        search={search}
        onSearch={setSearch}
        chats={answer.data}
        error={answer.error}
        onRetry={answer.reload}
        onMore={() => setPages((p) => p + 1)}
        onCustomer={(personId) => openWebPath(`/app/w/${ws}/customers/people/${personId}`)}
        online={ctx.online}
        onMark={async (profileId, marks) => {
          await change('outreach.friend.set', { workspaceId: ws, profileId, ...marks });
          answer.reload();
        }}
        asks={asks.data}
        actions={actions}
      />
    </PersonMenuScope>
  );
}

export function ChatsBody({
  view,
  onView,
  net = null,
  onNet,
  tag,
  onTag,
  search,
  onSearch,
  chats,
  error,
  onRetry,
  onMore,
  onCustomer,
  online = true,
  onMark,
  asks = null,
  actions,
}: {
  view: ChatView;
  onView: (v: ChatView) => void;
  /** The network it's narrowed to: null for every network. */
  net?: Platform | null;
  onNet?: (net: Platform | null) => void;
  tag: string;
  onTag: (t: string) => void;
  search: string;
  onSearch: (s: string) => void;
  chats: ChatsOutput | null;
  error: string | null;
  onRetry: () => void;
  onMore: () => void;
  onCustomer: (personId: string) => void;
  /** With no signal, Don't pitch and Never contact can't be switched: they need it there and then. */
  online?: boolean;
  /** Don't pitch or Never contact for who a chat is with (`outreach.friend.set`); left out, the switches don't show. */
  onMark?: (profileId: string, marks: Marks) => Promise<void>;
  /** What the person asked their computer here, with signal; the button shows once it's known. */
  asks?: AsksOutput | null;
  actions?: AskActions;
}) {
  const empty = search.trim() || tag ? W.chatsNoMatch : W.chatsEmpty[view];
  return (
    <OutreachFrame page="people" people="chats" testID="outreach-chats">
      {asks && actions ? (
        <Card className="gap-2 px-4 py-3.5" testID="chats-asks">
          <ComputerNote asks={asks} />
          <AskButton
            asks={asks}
            actions={actions}
            ask={{ kind: 'chats' }}
            {...(net ? { platform: net } : {})}
            label={ASK_WORDS.readChats}
            testID="ask-chats"
          />
          <Note>{READ_CHATS_WORDS}</Note>
        </Card>
      ) : null}
      <Segmented
        value={view}
        onChange={onView}
        label={W.rows.chats}
        options={CHAT_VIEW_KEYS.map((k) => ({
          value: k,
          label: CHAT_VIEWS[k],
          testID: `chats-view-${k}`,
        }))}
      />
      {onNet ? <NetworkFilter value={net} onChange={onNet} /> : null}
      <Input
        value={search}
        onChangeText={onSearch}
        placeholder={W.search}
        autoCorrect={false}
        testID="chats-search"
      />
      {chats?.tags.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-1.5">
            <Button
              size="sm"
              variant={tag ? 'ghost' : 'secondary'}
              onPress={() => onTag('')}
              testID="chats-tag-all"
            >
              {W.allTags}
            </Button>
            {chats.tags.map((t) => (
              <Button
                key={t.name}
                size="sm"
                variant={tag === t.name ? 'secondary' : 'ghost'}
                onPress={() => onTag(t.name)}
                testID="chats-tag"
              >
                {`${t.name} ${t.count}`}
              </Button>
            ))}
          </View>
        </ScrollView>
      ) : null}
      {chats ? (
        chats.chats.length ? (
          <>
            {chats.chats.map((c) => {
              const link = chatUrlOn(c.platform, c.threadKey);
              return (
                <Card key={c.chatId} className="gap-1.5 px-4 py-3.5" testID="chats-item">
                  <View className="flex-row flex-wrap items-center gap-2">
                    <PersonName
                      who={{
                        profileId: c.profileId,
                        name: c.name,
                        url: null,
                        platform: c.platform,
                        threadKey: c.threadKey,
                        personId: c.personId,
                      }}
                      ownSwitches
                    />
                    <NetworkName platform={c.platform} />
                    {c.personId ? (
                      <Badge variant="accent">
                        <Text>{W.inContacts}</Text>
                      </Badge>
                    ) : null}
                  </View>
                  {c.summary ? (
                    <Text className="text-[14px] leading-[20px]">{c.summary}</Text>
                  ) : null}
                  {c.tags.length ? <Note>{c.tags.join(' · ')}</Note> : null}
                  {c.nextStep ? <Note>{`${W.nextStepLabel}: ${c.nextStep}`}</Note> : null}
                  {onMark && c.profileId ? (
                    <ChatMarks chat={c} online={online} onMark={onMark} />
                  ) : null}
                  <View className="flex-row flex-wrap gap-2">
                    {link ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={ExternalLink}
                        onPress={() => openOutside(link)}
                      >
                        {openChatWords(c.platform)}
                      </Button>
                    ) : null}
                    {c.personId ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={UserRound}
                        onPress={() => onCustomer(c.personId!)}
                        testID="chats-customer"
                      >
                        {W.openCustomer}
                      </Button>
                    ) : null}
                  </View>
                </Card>
              );
            })}
            {chats.page < chats.pages ? (
              <Button variant="secondary" onPress={onMore} testID="chats-more">
                {W.more}
              </Button>
            ) : null}
          </>
        ) : (
          <Card className="gap-1.5 px-5 py-6" testID="chats-empty">
            <Text className="text-[16px] font-semibold">{empty.title}</Text>
            <Note>{empty.body}</Note>
          </Card>
        )
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="chats-needs-signal" />
      ) : null}
    </OutreachFrame>
  );
}

/** Don't pitch or Never contact as switched on a chat. */
type Marks = { dontPitch?: boolean; neverContact?: boolean };

/**
 * Don't pitch and Never contact for the person a chat is with, as the web's Chats tab and Friends rows have them: each
 * flips at once and goes to HandsFreeOS (`outreach.friend.set`, with signal only), flipping back with why if it's
 * refused. The words are core's (`OUTREACH_WORDS.person`).
 */
function ChatMarks({
  chat: c,
  online,
  onMark,
}: {
  chat: ChatsOutput['chats'][number];
  online: boolean;
  onMark: (profileId: string, marks: Marks) => Promise<void>;
}) {
  const [flipped, setFlipped] = React.useState<Marks>({});
  React.useEffect(() => setFlipped({}), [c.dontPitch, c.neverContact]);
  const set = async (marks: Marks) => {
    setFlipped((was) => ({ ...was, ...marks }));
    try {
      await onMark(c.profileId!, marks);
      toast.show(
        marks.neverContact === true
          ? W.person.neverContactDone(c.name)
          : marks.neverContact === false
            ? W.person.neverContactOff(c.name)
            : marks.dontPitch
              ? W.person.dontPitchDone(c.name)
              : W.person.dontPitchOff(c.name),
      );
    } catch (e) {
      setFlipped((was) => {
        const back = { ...was };
        for (const k of Object.keys(marks) as (keyof Marks)[]) delete back[k];
        return back;
      });
      toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
    }
  };
  const rows: { key: keyof Marks; label: string; on: boolean }[] = [
    { key: 'dontPitch', label: W.person.dontPitch, on: flipped.dontPitch ?? c.dontPitch },
    {
      key: 'neverContact',
      label: W.person.neverContact,
      on: flipped.neverContact ?? c.neverContact,
    },
  ];
  return (
    <View className="gap-1.5">
      {rows.map((r) => (
        <View key={r.key} className="flex-row items-center justify-between gap-3">
          <Text className="text-[14px]">{r.label}</Text>
          <Switch
            size="sm"
            label={`${r.label} ${c.name}`}
            checked={r.on}
            disabled={!online}
            onCheckedChange={(on) => void set({ [r.key]: on })}
            testID={r.key === 'dontPitch' ? 'chats-dont-pitch' : 'chats-never-contact'}
          />
        </View>
      ))}
      {!online ? <Note>{W.person.switchesNeedSignal}</Note> : null}
    </View>
  );
}
