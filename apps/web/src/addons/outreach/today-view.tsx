'use client';
/**
 * Social Outreach's Today tab (docs/outreach.md, the plan's Phase 1 step 5): the person's short list for the day on
 * Facebook, from what HandsFreeOS knows (packages/core/src/addons/outreach/today.ts): friend requests to people from
 * the business's groups who fit a playbook, a first message to new friends, follow-ups and replies. Each opens on
 * Facebook, and a message comes with the AI's drafts to copy. HandsFreeOS never sends anything there: the person does,
 * and the extension notes it, which takes it off the list and counts it against today's limits.
 */
import { DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import {
  DRAFT_KINDS,
  TODAY_KINDS,
  type DraftKind,
  type TodayDraftOutput,
} from '@hfos/core/addons/outreach/today';
import { Copy, Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { EmptyState } from '@/components/ui/empty-state';
import { errorMessage } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { outreachHref } from './address';
import type { TodayItem, TodayList } from './types';

const KIND_BADGE = {
  friend_request: 'accent',
  opener: 'ok',
  follow_up: 'gray',
  reply: 'pending',
} as const;

/** Where to open someone on the list: their chat for a message in one, else their profile. */
function openUrl(item: TodayItem): string | null {
  if (item.threadKey)
    return `https://www.facebook.com/messages/t/${encodeURIComponent(item.threadKey)}`;
  return item.profileUrl;
}

export function TodayView({ workspaceId, today }: { workspaceId: string; today: TodayList }) {
  const limits = [
    ['friend_request', today.limits.friend_request],
    ['first_message', today.limits.first_message],
    ['follow_up', today.limits.follow_up],
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
              <span className="text-[12.5px] text-text-3">You send each one yourself</span>
            </div>
            <ul className="mt-2">
              {today.items.map((item) => (
                <TodayRow
                  key={`${item.kind}:${item.chatId ?? item.profileId ?? item.name}`}
                  workspaceId={workspaceId}
                  item={item}
                />
              ))}
            </ul>
          </Card>
        ) : (
          <Card data-testid="today-empty">
            <EmptyState title="Nothing on your list yet">
              Save groups and their members with the extension, and read your chats in Messenger.
              People who fit your playbooks, new friends to say hi to, and chats to follow up show
              here.
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

function TodayRow({ workspaceId, item }: { workspaceId: string; item: TodayItem }) {
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
        <Badge variant={KIND_BADGE[item.kind]}>{TODAY_KINDS[item.kind]}</Badge>
      </div>
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
  const ask = async () => {
    setBusy(true);
    try {
      const out = await workerPost<TodayDraftOutput>(
        '/v1/addons/outreach/actions/outreach.today.draft',
        { workspaceId, input: { kind, profileId: item.profileId, chatId: item.chatId } },
      );
      if (!out.drafts.length) toast.message('The AI had nothing to suggest. Try again.');
      setDrafts(out.drafts);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2">
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
                onClick={() => void copyText(text, 'Copied. Paste it in Messenger.')}
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
        {drafts.length ? 'Draft again' : 'Draft a message'}
      </Button>
    </div>
  );
}
