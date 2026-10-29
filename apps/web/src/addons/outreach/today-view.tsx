'use client';
/**
 * Social Outreach's Today tab (docs/outreach.md, the plan's Phase 1 step 5): the person's short list for the day on
 * Facebook, from what HandsFreeOS knows (packages/core/src/addons/outreach/today.ts): requests they got from people who
 * fit to confirm (decision 30), a post to like before a friend request (decision 33), friend requests to people from
 * the business's groups who fit a playbook, a first message to new friends, friends the AI found a good fit to
 * reconnect with (decision 46), people ready for the offer to pitch (decision 47; copying a pitch marks it pitched),
 * follow-ups and replies, and comments on good posts in their groups (decision 20). With the extension on its own (decision 26), it does the confirms,
 * likes, requests and comments itself in the person's working hours. Each opens on Facebook, and a message or a comment comes with the AI's
 * drafts to copy; a post can be put aside. HandsFreeOS never sends anything there: the person does, and the extension
 * notes it, which takes it off the list and counts it against today's limits. While the person's computer is online,
 * Draft asks it to look the person up on Facebook first (decision 21, a `lookup` ask: ./asks.tsx), and the drafts come
 * back on the ask; offline, or with **Draft from what HandsFreeOS knows**, they come from what HandsFreeOS knows. Each
 * person kept as a profile has a menu on their name (./person-menu.tsx, decision 91): their page, Contacts, Mark as
 * client, Demo booked, Don't pitch and Never contact; the icon beside the name opens the post, chat or page. A first message's
 * drafts open the way the playbook's next opener says, and copying one notes which it was, for the results card
 * (decision 23). Anyone on the list for a message has the person's own demo link to copy (decision 24).
 *
 * A message the extension drafted to send for them (packages/core/src/addons/outreach/sends.ts) shows in place of the
 * drafts: one waiting has its words to change, **Send** and **Skip**, and **Approve all** OKs every one waiting but a
 * reply handed over or one to someone who needs the person, which wait for an OK of their own (`oneByOne`, decision
 * 42); the extension then sends them in Messenger. The same messages are in Waiting for you (./waiting-view.tsx). While the person's training wheels are on, it says what's left before they
 * come off; owners and admins see who's on them and can end them early.
 *
 * Each network has its own list (Chris: each network on its own): the strip at the top has a row for each network the
 * person works, with its own Start my day and Stop for today and its own warning line, and the list is the one shown
 * (`outreach.today` with its `platform`), in its words: an invitation to connect on LinkedIn, a friend request on
 * Facebook. Asks made from it carry its network, and only the kinds it can be asked show.
 *
 * Partners from the Partners list (decision 81) have a part of their own below it: a like first, the ask, follow-ups,
 * the details after a yes, and replies, each message with an OK of its own. Copying one moves them along the list.
 *
 * On Instagram, LinkedIn and Alignable (decision 92) the people found by topic say why under their name, from how they
 * were found ("Commented on a post under #austinroofing") and what the AI saw on their own page; a writer's like goes on
 * the post that found them, shown under it. A comment on a good post on Instagram and Alignable is drafted to wait
 * like a message, with **OK**, **Change** and **Skip**, and Approve all takes it too, but never an answer to a post
 * asking for what the business offers.
 */
import { freshWords, underAPost, wheelsWords } from '@hfos/core/addons/outreach/automation';
import { KNOWS_WORDS } from '@hfos/core/addons/outreach/knows';
import { clockWords } from '@hfos/core/addons/outreach/live';
import { OPENER_KINDS, openerShort, type DraftOpener } from '@hfos/core/addons/outreach/openers';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { PARTNER_WORDS as PW } from '@hfos/core/addons/outreach/partners';
import {
  doneOnItsOwn,
  DRAFT_KINDS,
  isPartnerMessage,
  type DraftKind,
  type TodayDraftOutput,
} from '@hfos/core/addons/outreach/today';
import {
  approveAllTakesComments,
  approveAllWords,
  forumAnswer,
  forumAnswersLeftWords,
  oneByOne,
} from '@hfos/core/addons/outreach/waiting-words';
import { askableOn, askOpen, cantAskWhy } from '@hfos/core/addons/outreach/asks';
import {
  dailyWordsOn,
  findPostsWordsOn,
  helpfulOn,
  NETWORK_WORDS as NW,
  requestsHeldWords,
  todayKindsOn,
  todayOpenOf,
} from '@hfos/core/addons/outreach/network-words';
import {
  NETWORKS,
  PLATFORMS,
  runsOnItsOwn,
  type Platform,
} from '@hfos/core/addons/outreach/networks';
import { adviceLeft, READY_WORDS } from '@hfos/core/addons/outreach/readiness';
import { messageParts } from '@hfos/core/addons/outreach/voice';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { PROFILE_PART_WORDS } from '@hfos/core/addons/outreach/profile-parts';
import {
  BellOff,
  CalendarCheck,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  Sparkles,
  Video,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { AskButton, AskLine, latestAskOn, targetOf } from './asks';
import { CancelAllButtons } from './cancel-all';
import { ChatSoFar } from './chat-bubbles';
import { Drafted } from './drafted';
import { HelpfulCard } from './helpful-card';
import { PersonName } from './person-menu';
import { GetReadyCard } from './get-ready';
import { StatusStrip, type NetworkLive } from './status-strip';
import type {
  Asks,
  HelpfulList,
  Live,
  Readiness,
  TodayItem,
  TodayList,
  Waiting,
  WheelsList,
} from './types';
import { useAct } from './use-act';
import { NeedsYou } from './waiting-view';

const KIND_BADGE = {
  confirm: 'ok',
  warm_up: 'gray',
  friend_request: 'accent',
  opener: 'ok',
  reconnect: 'ok',
  pitch: 'accent',
  video: 'accent',
  follow_up: 'gray',
  check_in: 'gray',
  reply: 'pending',
  demo_reminder: 'accent',
  rebook: 'pending',
  birthday: 'accent',
  new_job: 'accent',
  comment: 'accent',
  group_reply: 'accent',
  warm_lead: 'ok',
  recommend: 'ok',
  partner_reply: 'pending',
  partner_details: 'accent',
  partner_follow_up: 'gray',
  partner_ask: 'ok',
  partner_warm_up: 'gray',
} as const;

export function TodayView({
  workspaceId,
  platform = 'facebook',
  networks,
  today,
  helpful,
  wheels,
  asks,
  waiting,
  readiness,
  canManage = false,
}: {
  workspaceId: string;
  /** An owner or admin: a refused Start my day may point them to the business's part to fix. */
  canManage?: boolean;
  /** The network whose list it is. */
  platform?: Platform;
  /** Each network the person works, with what their computer is doing there: the strip at the top. */
  networks: readonly NetworkLive[];
  /** The network's list for today. */
  today: TodayList;
  /**
   * Get ready on the network shown (decisions 63 and 90): what's left, the profile's advice among it; null when it
   * couldn't be had. Whether anything holds the day is `today.ready`.
   */
  readiness: Readiness | null;
  /** Today's helpful post, and those up lately (decision 50). */
  helpful: HelpfulList;
  /** Who's on training wheels: for owners and admins, else null. */
  wheels: WheelsList | null;
  /** The look-ups and group members asked of the person's computer from here. */
  asks: Asks;
  /** Everything that needs the person, first. Null when it couldn't be had. */
  waiting: Waiting | null;
}) {
  // A look-up's drafts, and a group's members saved, show once its ask ends.
  useLiveRefresh(['outreach_ask'], 800);
  // Until the person is ready, Get ready shows in place of the list (decision 63); once they are, only while their
  // profile is left, as advice above the list (decision 90).
  const ready = today.ready;
  const getReady = readiness && (!ready || adviceLeft(readiness.items).length) ? readiness : null;
  const live = networks.find((n) => n.platform === platform)?.live ?? null;
  const many = networks.length > 1;
  const name = PLATFORMS[platform];
  // A message waiting for an OK is under Needs you; the list keeps everyone else, so nobody shows twice.
  const needs = new Set(
    (waiting?.items ?? []).flatMap((i) =>
      i.kind === 'message' || i.kind === 'reply' ? [i.send.sendId] : [],
    ),
  );
  const items = today.items.filter(
    (i) => !(i.send?.state === 'waiting' && needs.has(i.send.sendId)),
  );
  const partners = today.partners.filter(
    (i) => !(i.send?.state === 'waiting' && needs.has(i.send.sendId)),
  );
  // Approve all leaves those that wait for an OK of their own: a reply handed over, one to someone who needs them, or a
  // forum answer (decision 92).
  const waitingSends = items.filter((i) => i.send?.state === 'waiting');
  const approvable = waitingSends.filter((i) => !oneByOne(i.send!)).length;
  const comments = approveAllTakesComments(waitingSends.map((i) => ({ ...i.send!, kind: i.kind })));
  const answers = waitingSends.filter((i) => forumAnswer({ ...i.send!, kind: i.kind })).length;
  const approving = useAct();
  const approveAll = () =>
    approving.act('all', async () => {
      // The number the server OK'd: Today lists only today's, and more may have come in since.
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.send.approve', { body: { workspaceId } }),
      );
      toast.success(W.okdAll(out.approved.length, comments));
    });
  return (
    <div data-testid="outreach-today">
      {networks.length ? (
        <StatusStrip
          workspaceId={workspaceId}
          networks={networks}
          platform={platform}
          ready={ready}
          canManage={canManage}
        />
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {today.warning && !live?.warning ? (
            <p
              role="alert"
              data-testid="today-warning"
              className="rounded-card bg-danger-soft p-3.5 text-[13px] text-danger-text"
            >
              {warningNote(today.warning, Date.now(), platform)}
            </p>
          ) : null}
          {today.wheels.on ? (
            <p
              data-testid="today-wheels"
              className="rounded-card bg-card-2 p-3.5 text-[13px] text-text-2"
            >
              {wheelsWords(today.wheels)}
            </p>
          ) : null}
          {/* None from a server before decision 96. */}
          {today.fresh?.on ? (
            <p
              data-testid="today-fresh"
              className="rounded-card bg-card-2 p-3.5 text-[13px] text-text-2"
            >
              {freshWords(today.fresh, platform)}
            </p>
          ) : null}
          {today.requestsHeld ? (
            <div
              data-testid="today-requests-held"
              className="rounded-card bg-warning-soft p-3.5 text-[13px] text-warning-text"
            >
              <p>{requestsHeldWords(today.requestsHeld, platform)}</p>
              {/* Cancel all (decision 121), while it isn't going: none from a server before it. */}
              {today.requestsHeld.why === 'waiting' && !today.requestsHeld.cancelling ? (
                <CancelAllButtons
                  workspaceId={workspaceId}
                  platform={platform}
                  asks={asks}
                  waiting={today.requestsHeld.count}
                  extension={today.requestsHeld.extension ?? 0}
                />
              ) : null}
            </div>
          ) : null}
          {/* Their profile, read on its own on the 1st: what the AI suggests waits for their OK (decision 99). */}
          {today.profileOwn ? (
            <p
              data-testid="today-profile-own"
              className="rounded-card bg-card-2 p-3.5 text-[13px] text-text-2"
            >
              {PROFILE_PART_WORDS.ownWaiting(platform, today.profileOwn.parts)}{' '}
              <Link
                href={outreachHref(workspaceId, { view: 'settings', part: platform })}
                className="font-medium text-accent-text hover:underline"
              >
                {PROFILE_PART_WORDS.ownLook}
              </Link>
            </p>
          ) : null}
          {getReady ? (
            <GetReadyCard workspaceId={workspaceId} readiness={getReady} asks={asks} />
          ) : null}
          {waiting ? <NeedsYou workspaceId={workspaceId} waiting={waiting} /> : null}
          {helpfulOn(platform) ? (
            <HelpfulCard
              workspaceId={workspaceId}
              platform={platform}
              helpful={helpful}
              asks={asks}
            />
          ) : null}
          {items.length ? (
            <section aria-labelledby="today-list-title" className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 id="today-list-title" className="text-lg font-semibold tracking-tight">
                  {many ? NW.listOn(name) : W.listTitle}
                  <span className="font-medium text-text-3">
                    {' '}
                    · {items.length.toLocaleString()}
                  </span>
                </h2>
                {approvable > 1 ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={approving.busy !== null}
                    onClick={() => void approveAll()}
                    data-testid="today-approve-all"
                  >
                    <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {approveAllWords(approvable, comments)}
                  </Button>
                ) : null}
              </div>
              {approvable > 1 && answers ? (
                <p className="-mt-1 text-[12.5px] text-text-2" data-testid="today-answers-left">
                  {forumAnswersLeftWords(answers)}
                </p>
              ) : null}
              {ready ? null : (
                <p className="-mt-1 text-[13px] text-text-2">{READY_WORDS.repliesStill}</p>
              )}
              <Card className="p-0" data-testid="today-list">
                <ul>
                  {items.map((item, i) => (
                    <TodayRow
                      key={`${item.kind}:${item.postId ?? item.chatId ?? item.profileId ?? item.name}`}
                      workspaceId={workspaceId}
                      platform={platform}
                      item={item}
                      auto={today.auto.includes(item.kind)}
                      asks={asks}
                      first={i === 0}
                    />
                  ))}
                </ul>
              </Card>
            </section>
          ) : ready ? (
            <TodayStart workspaceId={workspaceId} platform={platform} />
          ) : null}
          {askableOn(platform, 'posts') && !runsOnItsOwn(platform) ? (
            <FindPostsCard workspaceId={workspaceId} platform={platform} asks={asks} />
          ) : null}
          {partners.length ? (
            <section
              aria-labelledby="today-partners-title"
              className="space-y-3"
              data-testid="today-partners"
            >
              <h2 id="today-partners-title" className="text-lg font-semibold tracking-tight">
                {PW.title}
                <span className="font-medium text-text-3">
                  {' '}
                  · {partners.length.toLocaleString()}
                </span>
              </h2>
              <p className="-mt-1 text-[13px] text-text-2">{PW.todayAbout}</p>
              <Card className="p-0" data-testid="today-partner-list">
                <ul>
                  {partners.map((item, i) => (
                    <TodayRow
                      key={`${item.kind}:${item.profileId ?? item.name}`}
                      workspaceId={workspaceId}
                      platform={platform}
                      item={item}
                      auto={doneOnItsOwn(item.kind, today.auto)}
                      asks={asks}
                      first={i === 0}
                      partner
                    />
                  ))}
                </ul>
              </Card>
            </section>
          ) : null}
        </div>
        <aside className="space-y-4">
          {live ? <DoneToday workspaceId={workspaceId} live={live} platform={platform} /> : null}
          {wheels?.people.length ? <WheelsCard workspaceId={workspaceId} wheels={wheels} /> : null}
          {!today.hasPlaybook ? (
            <Card className="p-4">
              <h3 className="text-[15px] font-semibold">
                {`${dailyWordsOn(platform).friend_request.label} need a playbook`}
              </h3>
              <p className="mt-1.5 text-[13px] text-text-2">
                People who fit are suggested once the business has a playbook saying who to look
                for.
              </p>
              <ButtonLink
                size="sm"
                variant="secondary"
                className="mt-3"
                href={outreachHref(workspaceId, { view: 'playbooks' })}
              >
                Go to Playbooks
              </ButtonLink>
            </Card>
          ) : null}
          {today.readAdmins.length && askableOn(platform, 'members') ? (
            <Card className="p-4" data-testid="today-read-admins">
              <h3 className="text-[15px] font-semibold">Save who runs these groups</h3>
              <p className="mt-1.5 text-[13px] text-text-2">
                Their members are suggested once the group’s admins are saved, so nobody who runs a
                group is approached.
              </p>
              <ul className="mt-3 grid gap-3 text-[13px]">
                {today.readAdmins.map((g) => (
                  <li key={g.groupId} className="grid gap-1.5">
                    <a
                      href={g.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent-text hover:underline"
                    >
                      {g.name ?? 'A group'}
                    </a>
                    <AskButton
                      workspaceId={workspaceId}
                      asks={asks}
                      ask={{ kind: 'members', groupIds: [g.groupId] }}
                      label="Save its members"
                      testId="today-ask-members"
                    />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
      <HowItWorks />
    </div>
  );
}

/** What each of the empty list's steps asks the computer: shown only on a network that can be asked it. */
const START_ASKS = { groups: 'groups', chats: 'chats', friends: 'checks' } as const;

/**
 * Find posts, on a network the extension doesn't work on its own: the person asks for it here, and the good ones come
 * onto the list. Where a runner works the network (Alignable's, from part 5), it reads the town's posts once a day
 * itself, so the card doesn't show.
 */
function FindPostsCard({
  workspaceId,
  platform,
  asks,
}: {
  workspaceId: string;
  platform: Platform;
  asks: Asks;
}) {
  const words = findPostsWordsOn(platform);
  return (
    <Card className="p-5" data-testid="today-find-posts">
      <h2 className="text-[15px] font-semibold">{words.title}</h2>
      <p className="mt-1 text-[13px] text-text-2">{words.body}</p>
      <div className="mt-3">
        <AskButton
          workspaceId={workspaceId}
          asks={asks}
          ask={{ kind: 'posts' }}
          platform={platform}
          label={words.title}
          testId="today-find-posts-ask"
        />
      </div>
    </Card>
  );
}

/**
 * An empty list: what gives it something to work with, each a button to where it's done (decision 59), in its
 * network's words, and only the steps its network can be asked.
 */
function TodayStart({ workspaceId, platform }: { workspaceId: string; platform: Platform }) {
  const words = NETWORKS[platform].words;
  const steps = W.todayStart
    .filter((step) => askableOn(platform, START_ASKS[step.to]))
    .map((step) =>
      step.to === 'chats'
        ? { ...step, body: `The AI reads your ${words.messaging} chats and finds who fits.` }
        : step.to === 'friends'
          ? {
              ...step,
              title: `Check your ${words.friends}`,
              body: `It looks for good fits among the ${words.friends} you already have.`,
            }
          : step,
    );
  return (
    <Card className="p-5" data-testid="today-empty">
      <h2 className="text-[15px] font-semibold">{W.todayEmptyTitle}</h2>
      <p className="mt-1 text-[13px] text-text-2">{W.todayEmptyBody}</p>
      <ol className="mt-4 grid gap-2.5">
        {steps.map((step, i) => (
          <li
            key={step.to}
            className="flex flex-wrap items-center gap-3 rounded-menu border border-border p-3.5"
            data-testid={`today-start-${step.to}`}
          >
            <span
              className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-text"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium">{step.title}</span>
              <span className="block text-[12.5px] text-text-2">{step.body}</span>
            </span>
            <ButtonLink
              size="sm"
              variant="secondary"
              href={outreachHref(workspaceId, {
                view: step.to,
                ...(step.to === 'groups' ? {} : { net: platform }),
              })}
            >
              {step.button}
            </ButtonLink>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** The newest of today's steps, beside the lists: the rest, and the computers, on the computer's own page. */
function DoneToday({
  workspaceId,
  live,
  platform,
}: {
  workspaceId: string;
  live: Live;
  platform: Platform;
}) {
  const shown = live.steps.slice(0, 6);
  return (
    <Card className="p-4" data-testid="today-done">
      <h3 className="text-[15px] font-semibold">{W.doneToday}</h3>
      {shown.length ? (
        <ol className="mt-3 space-y-2">
          {shown.map((step, i) => (
            <li key={`${step.at}-${i}`} className="flex gap-3 text-[13px]">
              <span className="w-[62px] flex-none tabular-nums text-text-3">
                {clockWords(step.at, live.timezone)}
              </span>
              <span
                className={cn(
                  'min-w-0',
                  step.kind === 'stopped' && 'text-danger-text',
                  step.kind === 'passed' && 'text-text-2',
                )}
              >
                {step.line}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-[13px] text-text-2">{W.noSteps}</p>
      )}
      <Link
        href={outreachHref(workspaceId, { view: 'live', net: platform })}
        className="mt-3 inline-block text-[13px] font-medium text-accent-text hover:underline"
      >
        {W.seeAllToday}
      </Link>
    </Card>
  );
}

/** How it works, folded away: once, instead of a note beside every list. */
function HowItWorks() {
  return (
    <details
      className="group mt-6 rounded-card border border-border bg-card"
      data-testid="today-how"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-card px-5 py-4 text-[14px] font-medium [&::-webkit-details-marker]:hidden">
        {W.howItWorks}
        <ChevronDown
          className="h-4 w-4 text-text-2 transition-transform group-open:rotate-180"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </summary>
      <div className="grid gap-5 px-5 pb-5 text-[13px] text-text-2 md:grid-cols-3">
        {W.howItWorksSteps.map((step, i) => (
          <p key={step.title}>
            <strong className="font-semibold text-text">
              {i + 1}. {step.title}
            </strong>{' '}
            {step.body}
          </p>
        ))}
      </div>
    </details>
  );
}

function TodayRow({
  workspaceId,
  platform,
  item,
  auto,
  asks,
  first = false,
  partner = false,
}: {
  workspaceId: string;
  /** The network the list is on. */
  platform: Platform;
  item: TodayItem;
  /** The extension does it on its own for you. */
  auto: boolean;
  asks: Asks;
  /** The list's first row: no line above it. */
  first?: boolean;
  /** Someone on the Partners list: never offered a demo or Don't pitch, which are a customer's. */
  partner?: boolean;
}) {
  // Where Open goes, and its words, as the phone's: the post, their chat, else their page.
  const openAt = todayOpenOf(item, platform);
  const draftKind = DRAFT_KINDS.find((k) => k === item.kind);
  return (
    <li className={cn('px-5 py-4', !first && 'border-t border-border')} data-testid="today-item">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 text-[13.5px]">
          {partner ? (
            openAt ? (
              <a
                href={openAt.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent-text hover:underline"
              >
                {item.name}
              </a>
            ) : (
              <span className="font-medium">{item.name}</span>
            )
          ) : (
            // The name opens the person menu (decision 91); the icon beside it opens the post, chat or page.
            <span className="inline-flex max-w-full items-center gap-1 align-top">
              <PersonName
                workspaceId={workspaceId}
                who={{
                  profileId: item.profileId,
                  name: item.name,
                  platform,
                  url: item.profileUrl,
                  threadKey: item.threadKey,
                  personId: item.personId,
                  demoBooked: item.demoBooked,
                }}
                className={cn('font-medium', item.profileId && 'text-accent-text')}
              />
              {openAt ? (
                <a
                  href={openAt.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={openAt.words}
                  title={openAt.words}
                  className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[4px] text-text-3 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                  data-testid="today-open"
                >
                  <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                </a>
              ) : null}
            </span>
          )}
          {item.why.length ? (
            <div className="text-[12.5px] text-text-3">{item.why.join(' · ')}</div>
          ) : null}
        </div>
        <span className="flex items-center gap-1.5">
          {item.asking ? (
            <Badge variant="pending" data-testid="today-asking">
              {W.asking}
            </Badge>
          ) : null}
          {auto ? (
            <Badge variant="ok" data-testid="today-auto">
              {W.doneOnItsOwn}
            </Badge>
          ) : null}
          <Badge variant={KIND_BADGE[item.kind]}>{todayKindsOn(platform)[item.kind]}</Badge>
        </span>
      </div>
      {item.post ? (
        <blockquote
          className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-3 text-[13px] text-text-2"
          data-testid="today-post"
        >
          {item.post}
          {item.posted ? <span className="text-text-3"> · {item.posted}</span> : null}
        </blockquote>
      ) : null}
      {item.summary ? <p className="mt-1.5 text-[13px] text-text">{item.summary}</p> : null}
      {item.nextStep ? (
        <p className="mt-1 text-[12.5px] text-text-2">Next: {item.nextStep}</p>
      ) : null}
      <ChatSoFar recent={item.recent} />
      {item.send ? (
        <Drafted
          workspaceId={workspaceId}
          name={item.name}
          send={item.send}
          comment={underAPost(item.kind) ? platform : null}
        />
      ) : draftKind ? (
        <Drafts
          workspaceId={workspaceId}
          platform={platform}
          item={item}
          kind={draftKind}
          asks={asks}
        />
      ) : null}
    </li>
  );
}

/** Who's on training wheels, for owners and admins: how far each has come, and End now. */
function WheelsCard({ workspaceId, wheels }: { workspaceId: string; wheels: WheelsList }) {
  const { busy, act } = useAct();
  return (
    <Card className="p-4" data-testid="today-wheels-team">
      <h3 className="text-[15px] font-semibold">{W.wheelsTitle}</h3>
      <p className="mt-1.5 text-[13px] text-text-2">
        Their messages wait for their OK and their daily limits are half, for 7 days and 25 messages
        OK’d. End them early for someone you trust.
      </p>
      <ul className="mt-2 space-y-2 text-[13px]">
        {wheels.people.map((p) => (
          <li key={`${p.userId}:${p.platform}`} className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="font-medium">{p.name}</span>
              <span className="text-text-3"> · {PLATFORMS[p.platform]}</span>
              <span className="block text-[12px] text-text-3">
                {p.wheels.ok.toLocaleString()} of 25 OK’d ·{' '}
                {p.wheels.daysLeft
                  ? `${p.wheels.daysLeft} ${p.wheels.daysLeft === 1 ? 'day' : 'days'} to go`
                  : 'days done'}
              </span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void act(
                  `${p.userId}:${p.platform}`,
                  async () =>
                    unwrap(
                      await apiBrowser().POST('/v1/commands/outreach.wheels.end', {
                        body: { workspaceId, userId: p.userId, platform: p.platform },
                      }),
                    ),
                  W.wheelsEnded(p.name),
                )
              }
              data-testid="today-wheels-end"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
              {W.endNow}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The AI's drafts for a message, asked for when wanted: each to copy and send on its network. */
function Drafts({
  workspaceId,
  platform,
  item,
  kind,
  asks,
}: {
  workspaceId: string;
  platform: Platform;
  item: TodayItem;
  kind: DraftKind;
  asks: Asks;
}) {
  // A comment, a reply in a group, or an answer to a comment on their own post: one, under a post.
  const underPost = underAPost(kind) || kind === 'warm_lead';
  const [busy, setBusy] = useState(false);
  const [drafted, setDrafted] = useState<readonly string[]>([]);
  /** The opener the drafts were written with, for a first message. */
  const [draftedOpener, setOpener] = useState<DraftOpener | null>(null);
  /** What they were written as: a reply to a yes comes back as Send the video or Send the link. */
  const [draftedAs, setDraftedAs] = useState<DraftKind | null>(null);
  /** For a reply: what they asked that Knowledge doesn't answer (decision 122). */
  const [draftedUnanswered, setUnanswered] = useState<string | null>(null);
  // Looked up on its network first, while the computer is online and can be asked there.
  const lookup = {
    kind: 'lookup' as const,
    draft: { kind, profileId: item.profileId, chatId: item.chatId, postId: item.postId },
  };
  const looked = latestAskOn(asks, platform, 'lookup', targetOf(lookup));
  const online =
    asks.computer !== null &&
    asks.computer.online &&
    !asks.computer.signedOut &&
    cantAskWhy(asks, 'lookup', platform) === null;
  const messaging = NETWORKS[platform].words.messaging;
  // Drafts asked for here come first; else the look-up's, once it's done.
  const fromLookup = !drafted.length && looked?.state === 'done' ? looked.result : null;
  const drafts = fromLookup?.drafts ?? drafted;
  const opener = fromLookup ? fromLookup.opener : draftedOpener;
  const as = (fromLookup ? fromLookup.kind : draftedAs) ?? kind;
  const unanswered = fromLookup ? fromLookup.unanswered : draftedUnanswered;
  const lookingUp = looked !== null && askOpen(looked.state);
  const skipping = useAct();
  const skip = (postId: string) =>
    skipping.act(
      'skip',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.post.skip', {
            body: { workspaceId, postId },
          }),
        ),
      W.notForMeDone,
    );
  const ask = async () => {
    setBusy(true);
    try {
      const out = await workerPost<TodayDraftOutput>(
        '/v1/addons/outreach/actions/outreach.today.draft',
        {
          workspaceId,
          input: { kind, profileId: item.profileId, chatId: item.chatId, postId: item.postId },
        },
      );
      if (!out.drafts.length) toast.message('The AI had nothing to suggest. Try again.');
      setDrafted(out.drafts);
      setOpener(out.opener);
      setDraftedAs(out.kind);
      setUnanswered(out.unanswered);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  /**
   * Copying a message notes it as sent, so its follow-ups come in turn (decision 67): the link moves them on to
   * pitched (decision 47), a first message also notes which opener it was, and a partner's moves them along the
   * Partners list. That it couldn't is no reason to stop them.
   */
  const noteSent = async (sent: DraftKind) => {
    const profileId = item.profileId;
    if (!profileId) return;
    const api = apiBrowser();
    if (sent === 'pitch')
      await api
        .POST('/v1/commands/outreach.stage.mark', {
          body: { workspaceId, profileId, mark: 'pitched' },
        })
        .catch(() => undefined);
    else if (
      sent === 'opener' ||
      sent === 'video' ||
      sent === 'follow_up' ||
      sent === 'check_in' ||
      sent === 'reply' ||
      isPartnerMessage(sent)
    )
      await api
        .POST('/v1/commands/outreach.conversation.note', {
          body: { workspaceId, profileId, kind: sent },
        })
        .catch(() => undefined);
    if (sent !== 'opener' || !opener) return;
    await api
      .POST('/v1/commands/outreach.opener.use', { body: { workspaceId, profileId, opener } })
      .catch(() => undefined);
  };
  const copy = async (text: string, part?: { readonly n: number; readonly of: number }) => {
    await copyText(
      text,
      underPost
        ? 'Copied. Paste it as a comment on the post.'
        : part
          ? `Copied text ${part.n} of ${part.of}. Paste it in ${messaging}${part.n < part.of ? ', then copy the next' : ''}.`
          : `Copied. Paste it in ${messaging}.`,
    );
    // A message copied a text at a time counts once, with its first.
    if (part && part.n > 1) return;
    await noteSent(as);
  };
  const stopping = useAct();
  const stopCheckIns = (profileId: string) =>
    stopping.act(
      'stop',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.conversation.stop', {
            body: { workspaceId, profileId },
          }),
        ),
      W.checkInsStopped(item.name),
    );
  return (
    <div className="mt-2">
      {!online && drafted.length ? (
        <p className="mb-1 text-[12px] text-text-3" data-testid="today-drafts-offline">
          {asks.computer
            ? 'Your computer is offline, so these are from what HandsFreeOS knows.'
            : 'These are from what HandsFreeOS knows.'}
        </p>
      ) : null}
      {fromLookup && looked?.line ? (
        <p className="mb-1 text-[12px] text-text-3" data-testid="today-looked-up">
          {looked.line}
        </p>
      ) : null}
      {drafts.length && opener ? (
        <p className="mb-1 text-[12px] text-text-3" data-testid="today-opener">
          Opens with {OPENER_KINDS[opener.kind].toLowerCase()}: “{openerShort(opener.text, 70)}”
        </p>
      ) : null}
      {drafts.length && unanswered ? (
        <p className="mb-1 text-[12px] text-text-3" data-testid="today-unanswered">
          {KNOWS_WORDS.draftNote(unanswered)}
        </p>
      ) : null}
      {drafts.length ? (
        <ul className="space-y-1.5" data-testid="today-drafts">
          {drafts.map((text) => {
            // A message the person sends as a few texts: each its own, to copy in turn.
            const parts = underPost ? [text] : messageParts(text, true);
            return (
              <li key={text} className="space-y-1 rounded-md bg-card-2 px-3 py-2 text-[13px]">
                {parts.map((part, i) => (
                  <div key={i} className="flex items-start gap-2" data-testid="today-draft-text">
                    <p className="flex-1 whitespace-pre-wrap">{part}</p>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={
                        parts.length > 1
                          ? `Copy text ${i + 1} of ${parts.length}`
                          : 'Copy this draft'
                      }
                      onClick={() =>
                        void copy(
                          part,
                          parts.length > 1 ? { n: i + 1, of: parts.length } : undefined,
                        )
                      }
                    >
                      <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </Button>
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      ) : null}
      {looked && (lookingUp || looked.state !== 'done') ? (
        <AskLine workspaceId={workspaceId} asks={asks} ask={looked} className="mt-1.5" />
      ) : null}
      {online ? (
        <div className="mt-1.5 inline-flex">
          <AskButton
            workspaceId={workspaceId}
            asks={asks}
            ask={lookup}
            platform={platform}
            label={
              drafts.length
                ? 'Look up and draft again'
                : underPost
                  ? kind === 'group_reply'
                    ? 'Draft a reply'
                    : 'Draft a comment'
                  : 'Draft a message'
            }
            showLine={false}
            onAsked={() => setDrafted([])}
            testId="today-draft-lookup"
          />
        </div>
      ) : null}
      <Button
        variant={online ? 'ghost' : 'secondary'}
        size="sm"
        className={online ? 'ml-1.5 mt-1.5' : 'mt-1.5'}
        disabled={busy || lookingUp}
        onClick={() => void ask()}
        data-testid="today-draft"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
        ) : (
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />
        )}
        {online
          ? 'Draft from what HandsFreeOS knows'
          : drafts.length
            ? 'Draft again'
            : underPost
              ? kind === 'group_reply'
                ? 'Draft a reply'
                : 'Draft a comment'
              : 'Draft a message'}
      </Button>
      {kind === 'video' && item.videoLink ? (
        <Button
          variant="ghost"
          size="sm"
          className="ml-1.5 mt-1.5"
          onClick={() =>
            void copyText(item.videoLink!, W.videoCopied).then(() => noteSent('video'))
          }
          data-testid="today-video-link"
        >
          <Video className="h-3.5 w-3.5" strokeWidth={1.5} />
          {W.copyVideoLink}
        </Button>
      ) : null}
      {item.demoLink && kind !== 'video' ? (
        <Button
          variant="ghost"
          size="sm"
          className="ml-1.5 mt-1.5"
          onClick={() =>
            kind === 'pitch'
              ? void copyText(item.demoLink!, W.linkCopied).then(() => noteSent('pitch'))
              : void copyText(
                  item.demoLink!,
                  'Copied your demo link for them. A booking through it counts by itself.',
                )
          }
          data-testid="today-demo-link"
        >
          <CalendarCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
          {kind === 'pitch' ? W.copyLinkOnly : 'Copy demo link'}
        </Button>
      ) : null}
      {kind === 'check_in' && item.profileId ? (
        <Button
          variant="ghost"
          size="sm"
          className="ml-1.5 mt-1.5"
          disabled={stopping.busy !== null}
          onClick={() => void stopCheckIns(item.profileId!)}
          data-testid="today-stop-check-ins"
        >
          <BellOff className="h-3.5 w-3.5" strokeWidth={1.5} />
          {W.stopCheckIns}
        </Button>
      ) : null}
      {item.postId ? (
        <Button
          variant="ghost"
          size="sm"
          className="ml-1.5 mt-1.5"
          disabled={skipping.busy !== null}
          onClick={() => void skip(item.postId!)}
          data-testid="today-skip"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          {W.notForMe}
        </Button>
      ) : null}
    </div>
  );
}
