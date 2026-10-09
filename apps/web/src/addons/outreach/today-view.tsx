'use client';
/**
 * Social Outreach's Today tab (docs/outreach.md, the plan's Phase 1 step 5): the person's short list for the day on
 * Facebook, from what HandsFreeOS knows (packages/core/src/addons/outreach/today.ts): requests they got from people who
 * fit to confirm (decision 30), a post to like before a friend request (decision 33), friend requests to people from
 * the business's groups who fit a playbook, a first message to new friends, follow-ups and replies, and comments on
 * good posts in their groups (decision 20). With the extension on its own (decision 26), it does the confirms,
 * likes, requests and comments itself in the person's working hours. Each opens on Facebook, and a message or a comment comes with the AI's
 * drafts to copy; a post can be put aside. HandsFreeOS never sends anything there: the person does, and the extension
 * notes it, which takes it off the list and counts it against today's limits. The extension's panel looks the person
 * up on Facebook before drafting (decision 21); here, the drafts come from what HandsFreeOS knows. A first message's
 * drafts open the way the playbook's next opener says, and copying one notes which it was, for the results card
 * (decision 23). Anyone on the list for a message has the person's own demo link to copy (decision 24).
 */
import { DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import { OPENER_KINDS, openerShort, type DraftOpener } from '@hfos/core/addons/outreach/openers';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import {
  DRAFT_KINDS,
  TODAY_KINDS,
  type DraftKind,
  type TodayDraftOutput,
} from '@hfos/core/addons/outreach/today';
import { CalendarCheck, Copy, Loader2, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { EmptyState } from '@/components/ui/empty-state';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { outreachHref } from './address';
import type { TodayItem, TodayList } from './types';
import { useAct } from './use-act';

const KIND_BADGE = {
  confirm: 'ok',
  warm_up: 'gray',
  friend_request: 'accent',
  opener: 'ok',
  follow_up: 'gray',
  reply: 'pending',
  comment: 'accent',
} as const;

/** Where to open someone on the list: the post to comment on, their chat for a message in one, else their profile. */
function openUrl(item: TodayItem): string | null {
  if (item.postUrl) return item.postUrl;
  if (item.threadKey)
    return `https://www.facebook.com/messages/t/${encodeURIComponent(item.threadKey)}`;
  return item.profileUrl;
}

export function TodayView({ workspaceId, today }: { workspaceId: string; today: TodayList }) {
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
        {today.items.length ? (
          <Card className="p-0" data-testid="today-list">
            <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
              <h3 className="text-[15px] font-semibold">Your list for today</h3>
              <span className="text-[12.5px] text-text-3">
                You do each one, or the extension does on its own
              </span>
            </div>
            <ul className="mt-2">
              {today.items.map((item) => (
                <TodayRow
                  key={`${item.kind}:${item.postId ?? item.chatId ?? item.profileId ?? item.name}`}
                  workspaceId={workspaceId}
                  item={item}
                  auto={today.auto.includes(item.kind)}
                />
              ))}
            </ul>
          </Card>
        ) : (
          <Card data-testid="today-empty">
            <EmptyState title="Nothing on your list yet">
              Save groups and their members with the extension, read your chats in Messenger, and
              find posts in your groups. People who fit your playbooks, new friends to say hi to,
              chats to follow up and posts worth a comment show here.
            </EmptyState>
          </Card>
        )}
      </div>
      <aside className="space-y-4">
        <Card className="p-4" data-testid="today-limits">
          <h3 className="text-[15px] font-semibold">Today so far</h3>
          <ul className="mt-2 space-y-1 text-[13px]">
            {limits.map(([step, { done, most }]) => (
              <li key={step} className="flex justify-between gap-3">
                <span className="text-text-2">{DAILY_WORDS[step].label}</span>
                <span className="tabular-nums">
                  {done.toLocaleString()} of {most.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </Card>
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
              nobody who runs a group is approached. Open the list and save it with the extension.
            </p>
            <ul className="mt-2 space-y-1 text-[13px]">
              {today.readAdmins.map((g) => (
                <li key={g.groupId}>
                  <a
                    href={`${g.url.replace(/\/?$/, '/')}members/admins`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-text hover:underline"
                  >
                    {g.name ?? 'A group'}
                  </a>
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
}: {
  workspaceId: string;
  item: TodayItem;
  /** The extension does it on its own for you. */
  auto: boolean;
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
              Done on its own
            </Badge>
          ) : null}
          <Badge variant={KIND_BADGE[item.kind]}>{TODAY_KINDS[item.kind]}</Badge>
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
      {draftKind ? <Drafts workspaceId={workspaceId} item={item} kind={draftKind} /> : null}
    </li>
  );
}

/** The AI's drafts for a message, asked for when wanted: each to copy and send on Facebook. */
function Drafts({
  workspaceId,
  item,
  kind,
}: {
  workspaceId: string;
  item: TodayItem;
  kind: DraftKind;
}) {
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<readonly string[]>([]);
  /** The opener the drafts were written with, for a first message. */
  const [opener, setOpener] = useState<DraftOpener | null>(null);
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
      'Put aside. It won’t be suggested again.',
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
      setDrafts(out.drafts);
      setOpener(out.opener);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  /** Copying a first message notes which opener it was; that it couldn't is no reason to stop them. */
  const copy = async (text: string) => {
    await copyText(
      text,
      kind === 'comment'
        ? 'Copied. Paste it as a comment on the post.'
        : 'Copied. Paste it in Messenger.',
    );
    if (!opener || !item.profileId) return;
    await apiBrowser()
      .POST('/v1/commands/outreach.opener.use', {
        body: { workspaceId, profileId: item.profileId, opener },
      })
      .catch(() => undefined);
  };
  return (
    <div className="mt-2">
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
      <Button
        variant="secondary"
        size="sm"
        className="mt-1.5"
        disabled={busy}
        onClick={() => void ask()}
        data-testid="today-draft"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
        ) : (
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />
        )}
        {drafts.length ? 'Draft again' : kind === 'comment' ? 'Draft a comment' : 'Draft a message'}
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
          Not for me
        </Button>
      ) : null}
    </div>
  );
}
