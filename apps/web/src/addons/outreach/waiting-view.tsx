'use client';
/**
 * Needs you, at the top of Social Outreach's Today (docs/outreach.md, decisions 40, 42 and 59): everything waiting for
 * the person, in one list, the same as the extension's panel and the number on its icon (packages/core/src/addons/outreach/waiting.ts):
 *
 * - **Your computer needs you**: something asked of it from here hit a step it couldn't find, or Facebook wants a
 *   password typed (./asks.tsx), with **Carry on**, **Skip** and **Stop**;
 * - **Replies handed over to you**: replies that need the person, each with why, to change, send or skip;
 * - **Messages to OK**: **Approve all** OKs them, except one to someone who needs the person, which waits on its own;
 * - **Steps it needs you for**: a step the extension couldn't do, to do on Facebook (**I did it**) or **Let it go**;
 *   a message that didn't go has its words to copy;
 * - **Friend requests to decide**: requests from the last two weeks that didn't fit a playbook, with why, and
 *   **Leave it**.
 *
 * It follows changes live: a message drafted or sent, a step noted on any computer, a request answered. One list for
 * every network, each item marked with its network by name (`networkOfWaiting`), its links on that network.
 */
import { wheelsWords } from '@hfos/core/addons/outreach/automation';
import {
  chatUrlOn,
  networkOfWaiting,
  openChatWords,
  openPageWords,
} from '@hfos/core/addons/outreach/network-words';
import { networkOfLink } from '@hfos/core/addons/outreach/networks';
import {
  approveAllCount,
  approveAllWords,
  moreWords,
  needClearedWords,
  needTitle,
  needWhyWords,
  NEED_CLEARS,
  WAITING_KIND_KEYS,
  WAITING_KINDS,
  waitingWords,
  type NeedClear,
  type WaitingKind,
} from '@hfos/core/addons/outreach/waiting-words';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { Check, CheckCheck, Copy, ExternalLink, X } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
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
import { NetworkName } from './network-ui';
import { PersonMenu } from './person-menu';
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
    <section aria-labelledby="needs-you" className="space-y-3" data-testid="outreach-waiting">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="needs-you" className="text-lg font-semibold tracking-tight">
          {W.needsYou}
          {waiting.count ? (
            <span className="font-medium text-text-3" data-testid="waiting-count">
              {' '}
              · {waiting.count.toLocaleString()}
            </span>
          ) : null}
        </h2>
        {waiting.count ? (
          <span className="text-[12.5px] text-text-3">{waitingWords(waiting.count)}</span>
        ) : null}
      </div>
      {waiting.count ? (
        WAITING_KIND_KEYS.map((kind) => (
          <Group key={kind} workspaceId={workspaceId} kind={kind} waiting={waiting} />
        ))
      ) : (
        <p
          className="rounded-card border border-dashed border-border-strong px-4 py-3.5 text-[13px] text-text-2"
          data-testid="waiting-none"
        >
          {W.needsYouNone}
        </p>
      )}
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
  return (
    <Card className="p-0" data-testid={`waiting-${kind}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 pt-4">
        <h3 className="text-[15px] font-semibold">
          {WAITING_KINDS[kind]} <span className="text-text-3">· {count.toLocaleString()}</span>
        </h3>
        {kind === 'message' ? <ApproveAll workspaceId={workspaceId} waiting={waiting} /> : null}
      </div>
      {kind === 'message' && waiting.wheels.on ? (
        <p className="px-5 pt-1.5 text-[12.5px] text-text-2" data-testid="waiting-wheels">
          {wheelsWords(waiting.wheels)}
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

/** OKs every message waiting but those that wait on their own. */
function ApproveAll({ workspaceId, waiting }: { workspaceId: string; waiting: Waiting }) {
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
          toast.success(W.okdAll(out.approved.length));
        })
      }
      data-testid="waiting-approve-all"
    >
      <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
      {approveAllWords(all)}
    </Button>
  );
}

function SendRow({ workspaceId, item }: { workspaceId: string; item: SendItem }) {
  const send = item.send;
  const platform = networkOfWaiting(item);
  const open = chatUrlOn(platform, send.threadKey) ?? send.profileUrl;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {open ? (
          <a
            href={open}
            target="_blank"
            rel="noreferrer"
            className="text-[14px] font-medium hover:underline"
          >
            {send.name}
          </a>
        ) : (
          <span className="text-[14px] font-medium">{send.name}</span>
        )}
        <NetworkName platform={platform} />
        {item.kind === 'reply' ? <Badge variant="pending">{W.handedOver}</Badge> : null}
        <PersonMenu workspaceId={workspaceId} who={send} />
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
  // Only an address on a network the add-on knows is linked.
  const onFacebook = need.url && networkOfLink(need.url) ? need.url : null;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[14px] font-medium" data-testid="waiting-need">
          {needTitle(need.step, need.name)}
        </p>
        <NetworkName platform={platform} />
        <PersonMenu workspaceId={workspaceId} who={need} />
      </div>
      <p className="mt-1 text-[12.5px] text-text-2">
        {needWhyWords(need.why)}
        {when(need.seenAt, timeZone) ? ` · ${when(need.seenAt, timeZone)}` : ''}
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
        {messenger || onFacebook ? (
          <a
            href={messenger ?? onFacebook ?? ''}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName({ variant: 'ghost', size: 'sm' })}
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            {messenger ? openChatWords(platform) : openPageWords(platform)}
          </a>
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
  const { busy, act } = useAct();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={request.url}
          target="_blank"
          rel="noreferrer"
          className="text-[14px] font-medium hover:underline"
          data-testid="waiting-request"
        >
          {request.name}
        </a>
        <NetworkName platform={platform} />
        <span className="text-[12.5px] text-text-3">
          {W.asked(when(request.since, timeZone), request.mutualFriends)}
        </span>
        <PersonMenu workspaceId={workspaceId} who={request} />
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
