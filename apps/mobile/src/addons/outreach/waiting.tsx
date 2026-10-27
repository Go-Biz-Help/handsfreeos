import { wheelsWords } from '@hfos/core/addons/outreach/automation';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import {
  chatUrlOn,
  networkOfUrl,
  networkOfWaiting,
  openChatWords,
  openPageWords,
  todayKindsOn,
} from '@hfos/core/addons/outreach/network-words';
import { networkOfLink } from '@hfos/core/addons/outreach/networks';
import {
  recentBubbles,
  RECENT_WORDS,
  SendText,
  type RecentMessage,
} from '@hfos/core/addons/outreach/sends';
import {
  approveAllFromPhone,
  type PhoneSend,
  type PhoneWaiting,
} from '@hfos/core/addons/outreach/views/waiting';
import type { WaitingOutput } from '@hfos/core/addons/outreach/waiting';
import {
  approveAllWords,
  moreWords,
  NEED_CLEARS,
  needClearedWords,
  needTitle,
  needWhyWords,
  oneByOneWords,
  WAITING_KINDS,
  waitingWords,
  type NeedClear,
} from '@hfos/core/addons/outreach/waiting-words';
import { seenWords } from '@hfos/core/addons/outreach/live';
import * as React from 'react';
import { View } from 'react-native';

import { ChangeError } from '@/changes';
import { Check, CheckCheck, ExternalLink, Pencil, X } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { clearNeed, okAll, okSend, setAside, skipSend } from './actions';
import { AskLine, useAskActions, type AskActions } from './asks';
import { ChatBubbles } from './chat-bubbles';
import { useOutreachWaiting } from './copy';
import { NetworkName } from './networks';
import { PersonName } from './person-menu';
import {
  NeedsSignal,
  Note,
  openOutside,
  openSettingsPart,
  useOutreachAnswer,
  useOutreachContext,
} from './kit';

/**
 * Waiting for you on the phone (decision 44, owner answer 19b): the person's messages waiting for their OK come from
 * the phone's own copy, so they read, OK, change, skip and Approve all with no signal; each goes to HandsFreeOS when
 * the phone's back online. What they asked their computer that needs them there (decision 43, with **Carry on**,
 * **Skip** and **Stop**), the steps it needs them for and the friend requests to decide come from HandsFreeOS, with
 * signal, and the screen says so plainly without.
 *
 * Each card's name opens the person menu (decision 91, ./person-menu.tsx) inside the `PersonMenuScope` Today's tab puts
 * around it: their page first, then Contacts, Mark as client, Don't pitch, Never contact and the rest. Each card keeps
 * its own Open button.
 */

type Asked = Extract<WaitingOutput['items'][number], { kind: 'ask' }>['ask'];
type Need = Extract<WaitingOutput['items'][number], { kind: 'need' }>['need'];
type Request = Extract<WaitingOutput['items'][number], { kind: 'request' }>['request'];

/**
 * What the server adds to the phone's list: what the computer needs them for, the steps, the friend requests, the
 * training wheels and the pushes.
 */
export interface WaitingFromServer {
  readonly asks: readonly Asked[];
  readonly needs: readonly Need[];
  readonly requests: readonly Request[];
  readonly kinds: Pick<WaitingOutput['kinds'], 'ask' | 'need' | 'request'>;
  readonly wheels: WaitingOutput['wheels'];
  readonly pushes: WaitingOutput['pushes'];
  /** Each message's chat so far, by its id: with signal only, since the phone's copy doesn't keep chats. */
  readonly recent: ReadonlyMap<string, readonly RecentMessage[]>;
}

export function serverPart(answer: WaitingOutput): WaitingFromServer {
  return {
    recent: new Map(
      answer.items.flatMap((i) =>
        i.kind === 'reply' || i.kind === 'message' ? [[i.send.sendId, i.send.recent] as const] : [],
      ),
    ),
    asks: answer.items.flatMap((i) => (i.kind === 'ask' ? [i.ask] : [])),
    needs: answer.items.flatMap((i) => (i.kind === 'need' ? [i.need] : [])),
    requests: answer.items.flatMap((i) => (i.kind === 'request' ? [i.request] : [])),
    kinds: { ask: answer.kinds.ask, need: answer.kinds.need, request: answer.kinds.request },
    wheels: answer.wheels,
    pushes: answer.pushes,
  };
}

/** What a press says: done, or waiting on the phone for signal. */
const saidOf = (online: boolean, now: string, queued: string) => (online ? now : queued);

function failed(e: unknown) {
  toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
}

/** What needs the person and what its buttons do: for its own screen, and for Today's tab (./hub.tsx). */
export function useWaitingProps(): React.ComponentProps<typeof WaitingBody> {
  const ctx = useOutreachContext();
  const phone = useOutreachWaiting(ctx.workspaceId, ctx.userId);
  const answer = useOutreachAnswer(
    async () =>
      serverPart(
        unwrap(
          await api.POST('/v1/queries/outreach.waiting', {
            body: { workspaceId: ctx.workspaceId },
          }),
        ),
      ),
    `waiting:${ctx.workspaceId}`,
    W.rows.waiting,
  );
  const ws = ctx.workspaceId;
  const askActions = useAskActions(null, answer.reload);
  return {
    phone,
    server: answer.data,
    serverError: answer.error,
    online: ctx.online,
    timeZone: ctx.timeZone,
    now: Date.now(),
    onRetry: answer.reload,
    onOk: async (send, text) => {
      try {
        await okSend(ws, send.sendId, text);
        toast.show(saidOf(ctx.online, W.okd, W.okdQueued));
      } catch (e) {
        failed(e);
      }
    },
    onSkip: async (send) => {
      try {
        await skipSend(ws, send.sendId);
        toast.show(saidOf(ctx.online, W.skipped, W.skippedQueued));
      } catch (e) {
        failed(e);
      }
    },
    onOkAll: async (sends) => {
      try {
        await okAll(ws, sends);
        toast.show(saidOf(ctx.online, W.okdAll(sends.length), W.okdQueued));
      } catch (e) {
        failed(e);
      }
    },
    onClear: async (need, how) => {
      try {
        await clearNeed(ws, need.needId, how);
        toast.show(saidOf(ctx.online, needClearedWords(how, 'done'), W.queued));
        answer.reload();
      } catch (e) {
        failed(e);
      }
    },
    onLeave: async (request) => {
      try {
        await setAside(ws, request.profileId);
        toast.show(saidOf(ctx.online, W.left(request.name), W.queued));
        answer.reload();
      } catch (e) {
        failed(e);
      }
    },
    // How the phone hears of it is on General.
    onSettings: () => openSettingsPart(ws, 'general'),
    askActions,
  };
}

export function WaitingBody({
  phone,
  server,
  serverError,
  online,
  timeZone,
  now,
  onRetry,
  onOk,
  onSkip,
  onOkAll,
  onClear,
  onLeave,
  onSettings,
  askActions,
  embedded = false,
}: {
  phone: PhoneWaiting;
  server: WaitingFromServer | null;
  serverError: string | null;
  online: boolean;
  timeZone: string;
  now: number;
  onRetry: () => void;
  onOk: (send: PhoneSend, text?: string) => void;
  onSkip: (send: PhoneSend) => void;
  onOkAll: (sends: { sendId: string }[]) => void;
  onClear: (need: Need, how: NeedClear) => void;
  onLeave: (request: Request) => void;
  onSettings: () => void;
  /** Carry on, Skip and Stop, on what the computer needs them for. */
  askActions?: AskActions;
  /** Inside Today's tab, as Needs you (./hub.tsx): no screen of its own, and a line when nothing waits. */
  embedded?: boolean;
}) {
  const [changing, setChanging] = React.useState<PhoneSend | null>(null);
  const all = approveAllFromPhone(phone);
  const count =
    phone.kinds.reply.count +
    phone.kinds.message.count +
    (server ? server.kinds.ask.count + server.kinds.need.count + server.kinds.request.count : 0);
  const sendRow = (send: PhoneSend) => (
    <SendCard
      key={send.sendId}
      send={send}
      recent={server?.recent.get(send.sendId) ?? []}
      now={now}
      onOk={() => onOk(send)}
      onChange={() => setChanging(send)}
      onSkip={() => onSkip(send)}
    />
  );
  // Its own screen, or a part of Today's tab: a plain function, so the screen is never drawn anew.
  const frame = (children: React.ReactNode) =>
    embedded ? (
      <View className="gap-3" testID="outreach-waiting">
        {children}
      </View>
    ) : (
      <Screen
        title={W.rows.waiting}
        subtitle={server ? waitingWords(count) : W.waitingMore(count)}
        leading="back"
        testID="outreach-waiting"
      >
        {children}
      </Screen>
    );
  return frame(
    <>
      {!online ? (
        <Card className="px-4 py-3" testID="waiting-offline">
          <Note>{W.waitingOffline}</Note>
        </Card>
      ) : null}

      {server?.asks.length && askActions ? (
        <Group
          title={WAITING_KINDS.ask}
          count={server.kinds.ask.count}
          shown={server.asks.length}
          kind="ask"
          testID="waiting-ask"
        >
          {server.asks.map((ask) => (
            <AskLine
              key={ask.askId}
              asks={{ timezone: timeZone, computer: null, now: new Date(now).toISOString() }}
              ask={ask}
              actions={askActions}
              named
            />
          ))}
        </Group>
      ) : null}

      {phone.replies.length ? (
        <Group
          title={WAITING_KINDS.reply}
          count={phone.kinds.reply.count}
          shown={phone.replies.length}
          kind="reply"
          note={W.repliesNote}
          testID="waiting-reply"
        >
          {phone.replies.map(sendRow)}
        </Group>
      ) : null}

      {phone.messages.length ? (
        <Group
          title={WAITING_KINDS.message}
          count={phone.kinds.message.count}
          shown={phone.messages.length}
          kind="message"
          note={server?.wheels.on ? wheelsWords(server.wheels) : null}
          testID="waiting-message"
          action={
            all.length >= 2 ? (
              <Button
                size="md"
                icon={CheckCheck}
                onPress={() => onOkAll(all)}
                testID="waiting-approve-all"
              >
                {approveAllWords(all.length)}
              </Button>
            ) : null
          }
        >
          {phone.messages.map(sendRow)}
        </Group>
      ) : null}

      {server ? (
        <>
          {server.needs.length ? (
            <Group
              title={WAITING_KINDS.need}
              count={server.kinds.need.count}
              shown={server.needs.length}
              kind="need"
              testID="waiting-need"
            >
              {server.needs.map((need) => (
                <NeedCard
                  key={need.needId}
                  need={need}
                  when={seenWords(need.seenAt, timeZone, now)}
                  onClear={(how) => onClear(need, how)}
                />
              ))}
            </Group>
          ) : null}
          {server.requests.length ? (
            <Group
              title={WAITING_KINDS.request}
              count={server.kinds.request.count}
              shown={server.requests.length}
              kind="request"
              testID="waiting-request"
            >
              {server.requests.map((request) => (
                <RequestCard
                  key={request.profileId}
                  request={request}
                  when={seenWords(request.since, timeZone, now)}
                  onLeave={() => onLeave(request)}
                />
              ))}
            </Group>
          ) : null}
        </>
      ) : online && serverError ? (
        <NeedsSignal words={serverError} onRetry={onRetry} testID="waiting-server-error" />
      ) : null}

      {count === 0 && embedded && (server || !online) ? (
        <Card className="border-dashed px-4 py-3.5" testID="waiting-empty">
          <Note>{server ? W.needsYouNone : W.waitingMore(0)}</Note>
        </Card>
      ) : count === 0 && (server || !online) ? (
        <Card className="gap-1.5 px-5 py-6" testID="waiting-empty">
          {/* With no word from HandsFreeOS, only the phone's messages are known: steps and requests may wait. */}
          <Text className="text-[16px] font-semibold">
            {server ? W.emptyTitle : W.waitingMore(0)}
          </Text>
          <Note>{W.emptyBody}</Note>
        </Card>
      ) : null}

      {server && !embedded ? (
        <Card className="gap-2 px-4 py-3.5" testID="waiting-hear">
          <Text className="text-[15px] font-semibold">{W.hearTitle}</Text>
          <Note>{W.hearOfIt(server.pushes)}</Note>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onPress={onSettings}
            testID="waiting-settings"
          >
            {W.changeInSettings}
          </Button>
        </Card>
      ) : null}

      <ChangeSheet
        send={changing}
        onClose={() => setChanging(null)}
        onOk={(send, text) => {
          setChanging(null);
          onOk(send, text);
        }}
      />
    </>,
  );
}

function Group({
  title,
  count,
  shown,
  kind,
  note,
  action,
  children,
  testID,
}: {
  title: string;
  count: number;
  shown: number;
  kind: 'ask' | 'reply' | 'message' | 'need' | 'request';
  note?: string | null;
  action?: React.ReactNode;
  children: React.ReactNode;
  testID: string;
}) {
  return (
    <View className="gap-2" testID={testID}>
      <View className="gap-1 px-1">
        <Text className="text-[15px] font-semibold">
          {title} <Text className="text-text-3">· {count.toLocaleString('en-US')}</Text>
        </Text>
        {note ? <Note>{note}</Note> : null}
      </View>
      {action}
      {children}
      {shown < count ? <Note>{moreWords(kind, count - shown)}</Note> : null}
    </View>
  );
}

function SendCard({
  send,
  recent,
  now,
  onOk,
  onChange,
  onSkip,
}: {
  send: PhoneSend;
  /** The chat so far, oldest first. */
  recent: readonly RecentMessage[];
  now: number;
  onOk: () => void;
  onChange: () => void;
  onSkip: () => void;
}) {
  // Each on its own network, as its profile's link says (the phone's copy keeps no more).
  const platform = networkOfUrl(send.profileUrl);
  const open = chatUrlOn(platform, send.threadKey) ?? send.profileUrl;
  const why = oneByOneWords(send);
  return (
    <Card className="gap-2.5 px-4 py-3.5" testID="waiting-send">
      <View className="flex-row flex-wrap items-center gap-2">
        <PersonName
          who={{
            profileId: send.profileId,
            name: send.name,
            url: send.profileUrl,
            platform,
            threadKey: send.threadKey,
          }}
        />
        <NetworkName platform={platform} />
        <Text className="text-[12.5px] text-text-3">{todayKindsOn(platform)[send.kind]}</Text>
        {send.handedOver ? (
          <Badge variant="pending">
            <Text>{W.handedOver}</Text>
          </Badge>
        ) : null}
      </View>
      {recent.length ? (
        <View className="gap-1">
          <Note>{RECENT_WORDS.title}</Note>
          <ChatBubbles
            bubbles={recentBubbles(recent, now)}
            label={RECENT_WORDS.title}
            testID="waiting-chat-so-far"
          />
        </View>
      ) : null}
      <Text
        selectable
        className="rounded-control bg-card-2 px-3 py-2 text-[14.5px] leading-[21px]"
        testID="waiting-send-text"
      >
        {send.text}
      </Text>
      {why ? <Note>{why}</Note> : null}
      <View className="flex-row flex-wrap gap-2">
        <Button size="md" icon={Check} onPress={onOk} testID="waiting-ok">
          {W.ok}
        </Button>
        <Button
          size="md"
          variant="secondary"
          icon={Pencil}
          onPress={onChange}
          testID="waiting-change"
        >
          {W.change}
        </Button>
        <Button size="md" variant="ghost" icon={X} onPress={onSkip} testID="waiting-skip">
          {W.skip}
        </Button>
        {open ? (
          <Button
            size="md"
            variant="ghost"
            icon={ExternalLink}
            onPress={() => openOutside(open)}
            testID="waiting-open"
          >
            {send.threadKey ? openChatWords(platform) : openPageWords(platform)}
          </Button>
        ) : null}
      </View>
    </Card>
  );
}

/** Change a message before the OK: the words, then OK and send. */
function ChangeSheet({
  send,
  onClose,
  onOk,
}: {
  send: PhoneSend | null;
  onClose: () => void;
  onOk: (send: PhoneSend, text: string) => void;
}) {
  const [text, setText] = React.useState('');
  const [problem, setProblem] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (send) setText(send.text);
    setProblem(null);
  }, [send]);
  const trimmed = text.trim();
  // Checked here, so a message HandsFreeOS would refuse never leaves the list to wait on the phone.
  const ok = () => {
    if (!send) return;
    const checked = SendText.safeParse(text);
    if (checked.success) onOk(send, checked.data);
    else setProblem(checked.error.issues[0]?.message ?? null);
  };
  return (
    <Sheet
      open={send !== null}
      onClose={onClose}
      title={send ? W.changeTitle(send.name) : undefined}
      description={W.changeHelp}
      testID="waiting-change-sheet"
    >
      <View className="gap-3">
        <Input
          value={text}
          onChangeText={(t) => {
            setText(t);
            setProblem(null);
          }}
          multiline
          autoFocus
          className="h-40 py-3"
          testID="waiting-change-text"
        />
        {problem ? (
          <Text className="text-[13px] leading-[18px] text-danger" testID="waiting-change-problem">
            {problem}
          </Text>
        ) : null}
        <Button disabled={!trimmed} onPress={ok} testID="waiting-change-ok">
          {W.okChanged}
        </Button>
      </View>
    </Sheet>
  );
}

function NeedCard({
  need,
  when,
  onClear,
}: {
  need: Need;
  when: string;
  onClear: (how: NeedClear) => void;
}) {
  // Its profile's network, as HandsFreeOS says: its words, its label and its links are that network's.
  const platform = networkOfWaiting({ kind: 'need', need });
  const messenger = need.step === 'message' ? chatUrlOn(platform, need.threadKey) : null;
  // Only an address on a network the add-on knows opens: their page there, the post, or the chat.
  const page = need.url && networkOfLink(need.url) ? need.url : null;
  const why = needWhyWords(need.why);
  return (
    <Card className="gap-2 px-4 py-3.5" testID="waiting-need-item">
      {/* The name on its own, so it can be a button with its own target; the step under it says it in words. */}
      <View className="flex-row flex-wrap items-center gap-2">
        <PersonName
          who={{
            profileId: need.profileId,
            name: need.name,
            // Their page: a comment's or a like's address is the post, and a message's may be the chat.
            url: need.postId === null && need.step !== 'message' ? page : null,
            platform,
            threadKey: need.threadKey,
          }}
        />
        <NetworkName platform={platform} />
      </View>
      <Text className="text-[14.5px] leading-[21px]" testID="waiting-need-title">
        {needTitle(need.step, need.name, platform)}
      </Text>
      <Note>{[why, when].filter(Boolean).join(' · ')}</Note>
      {need.text ? (
        <Text
          selectable
          className="rounded-control bg-card-2 px-3 py-2 text-[14px] leading-[20px]"
          testID="waiting-need-text"
        >
          {need.text}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button size="md" icon={Check} onPress={() => onClear('done')} testID="waiting-need-done">
          {NEED_CLEARS.done}
        </Button>
        <Button
          size="md"
          variant="ghost"
          icon={X}
          onPress={() => onClear('dismissed')}
          testID="waiting-need-dismiss"
        >
          {NEED_CLEARS.dismissed}
        </Button>
        {messenger || page ? (
          <Button
            size="md"
            variant="ghost"
            icon={ExternalLink}
            onPress={() => openOutside(messenger ?? page)}
            testID="waiting-need-open"
          >
            {messenger ? openChatWords(platform) : openPageWords(platform)}
          </Button>
        ) : null}
      </View>
    </Card>
  );
}

function RequestCard({
  request,
  when,
  onLeave,
}: {
  request: Request;
  when: string;
  onLeave: () => void;
}) {
  const platform = networkOfUrl(request.url);
  return (
    <Card className="gap-2 px-4 py-3.5" testID="waiting-request-item">
      <View className="flex-row flex-wrap items-center gap-2">
        <PersonName
          who={{ profileId: request.profileId, name: request.name, url: request.url, platform }}
        />
        <NetworkName platform={platform} />
      </View>
      <Note>{W.asked(when, request.mutualFriends)}</Note>
      {request.why.length ? <Note>{request.why.join(' · ')}</Note> : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          size="md"
          variant="secondary"
          icon={ExternalLink}
          onPress={() => openOutside(request.url)}
          testID="waiting-request-open"
        >
          {openPageWords(platform)}
        </Button>
        <Button size="md" variant="ghost" icon={X} onPress={onLeave} testID="waiting-request-leave">
          {W.leaveIt}
        </Button>
      </View>
    </Card>
  );
}
