'use client';
/**
 * The ticker along the bottom of every Social Outreach page (docs/outreach.md, decision 140): what the person's
 * computer is doing that very second, then today's newest steps going past like the news line along the bottom of a
 * TV (`outreach.ticker`, words from `tickerOf`). It holds still while pointed at, focused, tapped or paused, and for
 * reduced motion. Each person sees only their own.
 *
 * While it's on screen it says so every minute (`outreach.live.watch`), and the person's computer then tells what
 * it's doing every few seconds instead of every 45, so the line keeps up.
 */
import {
  tickerOf,
  tickerSeconds,
  TICKER_WORDS as TW,
  WATCH_EVERY_SECONDS,
  type TickerOutput,
} from '@hfos/core/addons/outreach/tallies';
import { Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { useServerNow } from './live-view';

/** Asked again this often while the tab is shown, when nothing was heard. */
const AGAIN_MS = 60_000;
const EPOCH = new Date(0).toISOString();

const DOT = {
  live: 'bg-success animate-pulse',
  quiet: 'bg-text-3',
  warn: 'bg-warning',
} as const;

export function OutreachTicker({ workspaceId }: { workspaceId: string }) {
  const [out, setOut] = useState<TickerOutput | null>(null);
  const [paused, setPaused] = useState(false);
  // What the person's computer says: its line, a step, its day started or stopped.
  const heard = useLiveVersion(['outreach_computer', 'outreach_line', 'outreach_day'], 300);
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') setBeat((n) => n + 1);
    }, AGAIN_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let gone = false;
    apiBrowser()
      .POST('/v1/queries/outreach.ticker', { body: { workspaceId } })
      .then(unwrap)
      .then((got) => {
        if (!gone) setOut(got);
      })
      // Not had (offline, or the add-on just turned off): what's shown stays.
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [workspaceId, heard, beat]);
  // On screen: the computer tells every few seconds for the next minute and a half, said again each minute.
  useEffect(() => {
    const watch = () => {
      if (document.visibilityState !== 'visible') return;
      void apiBrowser()
        .POST('/v1/commands/outreach.live.watch', { body: { workspaceId } })
        .catch(() => undefined);
    };
    watch();
    const t = setInterval(watch, WATCH_EVERY_SECONDS * 1000);
    document.addEventListener('visibilitychange', watch);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', watch);
    };
  }, [workspaceId]);

  // Ticks on its own, so a computer that goes quiet shows offline without asking again.
  const now = useServerNow(out?.now ?? EPOCH, 15_000);
  // How long one pass takes: from the words' own width (the lane shown, the phone's or the desktop's), never too fast
  // to read.
  const bar = useRef<HTMLDivElement>(null);
  const [seconds, setSeconds] = useState(30);
  const steps = out?.steps.map((s) => s.at + s.line).join('\n') ?? '';
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => {
      const widths = [...el.querySelectorAll<HTMLElement>('[data-ticker-copy="0"]')].map(
        (c) => c.scrollWidth,
      );
      setSeconds(tickerSeconds(Math.max(0, ...widths)));
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, [steps]);

  if (!out) return null;
  const t = tickerOf(out, now);
  const lane = (className: string) => (
    <div
      className={cn('outreach-ticker-lane min-w-0 flex-1 overflow-hidden', className)}
      aria-label={TW.label}
      onClick={() => setPaused((p) => !p)}
    >
      {t.steps.length ? (
        <div className="outreach-ticker-track flex w-max whitespace-nowrap">
          {[0, 1].map((n) => (
            <span
              key={n}
              data-ticker-copy={n}
              aria-hidden={n === 1 || undefined}
              className={cn('flex pr-8', n === 1 && 'outreach-ticker-copy')}
            >
              {t.steps.map((s, i) => (
                <span key={i} className="mr-8 inline-flex items-baseline gap-2 text-[13px]">
                  <span className="tabular-nums text-text-3">{s.at}</span>
                  <span className="text-text-2">{s.line}</span>
                </span>
              ))}
            </span>
          ))}
        </div>
      ) : (
        <p className="truncate text-[13px] text-text-3">{t.empty}</p>
      )}
    </div>
  );

  return (
    <div
      ref={bar}
      className="outreach-ticker sticky bottom-[74px] z-20 mt-6 md:bottom-4 print:hidden"
      data-testid="outreach-ticker"
      data-state={t.head.state}
      data-paused={paused || undefined}
      style={{ '--ticker-seconds': `${seconds}s` } as CSSProperties}
    >
      <div className="rounded-card border border-border bg-card shadow-2">
        <div className="flex items-center gap-2.5 px-3 py-2 md:h-11 md:py-0">
          <span
            className="inline-flex flex-none items-center gap-1.5 rounded-full bg-card-2 px-2 py-0.5 text-[11.5px] font-semibold uppercase tracking-wide text-text-2"
            data-testid="ticker-live"
          >
            <span aria-hidden className={cn('h-2 w-2 rounded-full', DOT[t.head.tone])} />
            {TW.live}
          </span>
          <Link
            href={outreachHref(workspaceId, { view: 'today' })}
            title={TW.today}
            className="min-w-0 flex-1 truncate text-[13px] font-medium hover:underline md:max-w-[42%] md:flex-none"
            data-testid="ticker-head"
          >
            {t.head.words}
          </Link>
          {t.steps.length ? (
            <span aria-hidden className="hidden h-4 w-px flex-none bg-border md:block" />
          ) : null}
          {lane('hidden md:block')}
          {t.steps.length ? (
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              aria-label={paused ? TW.play : TW.pause}
              aria-pressed={paused}
              className="outreach-ticker-pause flex h-7 w-7 flex-none items-center justify-center rounded-full text-text-3 hover:bg-card-2 hover:text-text"
              data-testid="ticker-pause"
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </button>
          ) : null}
        </div>
        {lane('border-t border-border px-3 py-1.5 md:hidden')}
      </div>
    </div>
  );
}
