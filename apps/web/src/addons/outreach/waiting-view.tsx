'use client';
/**
 * Needs you, Social Outreach's first page (docs/outreach.md, decisions 40, 42, 59, 72 and 127). The extension only
 * counts it, on its icon and in a line in its panel, which links to Today's `#needs-you` as its pop-ups do: Today
 * sends that here, and the list keeps the id. Everything waiting for the person, in one list
 * (packages/core/src/addons/outreach/waiting.ts):
 *
 * - **Your computer needs you**: something asked of it from here hit a step it couldn't find, or Facebook wants a
 *   password typed (./asks.tsx), with **Carry on**, **Skip** and **Stop**;
 * - **Replies handed over to you**: replies that need the person, each with why, to change, send or skip;
 * - **Messages to OK**: **Approve all** OKs them, except one to someone who needs the person, which waits on its own;
 *   with comments on good posts among them (decision 92, Instagram's and Alignable's), **Messages and comments to OK**,
 *   each comment headed "Comment on Dana Reyes’s post" with the post's first words above it. Approve all takes them
 *   too, never an answer to a post asking for what the business offers, and says why. While comments wait for the
 *   person under their own hold, it says how long that lasts;
 * - **Steps it needs you for**: a step the extension couldn't do, in its network's words, to do there (**I did it**)
 *   or **Let it go**; **Open** goes to their page on that network (or the post, or the chat), and a message that
 *   didn't go has its words to copy. Every step that can be tried again has **Retry** (decisions 132 and 144), with
 *   **Retry all** over two or more: a message goes again a few minutes after the one before, and any other step goes
 *   back on Today's list for the extension's next go;
 * - **Friend requests to decide**: requests from the last two weeks the AI isn't sure of (decision 136), or that didn't
 *   fit a playbook, with why, and **Confirm** and **Delete** (the extension does it; what the AI says stands out) beside
 *   **Leave it**.
 *
 * Each person's name opens their person menu (./person-menu.tsx, decision 91): their page first, then Contacts, Mark
 * as client, Demo booked, Don't pitch and Never contact. Each card keeps its own Open.
 *
 * It follows changes live: a message drafted or sent, a step noted on any computer, a request answered. One list for
 * every network, each item marked with its network by name (`networkOfWaiting`), its links on that network.
 */
import { TOUCHED_POSTS_WORDS } from '@hfos/core/addons/outreach/activity';
import { underAPost, wheelsWords } from '@hfos/core/addons/outreach/automation';
import {
  chatUrlOn,
  networkOfWaiting,
  openChatWords,
  openPageWords,
} from '@hfos/core/addons/outreach/network-words';
import { answersRequests, networkOfLink } from '@hfos/core/addons/outreach/networks';
import { COMMENT_HOLD_WORDS } from '@hfos/core/addons/outreach/sends';
import {
  approveAllCount,
  approveAllTakesComments,
  approveAllWords,
  commentHoldShown,
  forumAnswer,
  forumAnswersLeftWords,
  messagesTitle,
  moreWords,
  needClearedWords,
  needPageOf,
  needReportHref,
  NEED_REPORT_WORDS,
  needRetryable,
  needTitleAround,
  needWhyWords,
  NEED_CLEARS,
  NEED_RETRY,
  postTitleAround,
  retriedWords,
  WAITING_KIND_KEYS,
  WAITING_KINDS,
  waitingWords,
  type NeedClear,
  type WaitingKind,
} from '@hfos/core/addons/outreach/waiting-words';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { Check, CheckCheck, Copy, ExternalLink, RotateCcw, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useStaffCan } from '@/components/shell/workspace-shell';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { outreachHref } from './address';
import { AskLine } from './asks';
import { ChatSoFar } from './chat-bubbles';
import { KeepChatButton } from './chat-keep';
import { UnsureCountryCard } from './country-skipped';
import { NetworkName } from './network-ui';
import { PersonName } from './person-menu';
import { PostQuote } from './post-quote';
import { Drafted } from './drafted';
import type { Waiting, WaitingItem } from './types';
import { useAct } from './use-act';

type SendItem = Extract<WaitingItem, { kind: 'reply' | 'message' }>;
type NeedItem = Extract<WaitingItem, { kind: 'need' }>;
type RequestItem = Extract<WaitingItem, { kind: 'request' }>;

/** "Oct 9, 2:10 PM", on the business's clock: the same on the server and in the browser. */
function when(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

export function NeedsYou({ workspaceId, waiting }: { workspaceId: string; waiting: Waiting }) {
  useLiveRefresh(
    [
      'outreach_profile',
      'outreach_need',
      'outreach_ask',
      'workspace',
      'outreach_automation',
      'addon',
    ],
    800,
  );
  return (
    <section
      id="needs-you"
      aria-label={W.needsYou}
      className="space-y-3"
      data-testid="outreach-waiting"
    >
      {waiting.count ? (
        <>
          <p className="text-[13px] text-text-2" data-testid="waiting-count">
            {waitingWords(waiting.count)}
          </p>
          {WAITING_KIND_KEYS.map((kind) => (
            <Group key={kind} workspaceId={workspaceId} kind={kind} waiting={waiting} />
          ))}
        </>
      ) : (
        <p
          className="rounded-card border border-dashed border-border-strong px-4 py-3.5 text-[13px] text-text-2"
          data-testid="waiting-none"
        >
          {W.needsYouNone}
        </p>
      )}
      {/* Whoever the country setting can't place waits on the person too (decision 128): it loads itself. */}
      <UnsureCountryCard workspaceId={workspaceId} />
    </section>
  );
}

function Group({
  workspaceId,
  kind,
  waiting,
}: {
  workspaceId: string;
  kind: WaitingKind;
  waiting: Waiting;
}) {
  const items = waiting.items.filter((item) => item.kind === kind);
  const count = waiting.kinds[kind].count;
  if (!count) return null;
  // Comments on good posts wait among the messages (decision 92): the heading says so, and Approve all leaves forum
  // answers, saying why.
  const sends = items.flatMap((item) => (item.kind === 'message' ? [item.send] : []));
  const comments = sends.filter((send) => underAPost(send.kind));
  const answers = comments.filter(forumAnswer).length;
  // A comment Approve all takes, on a network whose comments-only hold is on: the hold's note says what it is.
  const held = commentHoldShown(comments, waiting.commentHolds);
  return (
    <Card className="p-0" data-testid={`waiting-${kind}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 pt-4">
        <h3 className="text-[15px] font-semibold" data-testid={`waiting-${kind}-title`}>
          {kind === 'message' ? messagesTitle(comments.length > 0) : WAITING_KINDS[kind]}{' '}
          <span className="text-text-3">· {count.toLocaleString()}</span>
        </h3>
        {kind === 'message' ? (
          <ApproveAll
            workspaceId={workspaceId}
            waiting={waiting}
            comments={approveAllTakesComments(comments)}
          />
        ) : null}
        {kind === 'need' ? <RetryAll workspaceId={workspaceId} items={items} /> : null}
      </div>
      {kind === 'message' && waiting.wheels.on ? (
        <p className="px-5 pt-1.5 text-[12.5px] text-text-2" data-testid="waiting-wheels">
          {wheelsWords(waiting.wheels)}
        </p>
      ) : null}
      {kind === 'message' && held ? (
        <p className="px-5 pt-1.5 text-[12.5px] text-text-2" data-testid="waiting-comment-hold">
          {COMMENT_HOLD_WORDS}
        </p>
      ) : null}
      {kind === 'message' && answers && approveAllCount(waiting.items, count) >= 2 ? (
        <p className="px-5 pt-1.5 text-[12.5px] text-text-2" data-testid="waiting-answers-left">
          {forumAnswersLeftWords(answers)}
        </p>
      ) : null}
      {kind === 'reply' ? (
        <p className="px-5 pt-1.5 text-[12.5px] text-text-2">{W.repliesNote}</p>
      ) : null}
      <ul className="mt-2">
        {items.map((item) => (
          <li
            key={
              item.kind === 'ask'
                ? item.ask.askId
                : item.kind === 'need'
                  ? item.need.needId
                  : item.kind === 'request'
                    ? item.request.profileId
                    : item.send.sendId
            }
            className="border-t border-border px-5 py-3.5"
            data-testid="waiting-item"
          >
            {item.kind === 'ask' ? (
              <>
                <NetworkName platform={networkOfWaiting(item)} className="mb-1 block" />
                <AskLine
                  workspaceId={workspaceId}
                  asks={{ timezone: waiting.timezone, computer: null, now: item.at }}
                  ask={item.ask}
                  named
                />
              </>
            ) : item.kind === 'need' ? (
              <NeedRow workspaceId={workspaceId} item={item} timeZone={waiting.timezone} />
            ) : item.kind === 'request' ? (
              <RequestRow workspaceId={workspaceId} item={item} timeZone={waiting.timezone} />
            ) : (
              <SendRow workspaceId={workspaceId} item={item} />
            )}
          </li>
        ))}
      </ul>
      {items.length < count ? (
        <p className="border-t border-border px-5 py-3 text-[12.5px] text-text-3">
          {moreWords(kind, count - items.length)}
        </p>
      ) : null}
      {kind === 'request' ? (
        <p className="border-t border-border px-5 py-3 text-[13px]">
          <Link
            className="font-medium text-accent-text underline-offset-2 hover:underline"
            href={outreachHref(workspaceId, { view: 'friends', show: 'requests' })}
          >
            All your requests
          </Link>
        </p>
      ) : null}
    </Card>
  );
}

/** OKs every message, and comment, waiting but those that wait on their own. */
function ApproveAll({
  workspaceId,
  waiting,
  comments,
}: {
  workspaceId: string;
  waiting: Waiting;
  /** Comments it takes wait among the messages (decision 92): they go together. */
  comments: boolean;
}) {
  const { busy, act } = useAct();
  // More may wait than are listed: the count, less those listed that wait on their own.
  const all = approveAllCount(waiting.items, waiting.kinds.message.count);
  if (all < 2) return null;
  return (
    <Button
      size="sm"
      disabled={busy !== null}
      onClick={() =>
        void act('all', async () => {
          // The number the server OK'd: more may have come in since the page loaded.
          const out = unwrap(
            await apiBrowser().POST('/v1/commands/outreach.send.approve', {
              body: { workspaceId },
            }),
          );
          toast.success(W.okdAll(out.approved.length, comments));
        })
      }
      data-testid="waiting-approve-all"
    >
      <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
      {approveAllWords(all, comments)}
    </Button>
  );
}

/**
 * Tries a step handed over again, or every one (`needIds` null): a message a few minutes after the one before, any
 * other step back on Today's list (decision 144).
 */
async function retry(workspaceId: string, needIds: string[] | null): Promise<void> {
  const { retried, passed } = unwrap(
    await apiBrowser().POST('/v1/commands/outreach.need.retry', {
      body: { workspaceId, needIds },
    }),
  );
  const said = retriedWords(retried.length, passed);
  if (retried.length) toast.success(said);
  else toast.info(said);
}

/** Retry all, over two or more steps that can be tried again (decisions 132 and 144). */
function RetryAll({ workspaceId, items }: { workspaceId: string; items: readonly WaitingItem[] }) {
  const { busy, act } = useAct();
  const retryable = items.filter((item) => item.kind === 'need' && needRetryable(item.need));
  if (retryable.length < 2) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy !== null}
      onClick={() => void act('retry-all', () => retry(workspaceId, null))}
      data-testid="waiting-retry-all"
    >
      <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
      {NEED_RETRY.all}
    </Button>
  );
}

function SendRow({ workspaceId, item }: { workspaceId: string; item: SendItem }) {
  const send = item.send;
  const platform = networkOfWaiting(item);
  if (underAPost(send.kind)) return <CommentRow workspaceId={workspaceId} item={item} />;
  const chat = chatUrlOn(platform, send.threadKey);
  const open = chat ?? send.profileUrl;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {/* The name opens the person menu (decision 91): their page first, Contacts, Client, Don't pitch and more. */}
        <PersonName
          workspaceId={workspaceId}
          who={{
            profileId: send.profileId,
            name: send.name,
            platform,
            url: send.profileUrl,
            threadKey: send.threadKey,
          }}
          className="text-[14px] font-medium"
        />
        <NetworkName platform={platform} />
        {item.kind === 'reply' ? <Badge variant="pending">{W.handedOver}</Badge> : null}
        {open ? (
          <a
            href={open}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName({ variant: 'ghost', size: 'sm', className: 'h-7' })}
            data-testid="waiting-send-open"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            {chat ? openChatWords(platform) : openPageWords(platform)}
          </a>
        ) : null}
      </div>
      <ChatSoFar recent={send.recent} />
      <Drafted workspaceId={workspaceId} name={send.name} send={send} />
      {/* The chat it answers, onto their card in Contacts. */}
      {item.kind === 'reply' && send.chatId ? (
        <div className="mt-1.5">
          <KeepChatButton
            workspaceId={workspaceId}
            chatId={send.chatId}
            name={send.name}
            withProfile
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A comment on a good post waiting for the person's OK (decision 92): "Comment on Dana Reyes’s post", the post's first
 * words, then the comment with OK, Change and Skip. Open goes to the post. The day's reply in a group (decision 114)
 * the same way: "Answer Dana Reyes’s question".
 */
function CommentRow({ workspaceId, item }: { workspaceId: string; item: SendItem }) {
  const send = item.send;
  const platform = networkOfWaiting(item);
  const open = send.postUrl ?? send.profileUrl;
  const around = postTitleAround(send.kind);
  return (
    <div data-testid="waiting-comment">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[14px] font-medium" data-testid="waiting-comment-title">
          {around[0]}
          {/* The name opens the person menu (decision 91): their page first, Contacts, Client, Don't pitch and more. */}
          <PersonName
            workspaceId={workspaceId}
            who={{ profileId: send.profileId, name: send.name, platform, url: send.profileUrl }}
            className="text-accent-text"
          />
          {around[1]}
        </p>
        <NetworkName platform={platform} />
        {open ? (
          <a
            href={open}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName({ variant: 'ghost', size: 'sm', className: 'h-7' })}
            data-testid="waiting-send-open"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            {send.postUrl ? TOUCHED_POSTS_WORDS.openPost : openPageWords(platform)}
          </a>
        ) : null}
      </div>
      {send.post ? (
        <PostQuote post={send.post} whole={send.postWhole} testId="waiting-comment-post" />
      ) : null}
      <Drafted workspaceId={workspaceId} name={send.name} send={send} comment={platform} />
    </div>
  );
}

function NeedRow({
  workspaceId,
  item,
  timeZone,
}: {
  workspaceId: string;
  item: NeedItem;
  timeZone: string;
}) {
  const need = item.need;
  const { busy, act } = useAct();
  const staffSees = useStaffCan('platform.health.read');
  const clear = (how: NeedClear) =>
    act(how, async () => {
      const { state } = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.need.clear', {
          body: { workspaceId, needId: need.needId, how },
        }),
      );
      const said = needClearedWords(how, state);
      if (state === 'open') toast.info(said);
      else toast.success(said);
    });
  const platform = networkOfWaiting(item);
  const messenger = need.step === 'message' ? chatUrlOn(platform, need.threadKey) : null;
  // Only an address on a network the add-on knows is linked: their page there, the post, or the chat.
  const page = need.url && networkOfLink(need.url) ? need.url : null;
  const [before, after] = needTitleAround(need.step, platform);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[14px] font-medium" data-testid="waiting-need">
          {before}
          {/* Their page is the menu's first item; the step's own link is Open, below. */}
          <PersonName
            workspaceId={workspaceId}
            who={{
              profileId: need.profileId,
              name: need.name,
              // The step's address when it's their page, so it opens with no signal; else where they stand says.
              url: needPageOf(need),
              platform,
              threadKey: need.threadKey,
            }}
            className="text-accent-text"
          />
          {after}
        </p>
        <NetworkName platform={platform} />
      </div>
      <p className="mt-1 text-[12.5px] text-text-2">
        {needWhyWords(need.why)}
        {when(need.seenAt, timeZone) ? ` · ${when(need.seenAt, timeZone)}` : ''}
        {/* HandsFreeOS staff only: the page the extension saw, and what the AI helper found (decision 142). */}
        {need.reportId && staffSees ? (
          <>
            {' · '}
            <Link
              href={needReportHref(need.reportId)}
              className="font-medium text-accent-text hover:underline"
              data-testid="waiting-need-report"
            >
              {NEED_REPORT_WORDS}
            </Link>
          </>
        ) : null}
      </p>
      {need.text ? (
        <div className="mt-2 flex items-start gap-2">
          <p className="flex-1 whitespace-pre-wrap rounded-md bg-card-2 px-3 py-2 text-[13px]">
            {need.text}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void copyText(need.text ?? '', W.copied)}
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
            {W.copy}
          </Button>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {messenger || page ? (
          <a
            href={messenger ?? page ?? ''}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName({ variant: 'ghost', size: 'sm' })}
            data-testid="waiting-need-open"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            {messenger ? openChatWords(platform) : openPageWords(platform)}
          </a>
        ) : null}
        {needRetryable(need) ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void act('retry', () => retry(workspaceId, [need.needId]))}
            data-testid="waiting-need-retry"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
            {NEED_RETRY.one}
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => void clear('done')}
          data-testid="waiting-need-done"
        >
          <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
          {NEED_CLEARS.done}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => void clear('dismissed')}
          data-testid="waiting-need-dismiss"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          {NEED_CLEARS.dismissed}
        </Button>
      </div>
    </div>
  );
}

function RequestRow({
  workspaceId,
  item,
  timeZone,
}: {
  workspaceId: string;
  item: RequestItem;
  timeZone: string;
}) {
  const request = item.request;
  const platform = networkOfWaiting(item);
  // Confirm and Delete where the extension answers requests (decision 136): Facebook, LinkedIn and Alignable.
  const answers = answersRequests(platform);
  const { busy, act } = useAct();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="waiting-request">
          <PersonName
            workspaceId={workspaceId}
            who={{
              profileId: request.profileId,
              name: request.name,
              platform,
              url: request.url,
            }}
            className="text-[14px] font-medium"
          />
        </span>
        <NetworkName platform={platform} />
        <span className="text-[12.5px] text-text-3">
          {W.asked(when(request.since, timeZone), request.mutualFriends)}
        </span>
      </div>
      {request.why.length ? (
        <p className="mt-1 text-[12.5px] text-text-2">{request.why.join(' · ')}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <a
          href={request.url}
          target="_blank"
          rel="noreferrer"
          className={buttonClassName({ variant: 'ghost', size: 'sm' })}
        >
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
          {openPageWords(platform)}
        </a>
        {answers
          ? (['confirm', 'delete'] as const).map((answer) => (
              <Button
                key={answer}
                // What the AI says stands out (decision 136): the rest stay quiet.
                variant={request.said === answer ? 'secondary' : 'ghost'}
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void act(
                    answer,
                    async () =>
                      unwrap(
                        await apiBrowser().POST('/v1/commands/outreach.request.answer', {
                          body: { workspaceId, profileId: request.profileId, answer },
                        }),
                      ),
                    answer === 'confirm' ? W.confirming(request.name) : W.deleting(request.name),
                  )
                }
                data-testid={`waiting-request-${answer}`}
              >
                {answer === 'confirm' ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                )}
                {answer === 'confirm' ? W.confirmRequest : W.deleteRequest}
              </Button>
            ))
          : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void act(
              'aside',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/outreach.request.set_aside', {
                    body: { workspaceId, profileId: request.profileId },
                  }),
                ),
              W.left(request.name),
            )
          }
          data-testid="waiting-request-leave"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          {W.leaveIt}
        </Button>
      </div>
    </div>
  );
}
