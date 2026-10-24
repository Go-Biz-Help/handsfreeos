'use client';
/**
 * A customer's funnel line (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "Seeing where people are"), under
 * their name on their page, on their lead, and beside their conversation: "Recruiting · At the presentation · Next:
 * “Can you hear okay?” at Thu, 7:10 PM", with Pause, Move to… and Remove. Moving moves their lead, and the funnel
 * follows it, as dragging it on the board does. With a suggestion from the teammate waiting, the line asks yes or
 * no; in no funnel, it offers the ones they could be added to. A business without funnels sees nothing.
 */
import { FUNNEL_PERSON_WORDS as W, funnelWhereWords } from '@hfos/core';
import { ChevronDown, MoreHorizontal, Route } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@/components/shell/workspace-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { errorMessage } from '@/lib/api/client';
import { funnelActions, type FunnelOfPersonOut } from '@/lib/funnels/actions';
import { cn } from '@/lib/utils';

export function PersonFunnelLine({
  workspaceId,
  personId,
  className,
}: {
  workspaceId: string;
  personId: string;
  className?: string;
}) {
  const router = useRouter();
  const canChange = useCan('records.write');
  const actions = useMemo(() => funnelActions(workspaceId), [workspaceId]);
  const [data, setData] = useState<FunnelOfPersonOut | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      actions
        .ofPerson(personId)
        .then(setData)
        .catch(() => setData(null)),
    [actions, personId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function act(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await work();
      toast.success(done);
      await load();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;
  const { current, suggestion, canJoin, stages, timeZone } = data;
  const base = `/app/w/${workspaceId}/ai-team/funnels`;

  if (current) {
    const paused = current.status === 'paused';
    const next = current.next[0];
    const where = funnelWhereWords(
      current.stageName ?? 'their stage',
      current.booking ? { startsAt: new Date(current.booking.startsAt).getTime() } : null,
      timeZone,
    );
    const moveTo = stages.filter((s) => s.kind === 'open' && s.id !== current.stageId);
    const leadId = current.leadId;
    return (
      <div
        className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]', className)}
        data-testid="person-funnel"
      >
        <Route className="h-3.5 w-3.5 flex-none text-accent-text" strokeWidth={1.75} aria-hidden />
        <a href={`${base}/${current.funnelId}`} className="font-medium hover:underline">
          {current.funnelName}
        </a>
        <span className="text-text-2">· {where}</span>
        {paused ? (
          <Badge variant="pending">{W.paused(current.pausedReason)}</Badge>
        ) : next ? (
          <span className="min-w-0 truncate text-text-2">
            · {W.next(next.text, new Date(next.dueAt).getTime(), timeZone)}
          </span>
        ) : null}
        {canChange ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                disabled={busy}
                aria-label={`Change ${current.funnelName} for ${current.personName}`}
                data-testid="person-funnel-menu"
              >
                <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                onSelect={() =>
                  void act(
                    () => actions.pausePerson(current.id, !paused),
                    paused
                      ? W.resumedDone(current.funnelName, current.personName)
                      : W.pausedDone(current.funnelName, current.personName),
                  )
                }
                data-testid="person-funnel-pause"
              >
                {paused ? W.resume : W.pause}
              </DropdownMenuItem>
              {leadId && moveTo.length ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{W.moveTo}</DropdownMenuLabel>
                  {moveTo.map((s) => (
                    <DropdownMenuItem
                      key={s.id}
                      onSelect={() =>
                        void act(
                          () => actions.moveLead(leadId, s.id),
                          W.movedDone(current.personName, s.name),
                        )
                      }
                    >
                      {s.name}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                danger
                onSelect={() =>
                  void act(
                    () => actions.removePerson(current.id),
                    W.removedDone(current.funnelName, current.personName),
                  )
                }
                data-testid="person-funnel-remove"
              >
                {W.remove(current.funnelName)}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    );
  }

  if (suggestion) {
    return (
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-control bg-accent-soft px-2.5 py-1.5 text-[13px]',
          className,
        )}
        data-testid="person-funnel-suggestion"
      >
        <Route className="h-3.5 w-3.5 flex-none text-accent-text" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 text-accent-text">
          {W.suggested(suggestion.funnelName, suggestion.suggestedWhy)}
        </span>
        {canChange ? (
          <span className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={busy}
              onClick={() =>
                void act(
                  () => actions.decideSuggestion(suggestion.id, false),
                  W.declinedDone(suggestion.funnelName),
                )
              }
            >
              {W.no}
            </Button>
            <Button
              size="sm"
              className="h-7"
              loading={busy}
              onClick={() =>
                void act(
                  () => actions.decideSuggestion(suggestion.id, true),
                  W.addedDone(suggestion.funnelName),
                )
              }
              data-testid="person-funnel-suggestion-yes"
            >
              {W.yes}
            </Button>
          </span>
        ) : null}
      </div>
    );
  }

  if (!canJoin.length || !canChange) return null;
  return (
    <div className={cn('flex items-center text-[13px]', className)} data-testid="person-funnel-add">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="-ml-2 h-7 px-2 text-text-2" disabled={busy}>
            <Route className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            {W.add}
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {canJoin.map((f) => (
            <DropdownMenuItem
              key={f.id}
              onSelect={() =>
                void act(() => actions.addPerson(f.id, personId), W.addedDone(f.name))
              }
            >
              {f.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
