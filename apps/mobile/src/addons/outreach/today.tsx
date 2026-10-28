import {
  freshWords,
  wheelsWords,
  type WheelsListOutput,
} from '@hfos/core/addons/outreach/automation';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import {
  helpfulOn,
  requestsHeldWords,
  todayKindsOn,
  todayOpenOf,
} from '@hfos/core/addons/outreach/network-words';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { PARTNER_WORDS as PW } from '@hfos/core/addons/outreach/partners';
import {
  doneOnItsOwn,
  TODAY_KIND_KEYS,
  TODAY_LIMIT,
  type TodayItem,
  type TodayKind,
  type TodayOutput,
} from '@hfos/core/addons/outreach/today';
import {
  HELPFUL_STATES,
  HELPFUL_WORDS as H,
  helpfulOpenUrl,
  helpfulWordsOn,
  OPEN_HELPFUL_STATES,
  type HelpfulListOutput,
} from '@hfos/core/addons/outreach/helpful';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { PROFILE_PART_WORDS } from '@hfos/core/addons/outreach/profile-parts';
import { recentBubbles, RECENT_WORDS } from '@hfos/core/addons/outreach/sends';
import { oneByOneWords } from '@hfos/core/addons/outreach/waiting-words';
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
import {
  NeedsSignal,
  Note,
  openOutside,
  openSettingsPart,
  Part,
  useOutreachAnswer,
  useOutreachContext,
} from './kit';
import { PersonName } from './person-menu';

/**
 * Today on the phone (decision 44): the person's list for today, kind by kind, what the extension does on its own,
 * and each message it drafted, to OK or skip; each person's name opens their menu (./person-menu.tsx: their page,
 * Contacts, Mark as client, Demo booked, Don't pitch and more, as the web's) where a `PersonMenuScope` is around the
 * list, as on Today's tab (./hub.tsx); for owners and admins, who is on training wheels, with End now. Drafting
 * a message, copying an opener and the AI's drafts stay on the computer, beside Facebook. It needs signal.
 *
 * The list is one network's (`outreach.today`'s `platform`), in its words: "Send an invitation to connect" on
 * LinkedIn, its chats opening in LinkedIn messaging; Today's tab shows the one picked on its strip (./hub.tsx).
 * Partners from the Partners list (decision 81) have a part of their own after it, each message with an OK of its own.
 *
 * On Instagram, LinkedIn and Alignable (decision 92) the people found by topic say why under their name, and a writer's
 * like shows the post it goes on. On Instagram and Alignable a comment on a good post is drafted to wait like a message,
 * with OK and Skip (Change and Approve all are Needs you's, above it on Today's tab); skipped, its post is put aside,
 * so a comment that waits has no Not for me of its own. A forum answer says it waits for an OK of its own.
 */

const failed = (e: unknown) => toast.error(e instanceof ChangeError ? e.message : errorMessage(e));

/**
 * A network's list for today and what its buttons do: for its own screen, and for Today's tab with Needs you above it.
 */
export function useTodayProps(
  platform: Platform = 'facebook',
): React.ComponentProps<typeof TodayBody> {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const today = useOutreachAnswer(
    async () =>
      unwrap(await api.POST('/v1/queries/outreach.today', { body: { workspaceId: ws, platform } })),
    `today:${ws}:${platform}`,
    W.rows.today,
  );
  // The network's own helpful post: in a group on Facebook, on the person's own feed on LinkedIn.
  const helpful = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.helpful', { body: { workspaceId: ws, platform } }),
      ),
    `helpful:${ws}:${platform}`,
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
  // A comment on a good post (decision 92) says it goes under the post, and that a skip puts the post aside.
  const commentOf = (sendId: string) =>
    [...(today.data?.items ?? []), ...(today.data?.partners ?? [])].some(
      (i) => i.kind === 'comment' && i.send?.sendId === sendId,
    );
  return {
    platform,
    today: today.data,
    helpful: helpful.data,
    onHelpful: {
      write: () =>
        helpfulChange(
          () => change('outreach.helpful.ask', { workspaceId: ws, platform }),
          H.writing,
        ),
      ok: (helpfulId) =>
        helpfulChange(async () => {
          await change('outreach.helpful.ok', { workspaceId: ws, helpfulId });
          // Put up on the network it's for: in its group on Facebook, on their own feed on LinkedIn.
          await change('outreach.ask.make', {
            workspaceId: ws,
            platform,
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
    onOk: async (sendId) => {
      try {
        await okSend(ws, sendId);
        after(
          !ctx.online ? W.okdQueued : commentOf(sendId) ? W.okdComment(PLATFORMS[platform]) : W.okd,
        );
      } catch (e) {
        failed(e);
      }
    },
    onSkip: async (sendId) => {
      try {
        await skipSend(ws, sendId);
        after(!ctx.online ? W.skippedQueued : commentOf(sendId) ? W.commentSkipped : W.skipped);
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
    onProfileOwn: () => openSettingsPart(ws, platform),
    onEndWheels: async (userId, name, network = 'facebook') => {
      try {
        await change('outreach.wheels.end', { workspaceId: ws, userId, platform: network });
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
  platform = 'facebook',
  today,
  helpful = null,
  onHelpful,
  error,
  wheels,
  onRetry,
  onOk,
  onSkip,
  onNotForMe,
  onEndWheels,
  onProfileOwn,
  embedded = false,
  hideSends,
}: {
  /** The network whose list it is. */
  platform?: Platform;
  today: TodayOutput | null;
  /** Today's helpful post, and those up lately: none while it loads. */
  helpful?: HelpfulListOutput | null;
  onHelpful?: HelpfulActions;
  error: string | null;
  wheels: WheelsListOutput | null;
  onRetry: () => void;
  onOk: (sendId: string) => void;
  onSkip: (sendId: string) => void;
  onNotForMe: (postId: string) => void;
  /** Ends someone's training wheels on a network: Facebook's when left out. */
  onEndWheels: (userId: string, name: string, platform?: Platform) => void;
  /** Opens the network's part of Settings, where the AI's suggestions for its profile wait (decision 99). */
  onProfileOwn?: () => void;
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
  const shown = (i: TodayItem) => !(i.send?.state === 'waiting' && hideSends?.has(i.send.sendId));
  const list: TodayOutput = hideSends?.size
    ? { ...today, items: today.items.filter(shown), partners: today.partners.filter(shown) }
    : today;
  const kinds = TODAY_KIND_KEYS.filter((k) => list.items.some((i) => i.kind === k && !i.asking));
  // Posts asking for what the business offers come first, apart (decision 49).
  const asking = list.items.filter((i) => i.asking);
  return frame(
    <>
      {list.warning ? (
        <Card className="border-danger px-4 py-3" testID="today-warning">
          <Text className="text-[14px] leading-[20px] text-danger">
            {warningNote(list.warning, Date.now(), platform)}
          </Text>
        </Card>
      ) : null}
      {list.wheels.on ? <Note testID="today-wheels">{wheelsWords(list.wheels)}</Note> : null}
      {/* None from a server before decisions 96 and 97. */}
      {list.fresh?.on ? <Note testID="today-fresh">{freshWords(list.fresh, platform)}</Note> : null}
      {list.requestsHeld ? (
        <View className="rounded-menu bg-warning-soft px-3 py-2.5" testID="today-requests-held">
          <Text className="text-[13px] leading-[18px] text-warning-text">
            {requestsHeldWords(list.requestsHeld, platform)}
          </Text>
        </View>
      ) : null}
      {/* Their profile, read on its own on the 1st: what the AI suggests waits for their OK (decision 99). */}
      {list.profileOwn ? (
        <View className="gap-2 rounded-menu bg-card-2 px-3 py-2.5" testID="today-profile-own">
          <Text className="text-[13px] leading-[18px] text-text-2">
            {PROFILE_PART_WORDS.ownWaiting(platform, list.profileOwn.parts)}
          </Text>
          {onProfileOwn ? (
            <Button
              size="md"
              variant="secondary"
              className="self-start"
              onPress={onProfileOwn}
              testID="today-profile-own-look"
            >
              {PROFILE_PART_WORDS.ownLook}
            </Button>
          ) : null}
        </View>
      ) : null}
      {helpful && onHelpful && helpfulOn(platform) ? (
        <HelpfulPart platform={platform} helpful={helpful} on={onHelpful} />
      ) : null}
      {asking.length ? (
        <Part
          title={`${W.asking} · ${asking.length.toLocaleString('en-US')}`}
          about={W.askingAbout}
          testID="today-asking"
        >
          {asking.map((item, i) => (
            <ItemCard
              key={`${item.postId ?? i}:${i}`}
              platform={platform}
              item={item}
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
            platform={platform}
            kind={kind}
            today={list}
            onOk={onOk}
            onSkip={onSkip}
            onNotForMe={onNotForMe}
          />
        ))
      ) : list.partners.length ? null : (
        <Card className="px-5 py-6" testID="today-empty">
          <Note>{W.todayEmpty}</Note>
        </Card>
      )}
      {list.partners.length ? (
        <Part
          title={`${PW.title} · ${list.partners.length.toLocaleString('en-US')}`}
          about={PW.todayAbout}
          testID="today-partners"
        >
          {list.partners.map((item, i) => (
            <ItemCard
              key={`${item.kind}:${item.profileId ?? i}`}
              platform={platform}
              item={item}
              step={[
                todayKindsOn(platform)[item.kind],
                doneOnItsOwn(item.kind, list.auto) ? W.doneOnItsOwn : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              onOk={onOk}
              onSkip={onSkip}
              onNotForMe={onNotForMe}
            />
          ))}
        </Part>
      ) : null}
      <Note>{W.todayComputerOnly}</Note>
      {wheels ? (
        <Part title={W.wheelsTitle} testID="today-wheels-team">
          {wheels.people.length ? (
            wheels.people.map((p) => (
              <Card key={`${p.userId}:${p.platform}`} className="gap-2 px-4 py-3.5">
                <Text className="text-[15px] font-semibold">
                  {`${p.name} · ${PLATFORMS[p.platform]}`}
                </Text>
                <Note>{wheelsWords(p.wheels)}</Note>
                <Button
                  size="md"
                  variant="secondary"
                  className="self-start"
                  onPress={() => onEndWheels(p.userId, p.name, p.platform)}
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
  platform,
  kind,
  today,
  onOk,
  onSkip,
  onNotForMe,
}: {
  platform: Platform;
  kind: TodayKind;
  today: TodayOutput;
  onOk: (sendId: string) => void;
  onSkip: (sendId: string) => void;
  onNotForMe: (postId: string) => void;
}) {
  const items = today.items.filter((i) => i.kind === kind && !i.asking);
  const auto = today.auto.includes(kind);
  return (
    <Part
      title={`${todayKindsOn(platform)[kind]} · ${items.length.toLocaleString('en-US')}`}
      about={[limitWords(today, kind), auto ? W.doneOnItsOwn : null].filter(Boolean).join(' · ')}
      testID={`today-${kind}`}
    >
      {items.map((item, i) => (
        <ItemCard
          key={`${item.profileId ?? item.postId ?? i}:${i}`}
          platform={platform}
          item={item}
          onOk={onOk}
          onSkip={onSkip}
          onNotForMe={onNotForMe}
        />
      ))}
    </Part>
  );
}

function ItemCard({
  platform,
  item,
  step,
  onOk,
  onSkip,
  onNotForMe,
}: {
  platform: Platform;
  item: TodayItem;
  /** The step, where the part isn't one kind's: a partner's. */
  step?: string;
  onOk: (sendId: string) => void;
  onSkip: (sendId: string) => void;
  onNotForMe: (postId: string) => void;
}) {
  // Where Open goes, and its words, as the web's: the post, their chat, else their page.
  const openAt = todayOpenOf(item, platform);
  // A comment drafted to wait (decision 92): it goes under the post; skipping it puts the post aside.
  const comment = item.kind === 'comment' && item.send !== null;
  const alone = comment && item.send?.state === 'waiting' ? oneByOneWords(item.send) : null;
  return (
    <Card className="gap-2 px-4 py-3.5" testID="today-item">
      <View className="flex-row flex-wrap items-center gap-2">
        {/* A partner's name stays words: partners have their own list and marks (decision 81). */}
        <PersonName
          who={{
            profileId: item.partnerId ? null : item.profileId,
            name: item.name,
            url: item.profileUrl,
            platform,
            threadKey: item.threadKey,
            personId: item.personId,
            demoBooked: item.demoBooked,
          }}
        />
        {item.playbookName ? (
          <Badge variant="gray">
            <Text>{item.playbookName}</Text>
          </Badge>
        ) : null}
      </View>
      {step ? <Note testID="today-step">{step}</Note> : null}
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
          <Note>
            {item.send.state === 'waiting'
              ? comment
                ? W.commentWaiting
                : W.sentWaiting
              : comment
                ? W.commentOkd
                : W.sentOkd}
          </Note>
          {alone ? <Note testID="today-send-alone">{alone}</Note> : null}
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
        {item.kind === 'comment' && item.postId && !comment ? (
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
        {openAt ? (
          <Button
            size="md"
            variant="ghost"
            icon={ExternalLink}
            onPress={() => openOutside(openAt.url)}
            testID="today-open"
          >
            {openAt.words}
          </Button>
        ) : null}
      </View>
    </Card>
  );
}

/**
 * Today's helpful post (decision 50): what the AI wrote and for which group, to OK for the computer, say it's up
 * after copying it (the words can be selected), or put aside; why one was put aside; and those up lately, with who
 * engaged. With none today, Write a helpful post. It needs signal. On LinkedIn it's for the person's own feed: "Your
 * LinkedIn feed" where a group's name would be, and Open LinkedIn in place of Open the group.
 */
function HelpfulPart({
  platform,
  helpful,
  on,
}: {
  platform: Platform;
  helpful: HelpfulListOutput;
  on: HelpfulActions;
}) {
  const H = helpfulWordsOn(platform);
  const open = helpful.posts.find((p) =>
    (OPEN_HELPFUL_STATES as readonly string[]).includes(p.state),
  );
  const shown = open ?? helpful.posts.find((p) => p.state === 'skipped' || p.state === 'failed');
  const up = helpful.posts.filter((p) => p.state === 'posted');
  return (
    <Part title={H.title} about={H.limit} testID="today-helpful">
      {shown ? (
        <Card className="gap-2 px-4 py-3.5" testID="today-helpful-post">
          <Note>{[shown.groupName ?? H.feed?.name, shown.topic].filter(Boolean).join(' · ')}</Note>
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
              <Note>{shown.state === 'approved' ? H.waitingComputer : H.how(shown.how)}</Note>
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
                      onPress={() => openOutside(helpfulOpenUrl({ ...shown, platform }))}
                      testID="today-helpful-open"
                    >
                      {H.open}
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
