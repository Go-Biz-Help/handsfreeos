'use client';
import {
  DESK_HELPER_WORDS,
  DESK_PROBLEM_WORDS,
  learnedButtonWords,
  learnedWayWords,
  type LearnedWayRow,
} from '@hfos/core';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { whenWords } from '@/components/admin/ticket-bits';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';

const chip = (on: boolean) =>
  cn(
    'inline-flex h-8 items-center rounded-control px-3 text-[13px] font-medium',
    on ? 'bg-accent-soft text-accent-text' : 'text-text-2 hover:bg-card-2',
  );

/**
 * The desk's Learned ways (decision 142): how the AI helper found each step's button in a new place, how often it
 * worked and for how many businesses, and whether every computer tries it. Staff set one aside, and no computer tries
 * it again, or bring it back.
 */
export function LearnedWays({
  ways,
  area,
}: {
  ways: readonly LearnedWayRow[];
  area: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const areas = [...new Set(ways.map((w) => w.area))].sort();
  const set = async (wayId: string, removed: boolean) => {
    if (busy) return;
    setBusy(wayId);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/learned_way.set_removed', {
          body: { wayIds: [wayId], removed },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mx-auto w-full max-w-5xl" data-testid="learned-ways">
      <Link
        href="/admin/problems"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-text-2 hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
        {DESK_PROBLEM_WORDS.back}
      </Link>
      <h1 className="mt-2 text-xl font-semibold md:text-2xl">{DESK_HELPER_WORDS.ways}</h1>
      <p className="mt-1 text-[13px] text-text-3">{DESK_HELPER_WORDS.waysIntro}</p>

      {areas.length > 1 || area ? (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <Link href="/admin/problems/ways" className={chip(area === null)}>
            {DESK_PROBLEM_WORDS.everyArea}
          </Link>
          {(area && !areas.includes(area) ? [...areas, area] : areas).map((a) => (
            <Link
              key={a}
              href={`/admin/problems/ways?area=${a}`}
              className={chip(area === a)}
              data-testid={`ways-area-${a}`}
            >
              {a}
            </Link>
          ))}
        </div>
      ) : null}

      <ul
        className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card"
        data-testid="ways-list"
      >
        {ways.map((w) => (
          <li key={w.wayId} className="flex items-start gap-3 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-semibold">
                  {w.area} · {learnedButtonWords(w.button)}
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    w.removedAt
                      ? 'bg-card-2 text-text-3'
                      : w.trustedAt
                        ? 'bg-accent-soft text-accent-text'
                        : 'bg-card-2 text-text-2',
                  )}
                >
                  {w.removedAt
                    ? DESK_HELPER_WORDS.removedWay
                    : w.trustedAt
                      ? DESK_HELPER_WORDS.trusted
                      : DESK_HELPER_WORDS.learning}
                </span>
              </span>
              <span className="mt-0.5 block break-words text-[13px] text-text-2">
                {learnedWayWords(w.way)}
              </span>
              <span className="mt-0.5 block text-[12px] text-text-3">
                {DESK_HELPER_WORDS.wayCounts(w)}
                {w.lastWorkedAt ? ` · ${whenWords(w.lastWorkedAt)}` : ''}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              loading={busy === w.wayId}
              onClick={() => void set(w.wayId, w.removedAt === null)}
              data-testid={`way-set-${w.wayId}`}
            >
              {w.removedAt === null ? DESK_HELPER_WORDS.setAside : DESK_HELPER_WORDS.bringBack}
            </Button>
          </li>
        ))}
        {ways.length === 0 ? (
          <li className="px-4 py-10 text-center text-[13px] text-text-3">
            {DESK_HELPER_WORDS.noWays}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
