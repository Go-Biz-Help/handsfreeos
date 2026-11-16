'use client';
/**
 * Run now (docs/outreach.md, decision 129): a small menu at the top of People and Find people with the jobs their
 * computer can do for them there, in place of a card for each, and every job on Settings → Your computer, by network.
 * Most run on their own each day, so the menu is for doing one now. A job its computer is on, or can't do yet (no
 * computer, an older build, a warning today), waits, saying why. The jobs are core's (`run-now.ts`).
 */
import {
  askableOn,
  askedWords,
  askNameOn,
  askOpen,
  ASK_WORDS,
  cantAskWhy,
  latestAskOn,
  targetOf,
  type AskInput,
  type AskKind,
} from '@hfos/core/addons/outreach/asks';
import { PLATFORMS, WORKING_PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { SETTINGS_PAGE_WORDS as SP } from '@hfos/core/addons/outreach/settings-pages';
import {
  RUN_NOW_ALL,
  RUN_NOW_ON,
  RUN_NOW_WORDS as R,
  runNowOn,
  type RunNowPage,
} from '@hfos/core/addons/outreach/run-now';
import { ChevronDown, Play } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { AskButton } from './asks';
import type { Asks } from './types';
import { useAct } from './use-act';

/** A plain job's ask: nothing typed or ticked. */
const plain = (kind: AskKind) => ({ kind }) as AskInput;

/** Each network's jobs of some, those it can be asked: one network's, or every one's. */
const jobsOn = (kinds: readonly AskKind[], net: Platform | null) =>
  (net ? [net] : WORKING_PLATFORMS)
    .map((platform) => ({ platform, kinds: runNowOn(kinds, platform) }))
    .filter((n) => n.kinds.length);

/** The menu at the top of a page: its jobs on the network picked, or on each network under its name. */
export function RunNowMenu({
  workspaceId,
  asks,
  page,
  net,
}: {
  workspaceId: string;
  asks: Asks;
  page: RunNowPage;
  /** The network picked: null for every network. */
  net: Platform | null;
}) {
  const { busy, act } = useAct();
  const nets = jobsOn(RUN_NOW_ON[page], net);
  if (!nets.length) return null;
  const run = (platform: Platform, kind: AskKind) =>
    void act(`run:${platform}:${kind}`, async () => {
      const made = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.ask.make', {
          body: { workspaceId, platform, ask: plain(kind) },
        }),
      );
      toast.success(askedWords(made, asks, Date.now()));
    });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" loading={busy !== null} data-testid="run-now">
          <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
          {R.button}
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80" data-testid="run-now-menu">
        <p className="px-2.5 pb-1.5 pt-1 text-[12px] text-text-3">{R.menuAbout}</p>
        {nets.map(({ platform, kinds }, i) => (
          <Fragment key={platform}>
            {i ? <DropdownMenuSeparator /> : null}
            {nets.length > 1 ? <DropdownMenuLabel>{PLATFORMS[platform]}</DropdownMenuLabel> : null}
            {kinds.map((kind) => {
              const why = cantAskWhy(asks, kind, platform);
              const latest = latestAskOn(asks, platform, kind, targetOf(plain(kind)));
              const open = latest !== null && askOpen(latest.state);
              return (
                <DropdownMenuItem
                  key={kind}
                  disabled={why !== null || open || busy !== null}
                  title={why ?? (open ? ASK_WORDS.onIt : undefined)}
                  onSelect={() => run(platform, kind)}
                  data-testid={`run-now-${platform}-${kind}`}
                >
                  <span className="min-w-0 truncate">{askNameOn(kind, platform)}</span>
                </DropdownMenuItem>
              );
            })}
          </Fragment>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            href={outreachHref(workspaceId, { view: 'settings', part: 'computer' })}
            className="text-accent-text"
            data-testid="run-now-all-open"
          >
            {R.seeAll}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Settings → Your computer's list: every job, a part for each network the person works, with its latest ask. */
export function RunNowAll({
  workspaceId,
  asks,
  networks,
}: {
  workspaceId: string;
  asks: Asks;
  /** The networks on for the person. */
  networks: readonly Platform[];
}) {
  const nets = networks
    .map((platform) => ({ platform, kinds: RUN_NOW_ALL.filter((k) => askableOn(platform, k)) }))
    .filter((n) => n.kinds.length);
  // One network open at a time (decision 170, part 2): the first to start.
  const [open, setOpen] = useState<Platform | null>(nets[0]?.platform ?? null);
  if (!nets.length) return null;
  return (
    <Card className="px-[22px] py-5 max-md:px-4 max-md:py-4" data-testid="run-now-all">
      <div className="mb-2">
        <h3 className="text-[16px] font-semibold tracking-tight">{SP.runTitle}</h3>
        <p className="mt-0.5 text-[13px] text-text-2">{SP.runAbout}</p>
      </div>
      <div className="divide-y divide-border">
        {nets.map(({ platform, kinds }) => {
          const shown = open === platform;
          return (
            <section key={platform} data-testid={`run-now-all-${platform}`}>
              <button
                type="button"
                aria-expanded={shown}
                onClick={() => setOpen(shown ? null : platform)}
                className="flex min-h-[48px] w-full items-center justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                data-testid={`run-now-all-${platform}-toggle`}
              >
                <span className="text-[14px] font-semibold">
                  {PLATFORMS[platform]}
                  {shown ? null : (
                    <span className="font-normal text-text-3"> · {SP.jobs(kinds.length)}</span>
                  )}
                </span>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 flex-none text-text-2 transition-transform',
                    shown && 'rotate-180',
                  )}
                  strokeWidth={1.75}
                  aria-hidden
                />
              </button>
              {shown ? (
                <div className="grid gap-3 pb-4 sm:grid-cols-2">
                  {kinds.map((kind) => (
                    <AskButton
                      key={kind}
                      workspaceId={workspaceId}
                      asks={asks}
                      ask={plain(kind)}
                      platform={platform}
                      label={askNameOn(kind, platform)}
                      testId={`run-now-all-${platform}-${kind}`}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </Card>
  );
}
