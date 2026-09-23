'use client';
import { IDEAS_WORDS } from '@hfos/core';
import { ChevronUp } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * A vote for an idea, and taking it back. It changes on the press and puts itself right if the server says
 * otherwise, so a board of fifty ideas never waits on a round trip to show a vote. Closed ideas (done, not
 * planned, merged) show their count without a button.
 */
export function VoteButton({
  ideaId,
  workspaceId,
  voted,
  count,
  open = true,
  size = 'md',
}: {
  ideaId: string;
  workspaceId?: string;
  voted: boolean;
  count: number;
  open?: boolean;
  size?: 'md' | 'lg';
}) {
  const router = useRouter();
  const [mine, setMine] = useState(voted);
  const [shown, setShown] = useState(count);
  const [busy, setBusy] = useState(false);
  // A refresh from the server is the truth.
  useEffect(() => {
    setMine(voted);
    setShown(count);
  }, [voted, count]);

  const press = async () => {
    if (busy || !open) return;
    const next = !mine;
    setBusy(true);
    setMine(next);
    setShown((n) => Math.max(0, n + (next ? 1 : -1)));
    try {
      const out = unwrap(
        await apiBrowser().POST(next ? '/v1/commands/idea.vote' : '/v1/commands/idea.unvote', {
          body: { ideaId, ...(workspaceId ? { workspaceId } : {}) },
        }),
      );
      setMine(out.voted);
      setShown(out.voteCount);
      router.refresh();
    } catch (e) {
      setMine(!next);
      setShown((n) => Math.max(0, n + (next ? -1 : 1)));
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const big = size === 'lg';
  const box = cn(
    'flex flex-none flex-col items-center justify-center rounded-control border font-semibold tabular-nums',
    big ? 'h-16 w-14 text-base' : 'h-14 w-12 text-sm',
  );
  if (!open)
    return (
      <div
        className={cn(box, 'border-border bg-card-2 text-text-2')}
        title={IDEAS_WORDS.votingClosed}
        data-testid="idea-votes"
      >
        <ChevronUp className="h-4 w-4 text-text-3" strokeWidth={1.75} aria-hidden />
        <span>{shown}</span>
        <span className="sr-only">votes</span>
      </div>
    );
  return (
    <button
      type="button"
      onClick={press}
      aria-pressed={mine}
      aria-label={mine ? IDEAS_WORDS.unvote(shown) : IDEAS_WORDS.vote(shown)}
      title={mine ? 'You voted for this. Press to take your vote back.' : 'Vote for this'}
      data-testid="idea-vote"
      className={cn(
        box,
        'transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        mine
          ? 'border-accent bg-accent-soft text-accent-text'
          : 'border-border bg-card text-text hover:border-border-strong hover:bg-card-2',
      )}
    >
      <ChevronUp className="h-4 w-4" strokeWidth={mine ? 2.25 : 1.75} aria-hidden />
      <span data-testid="idea-vote-count">{shown}</span>
    </button>
  );
}
