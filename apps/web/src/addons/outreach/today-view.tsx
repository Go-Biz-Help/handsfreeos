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
 * person kept as a profile has a menu with Add to Contacts, Demo booked and Don't pitch (./person-menu.tsx). A first message's
 * drafts open the way the playbook's next opener says, and copying one notes which it was, for the results card
 * (decision 23). Anyone on the list for a message has the person's own demo link to copy (decision 24).
 *
 * A message the extension drafted to send for them (packages/core/src/addons/outreach/sends.ts) shows in place of the
 * drafts: one waiting has its words to change, **Send** and **Skip**, and **Approve all** OKs every one waiting but a
 * reply handed over or one to someone who needs the person, which wait for an OK of their own (`oneByOne`, decision
 * 42); the extension then sends them in Messenger. The same messages are in Waiting for you (./waiting-view.tsx). While the person's training wheels are on, it says what's left before they
 * come off; owners and admins see who's on them and can end them early.
 */
import { wheelsWords } from '@hfos/core/addons/outreach/automation';
import { DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import { OPENER_KINDS, openerShort, type DraftOpener } from '@hfos/core/addons/outreach/openers';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import {
  DRAFT_KINDS,
  TODAY_KINDS,
  type DraftKind,
  type TodayDraftOutput,
} from '@hfos/core/addons/outreach/today';
import {
  approveAllWords,
  messengerChatUrl,
  oneByOne,
  oneByOneWords,
} from '@hfos/core/addons/outreach/waiting-words';
import { askOpen, onFacebook } from '@hfos/core/addons/outreach/asks';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { CalendarCheck, Check, CheckCheck, Copy, Loader2, Send, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { EmptyState } from '@/components/ui/empty-state';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { outreachHref } from './address';
import { AskButton, AskLine, latestAsk, targetOf } from './asks';
import { PersonMenu } from './person-menu';
import type { Asks, TodayItem, TodayList, WheelsList } from './types';
import { useAct } from './use-act';

const KIND_BADGE = {
  confirm: 'ok',
  warm_up: 'gray',
  friend_request: 'accent',
  opener: 'ok',
  reconnect: 'ok',
  pitch: 'accent',
  follow_up: 'gray',
  reply: 'pending',
  comment: 'accent',
} as const;

/** Where to open someone on the list: the post to comment on, their chat for a message in one, else their profile. */
function openUrl(item: TodayItem): string | null {
  if (item.postUrl) return item.postUrl;
  return messengerChatUrl(item.threadKey) ?? item.profileUrl;
}

export function TodayView({
  workspaceId,
  today,
  wheels,
  asks,
}: {
  workspaceId: string;
  today: TodayList;
  /** Who's on training wheels: for owners and admins, else null. */
  wheels: WheelsList | null;
  /** The look-ups and group members asked of the person's computer from here. */
  asks: Asks;
}) {
  // A look-up's drafts, and a group's members saved, show once its ask ends.
  useLiveRefresh(['outreach_ask'], 800);
  // Approve all leaves those that wait for an OK of their own: a reply handed over, or one to someone who needs them.
  const waiting = today.items.filter(
    (i) => i.send?.state === 'waiting' && !oneByOne(i.send),
  ).length;
  const approving = useAct();
  const approveAll = () =>
    approving.act('all', async () => {
      // The number the server OK'd: Today lists only today's, and more may have come in since.
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.send.approve', { body: { workspaceId } }),
      );
      toast.success(W.okdAll(out.approved.length));
    });
  const limits = [
    ['friend_request', today.limits.friend_request],
    ['first_message', today.limits.first_message],
    ['follow_up', today.limits.follow_up],
    ['comment', today.limits.comment],
    ['like', today.limits.like],
  ] as const;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]" data-testid="outreach-today">
      <div className="min-w-0 space-y-4">
        {today.warning ? (
          <p
            role="alert"
            data-testid="today-warning"
            className="rounded-card bg-danger-soft p-3.5 text-[13px] text-danger-text"
          >
            {warningNote(today.warning)}
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
        {today.items.length ? (
          <Card className="p-0" data-testid="today-list">
            <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 pt-4">
              <h3 className="text-[15px] font-semibold">{W.listTitle}</h3>
              {waiting > 1 ? (
                <Button
                  size="sm"
                  disabled={approving.busy !== null}
                  onClick={() => void approveAll()}
                  data-testid="today-approve-all"
                >
                  <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {approveAllWords(waiting)}
                </Button>
              ) : (
                <span className="text-[12.5px] text-text-3">
                  You do each one, or the extension does on its own
                </span>
              )}
            </div>
            <ul className="mt-2">
              {today.items.map((item) => (
                <TodayRow
                  key={`${item.kind}:${item.postId ?? item.chatId ?? item.profileId ?? item.name}`}
                  workspaceId={workspaceId}
                  item={item}
                  auto={today.auto.includes(item.kind)}
                  asks={asks}
                />
              ))}
            </ul>
          </Card>
        ) : (
          <Card data-testid="today-empty">
            <EmptyState title={W.todayEmptyTitle}>{W.todayEmptyBody}</EmptyState>
          </Card>
        )}
      </div>
      <aside className="space-y-4">
        <Card className="p-4" data-testid="today-limits">
          <h3 className="text-[15px] font-semibold">{W.todaySoFar}</h3>
          <ul className="mt-2 space-y-1 text-[13px]">
            {limits.map(([step, { done, most }]) => (
              <li key={step} className="flex justify-between gap-3">
                <span className="text-text-2">{DAILY_WORDS[step].label}</span>
                <span className="tabular-nums">{W.countOf(done, most)}</span>
              </li>
            ))}
          </ul>
        </Card>
        {wheels?.people.length ? <WheelsCard workspaceId={workspaceId} wheels={wheels} /> : null}
        {!today.hasPlaybook ? (
          <Card className="p-4">
            <h3 className="text-[15px] font-semibold">Friend requests need a playbook</h3>
            <p className="mt-1.5 text-[13px] text-text-2">
              People from your groups are suggested once the business has a playbook saying who to
              look for.{' '}
              <Link
                href={outreachHref(workspaceId, { view: 'playbooks' })}
                className="text-accent-text hover:underline"
              >
                Go to Playbooks
              </Link>
            </p>
          </Card>
        ) : null}
        {today.readAdmins.length ? (
          <Card className="p-4" data-testid="today-read-admins">
            <h3 className="text-[15px] font-semibold">Save who runs these groups</h3>
            <p className="mt-1.5 text-[13px] text-text-2">
              Their members are suggested once each group’s admins and moderators are saved, so
              nobody who runs a group is approached. Save its members, and your computer reads who
              runs it first.
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
  );
}

function TodayRow({
  workspaceId,
  item,
  auto,
  asks,
}: {
  workspaceId: string;
  item: TodayItem;
  /** The extension does it on its own for you. */
  auto: boolean;
  asks: Asks;
}) {
  const url = openUrl(item);
  const draftKind = DRAFT_KINDS.find((k) => k === item.kind);
  return (
    <li className="border-t border-border px-5 py-3" data-testid="today-item">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 text-[13.5px]">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-accent-text hover:underline"
            >
              {item.name}
            </a>
          ) : (
            <span className="font-medium">{item.name}</span>
          )}
          {item.why.length ? (
            <div className="text-[12.5px] text-text-3">{item.why.join(' · ')}</div>
          ) : null}
        </div>
        <span className="flex items-center gap-1.5">
          {auto ? (
            <Badge variant="ok" data-testid="today-auto">
              {W.doneOnItsOwn}
            </Badge>
          ) : null}
          <Badge variant={KIND_BADGE[item.kind]}>{TODAY_KINDS[item.kind]}</Badge>
          <PersonMenu workspaceId={workspaceId} who={item} />
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
      {item.send ? (
        <Drafted workspaceId={workspaceId} name={item.name} send={item.send} />
      ) : draftKind ? (
        <Drafts workspaceId={workspaceId} item={item} kind={draftKind} asks={asks} />
      ) : null}
    </li>
  );
}

/** What Drafted needs of a message the extension drafted: Today's and Waiting for you's both have it. */
export interface DraftedSend {
  readonly sendId: string;
  readonly state: 'waiting' | 'approved' | (string & {});
  readonly text: string;
  readonly handedOver: boolean;
  readonly needsYou: string | null;
}

/**
 * A message the extension drafted to send: to change, send or skip while it waits, with why it waits for an OK of its
 * own when it does; else it goes soon. Today and Waiting for you both show it.
 */
export function Drafted({
  workspaceId,
  name,
  send,
}: {
  workspaceId: string;
  /** Who it's to. */
  name: string;
  send: DraftedSend;
}) {
  const [text, setText] = useState(send.text);
  const { busy, act } = useAct();
  if (send.state === 'approved')
    return (
      <div className="mt-2" data-testid="today-send-approved">
        <p className="text-[12.5px] text-text-3">{W.sentOkd}</p>
        <p className="mt-1 whitespace-pre-wrap rounded-md bg-card-2 px-3 py-2 text-[13px]">
          {send.text}
        </p>
      </div>
    );
  const alone = oneByOneWords(send);
  return (
    <div className="mt-2 space-y-1.5" data-testid="today-send">
      <p className="text-[12.5px] text-text-3">{W.sentWaiting}</p>
      {alone ? (
        <p className="text-[12.5px] text-warning-text" data-testid="today-send-alone">
          {alone}
        </p>
      ) : null}
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={`Message to ${name}`}
        rows={3}
      />
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          disabled={busy !== null || !text.trim()}
          onClick={() =>
            void act(
              'send',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/outreach.send.approve', {
                    body: { workspaceId, sends: [{ sendId: send.sendId, text }] },
                  }),
                ),
              W.okd,
            )
          }
          data-testid="today-send-ok"
        >
          <Send className="h-3.5 w-3.5" strokeWidth={1.5} />
          Send
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void act(
              'skip',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/outreach.send.skip', {
                    body: { workspaceId, sendId: send.sendId },
                  }),
                ),
              `Skipped. ${name} is off your list for today.`,
            )
          }
          data-testid="today-send-skip"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          Skip
        </Button>
      </div>
    </div>
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
          <li key={p.userId} className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="font-medium">{p.name}</span>
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
                  p.userId,
                  async () =>
                    unwrap(
                      await apiBrowser().POST('/v1/commands/outreach.wheels.end', {
                        body: { workspaceId, userId: p.userId },
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

/** The AI's drafts for a message, asked for when wanted: each to copy and send on Facebook. */
function Drafts({
  workspaceId,
  item,
  kind,
  asks,
}: {
  workspaceId: string;
  item: TodayItem;
  kind: DraftKind;
  asks: Asks;
}) {
  const [busy, setBusy] = useState(false);
  const [drafted, setDrafted] = useState<readonly string[]>([]);
  /** The opener the drafts were written with, for a first message. */
  const [draftedOpener, setOpener] = useState<DraftOpener | null>(null);
  // Looked up on Facebook first, while the computer is online and Facebook didn't warn them today.
  const lookup = {
    kind: 'lookup' as const,
    draft: { kind, profileId: item.profileId, chatId: item.chatId, postId: item.postId },
  };
  const looked = latestAsk(asks, 'lookup', targetOf(lookup));
  const online =
    asks.computer !== null &&
    asks.computer.online &&
    !asks.computer.signedOut &&
    !(asks.warnedToday && onFacebook('lookup'));
  // Drafts asked for here come first; else the look-up's, once it's done.
  const fromLookup = !drafted.length && looked?.state === 'done' ? looked.result : null;
  const drafts = fromLookup?.drafts ?? drafted;
  const opener = fromLookup ? fromLookup.opener : draftedOpener;
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
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  /**
   * Copying a first message notes which opener it was, and copying a pitch moves them on to pitched (decision 47);
   * that it couldn't is no reason to stop them.
   */
  const copy = async (text: string) => {
    await copyText(
      text,
      kind === 'comment'
        ? 'Copied. Paste it as a comment on the post.'
        : 'Copied. Paste it in Messenger.',
    );
    if (kind === 'pitch' && item.profileId)
      await apiBrowser()
        .POST('/v1/commands/outreach.stage.mark', {
          body: { workspaceId, profileId: item.profileId, mark: 'pitched' },
        })
        .catch(() => undefined);
    if (!opener || !item.profileId) return;
    await apiBrowser()
      .POST('/v1/commands/outreach.opener.use', {
        body: { workspaceId, profileId: item.profileId, opener },
      })
      .catch(() => undefined);
  };
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
      {drafts.length ? (
        <ul className="space-y-1.5" data-testid="today-drafts">
          {drafts.map((text) => (
            <li
              key={text}
              className="flex items-start gap-2 rounded-md bg-card-2 px-3 py-2 text-[13px]"
            >
              <p className="flex-1 whitespace-pre-wrap">{text}</p>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copy this draft"
                onClick={() => void copy(text)}
              >
                <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
              </Button>
            </li>
          ))}
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
            label={
              drafts.length
                ? 'Look up and draft again'
                : kind === 'comment'
                  ? 'Draft a comment'
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
            : kind === 'comment'
              ? 'Draft a comment'
              : 'Draft a message'}
      </Button>
      {item.demoLink ? (
        <Button
          variant="ghost"
          size="sm"
          className="ml-1.5 mt-1.5"
          onClick={() =>
            void copyText(
              item.demoLink!,
              'Copied your demo link for them. A booking through it counts by itself.',
            )
          }
          data-testid="today-demo-link"
        >
          <CalendarCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
          Copy demo link
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
