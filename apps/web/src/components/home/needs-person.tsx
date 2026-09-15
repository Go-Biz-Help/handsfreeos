'use client';
import { UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ContactAvatar, WaitChip } from '@/components/inbox/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AI_TEXT } from '@/components/workflows/chips';
import { handlingOf } from '@/lib/ai-team/inbox-types';
import { CHANNEL_WORD, firstNameOf, handoffWhy } from '@/lib/ai-team/inbox-words';
import { teammateCommands } from '@/lib/ai-team/use-inbox';
import { errorMessage } from '@/lib/api/client';
import type { ConversationSummary } from '@/lib/api/types';
import { minutesWaiting, zonedWhen } from '@/lib/inbox';
import { useUnread } from '@/lib/realtime/unread-provider';
import { cn } from '@/lib/utils';

/**
 * Home's "Needs a person": conversations the AI teammate handed to a person that nobody has picked up, the
 * longest waiting first, each with the teammate's note and Take it. Renders nothing when none wait.
 */
export function NeedsPersonCard({
  workspaceId,
  items,
  count,
  myUserId,
  timeZone,
  teammateName,
  className,
}: {
  workspaceId: string;
  /** The first few, longest waiting first (inbox.list's needs_person box). */
  items: ConversationSummary[];
  /** How many wait in all (inbox.summary). */
  count: number;
  myUserId: string;
  timeZone: string;
  teammateName: string | null;
  className?: string;
}) {
  const router = useRouter();
  const unread = useUnread();
  const [busy, setBusy] = useState<string | null>(null);
  if (!items.length) return null;
  const inbox = `/app/w/${workspaceId}/inbox`;

  async function take(c: ConversationSummary) {
    setBusy(c.id);
    try {
      await teammateCommands(workspaceId).takeOver(c.id);
      toast.success(
        `It’s yours. ${teammateName ?? 'The AI teammate'} stays quiet until you hand it back.`,
      );
      // The inbox's box counts outlive the page change: they drop the one just taken now.
      unread.refresh();
      router.push(`${inbox}/${c.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <Card
      className={cn('mb-5 overflow-hidden border-warning', className)}
      data-testid="home-needs-person"
    >
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5 pt-3.5 md:px-5">
        <span
          aria-hidden
          className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-warning-soft text-warning-text"
        >
          <UserRound className="h-[13px] w-[13px]" strokeWidth={1.75} />
        </span>
        <h2 className="text-[15px] font-semibold">Needs a person</h2>
        <Badge variant="pending" data-testid="home-needs-person-count">
          {count || items.length}
        </Badge>
        <Link
          href={`${inbox}?box=needs_person`}
          className="ml-auto text-[13px] font-medium text-accent-text hover:underline"
          data-testid="home-needs-person-open"
        >
          Open the box
        </Link>
      </div>
      <ul>
        {items.map((c) => {
          const h = handlingOf(c);
          const name = h?.teammate?.name ?? teammateName;
          const who = c.person?.fullName ?? c.counterpartDisplay;
          const since = h?.needsPersonSince ?? c.awaitingReplySince;
          const waited = minutesWaiting(since);
          const why = h ? handoffWhy(h.handoffReason, name ?? 'The AI teammate') : null;
          const line = h?.handoffNote ?? (why ? `${why[0]!.toUpperCase()}${why.slice(1)}.` : null);
          const to = !c.assignee
            ? null
            : c.assignee.id === myUserId
              ? 'assigned to you'
              : `assigned to ${firstNameOf(c.assignee.fullName)}`;
          return (
            <li
              key={c.id}
              className="flex items-start gap-3 border-t border-border px-4 py-3 md:px-5"
              data-testid="home-needs-person-row"
            >
              <ContactAvatar person={c.person} />
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="flex min-w-0 items-center gap-2">
                  <Link
                    href={`${inbox}/${c.id}`}
                    className="truncate text-[13px] font-semibold hover:underline"
                  >
                    {who}
                  </Link>
                  <span className="flex-none text-xs text-text-3">
                    {CHANNEL_WORD[c.channel] ?? c.channel}
                  </span>
                </span>
                <span className="line-clamp-2 text-[13px] leading-[1.45] text-text-2">
                  {line && name ? (
                    <>
                      <span className={cn('font-semibold', AI_TEXT)}>{name}:</span> {line}
                    </>
                  ) : (
                    c.lastPreview
                  )}
                </span>
                {h?.needsPersonSince || to ? (
                  <span className="text-xs text-text-3">
                    {h?.needsPersonSince
                      ? `Handed off at ${zonedWhen(new Date(h.needsPersonSince), timeZone)}`
                      : ''}
                    {h?.needsPersonSince && to ? ' · ' : ''}
                    {to ?? ''}
                  </span>
                ) : null}
              </span>
              <span className="flex flex-none flex-col items-end gap-2">
                {waited !== null ? <WaitChip minutes={waited} /> : null}
                <Button
                  size="sm"
                  loading={busy === c.id}
                  disabled={busy !== null}
                  onClick={() => void take(c)}
                  data-testid="home-take-it"
                >
                  Take it
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
