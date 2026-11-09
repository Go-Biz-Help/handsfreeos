'use client';
/**
 * What it's doing (docs/socialcontent.md, "What it's doing"): on top of Creators, whether the reading computer is
 * there (when it last asked for work, and its extension's version), what it's doing now (the words it's searching,
 * the searches done, the accounts it looked at, profiles and posts it read), how much more waits, and what it did
 * lately, each with what it found or why it didn't work. It refreshes as the reading computer says how it's going,
 * and every two minutes while it's seen, for when it last checked in.
 */
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import {
  READER_THERE_MS,
  SOCIALCONTENT_WORDS as W,
  momentAgo,
  progressFacts,
} from '@hfos/core/addons/socialcontent/words';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { startTransition, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { Overview, Work } from './types';

/** What a piece of work is about: "Find creators for “CRM software” on Instagram". */
export function workWhat(w: Work): string {
  const network = networkName(w.network);
  return w.kind === 'find'
    ? W.work.kinds.find(w.nicheName ?? '', network)
    : W.work.kinds[w.kind](w.creatorShown ?? '', network);
}

/** What a piece of work did, or is doing, as short facts. */
export function WorkFacts({ work, className }: { work: Work; className?: string }) {
  const facts = progressFacts(work.progress);
  if (!facts.length) return null;
  return (
    <ul className={cn('mt-1 flex flex-wrap gap-1.5', className)}>
      {facts.map((f) => (
        <li key={f} className="rounded-full bg-card-2 px-2 py-0.5 text-[12px] text-text-2">
          {f}
        </li>
      ))}
    </ul>
  );
}

/** Now, ticking each half minute, so "checked in 1 minute ago" stays true. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** How often the page is read again while it's seen: asking for work says nothing live, so "checked in" stays true. */
const CHECK_IN_EVERY_MS = 2 * 60_000;

function useCheckIns(on: boolean): void {
  const router = useRouter();
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') startTransition(() => router.refresh());
    }, CHECK_IN_EVERY_MS);
    return () => clearInterval(t);
  }, [router, on]);
}

export function ActivityCard({ overview }: { overview: Overview }) {
  const now = useNow();
  useCheckIns(!!overview.settings.readerUserId);
  const { settings, work } = overview;
  if (!settings.readerUserId) return null;
  const name = settings.readerName ?? 'The reading';
  const seen = settings.readerSeenAt;
  const there = seen !== null && now - new Date(seen).getTime() < READER_THERE_MS;
  const taken = work.filter((w) => w.state === 'taken');
  const waiting = Math.max(0, overview.counts.waiting - taken.length);
  const lately = work
    .filter((w) => w.state === 'done' || w.state === 'failed')
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
    .slice(0, 3);
  return (
    <Card className="p-4 md:p-5" data-testid="socialcontent-activity">
      <h2 className="text-[15px] font-semibold">{W.activity.title}</h2>
      <p
        className={cn('mt-1 text-[13px]', there ? 'text-text-2' : 'text-warning-text')}
        data-testid="socialcontent-reader"
      >
        {seen === null
          ? W.activity.readerNever(name)
          : there
            ? W.activity.reader(name, momentAgo(seen, now) ?? '', settings.readerVersion)
            : W.activity.readerQuiet(name, momentAgo(seen, now) ?? '')}
      </p>
      {taken.length === 0 && waiting === 0 && lately.length === 0 ? (
        <p className="mt-3 text-[13.5px] text-text-2">{W.activity.nothing}</p>
      ) : null}
      {taken.length ? (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-3">
            {W.activity.now}
          </div>
          <ul>
            {taken.map((w) => (
              <li key={w.id} className="py-2" data-testid={`socialcontent-now-${w.id}`}>
                <div className="flex items-center gap-2 text-[13.5px] text-text">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-3" aria-hidden />
                  <span className="min-w-0">{workWhat(w)}</span>
                </div>
                <div className="mt-0.5 pl-[22px] text-[12.5px] text-text-2">
                  {w.progress?.now ?? W.activity.starting}
                </div>
                <WorkFacts work={w} className="pl-[22px]" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {waiting ? (
        <p className="mt-2 text-[12.5px] text-text-3">{W.activity.waiting(waiting)}</p>
      ) : null}
      {lately.length ? (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-3">
            {W.activity.lately}
          </div>
          <ul>
            {lately.map((w) => (
              <li key={w.id} className="border-b border-border py-2 last:border-b-0">
                <div className="text-[13.5px] text-text">{workWhat(w)}</div>
                <div className="text-[12.5px] text-text-3">
                  {[W.work.states[w.state], momentAgo(w.finishedAt, now)]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <WorkFacts work={w} />
                {w.state === 'failed' && w.failure ? (
                  <div className="mt-0.5 text-[12.5px] text-danger-text">{w.failure}</div>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-text-3">{W.activity.all}</p>
        </div>
      ) : null}
    </Card>
  );
}
