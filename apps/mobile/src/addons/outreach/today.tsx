import { wheelsWords, type WheelsListOutput } from '@hfos/core/addons/outreach/automation';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import {
  TODAY_KIND_KEYS,
  TODAY_KINDS,
  TODAY_LIMIT,
  type TodayItem,
  type TodayKind,
  type TodayOutput,
} from '@hfos/core/addons/outreach/today';
import {
  HELPFUL_STATES,
  HELPFUL_WORDS as H,
  howWords,
  OPEN_HELPFUL_STATES,
  type HelpfulListOutput,
} from '@hfos/core/addons/outreach/helpful';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { messengerChatUrl } from '@hfos/core/addons/outreach/waiting-words';
import { recentBubbles, RECENT_WORDS } from '@hfos/core/addons/outreach/sends';
import * as React from 'react';
import { View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Check, ExternalLink, X } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { okSend, skipPost, skipSend } from './actions';
import { ChatBubbles } from './chat-bubbles';
import { NeedsSignal, Note, openOutside, Part, useOutreachAnswer, useOutreachContext } from './kit';
import { PersonMenu } from './person-menu';

/**
 * Today on the phone (decision 44): the person's list for today, kind by kind, what the extension does on its own,
 * and each message it drafted, to OK or skip; each person's menu (Add to Contacts, Demo booked, Don't pitch, as the
 * web's); for owners and admins, who is on training wheels, with End now. Drafting
 * a message, copying an opener and the AI's drafts stay on the computer, beside Facebook. It needs signal.
 */

const failed = (e: unknown) => toast.error(e instanceof ChangeError ? e.message : errorMessage(e));

/** Today's answers and what its buttons do: for its own screen, and for Today's tab with Needs you above it. */
export function useTodayProps(): React.ComponentProps<typeof TodayBody> {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const today = useOutreachAnswer(
    async () => unwrap(await api.POST('/v1/queries/outreach.today', { body: { workspaceId: ws } })),
    `today:${ws}`,
    W.rows.today,
  );
  const helpful = useOutreachAnswer(
    async () =>
      unwrap(await api.POST('/v1/queries/outreach.helpful', { body: { workspaceId: ws } })),
    `helpful:${ws}`,
    H.title,
  );
  const helpfulChange = async (run: () => Promise<unknown>, said: string) => {
    try {
      await run();
      toast.show(said);
      helpful.reload();
    } catch (e) {
      failed(e);
    }
  };
  const wheels = useOutreachAnswer(
    ctx.manages
      ? async () =>
          unwrap(await api.POST('/v1/queries/outreach.wheels', { body: { workspaceId: ws } }))
      : null,
    `wheels:${ws}`,
    W.wheelsTitle,
  );
  const after = (said: string) => {
    toast.show(said);
    today.reload();
  };
  return {
    today: today.data,
    helpful: helpful.data,
    onHelpful: {
      write: () =>
        helpfulChange(() => change('outreach.helpful.ask', { workspaceId: ws }), H.writing),
      ok: (helpfulId) =>
        helpfulChange(async () => {
          await change('outreach.helpful.ok', { workspaceId: ws, helpfulId });
          await change('outreach.ask.make', {
            workspaceId: ws,
            ask: { kind: 'post', helpfulId },
          });
        }, H.waitingComputer),
      posted: (helpfulId) =>
        helpfulChange(
          () => change('outreach.helpful.posted', { workspaceId: ws, helpfulId, posted: true }),
          H.postedDone,
        ),
      skip: (helpfulId) =>
        helpfulChange(
          () => change('outreach.helpful.skip', { workspaceId: ws, helpfulId }),
          W.skipped,
        ),
    },
    error: today.error,
    wheels: ctx.manages ? wheels.data : null,
    onRetry: today.reload,
    menu: (item) => (
      <PersonMenu workspaceId={ws} who={item} online={ctx.online} onChanged={today.reload} />
    ),
    onOk: async (sendId) => {
      try {
        await okSend(ws, sendId);
        after(ctx.online ? W.okd : W.okdQueued);
      } catch (e) {
        failed(e);
      }
    },
    onSkip: async (sendId) => {
      try {
        await skipSend(ws, sendId);
        after(ctx.online ? W.skipped : W.skippedQueued);
      } catch (e) {
        failed(e);
      }
    },
    onNotForMe: async (postId) => {
      try {
        await skipPost(ws, postId);
        after(ctx.online ? W.notForMeDone : W.queued);
      } catch (e) {
        failed(e);
      }
    },
    onEndWheels: async (userId, name) => {
      try {
        await change('outreach.wheels.end', { workspaceId: ws, userId });
        toast.show(W.wheelsEnded(name));
        wheels.reload();
      } catch (e) {
        failed(e);
      }
    },
  };
}

/** What the person does with today's helpful post (decision 50). */
export interface HelpfulActions {
  write: () => void;
  ok: (helpfulId: string) => void;
  posted: (helpfulId: string) => void;
  skip: (helpfulId: string) => void;
}

export function TodayBody({
  today,
  helpful = null,
  onHelpful,
  error,
  wheels,
  onRetry,
  menu,
  onOk,
  onSkip,
  onNotForMe,
  onEndWheels,
  embedded = false,
  hideSends,
}: {
  today: TodayOutput | null;
  /** Today's helpful post, and those up lately: none while it loads. */
  helpful?: HelpfulListOutput | null;
  onHelpful?: HelpfulActions;
  error: string | null;
  wheels: WheelsListOutput | null;
  onRetry: () => void;
  /** Each item's person menu (./person-menu.tsx): Add to Contacts, Demo booked, Don't pitch. */
  menu?: (item: TodayItem) => React.ReactNode;
  onOk: (sendId: string) => void;
  onSkip: (sendId: string) => void;
  onNotForMe: (postId: string) => void;
  onEndWheels: (userId: string, name: string) => void;
  /** Inside Today's tab, under Needs you (./hub.tsx): no screen of its own. */
  embedded?: boolean;
  /** Messages Needs you shows already: left off here, so nobody shows twice. */
  hideSends?: ReadonlySet<string>;
}) {
  // Its own screen, or a part of Today's tab: a plain function, so the screen is never drawn anew.
  const frame = (children: React.ReactNode) =>
    embedded ? (
      <View className="gap-3" testID="outreach-today">
        {children}
      </View>
    ) : (
      <Screen title={W.rows.today} leading="back" testID="outreach-today">
        {children}
      </Screen>
    );
  if (!today)
    return frame(
      error ? <NeedsSignal words={error} onRetry={onRetry} testID="today-needs-signal" /> : null,
    );
  const list: TodayOutput = hideSends?.size
    ? {
        ...today,
        items: today.items.filter(
          (i) => !(i.send?.state === 'waiting' && hideSends.has(i.send.sendId)),
        ),
      }
    : today;
  const kinds = TODAY_KIND_KEYS.filter((k) => list.items.some((i) => i.kind === k && !i.asking));
  // Posts asking for what the business offers come first, apart (decision 49).
  const asking = list.items.filter((i) => i.asking);
  return frame(
    <>
      {list.warning ? (
        <Card className="border-danger px-4 py-3" testID="today-warning">
          <Text className="text-[14px] leading-[20px] text-danger">
            {warningNote(list.warning)}
          </Text>
        </Card>
      ) : null}
      {list.wheels.on ? <Note testID="today-wheels">{wheelsWords(list.wheels)}</Note> : null}
      {helpful && onHelpful ? <HelpfulPart helpful={helpful} on={onHelpful} /> : null}
      {asking.length ? (
        <Part
          title={`${W.asking} · ${asking.length.toLocaleString('en-US')}`}
          about={W.askingAbout}
          testID="today-asking"
        >
          {asking.map((item, i) => (
            <ItemCard
              key={`${item.postId ?? i}:${i}`}
              item={item}
              menu={menu}
              onOk={onOk}
              onSkip={onSkip}
              onNotForMe={onNotForMe}
            />
          ))}
        </Part>
      ) : null}
      {kinds.length || asking.length ? (
        kinds.map((kind) => (
          <KindPart
            key={kind}
            kind={kind}
            today={list}
            menu={menu}
            onOk={onOk}
            onSkip={onSkip}
            onNotForMe={onNotForMe}
          />
        ))
      ) : (
        <Card className="px-5 py-6" testID="today-empty">
          <Note>{W.todayEmpty}</Note>
        </Card>
      )}
      <Note>{W.todayComputerOnly}</Note>
      {wheels ? (
        <Part title={W.wheelsTitle} testID="today-wheels-team">
          {wheels.people.length ? (
            wheels.people.map((p) => (
              <Card key={p.userId} className="gap-2 px-4 py-3.5">
                <Text className="text-[15px] font-semibold">{p.name}</Text>
                <Note>{wheelsWords(p.wheels)}</Note>
                <Button
                  size="md"
                  variant="secondary"
                  className="self-start"
                  onPress={() => onEndWheels(p.userId, p.name)}
                  testID="today-wheels-end"
                >
                  {W.endNow}
                </Button>
              </Card>
            ))
          ) : (
            <Note>{W.wheelsNone}</Note>
          )}
        </Part>
      ) : null}
    </>,
  );
}

function limitWords(today: TodayOutput, kind: TodayKind): string | null {
  const step = TODAY_LIMIT[kind];
  if (!step) return null;
  const { done, most } = today.limits[step];
  return W.countOf(done, most);
}

function KindPart({
  kind,
  today,
  menu,
  onOk,
  onSkip,
  onNotForMe,
}: {
  kind: TodayKind;
  today: TodayOutput;
  menu?: (item: TodayItem) => React.ReactNode;
  onOk: (sendId: string) => void;
  onSkip: (sendId: string) => void;
  onNotForMe: (postId: string) => void;
}) {
  const items = today.items.filter((i) => i.kind === kind && !i.asking);
  const auto = today.auto.includes(kind);
  return (
    <Part
      title={`${TODAY_KINDS[kind]} · ${items.length.toLocaleString('en-US')}`}
      about={[limitWords(today, kind), auto ? W.doneOnItsOwn : null].filter(Boolean).join(' · ')}
      testID={`today-${kind}`}
    >
      {items.map((item, i) => (
        <ItemCard
          key={`${item.profileId ?? item.postId ?? i}:${i}`}
          item={item}
          menu={menu}
          onOk={onOk}
          onSkip={onSkip}
          onNotForMe={onNotForMe}
        />
      ))}
    </Part>
  );
}

function ItemCard({
  item,
  menu,
  onOk,
  onSkip,
  onNotForMe,
}: {
  item: TodayItem;
  menu?: (item: TodayItem) => React.ReactNode;
  onOk: (sendId: string) => void;
  onSkip: (sendId: string) => void;
  onNotForMe: (postId: string) => void;
}) {
  const chat = messengerChatUrl(item.threadKey);
  const onPost = item.kind === 'comment' || item.kind === 'warm_lead';
  const page = onPost ? (item.postUrl ?? item.profileUrl) : (chat ?? item.profileUrl);
  return (
    <Card className="gap-2 px-4 py-3.5" testID="today-item">
      <View className="flex-row items-center gap-2">
        <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
          <Text className="text-[15px] font-semibold">{item.name}</Text>
          {item.playbookName ? (
            <Badge variant="gray">
              <Text>{item.playbookName}</Text>
            </Badge>
          ) : null}
        </View>
        {menu?.(item)}
      </View>
      {item.why.length ? <Note>{item.why.join(' · ')}</Note> : null}
      {item.kind === 'video' && !item.send ? <Note>{W.videoNext}</Note> : null}
      {item.summary ? <Text className="text-[14px] leading-[20px]">{item.summary}</Text> : null}
      {item.nextStep ? <Note>{`${W.nextStepLabel}: ${item.nextStep}`}</Note> : null}
      {item.post ? (
        <Text className="rounded-control bg-card-2 px-3 py-2 text-[14px] leading-[20px]">
          {item.post}
        </Text>
      ) : null}
      {item.recent.length ? (
        <View className="gap-1">
          <Note>{RECENT_WORDS.title}</Note>
          <ChatBubbles
            bubbles={recentBubbles(item.recent, Date.now())}
            label={RECENT_WORDS.title}
            testID="today-chat-so-far"
          />
        </View>
      ) : null}
      {item.send ? (
        <View className="gap-2" testID="today-send">
          <Note>{item.send.state === 'waiting' ? W.sentWaiting : W.sentOkd}</Note>
          <Text
            selectable
            className="rounded-control bg-card-2 px-3 py-2 text-[14.5px] leading-[21px]"
          >
            {item.send.text}
          </Text>
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {item.send?.state === 'waiting' ? (
          <>
            <Button
              size="md"
              icon={Check}
              onPress={() => onOk(item.send!.sendId)}
              testID="today-ok"
            >
              {W.ok}
            </Button>
            <Button
              size="md"
              variant="ghost"
              icon={X}
              onPress={() => onSkip(item.send!.sendId)}
              testID="today-skip"
            >
              {W.skip}
            </Button>
          </>
        ) : null}
        {item.kind === 'comment' && item.postId ? (
          <Button
            size="md"
            variant="ghost"
            icon={X}
            onPress={() => onNotForMe(item.postId!)}
            testID="today-not-for-me"
          >
            {W.notForMe}
          </Button>
        ) : null}
        {page ? (
          <Button size="md" variant="ghost" icon={ExternalLink} onPress={() => openOutside(page)}>
            {chat && !onPost ? W.openInMessenger : W.openOnFacebook}
          </Button>
        ) : null}
      </View>
    </Card>
  );
}

/**
 * Today's helpful post (decision 50): what the AI wrote and for which group, to OK for the computer, say it's up
 * after copying it (the words can be selected), or put aside; why one was put aside; and those up lately, with who
 * engaged. With none today, Write a helpful post. It needs signal.
 */
function HelpfulPart({ helpful, on }: { helpful: HelpfulListOutput; on: HelpfulActions }) {
  const open = helpful.posts.find((p) =>
    (OPEN_HELPFUL_STATES as readonly string[]).includes(p.state),
  );
  const shown = open ?? helpful.posts.find((p) => p.state === 'skipped' || p.state === 'failed');
  const up = helpful.posts.filter((p) => p.state === 'posted');
  return (
    <Part title={H.title} about={H.limit} testID="today-helpful">
      {shown ? (
        <Card className="gap-2 px-4 py-3.5" testID="today-helpful-post">
          <Note>{[shown.groupName, shown.topic].filter(Boolean).join(' · ')}</Note>
          {shown.state === 'drafting' ? <Note>{H.writing}</Note> : null}
          {shown.state === 'skipped' || shown.state === 'failed' ? (
            <Note>{`${HELPFUL_STATES[shown.state]}${shown.whyNot ? `: ${shown.whyNot}` : '.'}`}</Note>
          ) : null}
          {shown.text && (shown.state === 'draft' || shown.state === 'approved') ? (
            <>
              <Text
                selectable
                className="rounded-control bg-card-2 px-3 py-2 text-[14.5px] leading-[21px]"
              >
                {shown.text}
              </Text>
              <Note>{shown.state === 'approved' ? H.waitingComputer : howWords(shown.how)}</Note>
              <View className="flex-row flex-wrap gap-2">
                {shown.how === 'after_ok' || shown.state === 'approved' ? (
                  <Button
                    size="md"
                    icon={Check}
                    onPress={() => on.ok(shown.helpfulId)}
                    testID="today-helpful-ok"
                  >
                    {H.ok}
                  </Button>
                ) : null}
                {shown.how === 'copy' ? (
                  <>
                    <Button
                      size="md"
                      variant="ghost"
                      icon={ExternalLink}
                      onPress={() => openOutside(shown.groupUrl)}
                    >
                      {H.openGroup}
                    </Button>
                    <Button
                      size="md"
                      variant="secondary"
                      icon={Check}
                      onPress={() => on.posted(shown.helpfulId)}
                      testID="today-helpful-posted"
                    >
                      {H.posted}
                    </Button>
                  </>
                ) : null}
                <Button
                  size="md"
                  variant="ghost"
                  icon={X}
                  onPress={() => on.skip(shown.helpfulId)}
                  testID="today-helpful-skip"
                >
                  {H.skip}
                </Button>
              </View>
            </>
          ) : null}
        </Card>
      ) : null}
      {!open && helpful.today < helpful.perDay ? (
        <Button size="md" variant="secondary" onPress={on.write} testID="today-helpful-write">
          {H.write}
        </Button>
      ) : null}
      {up.map((p) => (
        <Card key={p.helpfulId} className="gap-1 px-4 py-3" testID="today-helpful-up">
          <Text className="text-[14.5px] font-semibold">
            {p.topic ?? p.groupName ?? HELPFUL_STATES.posted}
          </Text>
          <Note>
            {[p.groupName, H.engaged(p.comments, p.reactions)].filter(Boolean).join(' · ')}
          </Note>
        </Card>
      ))}
    </Part>
  );
}
